import sys
import time
import requests

SUPABASE_URL = "https://dwejbbhrjfcqcnslheas.supabase.co"
SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImR3ZWpiYmhyamZjcWNuc2xoZWFzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk1MzI3NzUsImV4cCI6MjEwNTEwODc3NX0.hi7BImksiFdYDk38er28OF-J0oliFfpcc0HxUFSSocw"

PORT = "/dev/ttyACM0"
WAIT_SECONDS = 180   # GPS가 위치를 잡을 때까지 최대 몇 초 기다릴지


def upload(lat, lon):
    data = {"lat": round(lat, 6), "lon": round(lon, 6)}
    res = requests.post(
        f"{SUPABASE_URL}/rest/v1/gps_logs",
        headers={
            "apikey": SUPABASE_KEY,
            "Content-Type": "application/json",
            "Prefer": "return=minimal",
        },
        json=data,
        timeout=10,
    )
    if res.status_code == 201:
        print("올리기 성공!", data)
    else:
        print("올리기 실패:", res.status_code, res.text)


def read_gps_once():
    import serial
    import pynmea2

    ser = serial.Serial(PORT, 9600, timeout=1)
    deadline = time.time() + WAIT_SECONDS
    print(f"GPS 위치 잡는 중... (최대 {WAIT_SECONDS}초)")

    while time.time() < deadline:
        line = ser.readline().decode("ascii", errors="ignore").strip()

        if line.startswith(("$GPGGA", "$GNGGA")):
            try:
                sats = pynmea2.parse(line).num_sats
                left = int(deadline - time.time())
                print(f"  위성 {sats or 0}개 / 남은 시간 {left}초", end="\r")
            except pynmea2.ParseError:
                pass

        if line.startswith(("$GPRMC", "$GNRMC")):
            try:
                msg = pynmea2.parse(line)
            except pynmea2.ParseError:
                continue
            if msg.status == "A":   # A = 위치 잡힘
                print()
                return msg.latitude, msg.longitude

    print()
    return None


if __name__ == "__main__":
    if len(sys.argv) == 3:
        # 직접 입력: python3 gps_once.py 35.1800 128.1000
        lat, lon = float(sys.argv[1]), float(sys.argv[2])
        print("직접 입력한 좌표로 올립니다.")
        upload(lat, lon)
    else:
        # GPS로: python3 gps_once.py
        result = read_gps_once()
        if result:
            print("위치 잡음:", result)
            upload(*result)
        else:
            print("시간 안에 GPS 위치를 못 잡았어요. 창가나 밖에서 다시 해보거나,")
            print("좌표를 직접 넣어서 올릴 수 있어요: python3 gps_once.py 위도 경도")
