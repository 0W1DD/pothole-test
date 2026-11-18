from smbus2 import SMBus
import requests, math, time, os
from datetime import datetime

CAM_URL = "http://10.194.36.252:8080/shot.jpg"
THRESHOLD = 0.6   # 평소(1g)보다 이만큼 더 튀면 감지
COOLDOWN = 300     # 한 번 찍고 몇 초 쉴지

ADDR = 0x53
bus = SMBus(1)
bus.write_byte_data(ADDR, 0x31, 0x08)
bus.write_byte_data(ADDR, 0x2D, 0x08)
os.makedirs("photos", exist_ok=True)

def to_g(lo, hi):
    v = (hi << 8) | lo
    return (v - 65536 if v > 32767 else v) * 0.0039

last_shot = 0
print("흔들림 감지 중... (Ctrl+C로 종료)")

while True:
    d = bus.read_i2c_block_data(ADDR, 0x32, 6)
    x, y, z = to_g(d[0], d[1]), to_g(d[2], d[3]), to_g(d[4], d[5])
    shock = abs(math.sqrt(x*x + y*y + z*z) - 1.0)   # 중력 빼고 남은 충격

    if shock > THRESHOLD and time.time() - last_shot > COOLDOWN:
        name = datetime.now().strftime("photos/%Y%m%d_%H%M%S.jpg")
        try:
            img = requests.get(CAM_URL, timeout=3)
            with open(name, "wb") as f:
                f.write(img.content)
            print(f"충격 {shock:.2f}g 감지! 사진 저장: {name}")
        except requests.RequestException as e:
            print("사진 실패:", e)
        last_shot = time.time()

    time.sleep(0.02)
