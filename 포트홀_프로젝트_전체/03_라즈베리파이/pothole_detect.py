"""
포트홀감지 (로컬전용,서버업로드없음) - 자전거용

흐름: 흔들림감지(ADXL345) → 그지점찍은폰IP캠사진 → YOLO검사
      → 포트홀이면 pothole/, 다른사물있으면 item/, 없으면 no_item/ 에저장함
파일이름: 위도_경도_충격세기g_시간.jpg

시뮬링크모델(bike_pothole_model)이랑 똑같은방식으로 계산함
  - 센서 400Hz, ±16g
  - 충격 = | |가속도크기| - 1g |  (센서방향상관없이 가만히있으면0, 쿵이나쑥빠짐둘다잡힘)
  - 충격점수 = 최근 WINDOW초 평균
  - 점수가 기준값넘고 COOLDOWN초지났으면 감지
기준값: calibrate.py 로학습한 threshold.json 있으면그거씀 (없으면 THRESHOLD)

이번에바뀐거
  - GPS속도로 느리면감지안함 (걷거나 자전거끌때 사진찍히는거막음)
  - 사진고를때 속도보고 카메라가그지점찍은순간을 계산해서고름
  - 기본기준값 0.6 → 1.2 (시뮬레이션추천값, step3결과나오면바꾸기)

설치: python3 -m pip install ultralytics smbus2 pyserial pynmea2 requests --break-system-packages
실행: python3 pothole_detect.py
"""
import json
import math
import os
import threading
import time
from collections import deque
from datetime import datetime

import pynmea2
import requests
import serial
from smbus2 import SMBus
from ultralytics import YOLO

# ===== 설정 =====
CAM_URL = "http://10.194.36.252:8080/shot.jpg"  # 폰 IP Webcam 앱주소
GPS_PORT = "/dev/ttyACM0"                         # USB GPS (G-Mouse)
ADXL_ADDR = 0x53                                  # ADXL345 I2C 주소
THRESHOLD = 1.2       # threshold.json 없을때쓰는 기본기준(g). 시뮬레이션추천값
WINDOW = 0.05         # 충격점수 평균시간(초). calibrate.py, 시뮬링크랑 같아야함
COOLDOWN = 2          # 한번감지하고 쉬는시간(초). 같은구멍 두번안셈 (앞바퀴뒷바퀴 두번쿵 포함)

MIN_SPEED_KMH = 6     # 이보다느리면 감지안함 (걷는속도 4~5km/h. 방지턱앞에서 속도줄이니까 너무높이면안됨)
NEED_GPS_SPEED = False  # True면 GPS안잡혔을때도 감지안함. False면 GPS없을땐 그냥감지함

CAM_AHEAD_M = 2.0     # 카메라가 바퀴앞 몇m를 찍는지 (사진가운데 기준, 직접재서넣기)
PHOTO_BEFORE = 0.5    # 속도모를때 충격 몇초전사진쓸지
PHOTO_MAX_BACK = 3.0  # 아무리느려도 이보다오래전사진은 안씀(초)

MODEL_PATH = "best_ncnn_model"  # 코랩에서 학습한모델 (포트홀+기본사물). 없으면 "yolo26n.pt" 로 바꾸면 원래대로
POTHOLE_NAMES = {"pothole", "woodlock"}  # 이이름 잡히면 포트홀로침 (우드락실험용 포함)
CONF = 0.25           # YOLO가 이신뢰도이상일때만 감지로침
SAVE_BOXES = True     # 감지된사진에 네모친거 boxed/ 에따로저장함 (확인용)

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
ITEM_DIR = os.path.join(BASE_DIR, "item")
NO_ITEM_DIR = os.path.join(BASE_DIR, "no_item")
POTHOLE_DIR = os.path.join(BASE_DIR, "pothole")  # 포트홀 잡힌사진
BOX_DIR = os.path.join(BASE_DIR, "boxed")
TH_JSON = os.path.join(BASE_DIR, "threshold.json")


