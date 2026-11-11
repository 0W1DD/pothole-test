"""
라즈베리파이 = 블랙박스 흉내 (센서·카메라 없어도 됨)
  충격 → SDK가 판단 → 사진 고르기 → 위치 붙이기 → Supabase potholes 에 올림 → 팀 웹 지도에 빨간핀

실행 (01_pi 폴더에서)
  python3 pi_blackbox_sim.py key                     Enter 칠때마다 가짜 충격 (센서 없을때)
  python3 pi_blackbox_sim.py key --serve             B형: 인터넷 없이 파이 안에 저장 + 파이 와이파이로 폰이 가져감 (폰 앱 'B형' 체크)
  python3 pi_blackbox_sim.py key --phone             충격 신호만 보내고, 사진·위치는 폰 앱이 붙여서 올림 (폰 앱에서 '라즈베리파이 센서 사용' 체크)
  python3 pi_blackbox_sim.py replay calib_normal.csv 실차로 기록한 진짜 흔들림을 다시 흘려보냄 (빨리감기 10배)
  python3 pi_blackbox_sim.py replay calib_normal.csv --x 1   실제 속도로
  python3 pi_blackbox_sim.py replay calib_normal.csv --dry  서버 안올리고 판별결과만 바로 (방지턱 맞췄는지, 오감지 몇번)
  python3 pi_blackbox_sim.py replay calib_normal.csv --only-bumps  방지턱 근처 감지만 지도에 올림 (핀 13개 이하)

처음 한번: 같은 폴더에 server.json 만들기 (깃허브에 올리지말기)
  {"url": "https://dwejbbhrjfcqcnslheas.supabase.co", "key": "sb_publishable_..."}

위치는 이 순서로 찾음
  1) USB GPS (/dev/ttyACM0) 꽂혀있으면 그거
  2) 없으면 폰 앱이 5초마다 올린 gps_logs 에서 충격시간이랑 제일 가까운거 (블랙박스엔 GPS 없고 폰이랑 시간으로 맞추는 구조 그대로)
  3) 그것도 없으면 학교 테스트좌표
사진은 이 순서로
  1) 폰 IP Webcam (CAM_URL) 되면 그거
  2) 없으면 sample_images 폴더 안 사진 아무거나 (없으면 사진없이 올림)
  찍은사진은 sim_photos 폴더에 저장. 서버엔 IMAGE_BUCKET 정해야 올림 (Storage 버킷)
"""
import glob
import json
import os
import random
import sys
import threading
import time
from datetime import datetime, timezone

import requests

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "02_sdk", "python"))
sys.path.insert(0, HERE)                          # pothole.py 를 같은폴더에 둬도 됨
import pothole  # noqa: E402  우리 SDK (C라이브러리 있으면 C, 없으면 똑같은 파이썬버전)

CAM_URL = "http://10.194.36.252:8080/shot.jpg"   # 폰 IP Webcam 주소 (안쓰면 그냥 둬도됨)
IMAGE_BUCKET = ""                                # Supabase Storage 버킷이름 (예: "pothole-images"). 비우면 사진은 파이에만 저장
TEST_LAT, TEST_LON = 36.8516, 127.1505           # GPS 아무것도 없을때 쓸 좌표 (공주대 천안캠 근처)
GPS_MATCH_SEC = 30                               # 폰 gps_logs 를 몇초 차이까지 같은시간으로 볼지
THRESHOLD_MG = 200                               # 실차 캘리브레이션 결과 0.20g

# ---------------- 서버 ----------------
try:
    CFG = json.load(open(os.path.join(HERE, "server.json"), encoding="utf-8"))
except FileNotFoundError:
    if "--serve" not in sys.argv:
        sys.exit("server.json 이 없어요. 파일 맨위 설명대로 만들어주세요.")
    CFG = {"url": "http://offline", "key": ""}      # B형은 파이가 서버에 안올리니까 없어도됨
URL, KEY = CFG["url"].rstrip("/"), CFG["key"].strip()
HDR = {"apikey": KEY, "Content-Type": "application/json"}
if KEY.startswith("eyJ"):                        # 옛날 anon 키면 Authorization 도
    HDR["Authorization"] = "Bearer " + KEY


def sb_insert(table, row):
    r = requests.post(f"{URL}/rest/v1/{table}", headers={**HDR, "Prefer": "return=minimal"}, json=row, timeout=10)
    if r.status_code >= 300:
        raise RuntimeError(f"{table} {r.status_code} {r.text[:150]}")


def sb_upload_image(path):
    if not IMAGE_BUCKET:
        return None
    name = f"sim/{os.path.basename(path)}"
    with open(path, "rb") as f:
        r = requests.post(f"{URL}/storage/v1/object/{IMAGE_BUCKET}/{name}",
                          headers={k: v for k, v in HDR.items() if k != "Content-Type"} | {"Content-Type": "image/jpeg"},
                          data=f.read(), timeout=20)
    if r.status_code >= 300:
        print(f"    사진 업로드 실패 {r.status_code} {r.text[:120]}")
        return None
    return f"{URL}/storage/v1/object/public/{IMAGE_BUCKET}/{name}"


