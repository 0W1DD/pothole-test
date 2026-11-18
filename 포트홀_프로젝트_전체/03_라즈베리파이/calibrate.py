"""
자전거 충격기준값 학습 (캘리브레이션)

평소주행 자잘한흔들림이랑 방지턱충격을 직접기록해서
둘을가르는 기준값계산하고 threshold.json 에저장함
pothole_detect.py 는 실행할때 threshold.json 자동으로읽음

순서:
  1) python3 calibrate.py normal   평범한길 달리기 (방지턱피해서)
  2) python3 calibrate.py bump     방지턱 여러번넘기 (몇번넘었는지 세두기)
  3) python3 calibrate.py result   기준값계산하고 저장

기록은 Ctrl+C로끝냄. 시간정하려면 초붙이면됨: python3 calibrate.py normal 120
센서붙인위치 바꾸면 다시학습해야함

이번에바뀐거
  - GPS속도도 같이기록함 (CSV에 kmh 칸). 끝나면 평균속도알려줌
    → 매틀랩 step2 가 이속도 자동으로씀
  - 멈춰있던시간(MIN_SPEED_KMH보다느림)은 결과계산때 뺌
  - normal 기록중 방지턱 지날때 Enter 누르면: 그부분은 평소주행에서 빼고, 방지턱으로 씀
    → 정해진길 여러바퀴 돌때는 normal 하나로 쭉 기록하고 Enter만 누르면 bump 따로 안해도됨
  - GPS 위도경도도 기록함 (바퀴마다 같은위치에서 잡혔는지 나중에 보려고)
"""
import csv
import json
import math
import os
import sys
import threading
import time
from collections import deque
from datetime import datetime

from smbus2 import SMBus

ADXL_ADDR = 0x53
GPS_PORT = "/dev/ttyACM0"
WINDOW = 0.05         # 충격점수 평균시간(초). pothole_detect.py, 시뮬링크랑 같아야함
COOLDOWN = 2          # 이시간안의 충격은 방지턱하나로침 (앞바퀴뒷바퀴 두번쿵 포함)
MIN_THRESHOLD = 0.15  # 기준값이 이보다낮게나오면 이걸로올림
MIN_SPEED_KMH = 6     # 이보다느린구간은 멈춘걸로보고 결과계산때뺌 (pothole_detect.py랑같게)
MARK_BEFORE = 1.5     # normal에서 Enter 누른시점 몇초전부터 뺄지 (누르는게 늦을수있어서)
MARK_AFTER = 3.0      # Enter 누른후 몇초까지 뺄지 (뒷바퀴까지 지나가게)

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
NORMAL_CSV = os.path.join(BASE_DIR, "calib_normal.csv")
BUMP_CSV = os.path.join(BASE_DIR, "calib_bump.csv")
OUT_JSON = os.path.join(BASE_DIR, "threshold.json")
MARKS_JSON = os.path.join(BASE_DIR, "calib_normal_marks.json")  # normal에서 Enter 누른시각들


# ===== GPS속도 (없어도 기록은됨) =====
gps = {"kmh": None, "t": 0.0, "lat": None, "lon": None}


def gps_loop():
    try:
        import pynmea2
        import serial
    except ImportError:
        print("pynmea2/pyserial 없음 → 속도없이 기록함")
        return
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
                    if msg.status == "A":
                        try:
                            gps["lat"], gps["lon"] = msg.latitude, msg.longitude
                            gps["kmh"] = float(msg.spd_over_grnd) * 1.852  # 노트 → km/h
                            gps["t"] = time.time()
                        except (TypeError, ValueError):
                            pass
        except Exception:
            time.sleep(3)


def speed_kmh():
    if gps["kmh"] is None or time.time() - gps["t"] > 3:
        return None
    return gps["kmh"]


# ===== 센서 =====
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
    """최근 WINDOW초동안 충격평균 = 충격점수"""

    def __init__(self):
        self.buf = deque()

    def add(self, t, shock):
        self.buf.append((t, shock))
        while t - self.buf[0][0] > WINDOW:
            self.buf.popleft()
        return sum(s for _, s in self.buf) / len(self.buf)


