/*
 * pothole SDK - 가속도센서로 포트홀(도로충격) 감지하는 초경량라이브러리
 *
 * 특징
 *   - 정수계산만씀 (float 안씀 → FPU없는칩에서도 돌아감)
 *   - malloc 안씀, 수학라이브러리 안씀, 스레드/파일/통신 안씀
 *   - 샘플하나넣을때마다 계산량 일정함 (덧셈몇번 + 정수제곱근1번)
 *   - 감지기 하나 = 구조체하나 (100바이트쯤). 여러개 만들어도됨
 *
 * 쓰는법
 *   pd_config c;  pd_default_config(&c);   // 기본값 받고 필요한거만 바꿈
 *   pd_detector d; pd_init(&d, &c);
 *   매샘플마다:  if (pd_feed(&d, 시각ms, x_mg, y_mg, z_mg, &ev) == PD_EVENT) { ... }
 *   GPS속도 들어올때마다: pd_set_speed(&d, 속도kmh x10);
 *
 * 단위
 *   가속도: mg (1g = 1000). 센서방향 상관없음 (세축크기로 계산함)
 *   시간: ms (아무기준이나 괜찮음, 늘어나기만하면됨)
 *   속도: km/h x 10 (18.5km/h → 185)
 */
#ifndef POTHOLE_H
#define POTHOLE_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define PD_VERSION        "0.1.0"
#define PD_MAX_WINDOW     32       /* 평균낼수있는 최대샘플수 */
#define PD_SPEED_UNKNOWN  0xFFFFu  /* 속도모름 */

/* pd_feed 가 돌려주는값 */
#define PD_NONE     0   /* 아무일없음 */
#define PD_EVENT    1   /* 포트홀(충격) 감지! ev 에 내용채워짐 */
#define PD_IGNORED  2   /* 충격은있었는데 너무느려서 무시함 (걷기/정차/주차) */

typedef struct {
    uint16_t threshold_mg;     /* 감지기준 (mg). 충격점수가 이거넘으면 감지. 자동기준켜면 최소값역할 */
    uint8_t  window;           /* 충격점수 평균낼 샘플수 1~32 (400Hz면 20 = 0.05초) */
    uint16_t cooldown_ms;      /* 한번감지하고 쉬는시간. 같은구멍 두번안셈 (앞바퀴뒷바퀴) */
    uint16_t min_speed_kmh10;  /* 이보다느리면 무시 (x10). 0이면 속도안봄 */
    uint8_t  need_speed;       /* 1이면 속도모를때도 무시. 0이면 속도모르면 그냥감지 */
    uint16_t cam_ahead_cm;     /* 카메라가 차앞 몇cm를 찍는지. 사진고를시점 계산용. 0이면 계산안함 */
    uint8_t  auto_gain_x10;    /* 자동기준: 평소흔들림의 몇배를 기준으로쓸지 (x10, 30=3배). 0이면 끔 */
} pd_config;

typedef struct {
    uint32_t t_ms;             /* 감지된시각 */
    uint16_t score_mg;         /* 그때 충격점수 */
    uint16_t threshold_mg;     /* 그때쓴 기준값 (자동기준이면 상황따라다름) */
    uint16_t speed_kmh10;      /* 그때속도 (모르면 PD_SPEED_UNKNOWN) */
    uint16_t photo_back_ms;    /* 이만큼 전에찍힌 사진/영상프레임을 쓰면 그지점임. 계산못하면 0 */
} pd_event;

/* 감지기 상태. 안의값은 직접 건드리지말기 */
typedef struct {
    pd_config cfg;
    uint16_t  buf[PD_MAX_WINDOW];  /* 최근충격들 */
    uint32_t  sum;                 /* buf 합 */
    uint8_t   idx, n;
    uint8_t   has_last;
    uint32_t  last_ms;             /* 마지막감지(또는무시)시각 */
    uint16_t  speed_kmh10;
    uint16_t  score_mg;            /* 지금 충격점수 */
    uint32_t  base_q8;             /* 평소흔들림 (x256), 자동기준용 */
} pd_detector;

/* 기본설정 채우기 (승용차, 400Hz 기준) */
void pd_default_config(pd_config *c);

/* 감지기 초기화. 설정은 복사해서 들고있음 */
void pd_init(pd_detector *d, const pd_config *c);

/* 속도알려주기 (GPS, OBD 등). 모르게되면 PD_SPEED_UNKNOWN */
void pd_set_speed(pd_detector *d, uint16_t speed_kmh10);

/* 샘플하나 넣기. 돌려주는값: PD_NONE / PD_EVENT / PD_IGNORED
   PD_EVENT 일때만 ev 채움 (ev 는 NULL 이어도됨) */
int pd_feed(pd_detector *d, uint32_t t_ms,
            int16_t x_mg, int16_t y_mg, int16_t z_mg, pd_event *ev);

/* 지금 충격점수 (mg) - 화면표시, 기록용 */
uint16_t pd_score(const pd_detector *d);

/* 지금쓰는 기준값 (mg) - 자동기준이면 계속바뀜 */
uint16_t pd_threshold(const pd_detector *d);

/* 바인딩용: 구조체크기 (Python 등에서 맞는지 확인) */
uint32_t pd_sizeof_detector(void);

#ifdef __cplusplus
}
#endif
#endif /* POTHOLE_H */
