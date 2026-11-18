"""포트홀 블랙박스 시연용 케이스 v3 (실측값 반영, 추가 부품 없이 조립)
갤럭시 S23 울트라 + 18650x2 UPS + 라즈베리파이 5 (황동 기둥 6mm) + keyes ADXL345

좌표: x = 폰 가로 (0 = 뒷면에서 봤을 때 카메라 섬 쪽 모서리, 파이 USB-C 쪽)
      y = 폰 세로 (0 = 카메라 쪽 끝, PL = 충전단자 쪽 끝)
      z = 폰 뒷면에서 바깥쪽(+)
실측(2026-11-17 줄자): 폰 166 x 약 80~81, 폰 뒷면 기준 UPS 기판 윗면 ~26.5, 파이 기판 윗면 ~32.5, 포트 꼭대기 ~46.5
센서 보드 약 28 x 21 (긴 변 양쪽에 핀: 6핀 / 4핀)
"""
import json, numpy as np, trimesh
from manifold3d import Manifold

# ---------- 치수 (mm) ----------
PW, PL, PT = 81.5, 166.0, 11.5   # 케이스 낀 폰
CLR, W, BACK = 1.0, 2.4, 2.0
LIPT, LIPW = 1.6, 3.0
DOCK_Y0, BTN_Y1 = 66.0, 92.0
BW = 3.0                         # 부품 상자 벽
H = 54.0                         # 상자 안쪽 높이 (포트 꼭대기 ~49 + 점퍼선 여유)
LID, LIP_IN, C = 2.0, 3.0, 0.25  # 뚜껑 두께, 끼움 턱 깊이, 끼움 여유
RIB = 1.5
PCB_W, PCB_L = 56.0, 85.0
UPS_H, GAP = 20.0, 6.0           # 배터리 높이, 배터리판~파이 황동 기둥
STRIP = 10.0                     # GPIO 쪽 센서·점퍼선 칸 폭
END_GAP = 3.0
SB_L, SB_W, SB_T = 28.0, 21.0, 1.6   # 센서 보드 (긴 변 세로로 세움)
SENSOR_END = 12.0                # 센서 보드를 포트 쪽 끝에서 이만큼 안쪽에

def box(x0, y0, z0, x1, y1, z1):
    return Manifold.cube([x1 - x0, y1 - y0, z1 - z0]).translate([x0, y0, z0])
def cyl(x, y, z0, h, r):
    return Manifold.cylinder(h, r, r, 40).translate([x, y, z0])

xo0, xo1 = -CLR - W, PW + CLR + W
yEnd = PL + CLR + W
zLip = -(PT + CLR) - LIPT
xi0, xi1 = xo0 + BW, xo1 - BW
yi0 = DOCK_Y0 + BW
zl0 = BACK + H
zTop = zl0 + LID

# 부품 위치
px1 = xi1 - STRIP
px0 = px1 - PCB_W
py0 = yi0 + END_GAP
pcx = (px0 + px1) / 2
zb = BACK + RIB
z_ups = zb + UPS_H + 1.6                 # UPS 기판 윗면
z_pi = z_ups + GAP + 1.6                 # 파이 기판 윗면
sx = xi1 - 3.6                           # 센서 보드 면 위치 (벽에서 3.6)
sy1 = yEnd - SENSOR_END; sy0 = sy1 - SB_W
sz0 = BACK + 4.0                         # 센서 아래 끝 (홈에 끼움)

# ---------- 1) 폰 거치부 ----------
dock = box(xo0, DOCK_Y0, zLip, xo1, yEnd, BACK)
dock -= box(-CLR, DOCK_Y0 - 1, -(PT + CLR), PW + CLR, PL + CLR, 0)
dock -= box(-CLR + LIPW, DOCK_Y0 - 1, zLip - 1, PW + CLR - LIPW, PL + CLR, 0)
dock -= box(6.0, PL - 1, zLip - 1, PW - 6.0, yEnd + 1, 0)                 # 충전단자(카메라 케이블)·S펜 쪽
dock -= box(xo0 - 1, DOCK_Y0 - 1, zLip - 1, -CLR + LIPW, BTN_Y1, 0)       # 버튼 쪽

# ---------- 2) 부품 상자 (포트 쪽 끝은 열림, 뚜껑은 위에서 끼움) ----------
body = box(xo0, DOCK_Y0, BACK - 0.01, xo1, yEnd, zl0)
body -= box(xi0, yi0, BACK, xi1, yEnd + 1, zl0 + 1)
# 배터리 받침 리브
for rx in (pcx - 13, pcx, pcx + 13):
    body += box(rx - 1.2, py0 + 2, BACK - 0.01, rx + 1.2, py0 + 76, zb)
