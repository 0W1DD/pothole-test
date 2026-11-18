"""실차 데이터 시뮬레이션 영상: 측정 기록을 SDK에 다시 흘려서 감지 과정을 보여줌 (1920x1080, 30fps)"""
import sys, csv, json, math, subprocess, os
sys.path.insert(0, "/home/claude/pothole-test/pi")
import pothole
import pi_blackbox_sim as sim
from PIL import Image, ImageDraw, ImageFont

W, H, FPS, SPEED = 1920, 1080, 30, 16
DATA = "/home/claude/pothole-test/pi/data/calib_normal.csv"
MARKS = json.load(open("/home/claude/pothole-test/pi/data/calib_normal_marks.json"))
THR = sim.THRESHOLD_MG / 1000
BG, INK, SUB, ACC, DARK, OK, MISS, LINE = "#F7F6F1", "#16213A", "#5A6272", "#E8772E", "#16213A", "#2F7D4F", "#B23A3A", "#DCD9CF"
FB, FR = "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc", "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc"
F = lambda s, b=True: ImageFont.truetype(FB if b else FR, s, index=1)

# ---------- 1) 데이터를 실제 SDK에 흘려서 감지 결과 만들기 ----------
rows = list(csv.DictReader(open(DATA)))
t0 = float(rows[0]["t"])
d = sim.make_detector()
near = lambda t: next((i for i, m in enumerate(MARKS, 1) if m - 8 <= t <= m + 3), None)
events, BIN = [], 0.05
series = {}
for r in rows:
    t = float(r["t"]) - t0
    k = int(t / BIN)
    sc = float(r["score"])
    if sc > series.get(k, 0): series[k] = sc
    res, ev = d.feed(int(t * 1000), pothole.g_to_mg(float(r["x"])), pothole.g_to_mg(float(r["y"])), pothole.g_to_mg(float(r["z"])))
    if res == pothole.EVENT:
        events.append((t, ev.score_mg / 1000, near(t)))
T_END = float(rows[-1]["t"]) - t0
N = int(T_END / BIN) + 1
score = [series.get(i, 0.0) for i in range(N)]
hit = sorted({b for _, _, b in events if b})
missed = [(MARKS[i - 1] + 3, i) for i in range(1, len(MARKS) + 1) if i not in hit]
n_false = sum(1 for e in events if not e[2])
print(f"주행 {T_END/60:.1f}분, 감지 {len(events)}, 방지턱 {len(hit)}/{len(MARKS)}, 놓침 {[m[1] for m in missed]}, 오감지 {n_false} ({n_false/(T_END/60):.2f}/분)")

# ---------- 2) 그리기 도구 ----------
GX0, GX1, GY0, GY1 = 90, 1190, 250, 770          # 그래프 영역
YMAX, WIN_BACK, WIN_FWD = 0.7, 34.0, 4.0
MX0, MX1, MY0, MY1 = 1290, 1840, 250, 770        # 지도 영역
lat0 = sum(p[0] for p in sim.ROUTE) / len(sim.ROUTE)
pts = [(p[1] * math.cos(math.radians(lat0)), p[0]) for p in sim.ROUTE]
xs, ys = [p[0] for p in pts], [p[1] for p in pts]
sc_ = min((MX1 - MX0 - 30) / (max(xs) - min(xs)), (MY1 - MY0 - 120) / (max(ys) - min(ys)))
cx, cy = (max(xs) + min(xs)) / 2, (max(ys) + min(ys)) / 2
def mp(lat, lon):
    return ((MX0 + MX1) / 2 + (lon * math.cos(math.radians(lat0)) - cx) * sc_, (MY0 + MY1) / 2 - (lat - cy) * sc_)
route_xy = [mp(*p) for p in sim.ROUTE]

def rr(dr, box, r, fill=None, outline=None, width=1):
    dr.rounded_rectangle(box, r, fill=fill, outline=outline, width=width)

def base_frame():
    im = Image.new("RGB", (W, H), BG); dr = ImageDraw.Draw(im)
    dr.text((90, 70), "실차 주행 데이터 재생", font=F(58), fill=INK)
    dr.text((92, 150), "교내 방지턱 코스 기록을 우리 C SDK에 그대로 다시 흘린 결과", font=F(30, False), fill=SUB)
    rr(dr, (GX0 - 30, GY0 - 40, GX1 + 30, GY1 + 50), 24, fill="#FFFFFF", outline=LINE, width=2)
    for g in (0.2, 0.4, 0.6):
        y = GY1 - g / YMAX * (GY1 - GY0)
        dr.line((GX0, y, GX1, y), fill="#ECEAE2", width=2)
        dr.text((GX0 + 6, y - 30), f"{g:.1f}g", font=F(22, False), fill="#9AA0AE")
    yt = GY1 - THR / YMAX * (GY1 - GY0)
    for x in range(GX0, GX1, 26): dr.line((x, yt, x + 14, yt), fill=ACC, width=4)
    rr(dr, (MX0 - 30, MY0 - 40, MX1 + 30, MY1 + 50), 24, fill=DARK)
    dr.text((MX0, MY0 - 20), "주행 경로", font=F(30), fill="#F7F6F1")
    dr.text((MX0, MY1 + 4), "위치는 경로 기준 추정 (이 기록엔 GPS 없음)", font=F(22, False), fill="#9AA6BD")
    dr.line(route_xy, fill="#3A4766", width=10, joint="curve")
    return im
