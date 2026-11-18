"""포트홀 블랙박스 시연용 케이스 v2
(갤럭시 S23 울트라 + 18650x2 UPS + 라즈베리파이 5 + ADXL345)

좌표: x = 폰 가로 (0 = 뒷면에서 봤을 때 카메라/버튼 쪽 모서리)
      y = 폰 세로 (0 = 카메라 쪽 끝, PL = 충전단자 쪽 끝)
      z = 폰 뒷면에서 바깥쪽(+)
아래 숫자만 고치고 다시 실행하면 STL이 새로 나옴.
"""
import numpy as np, trimesh
from manifold3d import Manifold, Mesh

# ---------- 치수 (mm) ----------
PW, PL, PT = 81.5, 166.0, 11.5   # 케이스 낀 폰 가로/세로/두께 (카드 사진으로 추정)
CLR = 1.0                        # 폰 여유 (TPU 케이스라 넉넉히)
W = 2.4                          # 폰 거치부 벽
BACK = 2.0                       # 폰과 부품 사이 판 두께
LIPT, LIPW = 1.6, 3.0            # 화면 쪽 걸림턱 두께/폭
DOCK_Y0 = 66.0                   # 거치부 시작 (카메라 섬 아래)
BTN_Y1 = 92.0                    # 이 위치까지는 버튼 쪽 벽을 비움 (전원/볼륨 버튼)
BW = 4.0                         # 부품 상자 벽
import sys
VAR = sys.argv[1] if len(sys.argv) > 1 else 'wire'   # 'pin' = 금색 핀으로 전원, 'wire' = 띄우고 전선으로 전원
GAP = 6.0 if VAR == 'pin' else 10.0   # 배터리판 기판과 파이 사이 간격
H = 52.0 if VAR == 'pin' else 56.0    # 상자 안쪽 높이: 띄움 3 + 배터리 20 + 기판 + GAP + 파이 + 점퍼선
LID = 2.0                        # 뚜껑 두께
RIB = 1.5                        # 배터리를 바닥에서 띄우는 리브 높이
PCB_W, PCB_L = 56.0, 85.0        # 파이/UPS 기판
SIDE_GAP, END_GAP = 2.25, 4.0    # 기판 옆/카메라 쪽 여유
FENCE_T, FENCE_H = 2.0, 26.0     # 부품 칸과 센서 칸 사이 칸막이
TIE_AT = (22.0, 50.0)            # 케이블타이 위치 (기판 카메라 쪽 끝에서)
C = 0.25                         # 뚜껑 끼움 여유

def box(x0, y0, z0, x1, y1, z1):
    return Manifold.cube([x1 - x0, y1 - y0, z1 - z0]).translate([x0, y0, z0])

def hull(pts):
    h = trimesh.Trimesh(vertices=np.array(pts, float)).convex_hull
    return Manifold(Mesh(vert_properties=np.asarray(h.vertices, np.float32), tri_verts=np.asarray(h.faces, np.uint32)))

def frustum(bx0, bx1, by0, by1, bz, tx0, tx1, ty0, ty1, tz):
    return hull([[x, y, bz] for x in (bx0, bx1) for y in (by0, by1)] + [[x, y, tz] for x in (tx0, tx1) for y in (ty0, ty1)])

xo0, xo1 = -CLR - W, PW + CLR + W
yEnd = PL + CLR + W
zLip = -(PT + CLR) - LIPT
xi0, xi1 = xo0 + BW, xo1 - BW          # 상자 안쪽
yi0 = DOCK_Y0 + BW
zl0 = BACK + H                          # 뚜껑 아랫면
zTop = zl0 + LID

# ---------- 1) 폰 거치부 (아래쪽 100mm만 감쌈 → 카메라는 완전히 노출) ----------
dock = box(xo0, DOCK_Y0, zLip, xo1, yEnd, BACK)
dock -= box(-CLR, DOCK_Y0 - 1, -(PT + CLR), PW + CLR, PL + CLR, 0)                  # 폰 자리 (카메라 쪽에서 밀어 넣음)
dock -= box(-CLR + LIPW, DOCK_Y0 - 1, zLip - 1, PW + CLR - LIPW, PL + CLR, 0)       # 화면 창
dock -= box(6.0, PL - 1, zLip - 1, PW - 6.0, yEnd + 1, 0)                          # 충전단자·스피커·S펜 쪽 열기 (모서리만 걸림)
dock -= box(xo0 - 1, DOCK_Y0 - 1, zLip - 1, -CLR + LIPW, BTN_Y1, 0)                # 전원/볼륨 버튼 쪽 벽 비우기