# ---------------- 위치 ----------------
gps_now = {"lat": None, "lon": None, "t": 0}


def gps_thread():
    """USB GPS 있으면 계속 읽어둠"""
    try:
        import pynmea2
        import serial
        ser = serial.Serial("/dev/ttyACM0", 9600, timeout=1)
    except Exception:
        return
    print("  USB GPS 찾음 → GPS로 위치 붙임")
    while True:
        line = ser.readline().decode("ascii", errors="ignore").strip()
        if line[3:6] != "RMC":
            continue
        try:
            m = pynmea2.parse(line)
            if m.status == "A":
                gps_now.update(lat=m.latitude, lon=m.longitude, t=time.time())
        except Exception:
            pass


def find_location(t_event):
    if gps_now["lat"] is not None and t_event - gps_now["t"] < 5:
        return gps_now["lat"], gps_now["lon"], "USB GPS"
    try:   # 폰 앱이 올린 gps_logs 에서 충격시간이랑 제일 가까운거
        r = requests.get(f"{URL}/rest/v1/gps_logs?select=lat,lon,created_at&order=created_at.desc&limit=50",
                         headers=HDR, timeout=10)
        best = None
        for g in r.json():
            ts = datetime.fromisoformat(g["created_at"].replace("Z", "+00:00")).timestamp()
            d = abs(ts - t_event)
            if best is None or d < best[0]:
                best = (d, g["lat"], g["lon"])
        if best and best[0] <= GPS_MATCH_SEC:
            return best[1], best[2], f"폰 gps_logs (시간차 {best[0]:.0f}초)"
    except Exception as e:
        print("    gps_logs 읽기 실패:", e)
    return TEST_LAT + random.uniform(-0.002, 0.002), TEST_LON + random.uniform(-0.002, 0.002), "테스트좌표"


# ---------------- 실차 기록 위치 (그날 기록엔 GPS가 비어서 지도로 추정) ----------------
# 7공 출발 → 시계방향 한바퀴 약 1.5km. 위쪽길 방지턱 4개를 지난 Enter 시각으로 맞춤 (2026-11 확인)
ROUTE = [(36.85102, 127.148279), (36.85135, 127.148591), (36.851541, 127.148927), (36.851614, 127.149685), (36.851449, 127.150778), (36.851429, 127.15195), (36.851383, 127.152614), (36.850855, 127.152746), (36.850842, 127.153277), (36.850756, 127.155308), (36.849799, 127.155425), (36.849984, 127.154527), (36.849766, 127.153277), (36.849753, 127.151637), (36.850591, 127.151833), (36.850756, 127.150934), (36.850835, 127.149763), (36.85104, 127.148669), (36.85102, 127.148279)]
# (기록 시작부터 초, 몇바퀴째 위치(0~2)) : 방지턱 지난 시각들
ROUTE_ANCHORS = [(0, 0.0), (88, 0.0515), (101, 0.1588), (146, 0.2268), (164, 0.3041), (418, 1.0515), (430, 1.1588), (461, 1.2268), (481, 1.3041)]


def route_pos(t):
    """기록 시작부터 t초에 차가 있었던 위치 (경로따라 시간비례로 추정)"""
    import math as _m
    seg = [0.0]
    for a, b in zip(ROUTE, ROUTE[1:]):
        seg.append(seg[-1] + _m.dist(a, b))
    L = seg[-1]
    a_ = ROUTE_ANCHORS
    if t >= a_[-1][0]:
        (t1, s1), (t2, s2) = a_[4], a_[-1]
        lap = s2 + (s2 - s1) / (t2 - t1) * (t - t2)
    else:
        for (t1, s1), (t2, s2) in zip(a_, a_[1:]):
            if t1 <= t <= t2:
                lap = s1 + (s2 - s1) * (t - t1) / (t2 - t1)
                break
    s = (lap % 1.0) * L
    for i in range(len(ROUTE) - 1):
        if seg[i] <= s <= seg[i + 1]:
            f = (s - seg[i]) / (seg[i + 1] - seg[i])
            (la1, lo1), (la2, lo2) = ROUTE[i], ROUTE[i + 1]
            return la1 + (la2 - la1) * f, lo1 + (lo2 - lo1) * f
    return ROUTE[0]