# 스택이 옆으로 밀리지 않게 낮은 칸막이 2개
body += box(px0 - 2.2, yi0 - 0.01, BACK - 0.01, px0 - 0.6, py0 + 60, BACK + 16)
body += box(px1 + 0.6, yi0 - 0.01, BACK - 0.01, px1 + 2.2, py0 + 60, BACK + 16)
# 센서 받침: 바닥 블록에 보드 끼우는 홈 + 벽 쪽 등받이
blk = box(sx - 3.0, sy0 - 1.5, BACK - 0.01, xi1 + 0.01, sy1 + 1.5, sz0 + 3.0)
blk -= box(sx - 0.05, sy0 - 0.3, sz0, sx + SB_T + 0.35, sy1 + 0.3, sz0 + 4)
body += blk
# 파이 USB-C 전원 플러그가 나가는 창 (USB-C 쪽 벽)
usb_y = py0 + 11.2
body -= box(xo0 - 1, usb_y - 9, z_pi - 6, xi0 + 1, usb_y + 9, z_pi + 9)
# UPS 전원 버튼·LED 창 (USB-C 쪽 벽, 포트 쪽 끝 근처)
body -= box(xo0 - 1, yEnd - 34, zb + 6, xi0 + 1, yEnd - 8, z_ups - 1)
# 통풍구 (GPIO 쪽 벽, 센서 자리 피해서)
for y in np.arange(84, sy0 - 6, 9):
    body -= box(xi1 - 1, y, BACK + 12, xo1 + 1, y + 3, zl0 - 8)
# 바깥 케이블 고리 3개 (USB-C 쪽 옆면): 남는 전원선·카메라 선을 8자로 감기
hooks = Manifold()
for hy in (84.0, 120.0, 156.0):
    zc = BACK + 20
    arm = box(xo0 - 9, hy - 4, zc - 3, xo0 + 0.5, hy + 4, zc + 3)
    lip = box(xo0 - 9, hy - 4, zc - 3, xo0 - 6, hy + 4, zc + 9)
    hooks += arm + lip
main = dock + body + hooks

# ---------- 3) 뚜껑 (위에서 끼우는 방식 + 누름 기둥) ----------
lid = box(xo0, DOCK_Y0, zl0, xo1, yEnd, zTop)
ring = box(xi0 + C, yi0 + C, zl0 - LIP_IN, xi1 - C, yEnd, zl0 + 0.01)
ring -= box(xi0 + C + 1.6, yi0 + C + 1.6, zl0 - LIP_IN - 1, xi1 - C - 1.6, yEnd + 1, zl0 + 1)
lid += ring
for y in np.arange(84, 131, 8):                                     # 파이 위 통풍구
    lid -= box(px0 + 10, y, zl0 - 1, px1 - 12, y + 3, zTop + 1)
lid -= box(10, 141, zTop - 0.6, 66, 160, zTop + 1)                   # 이름표 자리
# 누름 기둥: 파이 모서리 2곳 (황동 기둥 나사머리 위) + 센서 위
for (fx, fy) in ((px0 + 3.5, py0 + 3.5), (px0 + 3.5, py0 + 61.5)):
    lid += cyl(fx, fy, z_pi + 3.0, zl0 - (z_pi + 3.0) + 0.01, 2.6)
lid += box(sx - 0.4, sy0 + 4, sz0 + SB_L + 0.3, sx + SB_T + 0.4, sy0 + 10, zl0 + 0.01)   # 센서 윗변을 살짝 누름

def to_tm(m):
    mm = m.to_mesh()
    return trimesh.Trimesh(np.array(mm.vert_properties)[:, :3], np.array(mm.tri_verts), process=True)

# ---------- 검사용 더미 부품 ----------
phone = box(0, 0, -PT, PW, PL, 0)
cells = box(pcx - 20, py0 + 1, zb, pcx + 20, py0 + 74, zb + UPS_H)
ups = box(px0, py0, zb + UPS_H, px1, py0 + PCB_L, z_ups) + box(px0 + 4, py0 + PCB_L - 9, zb + 13, px1 - 4, py0 + PCB_L + 2, zb + UPS_H)
pi = box(px0, py0, z_pi - 1.6, px1, py0 + PCB_L, z_pi)
ports = box(px1 - 18, py0 + PCB_L - 19, z_pi, px1 - 2, py0 + PCB_L + 2, z_pi + 13.5) \
      + box(px0 + 21, py0 + PCB_L - 15, z_pi, px0 + 35, py0 + PCB_L + 2.5, z_pi + 16) \
      + box(px0 + 3, py0 + PCB_L - 15, z_pi, px0 + 17, py0 + PCB_L + 2.5, z_pi + 16)
