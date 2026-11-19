"""
실차 출발 전 점검 (A형: 센서 + S23 화면영상 + YOLO + 폰 gps_logs + 업로드)
  python3 car_check.py
아무것도 올리지 않음. 확인만 하고 ✅/❌ 로 보여줌.
"""
import glob
import json
import os
import shutil
import subprocess
import time

HERE = os.path.dirname(os.path.abspath(__file__))
results = []


def check(name, fn):
    t = time.time()
    try:
        ok, msg = fn()
    except Exception as e:
        ok, msg = False, f"에러: {e}"
    results.append(ok)
    print(f"{'✅' if ok else '❌'} {name:<14} {msg}  ({time.time() - t:.1f}초)", flush=True)
    return ok


def sh(*cmd, timeout=10):
    return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout).stdout.strip()


# 1. 센서
def c_sensor():
    from smbus2 import SMBus
    bus = SMBus(1)
    bus.write_byte_data(0x53, 0x2C, 0x0C)
    bus.write_byte_data(0x53, 0x31, 0x0B)
    bus.write_byte_data(0x53, 0x2D, 0x08)
    time.sleep(0.05)
    mags = []
    for _ in range(100):
        d = bus.read_i2c_block_data(0x53, 0x32, 6)
        v = [((d[i + 1] << 8) | d[i]) for i in (0, 2, 4)]
        v = [(x - 65536 if x > 32767 else x) * 0.0039 for x in v]
        mags.append(sum(x * x for x in v) ** 0.5)
        time.sleep(0.0025)
    avg, spread = sum(mags) / len(mags), max(mags) - min(mags)
    ok = 0.85 < avg < 1.15
    return ok, f"0x53 OK, 평균 {avg:.2f}g (1g 근처면 정상), 흔들림 {spread:.2f}g" + ("" if ok else " ← 배선/고정 확인")


# 2. S23
def c_phone():
    lines = [l for l in sh("adb", "devices").splitlines()[1:] if l.strip()]
    dev = [l for l in lines if l.endswith("\tdevice")]
    if not dev:
        return False, f"adb 기기 없음 {lines or ''} → USB선(데이터용)·USB디버깅·'허용' 확인"
    wake = sh("adb", "shell", "dumpsys power | grep -m1 mWakefulness=").split("=")[-1].strip()
    b, tip = {}, []
    for l in sh("adb", "shell", "dumpsys battery").splitlines():
        if l.startswith("  ") and not l.startswith("   ") and ":" in l:
            k, v = l.strip().split(":", 1)
            b[k.strip()] = v.strip()
    level = int(b.get("level", "-1"))
    cur = int(b.get("current now", "0") or 0)   # mA, 음수면 실제로는 닳는중
    charging = b.get("status") == "2" and cur >= 0
    if b.get("status") == "2" and cur < 0:
        tip.append(f"충전표시인데 실제 {cur}mA 방전 (파이 USB 전력 부족)")
    stay = sh("adb", "shell", "settings get global stay_on_while_plugged_in")
    if level < 50:
        tip.append(f"배터리 {level}% 낮음 → 차량 충전기로 충전")
    if stay in ("", "0", "null"):
        tip.append("개발자옵션 '화면 켜진 상태로 유지' 꺼져있음")
    return level >= 30, f"{dev[0].split()[0]} 연결, 화면 {wake}, 배터리 {level}% {'충전중' if charging else '방전중'}" + \
        (f" ← {', '.join(tip)}" if tip else "")