# ===== GPS: 뒤에서계속읽고 마지막위치랑속도 기억함 =====
gps = {"lat": None, "lon": None, "fix": False, "kmh": None, "t": 0.0}


def gps_loop():
    while True:
        try:
            with serial.Serial(GPS_PORT, 9600, timeout=1) as ser:
                while True:
                    line = ser.readline().decode("ascii", errors="ignore").strip()
                    if not line.startswith(("$GPRMC", "$GNRMC")):
                        continue
                    try:
                        msg = pynmea2.parse(line)
                    except pynmea2.ParseError:
                        continue
                    if msg.status == "A":  # A = 위치잡힘
                        gps["lat"], gps["lon"] = msg.latitude, msg.longitude
                        gps["fix"] = True
                        try:
                            gps["kmh"] = float(msg.spd_over_grnd) * 1.852  # 노트 → km/h
                        except (TypeError, ValueError):
                            gps["kmh"] = None
                        gps["t"] = time.time()
                    else:                  # V = 아직/놓침 (마지막위치는 남겨둠)
                        gps["fix"] = False
        except serial.SerialException as e:
            print("GPS연결문제, 3초뒤 다시해봄:", e)
            gps["fix"] = False
            time.sleep(3)


def speed_kmh():
    """지금속도(km/h). GPS안잡혔거나 3초넘게소식없으면 None"""
    if not gps["fix"] or gps["kmh"] is None or time.time() - gps["t"] > 3:
        return None
    return gps["kmh"]


# ===== 카메라: 뒤에서 사진계속받아서 최근몇초 기억함 =====
frames = deque(maxlen=60)  # (받은시각, jpg)  0.1초마다면 대략6초치


def cam_loop():
    s = requests.Session()
    ok = True
    while True:
        try:
            r = s.get(CAM_URL, timeout=3)
            r.raise_for_status()
            frames.append((time.time(), r.content))
            if not ok:
                print("카메라 다시연결됨")
                ok = True
            time.sleep(0.1)
        except requests.RequestException as e:
            if ok:
                print("카메라연결문제 (IP Webcam 서버켜져있는지 확인):", e)
                ok = False
            time.sleep(2)


def photo_back_sec(kmh):
    """충격 몇초전사진을 쓸지. 카메라가 CAM_AHEAD_M 앞을 보니까 그거지나오는데걸린시간만큼 뒤로감"""
    if kmh is None or kmh < 1:
        return PHOTO_BEFORE
    v = kmh / 3.6  # m/s
    return min(CAM_AHEAD_M / v, PHOTO_MAX_BACK)


def pick_frame(shock_time, back):
    want = shock_time - back
    snap = list(frames)
    if not snap:
        return None
    t, jpg = min(snap, key=lambda f: abs(f[0] - want))
    if abs(t - want) > 1.0:  # 너무동떨어진사진뿐이면 안씀
        return None
    return jpg


# ===== ADXL345 =====
def adxl_init(bus):
    bus.write_byte_data(ADXL_ADDR, 0x2C, 0x0C)  # 1초에400번 측정
    bus.write_byte_data(ADXL_ADDR, 0x31, 0x0B)  # ±16g 범위
    bus.write_byte_data(ADXL_ADDR, 0x2D, 0x08)  # 측정시작


def read_g(bus):
    d = bus.read_i2c_block_data(ADXL_ADDR, 0x32, 6)

    def conv(lo, hi):
        v = (hi << 8) | lo
        return (v - 65536 if v > 32767 else v) * 0.0039

    return conv(d[0], d[1]), conv(d[2], d[3]), conv(d[4], d[5])


class Scorer:
    """최근 WINDOW초동안 충격평균 = 충격점수 (시뮬링크 score_window_avg 랑같음)"""

    def __init__(self):
        self.buf = deque()

    def add(self, t, shock):
        self.buf.append((t, shock))
        while t - self.buf[0][0] > WINDOW:
            self.buf.popleft()
        return sum(s for _, s in self.buf) / len(self.buf)