# ---------- 2) 부품 상자 (충전단자 쪽 끝은 열림, 뚜껑은 그쪽에서 밀어 끼움) ----------
body = box(xo0, DOCK_Y0, BACK - 0.01, xo1, yEnd, zTop)
body -= box(xi0, yi0, BACK, xi1, yEnd + 1, zl0 + 0.01)
body -= frustum(xi0 - LID - C, xi1 + LID + C, yi0 - LID - C, yEnd + 5, zl0,
                xi0 - C + 1, xi1 + C - 1, yi0 - C + 1, yEnd + 5, zTop + 1)          # 뚜껑 레일(45도)

px0 = xi1 - SIDE_GAP - PCB_W            # 기판 위치 (GPIO 쪽 벽에 붙임, 반대쪽은 전원선·센서 칸)
py0 = yi0 + END_GAP
fx0 = px0 - SIDE_GAP - FENCE_T          # 칸막이
tie_y = [py0 + t for t in TIE_AT]

# 배터리 띄우는 리브 (케이블타이 지나갈 틈 포함)
pcx = px0 + PCB_W / 2
for rx in (pcx - 13, pcx, pcx + 13):
    rib = box(rx - 1.2, py0 + 2, BACK - 0.01, rx + 1.2, py0 + 76, BACK + RIB)
    for ty in tie_y:
        rib -= box(rx - 2, ty - 5, BACK, rx + 2, ty + 5, BACK + RIB + 1)
    body += rib
# 칸막이 + 케이블타이 구멍
fence = box(fx0, yi0 - 0.01, BACK - 0.01, fx0 + FENCE_T, py0 + 58, BACK + FENCE_H)
for ty in tie_y:
    fence -= box(fx0 - 1, ty - 3.5, BACK, fx0 + FENCE_T + 1, ty + 3.5, BACK + 4.5)
body += fence
# 옆면 세로 통풍구
zv0, zv1 = BACK + 10, zl0 - 10
for y in np.arange(130, 161, 9):                    # 센서 칸 쪽 벽 (센서 붙일 자리는 막아둠)
    body -= box(xo0 - 1, y, zv0, xi0 + 1, y + 3, zv1)
for y in np.arange(78, 131, 9):                     # 부품 쪽 벽
    body -= box(xi1 - 1, y, zv0, xo1 + 1, y + 3, zv1)
# UPS 전원 버튼/LED 쪽 창
body -= box(xi1 - 1, 137, BACK + 12, xo1 + 1, 161, BACK + 30)
zpi = BACK + RIB + 21.6 + GAP + 1.6
if VAR == 'wire':                                   # 파이 USB-C 전원 플러그가 벽 밖으로 나올 수 있는 창
    body -= box(xo0 - 1, py0 + 3, zpi - 7, xi0 + 1, py0 + 21, zpi + 9)

main = dock + body

# ---------- 3) 뚜껑 ----------
lid = frustum(xi0 - LID, xi1 + LID, yi0 - LID, yEnd, zl0, xi0, xi1, yi0, yEnd, zTop)
for y in np.arange(82, 127, 8):
    lid -= box(px0 + 6, y, zl0 - 1, px0 + PCB_W - 6, y + 3, zTop + 1)               # 파이 위 통풍구
lid -= box(12, 136, zTop - 0.6, 70, 156, zTop + 1)                                  # 이름표(스티커) 자리
for y in (160.5, 163.0, 165.5):
    lid += box(26, y, zTop - 0.01, 56, y + 1.2, zTop + 0.8)                         # 손잡이 돌기

def to_tm(m):
    mm = m.to_mesh()
    return trimesh.Trimesh(np.array(mm.vert_properties)[:, :3], np.array(mm.tri_verts), process=True)