# ===== 기록 =====
def record(mode, seconds):
    path = NORMAL_CSV if mode == "normal" else BUMP_CSV
    what = "평소주행 (방지턱피하기)" if mode == "normal" else "방지턱넘기 (몇번넘었는지 세기)"

    threading.Thread(target=gps_loop, daemon=True).start()
    bus = SMBus(1)
    adxl_init(bus)

    print(f"[{what}] 기록")
    for i in range(5, 0, -1):
        print(f"  {i}초뒤 시작...")
        time.sleep(1)
    print("기록중! 끝내려면 Ctrl+C" + (f" (아니면 {seconds}초뒤 자동으로끝)" if seconds else ""))

    scorer = Scorer()
    start = time.time()
    marks = []
    if mode == "normal":
        print("방지턱 지날때마다 Enter 누르기 (조수석이 눌러주기) → 평소주행이랑 방지턱 알아서 나눔")

        def mark_loop():
            for _ in sys.stdin:
                marks.append(time.time() - start)
                print(f"\n  [표시 {len(marks)}] {marks[-1]:.1f}초 → 이앞뒤는 뺌")
        threading.Thread(target=mark_loop, daemon=True).start()
    t = 0.0
    n = 0
    top = 0.0
    speeds = []
    errors = 0
    with open(path, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["t", "x", "y", "z", "score", "kmh", "lat", "lon"])
        try:
            while True:
                t = time.time() - start
                if seconds and t > seconds:
                    break
                try:
                    x, y, z = read_g(bus)
                except OSError:          # 선 흔들려서 잠깐 못읽음 → 기록 안끊고 다시시도
                    errors += 1
                    time.sleep(0.01)
                    if errors % 20 == 0:
                        try:
                            adxl_init(bus)   # 여러번 실패하면 센서 다시설정
                        except OSError:
                            pass
                        print(f"\n  ! 센서 읽기실패 {errors}번 (선 확인) - 기록은 계속함")
                    continue
                shock = abs(math.sqrt(x * x + y * y + z * z) - 1.0)  # 크기구하고 중력빼고 절댓값
                score = scorer.add(t, shock)
                kmh = speed_kmh()
                fresh = kmh is not None
                w.writerow([f"{t:.4f}", f"{x:.3f}", f"{y:.3f}", f"{z:.3f}", f"{score:.4f}",
                            "" if kmh is None else f"{kmh:.1f}",
                            f"{gps['lat']:.6f}" if fresh else "", f"{gps['lon']:.6f}" if fresh else ""])
                n += 1
                top = max(top, score)
                if n % 400 == 0:
                    f.flush()  # SSH끊겨도 그때까지 기록은남게
                    if kmh is not None:
                        speeds.append(kmh)
                    spd = f"{kmh:4.1f}km/h" if kmh is not None else "속도없음"
                    print(f"\r  {t:6.1f}초  지금 {score:.2f}g  최고 {top:.2f}g  {spd}   ",
                          end="", flush=True)
                time.sleep(0.001)
        except KeyboardInterrupt:
            pass

    if mode == "normal":
        with open(MARKS_JSON, "w") as mf:
            json.dump(marks, mf)
        print(f"\n방지턱 표시 {len(marks)}번 저장 ({os.path.basename(MARKS_JSON)})")
    if errors:
        print(f"\n센서 읽기실패 총 {errors}번 (그동안은 빠짐). 많으면 선 이음새 테이프로 고정하기")
    rate = n / t if t > 0 else 0
    print(f"\n저장: {os.path.basename(path)}  ({t:.0f}초, {n}개, 1초에 약{rate:.0f}번)")
    moving = [s for s in speeds if s >= MIN_SPEED_KMH]
    if moving:
        avg = sum(moving) / len(moving)
        print(f"평균속도 {avg:.1f}km/h = {avg / 3.6:.1f}m/s (매틀랩 step2 V_REAL 에쓰면됨, 자동으로도읽음)")
    else:
        print("GPS속도 못받음 → 매틀랩 step2 V_REAL 은 직접넣어야함")
    if mode == "normal":
        print("다음: python3 calibrate.py bump")
    else:
        print("다음: python3 calibrate.py result")


# ===== 결과계산 =====
def load(path, drop_slow=True, marks=()):
    """(시간, 점수) 목록. 속도기록있으면 느린구간(멈춘거)은 뺌
    방지턱기록은 넘을때 속도줄이는경우많아서 안뺌 (drop_slow=False)"""
    rows = []
    dropped = 0
    marked = 0
    with open(path) as f:
        for r in csv.DictReader(f):
            kmh = r.get("kmh", "")
            if drop_slow and kmh not in ("", None) and float(kmh) < MIN_SPEED_KMH:
                dropped += 1
                continue
            t = float(r["t"])
            if any(m - MARK_BEFORE <= t <= m + MARK_AFTER for m in marks):
                marked += 1
                continue
            rows.append((t, float(r["score"])))
    if dropped:
        print(f"  {os.path.basename(path)}: 느린구간 {dropped}개 뺌 ({MIN_SPEED_KMH}km/h 미만)")
    if marked:
        print(f"  {os.path.basename(path)}: Enter 표시한 방지턱 {len(marks)}곳 앞뒤 {marked}개 뺌")
    return rows


def pct(sorted_vals, p):
    i = min(len(sorted_vals) - 1, int(p / 100 * len(sorted_vals)))
    return sorted_vals[i]


def find_events(rows, n=None, min_score=0.0):
    """점수높은순으로 보면서 COOLDOWN초안에 안겹치는 봉우리만 고름"""
    picked = []
    for t, s in sorted(rows, key=lambda r: -r[1]):
        if s < min_score:
            break
        if all(abs(t - pt) > COOLDOWN for pt, _ in picked):
            picked.append((t, s))
            if n and len(picked) >= n:
                break
    return sorted(picked)