def c_stream():
    import av
    sh("adb", "shell", "input keyevent KEYCODE_WAKEUP")
    sh("adb", "shell", "am start -a android.media.action.STILL_IMAGE_CAMERA")
    time.sleep(2.5)
    p = subprocess.Popen(["adb", "exec-out", "screenrecord", "--output-format=h264", "--size=1544x720",
                          "--time-limit=3", "-"], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    frames = list(av.open(p.stdout, format="h264").decode(video=0))
    if not frames:
        return False, "영상 0장 → 폰 화면 켜짐/잠금 해제 확인"
    img = frames[-1].to_ndarray(format="gray")
    rot = sh("adb", "shell", "dumpsys window displays | grep -m1 -o 'mDisplayRotation=ROTATION_[0-9]*'")
    land = rot.endswith(("_90", "_270"))          # 화면이 가로로 돌아가 있어야 함
    bright = float(img[:, 450:1430].mean())        # 버튼 빼고 가운데 밝기
    frames[-1].to_image().save(os.path.join(HERE, "car_check_last.jpg"))
    ok = len(frames) >= 30 and land and bright > 20
    tip = []
    if not land:
        tip.append(f"폰이 세로({rot.split('_')[-1]}) → 가로로 거치 (자동회전 켜기)")
    if bright <= 20:
        tip.append("화면 까맘(렌즈 가림/어두움)")
    return ok, f"3초에 {len(frames)}장, {img.shape[1]}x{img.shape[0]}, 밝기 {bright:.0f}" + \
        (f" ← {', '.join(tip)}" if tip else "") + " (car_check_last.jpg)"


# 3. 전원·온도·디스크
def c_power():
    th = sh("vcgencmd", "get_throttled").split("=")[-1]
    temp = float(sh("vcgencmd", "measure_temp").split("=")[-1].rstrip("'C"))
    free = shutil.disk_usage(HERE).free / 1e9
    now_bad = int(th, 16) & 0xF
    ok = now_bad == 0 and temp < 75 and free > 2
    return ok, f"throttled={th} ({'지금 정상' if now_bad == 0 else '지금 전력부족/과열!'}), {temp:.0f}°C, 남은용량 {free:.1f}GB"


# 4. 인터넷·Supabase
def cfg():
    return json.load(open(os.path.join(HERE, "server.json")))


def c_net():
    import requests
    c = cfg()
    h = {"apikey": c["key"]}
    r = requests.get(f"{c['url']}/rest/v1/potholes?select=id&limit=1", headers=h, timeout=8)
    return r.status_code == 200, f"Supabase potholes HTTP {r.status_code}" + ("" if r.status_code == 200 else " ← 핫스팟/키 확인")


def c_gps():
    import requests
    from datetime import datetime
    c = cfg()
    r = requests.get(f"{c['url']}/rest/v1/gps_logs?select=lat,lon,created_at&order=created_at.desc&limit=5",
                     headers={"apikey": c["key"]}, timeout=8).json()
    if not r:
        return False, "gps_logs 비어있음"
    ts = [datetime.fromisoformat(g["created_at"]).timestamp() for g in r]
    age = time.time() - ts[0]
    gaps = [round(a - b, 1) for a, b in zip(ts, ts[1:])]
    ok = age < 10
    return ok, f"마지막 위치 {age:.0f}초 전 ({r[0]['lat']}, {r[0]['lon']}), 간격 {gaps}" + \
        ("" if ok else " ← 폰 앱 '운행 중 위치 올리기' 켜고 '안내 시작' 눌렀는지")


# 5. YOLO
def c_yolo():
    import numpy as np
    from ultralytics import YOLO
    m = YOLO(os.path.join(HERE, "best_ncnn_model"), task="detect")
    img = np.zeros((720, 980, 3), np.uint8)
    m(img, verbose=False)
    t = time.time()
    m(img, verbose=False)
    return True, f"모델 OK, 한장 {(time.time() - t) * 1000:.0f}ms"


# 6. 겹치는 프로그램
def c_conflict():
    s = sh("tmux", "ls") if shutil.which("tmux") else ""
    busy = [x.split(":")[0] for x in s.splitlines() if x.split(":")[0] in ("aa", "m", "bbb")]
    procs = sh("pgrep", "-af", "pi_blackbox_sim|calibrate.py|pothole_detect")
    procs = [p for p in procs.splitlines() if "car_check" not in p]
    ok = not busy and not procs
    return ok, "센서 쓰는 프로그램 없음" if ok else f"이미 돌고있음 tmux{busy} {procs} ← 하나만 돌리기"


if __name__ == "__main__":
    print("=== 실차 점검 (업로드 안 함) ===", flush=True)
    check("겹침 확인", c_conflict)
    check("가속도센서", c_sensor)
    check("전원/온도", c_power)
    check("S23 연결", c_phone)
    if "\tdevice" in sh("adb", "devices"):
        check("S23 화면영상", c_stream)
    check("인터넷/서버", c_net)
    check("폰 위치", c_gps)
    check("YOLO", c_yolo)
    print("=" * 30)
    if all(results):
        print("전부 OK 🚗  출발: tmux new -d -s aa -c " + HERE + " 'python3 -u pi_blackbox_sim.py sensor 2>&1 | tee a_sensor.log; bash'")
    else:
        print(f"❌ {results.count(False)}개 확인 필요")
