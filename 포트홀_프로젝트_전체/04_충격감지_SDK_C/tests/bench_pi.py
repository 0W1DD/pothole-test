"""
초경량 성능테스트 - 파이에서 돌리면 발표용 비교표 만들어줌

  cd ~/pothole_project/02_sdk
  python3 tests/bench_pi.py            (전부, 약 1~2분)
  python3 tests/bench_pi.py --no-yolo  (YOLO 비교 빼고)

비교하는것
  A. 우리 SDK (C)                 - 충격감지 엔진
  B. 원래방식 (Python, float)     - 처음 만든 pothole_detect.py 계산방식 그대로
  C. 카메라AI(YOLO) 계속돌리기   - "AI로 포트홀찾기" 흔한방식 (01_pi 에 모델있으면)
재는것: 크기, 샘플하나 처리시간, 실제 400Hz로 돌릴때 CPU, 메모리
결과: 화면 + bench_result.md (PPT에 그대로 쓰기)
"""
import json
import math
import os
import platform
import resource
import subprocess
import sys
import time
from collections import deque

HERE = os.path.dirname(os.path.abspath(__file__))
SDK = os.path.dirname(HERE)
PI_DIR = os.path.join(os.path.dirname(SDK), "01_pi")
BUILD = os.path.join(SDK, "build")
LIVE_SEC = 10
N_SPEED = 200_000


def sh(cmd, **kw):
    return subprocess.run(cmd, shell=True, capture_output=True, text=True, **kw)


def human(b):
    for u in ("B", "KB", "MB", "GB"):
        if b < 1024 or u == "GB":
            return f"{b:.0f} {u}" if u == "B" else f"{b:.1f} {u}"
        b /= 1024


def dir_size(p):
    if not p or not os.path.exists(p):
        return None
    if os.path.isfile(p):
        return os.path.getsize(p)
    return sum(os.path.getsize(os.path.join(r, f)) for r, _, fs in os.walk(p) for f in fs
               if not os.path.islink(os.path.join(r, f)))


def pkg_dir(name):
    import importlib.util
    try:
        s = importlib.util.find_spec(name)
    except Exception:
        return None
    if not s or not s.origin:
        return None
    return os.path.dirname(s.origin)


# ---------- 원래방식 (pothole_detect.py 첫버전 계산 그대로) ----------
class OldScorer:
    def __init__(self, window=0.05):
        self.buf = deque()
        self.w = window

    def add(self, t, shock):
        self.buf.append((t, shock))
        while t - self.buf[0][0] > self.w:
            self.buf.popleft()
        return sum(s for _, s in self.buf) / len(self.buf)


def old_step(sc, t, x, y, z, th=0.3):
    shock = abs(math.sqrt(x * x + y * y + z * z) - 1.0)
    return sc.add(t, shock) > th


def fake(i):
    # 가짜 센서값 (g), 평소흔들림
    return 0.01 * (i % 7), 0.01 * (i % 5), 1.0 + 0.02 * ((i * 37) % 11 - 5)


