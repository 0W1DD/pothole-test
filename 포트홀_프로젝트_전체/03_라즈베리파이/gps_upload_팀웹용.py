import time
import requests

# 지도용 프로젝트(mapDB)로 보내야 웹에서 보임
SUPABASE_URL = "https://dwejbbhrjfcqcnslheas.supabase.co"
SUPABASE_KEY = "sb_publishable_sX2k8azs-fszxaFBlg6tWA_TX1l8vrT"

PORT = "/dev/ttyACM0"
SEND_INTERVAL = 5          # 몇 초마다 보낼지
TEST_MODE = True           # GPS가 실제로 잡히면 False로 바꾸기

HEADERS = {
    "apikey": SUPABASE_KEY,
    "Content-Type": "application/json",
    "Prefer": "return=minimal",
}


def send(lat, lon):
    data = {"lat": round(lat, 6), "lon": round(lon, 6)}
    try:
        res = requests.post(f"{SUPABASE_URL}/rest/v1/gps_logs",
                            headers=HEADERS, json=data, timeout=5)
        print("보냄:", data, res.status_code, res.text)
    except requests.RequestException as e:
        print("전송 실패:", e)


if TEST_MODE:
    # 실내라 GPS가 안 잡힐 때: 가짜 좌표를 조금씩 움직이며 전송
    import random
    lat, lon = 35.18, 128.10
    print("테스트 모드: 가짜 좌표 전송 (Ctrl+C로 종료)")
    while True:
        lat += random.uniform(-0.0003, 0.0003)
        lon += random.uniform(-0.0003, 0.0003)
        send(lat, lon)
        time.sleep(SEND_INTERVAL)
else:
    import serial
    import pynmea2

    ser = serial.Serial(PORT, 9600, timeout=1)
    last_sent = 0
    print("GPS 모드: 위치 잡히면 전송 (Ctrl+C로 종료)")
    while True:
        line = ser.readline().decode("ascii", errors="ignore").strip()
        if not line.startswith(("$GPRMC", "$GNRMC")):
            continue
        try:
            msg = pynmea2.parse(line)
        except pynmea2.ParseError:
            continue

        if msg.status != "A":   # A = 위치 잡힘, V = 아직
            print("위치 잡는 중...")
            continue

        if time.time() - last_sent >= SEND_INTERVAL:
            send(msg.latitude, msg.longitude)
            last_sent = time.time()