# ---------------- 사진 ----------------
def take_photo(t_event):
    os.makedirs(os.path.join(HERE, "sim_photos"), exist_ok=True)
    path = os.path.join(HERE, "sim_photos", datetime.fromtimestamp(t_event).strftime("%Y%m%d_%H%M%S") + ".jpg")
    try:
        r = requests.get(CAM_URL, timeout=2)
        r.raise_for_status()
        open(path, "wb").write(r.content)
        return path, "폰카메라"
    except Exception:
        pass
    samples = glob.glob(os.path.join(HERE, "sample_images", "*.jp*g"))
    if samples:
        open(path, "wb").write(open(random.choice(samples), "rb").read())
        return path, "샘플사진"
    return None, "사진없음"


# ---------------- 감지되면 ----------------
PHONE_MODE = "--phone" in sys.argv
SERVE_MODE = "--serve" in sys.argv          # B형: 서버 대신 파이 안에 저장, 폰이 와이파이로 가져감
B_DIR = os.path.join(HERE, "b_store")
b_records = []


def b_save(ev, t_event):
    """B형: 기록을 파이 안에만 저장하고 index.json 갱신 (블랙박스 SD카드처럼)"""
    os.makedirs(os.path.join(B_DIR, "photos"), exist_ok=True)
    t_ms = int(t_event * 1000)
    rec = {"id": (b_records[-1]["id"] + 1) if b_records else 1, "t_ms": t_ms,
           "photo_ms": t_ms - int(ev.photo_back_ms), "score": round(ev.score_mg / 1000, 3),
           "speed_kmh": ev.speed_kmh, "photo": None}
    photo, _ = take_photo(t_event)                 # 파이 카메라 있으면 그 사진도 같이 (없으면 폰이 찍음)
    if photo:
        name = f"{rec['id']:05d}.jpg"
        os.replace(photo, os.path.join(B_DIR, "photos", name))
        rec["photo"] = "photos/" + name
    b_records.append(rec)
    tmp = os.path.join(B_DIR, "index.tmp")
    json.dump({"device": "pi-blackbox", "records": b_records[-200:]}, open(tmp, "w"))
    os.replace(tmp, os.path.join(B_DIR, "index.json"))
    print(f"\n★ 충격 {rec['score']:.2f}g → 파이 안에 저장 (#{rec['id']}). 폰이 와이파이로 가져갈 거예요")


def b_server(port=8080):
    """파이 와이파이에 붙은 폰이 index.json 이랑 사진을 가져가게 하는 작은 서버"""
    from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
    from functools import partial
    os.makedirs(B_DIR, exist_ok=True)
    if not os.path.exists(os.path.join(B_DIR, "index.json")):
        json.dump({"device": "pi-blackbox", "records": []}, open(os.path.join(B_DIR, "index.json"), "w"))

    class H(SimpleHTTPRequestHandler):
        def end_headers(self):
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Cache-Control", "no-store")
            super().end_headers()

        def log_message(self, *a):
            pass
    srv = ThreadingHTTPServer(("0.0.0.0", port), partial(H, directory=B_DIR))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    print(f"  B형 서버 켜짐: 폰에서 http://10.42.0.1:{port} (파이 와이파이에 붙었을 때)")


def send_shock(ev, t_event):
    """폰 앱한테 '충격 났어' 신호만 보냄 (Supabase shock_events 테이블을 우편함처럼)"""
    t_ms = int(t_event * 1000)
    row = {"t_ms": t_ms, "photo_ms": t_ms - int(ev.photo_back_ms), "score": round(ev.score_mg / 1000, 3),
           "speed_kmh": ev.speed_kmh, "source": "pi"}
    try:
        sb_insert("shock_events", row)
        print(f"\n★ 충격 {ev.score_mg/1000:.2f}g → 폰으로 신호 보냄 ✓ (사진은 {ev.photo_back_ms}ms 전 화면)")
    except Exception as e:
        print("\n★ 충격 감지, 신호 보내기 실패 ✗", e)


def on_event(ev, t_event, loc=None):
    if SERVE_MODE:
        return b_save(ev, t_event)
    if PHONE_MODE:
        return send_shock(ev, t_event)
    print(f"\n★ 충격감지! 점수 {ev.score_mg/1000:.2f}g (기준 {ev.threshold_mg/1000:.2f}g), 사진은 {ev.photo_back_ms}ms 전 프레임")
    lat, lon, src = loc if loc else find_location(t_event)
    print(f"    위치 {lat:.6f}, {lon:.6f} ← {src}")
    photo, psrc = take_photo(t_event)
    img_url = sb_upload_image(photo) if photo else None
    print(f"    사진 {psrc}" + (f" → {img_url}" if img_url else ""))
    row = {"title": "블랙박스 자동감지 (시뮬)", "status": "발견", "latitude": lat, "longitude": lon,
           "description": f"충격 {ev.score_mg/1000:.2f}g, {datetime.fromtimestamp(t_event):%Y-%m-%d %H:%M:%S}, 위치출처 {src}"}
    if img_url:
        row["image_url"] = img_url
    try:
        sb_insert("potholes", row)
        print("    potholes 업로드 ✓  → 팀 웹 지도에 빨간핀 확인!")
    except Exception as e:
        print("    potholes 업로드 ✗", e)
        if "row-level security" in str(e) or "42501" in str(e):
            print("    → Supabase SQL Editor 에서 테스트용 insert 정책 추가 필요 (README 참고)")