header = box(px1 - 6.1, py0 + 7, z_pi, px1 - 1, py0 + 58, z_pi + 8.5) + box(px1 - 6.1, py0 + 7, z_pi + 2.5, px1 - 1, py0 + 17, z_pi + 16.5)
plug = box(xo0 - 6, usb_y - 4.5, z_pi + 0.2, px0 + 1, usb_y + 4.5, z_pi + 3.6)
sensor = box(sx, sy0, sz0, sx + SB_T, sy1, sz0 + SB_L)
spins = box(sx - 1.3, sy1, sz0 + 6, sx + SB_T, sy1 + 8.5, sz0 + 22) + box(sx - 1.3, sy0 - 16.5, sz0 + 8, sx + SB_T, sy0, sz0 + 19)
stand = box(px0 + 1, py0 + 1, z_ups, px0 + 6, py0 + 6, z_pi - 1.6) + box(px1 - 6, py0 + PCB_L - 6, z_ups, px1 - 1, py0 + PCB_L - 1, z_pi - 1.6)
stack = cells + ups + pi + ports + header + stand

main_tm, lid_tm = to_tm(main), to_tm(lid)
print("본체", main_tm.extents.round(1), "watertight", main_tm.is_watertight, "조각", len(main_tm.split()))
print("뚜껑", lid_tm.extents.round(1), "watertight", lid_tm.is_watertight, "조각", len(lid_tm.split()))
for name, part in [("폰", phone), ("스택", stack), ("센서+핀", sensor + spins), ("뚜껑", lid), ("USB-C 플러그", plug)]:
    print(f"간섭 본체∩{name}: {(main ^ part).volume():.2f}")
for name, part in [("스택", stack), ("센서+핀", sensor + spins), ("USB-C 플러그", plug)]:
    print(f"간섭 뚜껑∩{name}: {(lid ^ part).volume():.2f}")
print(f"UPS 윗면 {z_ups:.1f} (실측 ~26.5), 파이 윗면 {z_pi:.1f} (실측 ~32.5), 포트 꼭대기 {z_pi+16:.1f}, 점퍼 꼭대기 {z_pi+16.5:.1f}, 뚜껑 아랫면 {zl0:.1f}")
print(f"전체 두께 {zTop - zLip:.1f}, 상자 바깥 {xo1-xo0+9:.1f}(고리 포함) x {yEnd-DOCK_Y0:.1f}")

p = main_tm.copy(); p.apply_translation([0, 0, -zLip]); p.export("blackbox_v3_body.stl")
q = lid_tm.copy(); q.apply_translation([0, 0, -zTop]); q.apply_transform(trimesh.transformations.rotation_matrix(np.pi, [1, 0, 0])); q.apply_translation([0, 0, -q.bounds[0][2]]); q.export("blackbox_v3_lid.stl")
cams = sum((Manifold.cylinder(1.6, r, r, 40).translate([x, y, 0]) for x, y, r in ((13, 16, 7), (13, 34, 7), (13, 52, 7), (32, 16, 5), (32, 34, 5))), Manifold())
for n, m in [("p_main", main), ("p_lid", lid), ("p_phone", phone), ("p_cams", cams), ("p_cells", cells), ("p_ups", ups), ("p_pi", pi),
             ("p_ports", ports), ("p_header", header + stand), ("p_sensor", sensor), ("p_spins", spins), ("p_plug", plug)]:
    to_tm(m).export(f"v3_{n}.stl")
json.dump({"hx": px1 - 3.5, "hy": py0 + 12, "hz": z_pi + 16.5, "sx": sx, "sy0": sy0, "sz": sz0 + 14, "px0": px0, "px1": px1, "xo0": xo0,
           "usb_y": usb_y, "z_pi": z_pi, "uay": py0 + PCB_L + 2, "uaz": zb + 16, "yend": yEnd, "hooks": [84, 120, 156], "hz0": BACK + 20,
           "thick": round(zTop - zLip, 1)}, open("v3_meta.json", "w"))
