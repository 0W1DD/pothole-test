#!/bin/bash
# 실차 기록 결과 보기:  bash drive_result.sh            (제일 최근 기록)
#                       bash drive_result.sh drives/20261123_1030
# 이 폴더의 calibrate.py·threshold.json 은 안 건드림 (복사본을 기록폴더 안에서 돌림)
cd "$(dirname "$(readlink -f "$0")")"
D=${1:-$(ls -td drives/*/ 2>/dev/null | head -1)}
D=${D%/}
[ -f "$D/calib_normal.csv" ] || { echo "기록 없음: $D"; exit 1; }
echo "===== $D ====="

echo; echo "■ 1. 감지 기록 (실제로 올라간 것)"
python3 - "$D" <<'EOF'
import json, os, sys
D = sys.argv[1]
ev = json.load(open(os.path.join(D, "events.json"))) if os.path.exists(os.path.join(D, "events.json")) else []
marks = json.load(open(os.path.join(D, "calib_normal_marks.json")))
near = lambda t: next((i for i, m in enumerate(marks, 1) if m - 8 <= t <= m + 3), None)  # calibrate.py MARK_BEFORE/AFTER
POT = {"pothole", "woodlock"}
done = [e for e in ev if not e.get("skipped")]
skip = [e for e in ev if e.get("skipped")]
bump = [e for e in done if near(e["t"])]
other = [e for e in done if not near(e["t"])]
yolo_pot = lambda es: sum(1 for e in es if e.get("label") in POT)
print(f"  Enter 표시 {len(marks)}개 / 감지 {len(done)}번 (처리중이라 건너뜀 {len(skip)}번)")
print(f"  표시 근처 감지 {len(bump)}번 → 표시 {len({near(e['t']) for e in bump})}/{len(marks)}곳 잡음")
print(f"  표시 아닌데 감지(오감지 후보) {len(other)}번 → YOLO가 포트홀이라고 한것 {yolo_pot(other)}번"
      f" = AI가 {len(other) - yolo_pot(other)}번 걸러냄")
yolo_bump = lambda es: sum(1 for e in es if e.get("label") == "speed_bump")
print(f"  YOLO가 '과속방지턱'이라고 한것: 표시 근처 {yolo_bump(bump)}/{len(bump)}번, 표시 아닌곳 {yolo_bump(other)}번"
      f"  (83클래스 모델부터)")
for e in done:
    b = near(e["t"])
    print(f"   {e['t']:7.1f}초 {e['score']:.2f}g  {'표시'+str(b) if b else '      '}  YOLO {e.get('label','-')} {e.get('conf') or ''}")
EOF

echo; echo "■ 2. SDK 다시 돌려보기 (replay --dry, 서버 안 올림)"
python3 pi_blackbox_sim.py replay "$D/calib_normal.csv" --dry 2>&1 | sed -n '/판별 요약/,$p'

echo; echo "■ 3. 기준값 다시 계산 (calibrate.py result, 이 폴더에만 threshold.json)"
cp calibrate.py "$D/calibrate.py"
python3 "$D/calibrate.py" result < /dev/null 2>&1 | tail -15