def make_detector():
    return pothole.Detector(threshold_mg=THRESHOLD_MG, min_speed_kmh10=0, cam_ahead_cm=600)


# ---------------- 모드1: Enter 치면 가짜 충격 ----------------
def run_key():
    d = make_detector()
    d.set_speed(kmh=30)                      # 시속 30km 가정 (사진시점 계산용)
    print("Enter 치면 방지턱/포트홀 넘은것처럼 충격 만들어서 SDK에 넣음 (끝: Ctrl+C)")
    t0 = time.time()
    while True:
        input()
        t_ms = int((time.time() - t0) * 1000)
        hit = False
        for i in range(120):                 # 400Hz × 0.3초. 평소 1g 근처 + 가운데 0.1초 동안 덜컹
            bump = 1000 if 40 <= i < 80 else 0
            z = 1000 + bump * (1 if i % 2 else -1) + random.randint(-30, 30)
            r, ev = d.feed(int(t_ms + i * 2.5), random.randint(-30, 30), random.randint(-30, 30), z)
            if r == pothole.EVENT and not hit:
                hit = True
                on_event(ev, time.time())
        if not hit:
            print("  (쿨다운 2초 안이라 무시됨. 조금 있다 다시)")


# ---------------- 모드2: 기록된 실차 데이터 다시 흘리기 ----------------
def run_replay(path, speedup, dry, only_bumps):
    """dry: 서버에 안올리고 판별결과만 / only_bumps: Enter 표시한 방지턱 근처 감지만 올림"""
    import csv
    d = make_detector()
    rows = list(csv.DictReader(open(path)))
    marks = []
    mp = os.path.join(os.path.dirname(os.path.abspath(path)), "calib_normal_marks.json")
    if os.path.exists(mp):
        marks = json.load(open(mp))
    near = lambda t: next((i for i, m in enumerate(marks, 1) if m - 8 <= t <= m + 3), None)  # Enter 늦게 눌러서 앞 8초까지
    print(f"{path} {len(rows)}줄, 방지턱표시 {len(marks)}개" + (" | 서버 안올림(dry)" if dry else ""))
    t_first = float(rows[0]["t"])
    start = time.time()
    found, hit_bumps, false_alarm = [], set(), 0
    for r in rows:
        t = float(r["t"]) - t_first
        if not dry:
            lag = t / speedup - (time.time() - start)
            if lag > 0.002:
                time.sleep(lag)
        kmh = r.get("kmh")
        d.set_speed(kmh=float(kmh) if kmh not in (None, "", "nan") else None)
        res, ev = d.feed(int(t * 1000), pothole.g_to_mg(float(r["x"])),
                         pothole.g_to_mg(float(r["y"])), pothole.g_to_mg(float(r["z"])))
        if res != pothole.EVENT:
            continue
        b = near(t)
        tag = f"방지턱 {b}번" if b else "방지턱 아님(오감지 후보)"
        print(f"  {t:6.1f}초  충격 {ev.score_mg/1000:.2f}g  → {tag}")
        found.append(t)
        if b:
            hit_bumps.add(b)
        else:
            false_alarm += 1
        if not dry and (b or not only_bumps):
            la, lo = route_pos(t)
            on_event(ev, time.time(), (la, lo, f"실차경로 추정 ({t:.0f}초 지점)"))
    mins = (float(rows[-1]["t"]) - t_first) / 60
    print("\n===== 판별 요약 =====")
    print(f"  주행 {mins:.1f}분, 감지 {len(found)}번")
    if marks:
        miss = [i for i in range(1, len(marks) + 1) if i not in hit_bumps]
        print(f"  방지턱 {len(marks)}개 중 {len(hit_bumps)}개 감지, 놓친것 {miss}")
        print(f"  방지턱 아닌데 감지 {false_alarm}번 (1분에 {false_alarm/mins:.2f}번) → 사진(YOLO)으로 거를 대상")


if __name__ == "__main__":
    threading.Thread(target=gps_thread, daemon=True).start()
    if SERVE_MODE:
        b_server()
    mode = sys.argv[1] if len(sys.argv) > 1 else "key"
    try:
        if mode == "replay":
            x = float(sys.argv[sys.argv.index("--x") + 1]) if "--x" in sys.argv else 10.0
            run_replay(sys.argv[2], x, "--dry" in sys.argv, "--only-bumps" in sys.argv)
        else:
            run_key()
    except KeyboardInterrupt:
        print("\n종료")
