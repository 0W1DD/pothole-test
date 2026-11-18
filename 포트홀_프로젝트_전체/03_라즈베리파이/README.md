# 라즈베리파이 코드

파이에서 쓰는 법:
1. 이 zip 전체를 파이 홈(~)에 풀기
2. `bash ~/포트홀_프로젝트_전체_20261118/03_라즈베리파이/setup.sh` (패키지·SDK 빌드·점검)
3. `server.json` 만들기 (Supabase 주소 + 공개 키, 코드_설명.md 참고)
4. 측정 순서는 상위 폴더 `앞으로_측정_방법.md`

실차 기록 재생 예시:
```
cd ~/포트홀_프로젝트_전체_20261118/03_라즈베리파이
python3 pi_blackbox_sim.py replay ../07_실차측정데이터/calib_normal.csv --dry
```

## 파일 설명
| 파일 | 하는 일 |
|---|---|
| `pothole_detect.py` | 충격 감지 → 사진 → YOLO 확인 → (포트홀이면) Supabase 업로드 |
| `uploader.py` | Supabase 업로드 (A형: 파이 → 서버 바로). 공개용 publishable 키만 씀 |
| `calibrate.py` | 실차 캘리브레이션 (`normal` 측정, `result` 결과). MARK_BEFORE 8초 |
| `check_all.py` | 센서·GPS·카메라·전원 한번에 점검 |
| `tidy_pi.py` | 파이 폴더 정리 |
| `pi_blackbox_sim.py`, `pothole.py` | 블랙박스 시뮬 (A형/B형, replay) |
| `b_test.sh` | B형 자동 테스트 |
| `hotspot_demo.sh` | 시연용 PotholeCam 와이파이 3분 켜기 |
| `setup.sh` | 한방 설치 |
| `best.pt`, `best_ncnn_model/` | 직접 학습한 YOLO26n 모델 |
| `tests/adxl_test.py` | ADXL345 센서 단품 테스트 |
| `tests/gps_once.py` | GPS 한번 읽어서 gps_logs에 올리기 |
| `tests/shake_photo.py` | 흔들면 사진 찍기 |

측정 데이터(calib_normal.csv, threshold.json 등)는 `../07_실차측정데이터/`에 있음.
`server.json`(서버 주소·키), 사진 폴더, 로그는 올리지 않음.
