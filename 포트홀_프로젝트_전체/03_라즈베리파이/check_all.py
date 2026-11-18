"""
측정전 한방점검 - 전원, 센서, GPS, 카메라, 저장공간 다 확인함

실행: python3 check_all.py          (GPS 최대 60초 기다림)
      python3 check_all.py 120      (GPS 120초까지 기다림, 밖에서 처음켤때)
      python3 check_all.py 0        (GPS 기다리기 건너뜀)
끝에 OK/문제 요약 나옴. 문제있는거만 고치고 다시돌리면됨
"""
import os
import shutil
import subprocess
import sys
import time

ADXL_ADDR = 0x53
GPS_PORT = "/dev/ttyACM0"
CAM_URL = "http://10.194.36.252:8080/shot.jpg"   # 폰 IP캠 주소 (핫스팟 바뀌면 앱화면 주소로 고치기)
HERE = os.path.dirname(os.path.abspath(__file__))

results = []   # (항목, 통과여부, 한줄설명)


def ok(name, msg):
    results.append((name, True, msg))
    print(f"  ✓ {msg}")


def bad(name, msg, tip=""):
    results.append((name, False, msg + (f" → {tip}" if tip else "")))
    print(f"  ✗ {msg}" + (f"\n    → {tip}" if tip else ""))


# ===== 1. 전원 =====
def check_power():
    print("\n[1] 전원")
    try:
        out = subprocess.run(["vcgencmd", "get_throttled"], capture_output=True, text=True, timeout=5).stdout
        v = int(out.strip().split("=")[1], 16)
    except Exception as e:
        bad("전원", f"확인못함 ({e})")
        return
    if v & 0x1:
        bad("전원", f"지금 전압부족 (throttled={hex(v)})", "케이블 짧고두꺼운걸로, 5V 3A 이상 충전기/보조배터리로")
    elif v & 0x10000:
        bad("전원", f"켜진뒤로 전압부족 있었음 (throttled={hex(v)})", "지금은 괜찮지만 측정중 꺼질수있음. 케이블/배터리 확인")
    else:
        ok("전원", "전압 정상 (0x0)")
    try:
        t = subprocess.run(["vcgencmd", "measure_temp"], capture_output=True, text=True, timeout=5).stdout.strip()
        temp = float(t.split("=")[1].split("'")[0])
        (ok if temp < 75 else bad)("온도", f"CPU 온도 {temp:.0f}°C" + ("" if temp < 75 else " 너무뜨거움"))
    except Exception:
        pass


# ===== 2. 가속도센서 =====
def check_adxl():
    print("\n[2] 가속도센서 (ADXL345)")
    try:
        from smbus2 import SMBus
    except ImportError:
        bad("센서", "smbus2 없음", "python3 -m pip install smbus2 --break-system-packages")
        return
    try:
        bus = SMBus(1)
        dev = bus.read_byte_data(ADXL_ADDR, 0x00)   # ADXL345 고유번호 0xE5
    except Exception as e:
        bad("센서", f"센서 응답없음 ({e})", "선 확인 (VCC→1번 3.3V, SDA→3번, SCL→5번, GND→6번), i2cdetect -y 1 에 53 보이는지")
        return
    if dev != 0xE5:
        bad("센서", f"0x53에 뭔가있는데 ADXL345가 아님 (id={hex(dev)})")
        return
    bus.write_byte_data(ADXL_ADDR, 0x2C, 0x0C)
    bus.write_byte_data(ADXL_ADDR, 0x31, 0x0B)
    bus.write_byte_data(ADXL_ADDR, 0x2D, 0x08)
    time.sleep(0.1)

    def g(lo, hi):
        v = (hi << 8) | lo
        return (v - 65536 if v > 32767 else v) * 0.0039

    mags, n, err = [], 0, 0
    t0 = time.time()
    while time.time() - t0 < 2:          # 2초동안 읽어봄 (가만히 둔상태로)
        try:
            d = bus.read_i2c_block_data(ADXL_ADDR, 0x32, 6)
            x, y, z = g(d[0], d[1]), g(d[2], d[3]), g(d[4], d[5])
            mags.append((x * x + y * y + z * z) ** 0.5)
            n += 1
        except OSError:
            err += 1
        time.sleep(0.002)
    if not mags:
        bad("센서", "값을 못읽음", "선이 헐거운지 확인")
        return
    avg = sum(mags) / len(mags)
    spread = max(mags) - min(mags)
    rate = n / 2
    ok("센서", f"ADXL345 연결됨, 1초에 약 {rate:.0f}번 읽힘")
    if 0.85 < avg < 1.15:
        ok("센서값", f"가만히 있을때 크기 {avg:.2f}g (1g 근처면 정상)")
    else:
        bad("센서값", f"가만히 있을때 크기 {avg:.2f}g (1g 이어야함)", "센서 흔들리는중이거나 고장")
    if err:
        bad("센서선", f"2초동안 읽기실패 {err}번", "선 접촉불량. 꾹 눌러서 다시꽂고 테이프로 고정")
    print(f"    (2초간 흔들림폭 {spread:.2f}g. 책상위면 0.05g 정도가 보통)")


