# pothole SDK v0.1.0

가속도센서 값을 넣으면 포트홀(도로충격)을 알려주는 초경량 라이브러리.
블랙박스, OBD 단말, 차량 앱 어디에나 넣을 수 있게 하드웨어랑 분리해서 만들었음.

## 얼마나 가벼운지

| 항목 | 값 |
|---|---|
| 코드크기 | **644 B** (ARM Cortex-M0) · 620 B (Cortex-M4) · 780 B (ARM64) · 920 B (안드로이드 ARMv7) |
| 메모리 | 감지기 하나 **100 B** (고정, malloc 없음) |
| 속도 | 샘플 하나 **55 ns** (PC 기준) → 400Hz로 돌려도 CPU **0.002%** |
| 필요한것 | C99 컴파일러랑 `stdint.h` 만. float·수학라이브러리·OS·스레드 안씀 |
| 본체 | `pothole.h` 96줄 + `pothole.c` 129줄 |

FPU 없는 칩에서도 돌아가게 **정수 계산만** 씀. 제곱근도 정수로 구함.

## 구조

```
센서(아무거나) ──x,y,z(mg)──▶ ┌──────────────┐ ──PD_EVENT──▶ 고객 앱
GPS/OBD 속도 ──km/h──────────▶ │ pothole SDK  │   (시각, 충격세기, 속도,
                              └──────────────┘    몇 ms 전 영상프레임 쓸지)
```

SDK는 판단만 함. 센서 읽기, 사진/영상 저장, 업로드는 고객 기기 쪽에서 함.

## 계산 방식

라즈베리파이 `pothole_detect.py`, 시뮬링크 모델이랑 똑같음.

1. **충격** = | √(x²+y²+z²) − 1000mg | → 센서를 어느 방향으로 붙여도 됨
2. **충격점수** = 최근 `window`개 평균 (기본 20개 = 400Hz에서 0.05초)
3. **감지** = 점수 > 기준값 이고, 마지막 감지 후 `cooldown_ms` 지났을 때 (앞바퀴·뒷바퀴 두 번 충격을 한 번으로 셈)
4. **느리면 무시** = `min_speed_kmh10` 보다 느리면 `PD_IGNORED` (주차장, 정체, 과속방지턱 앞 서행)
5. **사진 시점** = 카메라가 보는 거리 ÷ 속도 → `photo_back_ms` 만큼 전 프레임에 그 지점이 찍혀 있음
6. **자동기준 (선택)** = 평소 흔들림을 천천히 따라가서 그 몇 배를 기준으로 씀 → 차종·노면이 달라도 다시 학습 안 해도 됨

## C 에서 쓰기

```c
#include "pothole.h"

pd_config c;
pd_default_config(&c);         // 기본값
c.threshold_mg = 300;          // 차에서 학습한 값

pd_detector d;
pd_init(&d, &c);

// GPS/OBD 속도 들어올 때마다
pd_set_speed(&d, 325);         // 32.5 km/h (x10). 모르면 PD_SPEED_UNKNOWN

// 센서 샘플마다 (400Hz 권장)
pd_event ev;
if (pd_feed(&d, t_ms, x_mg, y_mg, z_mg, &ev) == PD_EVENT) {
    // ev.t_ms, ev.score_mg, ev.speed_kmh10
    // ev.photo_back_ms 전 프레임 저장 → 업로드
}
```

## Python 에서 쓰기 (라즈베리파이)

```python
import pothole
d = pothole.Detector(threshold_mg=300)
d.set_speed(kmh=32.5)
r, ev = d.feed(t_ms, x_mg, y_mg, z_mg)
if r == pothole.EVENT:
    print(ev)
```

`libpothole.so` 가 있으면 C로 돌고, 없으면 똑같이 동작하는 순수 Python 버전으로 돌아감 (결과 완전히 같음).

## 설정

| 이름 | 기본값 | 뜻 |
|---|---|---|
| `threshold_mg` | 300 | 감지 기준 (mg). 자동기준을 켜면 최소값 |
| `window` | 20 | 평균 낼 샘플 수 (1~32) |
| `cooldown_ms` | 2000 | 감지 후 쉬는 시간 |
| `min_speed_kmh10` | 100 | 이보다 느리면 무시 (10 km/h). 0이면 속도 안 봄 |
| `need_speed` | 0 | 1이면 속도 모를 때도 무시 |
| `cam_ahead_cm` | 600 | 카메라 화면 가운데가 차 앞 몇 cm 인지 |
| `auto_gain_x10` | 0 | 자동기준: 평소 흔들림의 몇 배 (30 = 3배). 0이면 끔 |

기본 기준값 300mg은 승용차를 생각한 임시값임. 실제 차에서 `calibrate.py` 로 다시 정해야 함.

## 빌드 / 테스트

```
make          # build/libpothole.a, build/libpothole.so, build/csv_demo
make test     # 테스트 (numpy 필요)
./build/csv_demo calib_bump.csv 300    # 기록한 CSV 넣어보기
```

라즈베리파이: `make` 한 다음 `python3 examples/pi_adxl.py`

## 테스트 결과

가짜 차량 주행 데이터 (센서 비스듬히 장착, 노면 진동, 방지턱·포트홀 7개, 정체 구간)

- C 버전 = Python 버전: 48,000 샘플 충격점수 전부 같음
- 원래 `pothole_detect.py` 방식(float)이랑 감지 개수 같고 시점 차이 최대 3 ms
- 센서 방향 5가지 아무렇게나 → 전부 똑같이 감지
- 앞뒤 바퀴 두 번 충격 → 한 번만 셈
- 정체 중 방지턱 → 무시, 사진 시점 6 m · 36 km/h → 600 ms
- 거친 길 (평소 흔들림 3배): 고정기준 오감지 11번 → 자동기준 1번, 감지는 4/4 그대로

## 아직 안 한 것

- 실제 차 데이터로 기준값·자동기준 배수 정하기
- 카메라 인식 (YOLO) 부분 경량화: 가장 작은 모델 → ONNX/TFLite, int8 양자화
- 안드로이드(JNI) / iOS 바인딩