def load_threshold():
    try:
        with open(TH_JSON) as f:
            d = json.load(f)
        th = float(d["threshold"])
        print(f"학습한기준값 {th:.2f}g 씀 (threshold.json, {d.get('made', '')})")
        if d.get("window") not in (None, WINDOW):
            print("  주의: 학습때랑 WINDOW값이다름. calibrate.py로 다시학습해야함")
        return th
    except (OSError, ValueError, KeyError):
        print(f"threshold.json 없음 → 기본기준값 {THRESHOLD}g 씀 (calibrate.py로 학습하는거추천)")
        return THRESHOLD


# ===== 감지됐을때 =====
def make_name(shock):
    t = datetime.now().strftime("%Y%m%d_%H%M%S")
    if gps["lat"] is None:
        loc = "nogps_nogps"
    else:
        loc = f"{gps['lat']:.6f}_{gps['lon']:.6f}"
    return f"{loc}_{shock:.2f}g_{t}.jpg"


def handle(model, shock, shock_time, kmh):
    back = photo_back_sec(kmh)
    jpg = pick_frame(shock_time, back)
    if jpg is None:
        print(f"충격 {shock:.2f}g 감지했는데 쓸만한사진없음 (카메라확인)")
        return

    name = make_name(shock)
    tmp = os.path.join(BASE_DIR, "_last.jpg")
    with open(tmp, "wb") as f:
        f.write(jpg)

    result = model(tmp, conf=CONF, verbose=False)[0]
    found = [result.names[int(c)] for c in result.boxes.cls]

    is_pothole = any(n in POTHOLE_NAMES for n in found)
    folder = POTHOLE_DIR if is_pothole else ITEM_DIR if found else NO_ITEM_DIR
    os.replace(tmp, os.path.join(folder, name))
    if found and SAVE_BOXES:
        result.save(filename=os.path.join(BOX_DIR, name))

    where = os.path.basename(folder)
    spd = f"{kmh:.0f}km/h" if kmh is not None else "속도모름"
    note = "" if gps["fix"] else "  (GPS없음: 마지막위치 또는 nogps)"
    print(f"충격 {shock:.2f}g ({spd}, {back:.2f}초전사진) → {where}/{name}  감지: {found}{note}")


def main():
    for d in (POTHOLE_DIR, ITEM_DIR, NO_ITEM_DIR, BOX_DIR):
        os.makedirs(d, exist_ok=True)  # 폴더없으면 만듦

    threading.Thread(target=gps_loop, daemon=True).start()
    threading.Thread(target=cam_loop, daemon=True).start()

    print("YOLO모델 불러오는중... (처음엔 다운로드때문에 오래걸릴수있음)")
    model = YOLO(MODEL_PATH)
    threshold = load_threshold()

    bus = SMBus(1)
    adxl_init(bus)
    scorer = Scorer()

    last = 0
    slow_said = 0
    print(f"감지시작! 기준 {threshold:.2f}g, {MIN_SPEED_KMH}km/h 보다느리면 안잡음 (Ctrl+C로 끝)")
    try:
        while True:
            now = time.time()
            x, y, z = read_g(bus)
            shock = abs(math.sqrt(x * x + y * y + z * z) - 1.0)  # 크기구하고 중력1g빼고 절댓값
            score = scorer.add(now, shock)
            if score > threshold and now - last > COOLDOWN:
                kmh = speed_kmh()
                too_slow = kmh is not None and kmh < MIN_SPEED_KMH
                no_speed = kmh is None and NEED_GPS_SPEED
                if too_slow or no_speed:
                    last = now  # 무시해도 쿨다운은 걸어둠 (계속출력되는거막음)
                    if now - slow_said > 10:
                        why = f"{kmh:.0f}km/h라 느림" if too_slow else "GPS속도모름"
                        print(f"충격 {score:.2f}g 있었는데 {why} → 무시함")
                        slow_said = now
                    continue
                last = now
                handle(model, score, now, kmh)
            time.sleep(0.002)
    except KeyboardInterrupt:
        print("\n끝")


if __name__ == "__main__":
    main()