# ===== 3. GPS =====
def check_gps(wait):
    print("\n[3] GPS")
    if not os.path.exists(GPS_PORT):
        bad("GPS", f"{GPS_PORT} 없음", "USB GPS 꽂혀있는지 확인. 다른 USB구멍에도 꽂아보기")
        return
    try:
        import pynmea2
        import serial
    except ImportError:
        bad("GPS", "pynmea2/pyserial 없음", "python3 -m pip install pynmea2 pyserial --break-system-packages")
        return
    if wait <= 0:
        ok("GPS", "장치는 있음 (위치확인 건너뜀)")
        return
    print(f"  위치잡는거 최대 {wait}초 기다림 (밖에서, 하늘보이게). 먼저 잡히면 바로끝남")
    sats_view = sats_used = 0
    fix = False
    lat = lon = kmh = None
    got_any = False
    t0 = last = time.time()
    try:
        with serial.Serial(GPS_PORT, 9600, timeout=1) as ser:
            while time.time() - t0 < wait:
                line = ser.readline().decode("ascii", errors="ignore").strip()
                if line.startswith("$"):
                    got_any = True
                try:
                    if line[3:6] == "GSV":
                        sats_view = int(pynmea2.parse(line).num_sv_in_view or 0)
                    elif line[3:6] == "GGA":
                        m = pynmea2.parse(line)
                        sats_used = int(m.num_sats or 0)
                    elif line[3:6] == "RMC":
                        m = pynmea2.parse(line)
                        if m.status == "A":
                            fix = True
                            lat, lon = m.latitude, m.longitude
                            kmh = float(m.spd_over_grnd or 0) * 1.852
                except (pynmea2.ParseError, ValueError, AttributeError):
                    pass
                if time.time() - last >= 2:
                    last = time.time()
                    print(f"\r  {time.time() - t0:3.0f}초  보이는위성 {sats_view}개, 쓰는위성 {sats_used}개, "
                          f"{'위치잡힘!' if fix else '아직못잡음'}   ", end="", flush=True)
                if fix and sats_used >= 4:
                    break
    except Exception as e:
        bad("GPS", f"GPS 읽기 오류 ({e})", "USB 다시꽂기. 다른 프로그램(pothole_detect 등)이 쓰고있으면 끄기")
        return
    print()
    if not got_any:
        bad("GPS", "GPS에서 아무신호도 안옴", "USB 다시꽂기")
    elif fix:
        ok("GPS", f"위치잡힘 ({lat:.6f}, {lon:.6f}), 위성 {sats_used}개, 지금속도 {kmh:.1f}km/h")
        print(f"    지도확인: https://maps.google.com/?q={lat:.6f},{lon:.6f}")
    else:
        bad("GPS", f"{wait}초동안 위치 못잡음 (보이는위성 {sats_view}개)",
            "실내면 밖으로, 처음이면 5~10분 걸릴수있음. 앞유리쪽 하늘보이게 두고 python3 check_all.py 300")


# ===== 4. 카메라 =====
def check_cam():
    print("\n[4] 폰 카메라 (IP Webcam)")
    try:
        import requests
    except ImportError:
        bad("카메라", "requests 없음", "python3 -m pip install requests --break-system-packages")
        return
    try:
        r = requests.get(CAM_URL, timeout=3)
        r.raise_for_status()
        ok("카메라", f"사진 받아짐 ({len(r.content) // 1024} KB)")
    except Exception:
        bad("카메라", f"{CAM_URL} 연결안됨",
            "흔들림측정(calibrate)만 할거면 괜찮음. 쓰려면 IP Webcam 서버켜고, 앱화면 주소로 CAM_URL 고치기")


# ===== 5. 저장공간·파일 =====
def check_disk():
    print("\n[5] 저장공간 / 파일")
    free = shutil.disk_usage(HERE).free / 1e9
    mins = free * 1000 / 1.5   # calibrate 기록 1분에 약 1.5MB
    (ok if free > 1 else bad)("저장공간", f"남은공간 {free:.1f} GB (흔들림기록 약 {mins / 60:.0f}시간분)")
    if os.path.exists(os.path.join(HERE, "calibrate.py")):
        ok("파일", "calibrate.py 있음")
    else:
        bad("파일", "calibrate.py 가 이폴더에 없음", "03_라즈베리파이 폴더에 넣기")
    old = [f for f in ("calib_normal.csv", "calib_bump.csv", "calib_normal_marks.json", "threshold.json")
           if os.path.exists(os.path.join(HERE, f))]
    if old:
        print(f"    참고: 예전기록 있음 {old}")
        print("    테스트였으면 지우기: rm -f " + " ".join(old))


def main():
    wait = int(sys.argv[1]) if len(sys.argv) > 1 else 60
    print("=== 측정전 점검 ===")
    check_power()
    check_adxl()
    check_gps(wait)
    check_cam()
    check_disk()

    print("\n=== 요약 ===")
    for name, passed, msg in results:
        print(f"  {'OK  ' if passed else '문제'} {name}: {msg}")
    must = {"전원", "센서", "센서값", "센서선", "GPS"}
    probs = [n for n, p, _ in results if not p and n in must]
    if not probs:
        print("\n측정해도됨!  →  python3 calibrate.py normal")
    else:
        print(f"\n먼저 고치기: {', '.join(probs)}")


if __name__ == "__main__":
    main()
