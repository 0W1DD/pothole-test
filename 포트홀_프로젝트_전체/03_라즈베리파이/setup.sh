#!/bin/bash
# 한방설치: 전체 zip 을 파이 홈(~)에 풀고 이거 실행하면 끝
#   bash ~/포트홀_프로젝트_전체_20261118/03_라즈베리파이/setup.sh
# 하는일
#   1) 홈(~)에 같이보낸 best_ncnn_model.zip, best.pt 를 이 폴더로 옮기고 모델 풀기
#   2) 필요한 패키지 설치 (이미있으면 건너뜀)
#   3) SDK 만들기
#   4) 점검 (check_all.py, GPS 기다리기는 건너뜀)

D="$(cd "$(dirname "$0")" && pwd)"
P="$(dirname "$D")"
SDK="$P/04_충격감지_SDK_C"
echo "=== 포트홀 프로젝트 설치 ==="

# 1) 모델파일 옮기기
for f in best_ncnn_model.zip best.pt; do
  if [ -f ~/"$f" ]; then mv -f ~/"$f" "$D/" && echo "  $f → 03_라즈베리파이 로 옮김"; fi
done
cd "$D" || exit 1
if [ -f best_ncnn_model.zip ]; then
  unzip -oq best_ncnn_model.zip && echo "  학습모델 풀었음 (best_ncnn_model/)"
elif [ -f best.pt ]; then
  echo "  best_ncnn_model.zip 없음 → best.pt 로 돌게 바꿈"
  sed -i 's/^MODEL_PATH = "best_ncnn_model"/MODEL_PATH = "best.pt"/' pothole_detect.py
else
  echo "  학습모델 없음 → 일반 yolo26n 으로 돌게 바꿈 (나중에 모델보내고 setup.sh 다시실행)"
  sed -i 's/^MODEL_PATH = "best_ncnn_model"/MODEL_PATH = "yolo26n.pt"/' pothole_detect.py
fi

# 2) 패키지 (인터넷 필요, 이미있으면 금방끝남)
echo "  패키지 확인중... (처음이면 몇분걸림)"
python3 -m pip install -q smbus2 pyserial pynmea2 requests --break-system-packages 2>/dev/null \
  || echo "  ! 기본패키지 설치실패 (인터넷 확인)"
if [ -d best_ncnn_model ]; then
  python3 -m pip install -q ncnn --break-system-packages 2>/dev/null \
    || echo "  ! ncnn 설치실패 → 인터넷 확인. 안되면 pothole_detect.py 의 MODEL_PATH 를 \"best.pt\" 로"
fi

# 3) SDK
if command -v make >/dev/null && [ -d "$SDK" ]; then
  (cd "$SDK" && make -s >/dev/null 2>&1) && echo "  SDK 만들었음 (04_충격감지_SDK_C/build)" \
    || echo "  ! SDK 만들기실패 (sudo apt install -y build-essential)"
fi

# 4) 점검
echo
python3 check_all.py 0

echo
echo "=== 설치끝 ==="
echo "  폴더:        cd $D"
echo "  GPS까지점검: python3 check_all.py 120   (밖에서)"
echo "  흔들림측정:  python3 calibrate.py normal  → 방지턱마다 Enter → Ctrl+C → python3 calibrate.py result"
echo "  포트홀감지:  python3 pothole_detect.py"
