"""
SDK 테스트 (make test 또는 python3 tests/test_sdk.py)
가짜차량주행데이터 만들어서 확인함 (numpy는 테스트에만씀, SDK는 안씀)

  1) C버전이랑 순수파이썬버전 결과 완전히같은지
  2) 원래 pothole_detect.py 방식(float)이랑 감지시점 같은지
  3) 센서 비스듬히붙여도 똑같이감지하는지
  4) 앞바퀴뒷바퀴 두번쿵 → 한번만세는지 (쿨다운)
  5) 느릴때 무시하는지, 사진시점 계산맞는지
  6) 자동기준: 거친길에서 잘못감지 줄어드는지
"""
import math
import os
import sys
from collections import deque

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "python"))
os.environ.setdefault("POTHOLE_LIB", os.path.join(HERE, "..", "build", "libpothole.so"))
import pothole  # noqa: E402

FS = 400
ok_all = True


def check(name, cond, detail=""):
    global ok_all
    ok_all &= bool(cond)
    print(f"  [{'통과' if cond else '실패'}] {name}" + (f"  ({detail})" if detail else ""))


def rot_matrix(rs):
    """아무방향 회전 (센서를 비스듬히 붙인거)"""
    q = rs.normal(size=4)
    q /= np.linalg.norm(q)
    a, b, c, d = q
    return np.array([[a*a+b*b-c*c-d*d, 2*(b*c-a*d), 2*(b*d+a*c)],
                     [2*(b*c+a*d), a*a-b*b+c*c-d*d, 2*(c*d-a*b)],
                     [2*(b*d-a*c), 2*(c*d+a*b), a*a-b*b-c*c+d*d]])


def make_drive(seed=1, dur=120, road=0.06, events=None, speed_fn=None, R=None):
    """가짜 차량주행. 반환: t(초), xyz(g, N×3), 속도(km/h, N), 실제이벤트시각들
    road: 평소노면흔들림세기(g). 이벤트는 (시각, 세기g, 종류) 목록
    방지턱/포트홀 하나 = 앞바퀴쿵 + 0.15~0.3초뒤 뒷바퀴쿵 (감쇠진동)"""
    rs = np.random.default_rng(seed)
    n = int(dur * FS)
    t = np.arange(n) / FS
    # 평소노면: 차체 1~2Hz 출렁임 + 10~15Hz 바퀴진동 + 잡음
    vert = (road * 0.6 * np.sin(2*np.pi*1.3*t + rs.uniform(0, 6)) +
            road * 0.8 * np.convolve(rs.normal(size=n), np.ones(8)/8, "same") * 2.5 +
            road * 0.3 * rs.normal(size=n))
    side = 0.02 * np.sin(2*np.pi*0.1*t) + 0.01 * rs.normal(size=n)  # 커브, 가감속
    fwd = 0.03 * np.sin(2*np.pi*0.05*t) + 0.01 * rs.normal(size=n)
    truth = []
    for (te, amp, kind) in (events or []):
        for k, (dt, g) in enumerate(((0.0, 1.0), (rs.uniform(0.15, 0.3), 0.7))):  # 앞, 뒤바퀴
            i0 = int((te + dt) * FS)
            tt = np.arange(int(0.4 * FS)) / FS
            pulse = amp * g * np.exp(-tt / 0.06) * np.sin(2*np.pi*9*tt + (math.pi if kind == "hole" else 0))
            seg = slice(i0, min(n, i0 + tt.size))
            vert[seg] += pulse[:seg.stop - seg.start]
        truth.append(te)
    acc = np.stack([fwd, side, 1.0 + vert], axis=1)  # 차 기준 (z=위)
    if R is not None:
        acc = acc @ R.T  # 센서가 비스듬히 붙어있음
    acc = np.round(acc / 0.0039) * 0.0039  # ADXL345 분해능
    spd = speed_fn(t) if speed_fn else np.full(n, 40.0)
    return t, acc, spd, np.array(truth)


def run(det, t, acc, spd, speed_every=FS):
    """SDK에 넣고 (결과, 이벤트, 점수들) 반환. 속도는 1초마다 (GPS처럼)"""
    evs, ign, scores = [], [], np.zeros(len(t), dtype=np.int32)
    mg = np.round(acc * 1000).astype(int)
    for i in range(len(t)):
        if i % speed_every == 0:
            det.set_speed(None if spd is None else float(spd[i]))
        r, ev = det.feed(int(round(t[i] * 1000)), *mg[i])
        scores[i] = det.score_mg
        if r == pothole.EVENT:
            evs.append(ev)
        elif r == pothole.IGNORED:
            ign.append(t[i])
    return evs, ign, scores


def float_reference(t, acc, threshold_g, window_s=0.05, cooldown_s=2.0):
    """원래 pothole_detect.py 방식 (float, 시간기준평균)"""
    buf, out, last = deque(), [], -1e9
    for ti, (x, y, z) in zip(t, acc):
        shock = abs(math.sqrt(x*x + y*y + z*z) - 1.0)
        buf.append((ti, shock))
        while ti - buf[0][0] > window_s - 1e-9:   # 같은 개수(20개)가 되게
            buf.popleft()
        score = sum(s for _, s in buf) / len(buf)
        if score > threshold_g and ti - last > cooldown_s:
            last = ti
            out.append(ti)
    return np.array(out)


def match(det_times, truth, tol=0.6):
    hit = sum(any(abs(d - te) <= tol for d in det_times) for te in truth)
    fa = sum(not any(abs(d - te) <= tol for te in truth) for d in det_times)
    return hit, fa


