"""
예제: 라즈베리파이 + ADXL345 + USB GPS 로 SDK 돌려보기
(pothole_detect.py 의 센서판단부분을 SDK로 바꾼버전. 사진/YOLO는 뺌)

실행: python3 examples/pi_adxl.py
  - libpothole.so 있으면 C로, 없으면 순수파이썬으로 돔 (결과같음)
  - 라이브러리만들기: gcc -O2 -shared -fPIC -Iinclude src/pothole.c -o python/libpothole.so
"""
import os
import sys
import threading
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "python"))
import pothole  # noqa: E402
from smbus2 import SMBus  # noqa: E402

ADXL_ADDR = 0x53
GPS_PORT = "/dev/ttyACM0"


def adxl_init(bus):
    bus.write_byte_data(ADXL_ADDR, 0x2C, 0x0C)  # 400Hz
    bus.write_byte_data(ADXL_ADDR, 0x31, 0x0B)  # ±16g, full-res
    bus.write_byte_data(ADXL_ADDR, 0x2D, 0x08)  # 측정시작


def read_mg(bus):
    d = bus.read_i2c_block_data(ADXL_ADDR, 0x32, 6)

    def conv(lo, hi):
        v = (hi << 8) | lo
        v = v - 65536 if v > 32767 else v
        return v * 39 // 10  # 3.9mg/LSB → mg (정수로)

    return conv(d[0], d[1]), conv(d[2], d[3]), conv(d[4], d[5])


def gps_loop(det):
    """GPS속도 들어오면 SDK에 알려줌. 없으면 그냥 속도모름으로 돔"""
    try:
        import pynmea2
        import serial
    except ImportError:
        return
    while True:
        try:
            with serial.Serial(GPS_PORT, 9600, timeout=1) as ser:
                while True:
                    line = ser.readline().decode("ascii", errors="ignore").strip()
                    if not line.startswith(("$GPRMC", "$GNRMC")):
                        continue
                    try:
                        m = pynmea2.parse(line)
                        kmh = float(m.spd_over_grnd) * 1.852 if m.status == "A" else None
                    except Exception:
                        continue
                    det.set_speed(kmh)
        except Exception:
            det.set_speed(None)
            time.sleep(3)


def main():
    det = pothole.Detector(threshold_mg=300)  # 차에서 calibrate 로 학습한값 넣기
    print(f"pothole SDK {pothole.__version__} ({det.backend}) 시작. Ctrl+C로끝")
    threading.Thread(target=gps_loop, args=(det,), daemon=True).start()

    bus = SMBus(1)
    adxl_init(bus)
    t0 = time.monotonic()
    try:
        while True:
            t_ms = int((time.monotonic() - t0) * 1000)
            r, ev = det.feed(t_ms, *read_mg(bus))
            if r == pothole.EVENT:
                print("포트홀!", ev)           # 여기서 사진고르기(ev.photo_back_ms 전), 업로드 등 하면됨
            elif r == pothole.IGNORED:
                print(f"충격 {det.score_mg}mg 있었는데 느려서무시함")
            time.sleep(0.0015)
    except KeyboardInterrupt:
        print("\n끝")


if __name__ == "__main__":
    main()