# ---------- 검사용 더미 부품 ----------
zb = BACK + RIB
phone = box(0, 0, -PT, PW, PL, 0)
cells = box(pcx - 20, py0 + 1, zb, pcx + 20, py0 + 74, zb + 20)
ups_pcb = box(px0, py0, zb + 20, px0 + PCB_W, py0 + PCB_L, zb + 21.6)
ups_usb = box(px0 + 4, py0 + PCB_L - 9, zb + 13, px0 + PCB_W - 4, py0 + PCB_L + 2, zb + 20)
pi_pcb = box(px0, py0, zb + 21.6 + GAP, px0 + PCB_W, py0 + PCB_L, zb + 23.2 + GAP)
zp = zb + 23.2 + GAP
ports = box(px0 + 2, py0 + PCB_L - 19, zp, px0 + 18, py0 + PCB_L + 2, zp + 13.5) \
      + box(px0 + 21, py0 + PCB_L - 15, zp, px0 + 35, py0 + PCB_L + 2.5, zp + 16) \
      + box(px0 + 39, py0 + PCB_L - 15, zp, px0 + 53, py0 + PCB_L + 2.5, zp + 16)
header = box(px0 + PCB_W - 6.1, py0 + 7, zp, px0 + PCB_W - 1, py0 + 58, zp + 8.5)
dupont = box(px0 + PCB_W - 6.1, py0 + 7, zp + 2.5, px0 + PCB_W - 1, py0 + 15, zp + 16.5)
sensor = box(xi0 + 0.2, 100, BACK + 8, xi0 + 1.8, 122, BACK + 28)
stack = cells + ups_pcb + ups_usb + pi_pcb + ports + header + dupont

main_tm, lid_tm = to_tm(main), to_tm(lid)
print("본체 크기", main_tm.extents.round(1), "물샐틈없음", main_tm.is_watertight, "조각수", len(main_tm.split()))
print("뚜껑 크기", lid_tm.extents.round(1), "물샐틈없음", lid_tm.is_watertight, "조각수", len(lid_tm.split()))
for name, part in [("폰", phone), ("부품", stack), ("센서", sensor), ("뚜껑", lid)]:
    print(f"간섭 검사 본체∩{name}: {(main ^ part).volume():.2f} mm3")
print(f"간섭 검사 뚜껑∩부품: {(lid ^ stack).volume():.2f} mm3")
print(f"부품 맨 위(점퍼 커넥터) z={zp + 16.5:.1f}, 뚜껑 아랫면 z={zl0:.1f} → 여유 {zl0 - zp - 16.5:.1f}mm")
print(f"전체 두께(화면~뚜껑) {zTop - zLip:.1f}mm, 센서·전선 칸 폭 {fx0 - xi0:.1f}mm")

# 출력용 (본체: 화면 쪽 턱이 바닥 / 뚜껑: 넓은 면이 바닥)
p = main_tm.copy(); p.apply_translation([0, 0, -zLip]); p.export(f"blackbox_{VAR}_body.stl")
q = lid_tm.copy(); q.apply_translation([0, 0, -zl0]); q.export(f"blackbox_{VAR}_lid.stl")

# 미리보기용
cam = Manifold.cylinder(1.6, 7, 7, 40)
cams = cam.translate([13, 16, 0]) + cam.translate([13, 34, 0]) + cam.translate([13, 52, 0]) \
     + Manifold.cylinder(1.6, 5, 5, 40).translate([32, 16, 0]) + Manifold.cylinder(1.6, 5, 5, 40).translate([32, 34, 0])
for n, m in [("p_main", main), ("p_lid", lid), ("p_phone", phone), ("p_cams", cams), ("p_cells", cells),
             ("p_ups", ups_pcb + ups_usb), ("p_pi", pi_pcb), ("p_ports", ports), ("p_header", header + dupont), ("p_sensor", sensor)]:
    to_tm(m).export(f"{VAR}_{n}.stl")
import json
json.dump({"hx": px0 + PCB_W - 3.5, "hy": py0 + 11, "hz": zp + 16.5, "sx": xi0 + 2, "sy": 111, "sz": BACK + 28, "top": zl0 - 2,
           "ties": tie_y, "px0": px0, "px1": px0 + PCB_W, "fx": fx0 - 1.5, "var": VAR, "ucy": py0 + 12, "ucz": zp + 1.5, "ux": px0, "uax": px0 + 10, "uay": py0 + PCB_L + 2, "uaz": zb + 16, "x0": xo0, "thick": round(zTop - zLip, 1), "clear": round(zl0 - zp - 16.5, 1), "yend": yEnd, "zb": BACK + 1, "zt": zp + 3}, open(f"{VAR}_meta.json", "w"))