def moving_minutes(rows):
    """빠진구간 빼고 실제로달린시간(분). 0.5초넘게 끊긴데는 안셈"""
    total = 0.0
    for (t0, _), (t1, _) in zip(rows, rows[1:]):
        if t1 - t0 < 0.5:
            total += t1 - t0
    return total / 60


def result():
    if not os.path.exists(NORMAL_CSV):
        print("먼저 기록해야함: python3 calibrate.py normal")
        return

    marks = []
    if os.path.exists(MARKS_JSON) and os.path.getmtime(MARKS_JSON) >= os.path.getmtime(NORMAL_CSV) - 5:
        marks = json.load(open(MARKS_JSON))   # 이번 normal 기록의 표시만 씀
    normal = load(NORMAL_CSV, marks=marks)
    use_marks = bool(marks)   # Enter 표시있으면 그걸 방지턱으로 (예전 bump 기록보다 우선)
    if use_marks:   # 한번에 쭉 기록 + Enter 표시 → 표시한곳이 방지턱
        allrows = load(NORMAL_CSV, drop_slow=False)
        bump = [r for r in allrows if any(m - MARK_BEFORE <= r[0] <= m + MARK_AFTER for m in marks)]
    elif os.path.exists(BUMP_CSV):
        bump = load(BUMP_CSV, drop_slow=False)
    else:
        print("방지턱 기록이없음: normal 하면서 Enter 표시하거나, python3 calibrate.py bump 하기")
        return
    if len(normal) < 100 or len(bump) < 10:
        print("기록이너무짧음. 1분이상 달려서 기록해야함")
        return

    ns = sorted(s for _, s in normal)
    n99, n999, nmax = pct(ns, 99), pct(ns, 99.9), ns[-1]
    normal_min = moving_minutes(normal)

    print("\n=== 평소주행 ===")
    print(f"  달린시간 {normal_min:.1f}분")
    print(f"  보통흔들림(중간값) {pct(ns, 50):.2f}g")
    print(f"  큰편(상위1%)      {n99:.2f}g")
    print(f"  아주큰편(상위0.1%) {n999:.2f}g")
    print(f"  최고              {nmax:.2f}g")

    if use_marks:
        count = len(marks)
        print(f"\nEnter 표시 {count}번 = 방지턱 {count}번으로 계산함")
    else:
        try:
            count = int(input("\n방지턱기록때 몇번넘었음? 숫자입력: ").strip())
        except ValueError:
            print("숫자로 넣어야함")
            return

    bumps = find_events(bump, n=count)
    peaks = sorted(s for _, s in bumps)
    print("\n=== 방지턱 ===")
    for t, s in bumps:
        print(f"  {t:6.1f}초  {s:.2f}g")
    if len(bumps) < count:
        print(f"  ({count}번이라했는데 {len(bumps)}개만찾음. 방지턱사이가 {COOLDOWN}초보다 짧았을수있음)")

    bmin = peaks[0]
    if bmin > nmax:
        th = (nmax + bmin) / 2
        verdict = "깔끔하게 구별됨"
    elif bmin > n999:
        th = (n999 + bmin) / 2
        verdict = "거의구별됨. 평소주행에서 가끔 잘못잡힐수있음"
    else:
        th = n999
        verdict = ("구별어려움. 약한방지턱은 놓칠수있음\n"
                   "  → 센서 더단단히고정하거나 방지턱 조금더빠르게넘어서 다시기록해보기")
    th = max(th, MIN_THRESHOLD)

    caught = sum(1 for s in peaks if s > th)
    false_hits = len(find_events(normal, min_score=th))
    per_min = false_hits / normal_min if normal_min > 0 else 0

    print("\n=== 결과 ===")
    print(f"  {verdict}")
    print(f"  추천기준값: {th:.2f}g")
    print(f"  이기준이면 방지턱 {len(peaks)}개중 {caught}개감지,"
          f" 평소주행에서 잘못감지 {false_hits}번 (1분에 {per_min:.1f}번)")

    with open(OUT_JSON, "w") as f:
        json.dump({
            "threshold": round(th, 3),
            "window": WINDOW,
            "normal_p999": round(n999, 3),
            "normal_max": round(nmax, 3),
            "bump_peaks": [round(s, 3) for s in peaks],
            "made": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        }, f, ensure_ascii=False, indent=2)
    print("\n저장: threshold.json → pothole_detect.py 가 다음실행부터 이값씀")


def main():
    if len(sys.argv) < 2 or sys.argv[1] not in ("normal", "bump", "result"):
        print(__doc__)
        return
    mode = sys.argv[1]
    if mode == "result":
        result()
    else:
        seconds = float(sys.argv[2]) if len(sys.argv) > 2 else None
        record(mode, seconds)


if __name__ == "__main__":
    main()