def main():
    no_yolo = "--no-yolo" in sys.argv
    R = {}
    print("=== 초경량 성능테스트 ===")
    print(f"기기: {platform.machine()}, {open('/proc/device-tree/model').read().strip(chr(0)) if os.path.exists('/proc/device-tree/model') else platform.node()}")

    # ---- 빌드 ----
    print("\n[준비] SDK 빌드")
    r = sh(f"cd {SDK} && make -s && gcc -O2 -Iinclude src/pothole.c tests/bench.c -o build/bench "
           f"&& gcc -O2 -Iinclude src/pothole.c tests/bench_live.c -o build/bench_live")
    if r.returncode:
        print(r.stderr)
        sys.exit("빌드실패: sudo apt install -y build-essential")
    print("  OK")

    # ---- 1. 크기 ----
    print("\n[1] 크기")
    text = sh(f"size {BUILD}/pothole.o").stdout.split("\n")[1].split()[0]
    R["sdk_code"] = int(text)
    R["sdk_so"] = os.path.getsize(f"{BUILD}/libpothole.so")
    R["sdk_mem"] = 100
    R["torch"] = dir_size(pkg_dir("torch"))
    R["ultra"] = dir_size(pkg_dir("ultralytics"))
    R["ncnn"] = dir_size(pkg_dir("ncnn"))
    R["model_ncnn"] = dir_size(os.path.join(PI_DIR, "best_ncnn_model"))
    R["model_pt"] = dir_size(os.path.join(PI_DIR, "best.pt"))
    print(f"  SDK 코드 (이 기기용): {R['sdk_code']} B,  라이브러리파일 {human(R['sdk_so'])}")
    for k, name in (("torch", "PyTorch"), ("ultra", "ultralytics"), ("ncnn", "ncnn"),
                    ("model_ncnn", "학습모델 NCNN"), ("model_pt", "학습모델 best.pt")):
        if R[k]:
            print(f"  {name}: {human(R[k])}")

    # ---- 2. 샘플하나 처리시간 ----
    print(f"\n[2] 샘플 하나 처리시간 ({N_SPEED:,}개 평균)")
    out = sh(f"{BUILD}/bench").stdout
    R["sdk_ns"] = float(out.split("샘플당")[1].split("ns")[0])
    sc = OldScorer()
    t0 = time.perf_counter()
    for i in range(N_SPEED):
        x, y, z = fake(i)
        old_step(sc, i / 400, x, y, z)
    R["old_ns"] = (time.perf_counter() - t0) / N_SPEED * 1e9
    print(f"  SDK (C):        {R['sdk_ns']:10.1f} ns")
    print(f"  원래방식 (Py):  {R['old_ns']:10.1f} ns   → SDK가 {R['old_ns'] / R['sdk_ns']:.0f}배 빠름")

    # ---- 3. 실제 400Hz로 돌릴때 CPU, 메모리 ----
    print(f"\n[3] 실제처럼 1초에 400번, {LIVE_SEC}초 돌리기 (CPU 사용률)")
    live = json.loads(sh(f"{BUILD}/bench_live {LIVE_SEC}").stdout)
    R["sdk_cpu"], R["sdk_rss"] = live["cpu_pct"], live["maxrss_kb"]
    code = (f"import sys,time,resource;sys.path.insert(0,{HERE!r});import bench_pi as b\n"
            f"sc=b.OldScorer();n={LIVE_SEC * 400};st=time.perf_counter();c0=time.process_time()\n"
            "for i in range(n):\n"
            "    x,y,z=b.fake(i);b.old_step(sc,i/400,x,y,z)\n"
            "    nx=st+(i+1)/400;d=nx-time.perf_counter()\n"
            "    d>0 and time.sleep(d)\n"
            f"print((time.process_time()-c0)/{LIVE_SEC}*100, resource.getrusage(resource.RUSAGE_SELF).ru_maxrss)")
    o = sh(f"{sys.executable} -c \"{code}\"").stdout.split()
    R["old_cpu"], R["old_rss"] = float(o[0]), int(o[1])
    R["sdk_calc"] = R["sdk_ns"] * 400 / 1e9 * 100   # 계산만 CPU% (1초에 400번)
    R["old_calc"] = R["old_ns"] * 400 / 1e9 * 100
    print(f"  계산만:  SDK {R['sdk_calc']:.4f} %  vs  원래방식 {R['old_calc']:.3f} %")
    print("  깨어나기 포함 (400번 자고깨는 비용까지, 센서읽는 프로그램이면 누구나 드는 비용):")
    print(f"  SDK (C):        CPU {R['sdk_cpu']:.3f} %,  메모리(프로세스전체) {R['sdk_rss'] / 1024:.1f} MB")
    print(f"  원래방식 (Py):  CPU {R['old_cpu']:.2f} %,  메모리(프로세스전체) {R['old_rss'] / 1024:.1f} MB")
    print("  (CPU 1코어 기준. 프로세스 메모리는 C/Python 실행환경 포함, SDK 자체는 100 B)")

    # ---- 4. YOLO 계속돌리기 ----
    R["yolo"] = None
    model = None
    for m in ("best_ncnn_model", "best.pt"):
        if os.path.exists(os.path.join(PI_DIR, m)):
            model = m
            break
    if not no_yolo and model:
        print(f"\n[4] 카메라AI(YOLO, {model}) 사진 한장 처리 (처음 불러오는건 빼고 10장 평균)")
        ycode = (f"import os,time,resource,numpy as np;os.chdir({PI_DIR!r})\n"
                 f"from ultralytics import YOLO;m=YOLO({model!r});img=(np.random.rand(480,640,3)*255).astype('uint8')\n"
                 "m(img,verbose=False);c0=time.process_time();t0=time.perf_counter()\n"
                 "for _ in range(10): m(img,verbose=False)\n"
                 "print((time.perf_counter()-t0)/10*1000,(time.process_time()-c0)/10*1000,resource.getrusage(resource.RUSAGE_SELF).ru_maxrss)")
        yr = sh(f"{sys.executable} -c \"{ycode}\"", timeout=600)
        try:
            ms, cpu_ms, rss = yr.stdout.split()[-3:]
            R["yolo"] = dict(ms=float(ms), cpu_ms=float(cpu_ms), rss=int(rss))
            fps = 10
            R["yolo"]["cont_cpu"] = float(cpu_ms) * fps / 1000 * 100   # 1초에 10장 계속 돌릴때 (코어% 합)
            print(f"  한장 {float(ms):.0f} ms (CPU {float(cpu_ms):.0f} ms), 메모리 {int(rss) / 1024:.0f} MB")
            print(f"  → 1초에 10장 계속 돌리면 CPU 약 {R['yolo']['cont_cpu']:.0f} % (코어 여러개 합)")
            print("  → 우리방식: 평소엔 SDK만, 충격왔을때 사진 1장만 YOLO")
        except ValueError:
            print("  YOLO 실행실패 (건너뜀):", yr.stderr[-300:])
    elif not no_yolo:
        print("\n[4] 01_pi 에 학습모델 없어서 YOLO 비교 건너뜀")

    # ---- 결과표 ----
    lines = ["# 초경량 성능테스트 결과", "",
             f"측정기기: {platform.machine()} · {time.strftime('%Y-%m-%d %H:%M')}", "",
             "## 충격감지 엔진 비교", "",
             "| 항목 | 우리 SDK (C) | 원래방식 (Python) | 차이 |",
             "| --- | --- | --- | --- |",
             f"| 샘플 하나 처리시간 | {R['sdk_ns']:.0f} ns | {R['old_ns']:.0f} ns | {R['old_ns'] / R['sdk_ns']:.0f}배 빠름 |",
             f"| CPU (계산만, 1초 400번) | {R['sdk_calc']:.4f} % | {R['old_calc']:.3f} % | {R['old_calc'] / R['sdk_calc']:.0f}배 적음 |",
             f"| CPU (깨어나기 포함 실측) | {R['sdk_cpu']:.3f} % | {R['old_cpu']:.2f} % | {R['old_cpu'] / max(R['sdk_cpu'], 1e-6):.1f}배 적음 |",
             f"| 프로세스 메모리 | {R['sdk_rss'] / 1024:.1f} MB | {R['old_rss'] / 1024:.1f} MB | {R['old_rss'] / R['sdk_rss']:.0f}배 적음 |",
             f"| 엔진 자체 메모리 | 100 B | - | - |",
             f"| 엔진 코드 크기 | {R['sdk_code']} B (이 기기) / 644 B (Cortex-M0) | Python + 실행환경 필요 | - |",
             ""]
    if R["torch"] or R["ultra"]:
        lines += ["## 설치 크기 비교 (카메라AI 쪽)", "", "| 구성 | 크기 |", "| --- | --- |",
                  f"| 우리 SDK 라이브러리 | {human(R['sdk_so'])} |"]
        for k, name in (("torch", "PyTorch"), ("ultralytics", "ultralytics"), ("ncnn", "ncnn"),
                        ("model_ncnn", "학습모델 (NCNN)"), ("model_pt", "학습모델 (best.pt)")):
            kk = "ultra" if k == "ultralytics" else k
            if R.get(kk):
                lines.append(f"| {name} | {human(R[kk])} |")
        lines.append("")
    if R["yolo"]:
        y = R["yolo"]
        lines += ["## 항상 카메라AI vs 우리방식 (충격감지 → 그때만 사진 1장)", "",
                  "| 방식 | CPU | 메모리 |", "| --- | --- | --- |",
                  f"| YOLO 1초에 10장 계속 | 약 {y['cont_cpu']:.0f} % (코어 합) | {y['rss'] / 1024:.0f} MB |",
                  f"| 우리방식 평소 (SDK만) | {R['sdk_calc']:.4f} % (계산) | {R['sdk_rss'] / 1024:.1f} MB |",
                  f"| 우리방식 충격때 | 사진 1장 {y['ms']:.0f} ms | (그때만) |", ""]
    lines += ["참고: 가짜 센서값 사용, 센서 읽기(I2C) 시간은 뺌. '깨어나기 포함'은 1초에 400번 자고 깨는 비용까지 들어간 값이라 "
              "어떤 방식이든 비슷하게 드는 바닥값이 섞여있음 → 엔진 자체 비교는 '계산만' 줄을 보면됨.", ""]
    out_md = os.path.join(SDK, "bench_result.md")
    open(out_md, "w", encoding="utf-8").write("\n".join(lines))
    print("\n" + "\n".join(lines))
    print(f"저장: {out_md}")


if __name__ == "__main__":
    main()
