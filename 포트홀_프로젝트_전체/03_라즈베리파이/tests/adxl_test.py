from smbus2 import SMBus
import time

ADDR = 0x53
bus = SMBus(1)
bus.write_byte_data(ADDR, 0x31, 0x08)  # 측정 범위 설정
bus.write_byte_data(ADDR, 0x2D, 0x08)  # 측정 시작

def to_g(lo, hi):
    v = (hi << 8) | lo
    if v > 32767:
        v -= 65536
    return v * 0.0039

while True:
    d = bus.read_i2c_block_data(ADDR, 0x32, 6)
    x, y, z = to_g(d[0], d[1]), to_g(d[2], d[3]), to_g(d[4], d[5])
    print(f"x={x:+.2f}  y={y:+.2f}  z={z:+.2f}  (g)")
    time.sleep(0.1)