BASE = base_frame()

def tx(tt, t): return GX0 + (tt - (t - WIN_BACK)) / (WIN_BACK + WIN_FWD) * (GX1 - GX0)
def gy(v): return GY1 - min(v, YMAX) / YMAX * (GY1 - GY0)

def frame(t):
    im = BASE.copy(); dr = ImageDraw.Draw(im)
    # 그래프
    i0, i1 = max(0, int((t - WIN_BACK) / BIN)), min(N - 1, int(t / BIN))
    poly = [(tx(i * BIN, t), gy(score[i])) for i in range(i0, i1 + 1)]
    if len(poly) > 1:
        dr.polygon([(poly[0][0], GY1)] + poly + [(poly[-1][0], GY1)], fill="#DDE3F2")
        dr.line(poly, fill=INK, width=3)
    xn = tx(t, t)
    dr.line((xn, GY0 - 10, xn, GY1), fill="#9AA0AE", width=2)
    done = [e for e in events if e[0] <= t]
    yt = gy(THR); lab = f"감지 기준 {THR:.2f}g"; w = dr.textlength(lab, font=F(26))
    rr(dr, (GX0 + 84, yt - 46, GX0 + 104 + w, yt - 8), 10, fill="#FFFFFF", outline=ACC, width=2)
    dr.text((GX0 + 94, yt - 46), lab, font=F(26), fill=ACC)
    seen = set()
    for j, (te, s, b) in enumerate(done):
        if te < t - WIN_BACK:
            seen.add(b); continue
        x, y = tx(te, t), gy(s)
        col = OK if b else "#9A7B4F"
        dr.line((x, y, x, GY1), fill=col, width=3)
        dr.ellipse((x - 11, y - 11, x + 11, y + 11), fill=col, outline="#FFFFFF", width=3)
        if b and b in seen: continue
        seen.add(b)
        lab = f"방지턱 {b}번 감지" if b else "오감지 후보"
        f_ = F(24); w = dr.textlength(lab, font=f_)
        ly = max(GY0 - 28, y - 62 - (j % 2) * 40)
        lx = min(max(x - w / 2, GX0 + 4), GX1 - w - 20)
        rr(dr, (lx - 10, ly - 4, lx + w + 10, ly + 34), 10, fill=col)
        dr.text((lx, ly - 2), lab, font=f_, fill="#FFFFFF")
    for tm, i in missed:
        if t - WIN_BACK <= tm <= t:
            x = tx(tm, t); lab = f"방지턱 {i}번 놓침"; f_ = F(24); w = dr.textlength(lab, font=f_)
            dr.line((x, GY1 - 60, x, GY1), fill=MISS, width=3)
            lx = min(max(x - w / 2, GX0 + 4), GX1 - w - 20)
            rr(dr, (lx - 10, GY1 - 100, lx + w + 10, GY1 - 62), 10, fill="#FFFFFF", outline=MISS, width=3)
            dr.text((lx, GY1 - 98), lab, font=f_, fill=MISS)
    # 방금 감지 표시
    last = done[-1] if done else None
    if last and t - last[0] < 0.45 * SPEED:
        rr(dr, (GX1 - 250, GY0 - 28, GX1 + 14, GY0 + 40), 16, fill=ACC)
        dr.text((GX1 - 226, GY0 - 22), "충격 감지!", font=F(44), fill="#FFFFFF")
    # 시간
    mm = lambda s: f"{int(s)//60:02d}:{int(s)%60:02d}"
    dr.text((GX1 + 30, 78), f"{mm(t)} / {mm(T_END)}", font=F(44), fill=INK, anchor="ra")
    dr.text((GX1 + 30, 150), f"{SPEED}배속", font=F(30, False), fill=SUB, anchor="ra")
    # 지도: 지나온 길 + 핀 + 현재 위치
    trail = [mp(*sim.route_pos(tt)) for tt in [max(0, t - 60) + k * 2 for k in range(int(min(t, 60) / 2) + 1)]] + [mp(*sim.route_pos(t))]
    if len(trail) > 1: dr.line(trail, fill="#F2A365", width=10, joint="curve")
    for te, s, b in done:
        x, y = mp(*sim.route_pos(te))
        if b: dr.ellipse((x - 13, y - 13, x + 13, y + 13), fill=ACC, outline="#FFFFFF", width=3)
        else: dr.ellipse((x - 7, y - 7, x + 7, y + 7), fill="#8F98AB")
    x, y = trail[-1]
    dr.ellipse((x - 18, y - 18, x + 18, y + 18), fill="#FFFFFF"); dr.ellipse((x - 11, y - 11, x + 11, y + 11), fill="#2A6FD6")
    dr.ellipse((MX0, MY0 + 30, MX0 + 20, MY0 + 50), fill=ACC); dr.text((MX0 + 30, MY0 + 24), "방지턱 감지", font=F(22, False), fill="#C9CFDB")
    dr.ellipse((MX0 + 186, MY0 + 34, MX0 + 198, MY0 + 46), fill="#8F98AB"); dr.text((MX0 + 208, MY0 + 24), "오감지 후보", font=F(22, False), fill="#C9CFDB")
    # 숫자 타일
    nb = len({b for _, _, b in done if b}); nf = sum(1 for e in done if not e[2])
    cur = score[min(N - 1, int(t / BIN))]
    tiles = [("방지턱 감지", f"{nb} / {len(MARKS)}", OK), ("오감지 후보", f"{nf}번", "#9A7B4F"), ("지금 충격", f"{cur:.2f}g", ACC if cur >= THR else INK)]
    for k, (a, b, c) in enumerate(tiles):
        x0 = GX0 - 30 + k * 390
        rr(dr, (x0, 860, x0 + 370, 1010), 22, fill="#FFFFFF", outline=LINE, width=2)
        dr.text((x0 + 28, 876), a, font=F(26, False), fill=SUB); dr.text((x0 + 28, 912), b, font=F(64), fill=c)
    rr(dr, (MX0 - 30, 860, MX1 + 30, 1010), 22, fill="#ECEAE2")
    dr.text((MX0, 880), "오감지 후보는 다음 단계에서", font=F(26, False), fill=SUB)
    dr.text((MX0, 922), "사진(YOLO) 확인으로 거름", font=F(36), fill=INK)
    return im