print(f"pothole SDK {pothole.__version__}  (C라이브러리: {'있음' if pothole._lib else '없음'})\n")

# ---------- 기본 시나리오 ----------
# 세기: 평소주행 점수최대 약120mg, 기준300mg → 이벤트점수 350~650mg 되게 맞춤
ev_list = [(10, 1.2, "bump"), (25, 0.9, "hole"), (40, 0.8, "hole"), (55, 1.5, "bump"),
           (70, 0.85, "hole"), (85, 0.8, "hole"), (100, 1.0, "bump")]
t, acc, spd, truth = make_drive(seed=1, events=ev_list)

print("1) C vs 순수파이썬")
if pothole._lib:
    ec, _, sc = run(pothole.Detector(backend="c"), t, acc, spd)
    ep, _, sp = run(pothole.Detector(backend="python"), t, acc, spd)
    check("모든샘플 충격점수 같음", np.array_equal(sc, sp), f"{len(t)}샘플")
    check("감지결과 같음", [e.as_tuple() for e in ec] == [e.as_tuple() for e in ep], f"{len(ec)}개")
else:
    print("  (C라이브러리 없어서 건너뜀: make 먼저)")

print("2) 원래방식(float)이랑 비교")
det = pothole.Detector(threshold_mg=300, min_speed_kmh10=0)
e_sdk, _, _ = run(det, t, acc, None)
t_sdk = np.array([e.t_ms / 1000 for e in e_sdk])
t_ref = float_reference(t, acc, 0.300)
same_n = len(t_sdk) == len(t_ref)
dmax = np.max(np.abs(t_sdk - t_ref)) * 1000 if same_n and len(t_ref) else float("nan")
check("감지개수 같음", same_n, f"SDK {len(t_sdk)}개, 원래방식 {len(t_ref)}개")
check("감지시점 차이 5ms 이하", same_n and dmax <= 5, f"최대 {dmax:.1f}ms")
hit, fa = match(t_sdk, truth)
check("방지턱/포트홀 다잡음, 잘못감지없음", hit == len(truth) and fa == 0, f"{hit}/{len(truth)}개, 오감지 {fa}")

print("3) 센서 비스듬히 붙여도 같은지")
rs = np.random.default_rng(7)
all_same = True
for k in range(5):
    R = rot_matrix(rs)
    t2, acc2, spd2, _ = make_drive(seed=1, events=ev_list, R=R)
    e2, _, _ = run(pothole.Detector(), t2, acc2, spd2)
    h2, f2 = match([e.t_ms / 1000 for e in e2], truth)
    all_same &= (h2 == len(truth) and f2 == 0)
check("아무방향 5번 다 똑같이감지", all_same)

print("4) 쿨다운 (앞바퀴뒷바퀴 두번쿵)")
e4, _, _ = run(pothole.Detector(), t, acc, spd)
check("이벤트 하나당 감지 한번", len(e4) == len(truth), f"이벤트 {len(truth)}개 → 감지 {len(e4)}번")

print("5) 속도")
slow = lambda tt: np.where((tt > 50) & (tt < 62), 4.0, 40.0)   # 50~62초 정체 (55초 방지턱)
e5, ign5, _ = run(pothole.Detector(), t, acc, slow(t))
check("정체중 방지턱은 무시", len(ign5) == 1 and 54 < ign5[0] < 57 and len(e5) == len(truth) - 1,
      f"무시 {len(ign5)}번, 감지 {len(e5)}번")
e5b, _, _ = run(pothole.Detector(cam_ahead_cm=600), t, acc, np.full(len(t), 36.0))
check("사진시점: 6m, 36km/h → 600ms", all(e.photo_back_ms == 600 for e in e5b), f"{e5b[0].photo_back_ms}ms")
e5c, ign5c, _ = run(pothole.Detector(need_speed=1), t, acc, None)
check("need_speed=1 이면 속도모를때 전부무시", len(e5c) == 0 and len(ign5c) == len(truth))

print("6) 자동기준 (거친길)")
rough_ev = [(15, 1.3, "bump"), (45, 1.2, "hole"), (75, 1.4, "bump"), (105, 1.3, "hole")]
t6, acc6, spd6, truth6 = make_drive(seed=3, road=0.18, events=rough_ev)  # 평소흔들림 3배
e6f, _, _ = run(pothole.Detector(threshold_mg=300), t6, acc6, spd6)
e6a, _, _ = run(pothole.Detector(threshold_mg=300, auto_gain_x10=30), t6, acc6, spd6)
hf, ff = match([e.t_ms / 1000 for e in e6f], truth6)
ha, fa_ = match([e.t_ms / 1000 for e in e6a], truth6)
print(f"     고정기준 300mg: 감지 {hf}/{len(truth6)}, 오감지 {ff}")
print(f"     자동기준 3배: 감지 {ha}/{len(truth6)}, 오감지 {fa_}  (마지막기준 {e6a[-1].threshold_mg if e6a else '-'}mg)")
check("자동기준이 오감지 줄임", fa_ < ff and ha == len(truth6))
e6s, _, _ = run(pothole.Detector(threshold_mg=300, auto_gain_x10=30), t, acc, spd)
hs, fs_ = match([e.t_ms / 1000 for e in e6s], truth)
check("자동기준 켜도 좋은길에선 그대로잡음", hs == len(truth) and fs_ == 0, f"{hs}/{len(truth)}, 오감지 {fs_}")

print("\n결과:", "전부통과" if ok_all else "실패있음")
sys.exit(0 if ok_all else 1)