def card(lines, fade=1.0, dark=True):
    im = Image.new("RGB", (W, H), DARK if dark else BG); dr = ImageDraw.Draw(im)
    for (y, text, size, bold, col) in lines:
        dr.text((W / 2, y), text, font=F(size, bold), fill=col, anchor="mm")
    if fade < 1: im = Image.blend(Image.new("RGB", (W, H), DARK if dark else BG), im, max(0, fade))
    return im

INTRO = [(400, "실차 데이터로 본 충격 감지", 96, True, "#F7F6F1"),
         (520, f"교내 방지턱 코스 {T_END/60:.1f}분 주행 기록 · 센서 1초 512번 측정", 40, False, "#C9CFDB"),
         (620, "측정 기록을 우리 C SDK에 그대로 다시 흘려서 감지 과정을 재생합니다", 36, False, "#F2A365")]
OUTRO = [(250, "재생 결과", 44, True, "#F2A365"),
         (420, f"방지턱 {len(MARKS)}개 중 {len(hit)}개 감지", 110, True, "#F7F6F1"),
         (560, f"놓친 {len(missed)}개는 기준 {THR:.2f}g에 못 미친 낮은 턱", 40, False, "#C9CFDB"),
         (700, f"방지턱이 아닌 감지 {n_false}번 (1분에 {n_false/(T_END/60):.2f}번)", 52, True, "#F7F6F1"),
         (790, "→ 사진(YOLO) 확인 단계에서 걸러낼 대상", 40, False, "#F2A365")]

def encode(name, frames):
    tmp = name.replace(".mp4", ".tmp.mp4")
    p = subprocess.Popen(["ffmpeg", "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}", "-r", str(FPS), "-i", "-",
                          "-c:v", "libx264", "-crf", "18", "-preset", "veryfast", "-pix_fmt", "yuv420p", tmp], stdin=subprocess.PIPE)
    for im in frames: p.stdin.write(im.tobytes())
    p.stdin.close()
    if p.wait() == 0: os.replace(tmp, name)

if __name__ == "__main__":
    if sys.argv[1:] == ["test"]:
        for t in (150, 345, 484, 600): frame(t).save(f"test_{t}.png")
        card(INTRO).save("test_intro.png"); card(OUTRO).save("test_outro.png")
    else:
        n1, n3 = int(3.5 * FPS), int(6.5 * FPS)
        encode("s1.mp4", (card(INTRO, min(1, i / 12, (n1 - i) / 10)) for i in range(n1)))
        n2 = int(T_END / SPEED * FPS)
        encode("s2.mp4", (frame(i / FPS * SPEED) for i in range(n2)))
        encode("s3.mp4", (card(OUTRO, min(1, i / 12)) for i in range(n3)))
        open("list.txt", "w").write("file s1.mp4\nfile s2.mp4\nfile s3.mp4\n")
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "concat", "-i", "list.txt", "-c", "copy", "out.mp4"], check=True)
