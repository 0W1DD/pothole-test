/*
 * pothole SDK 본체. 정수만씀, malloc 없음, 라이브러리 안씀
 *
 * 계산 (pothole_detect.py, 시뮬링크모델이랑 같음)
 *   충격     = | sqrt(x²+y²+z²) - 1000mg |   센서방향 상관없이 가만히있으면0
 *   충격점수 = 최근 window개 충격의 평균
 *   감지     = 충격점수 > 기준값 이고 마지막감지후 cooldown 지났을때
 */
#include "pothole.h"

#define G_MG 1000u

/* 정수제곱근 (비트하나씩 정하는방식, 최대16번반복) */
static uint32_t isqrt32(uint32_t v)
{
    uint32_t r = 0, b = 1u << 30;
    while (b > v) b >>= 2;
    while (b) {
        if (v >= r + b) { v -= r + b; r = (r >> 1) + b; }
        else            { r >>= 1; }
        b >>= 2;
    }
    return r;
}

static uint16_t clamp16(uint32_t v) { return v > 0xFFFFu ? 0xFFFFu : (uint16_t)v; }

void pd_default_config(pd_config *c)
{
    c->threshold_mg    = 300;   /* 0.3g. 승용차는 서스펜션땜에 충격이작음 → 실제차에서 다시학습하기 */
    c->window          = 20;    /* 400Hz x 0.05초 */
    c->cooldown_ms     = 2000;
    c->min_speed_kmh10 = 100;   /* 10km/h 보다느리면 무시 (주차장, 정체) */
    c->need_speed      = 0;
    c->cam_ahead_cm    = 600;   /* 블랙박스는 앞 6m쯤이 화면가운데 */
    c->auto_gain_x10   = 0;     /* 자동기준 끔 */
}

void pd_init(pd_detector *d, const pd_config *c)
{
    uint8_t i;
    d->cfg = *c;
    if (d->cfg.window < 1) d->cfg.window = 1;
    if (d->cfg.window > PD_MAX_WINDOW) d->cfg.window = PD_MAX_WINDOW;
    for (i = 0; i < PD_MAX_WINDOW; i++) d->buf[i] = 0;
    d->sum = 0;
    d->idx = 0;
    d->n = 0;
    d->has_last = 0;
    d->last_ms = 0;
    d->speed_kmh10 = PD_SPEED_UNKNOWN;
    d->score_mg = 0;
    d->base_q8 = 0;
}

void pd_set_speed(pd_detector *d, uint16_t speed_kmh10) { d->speed_kmh10 = speed_kmh10; }

uint16_t pd_score(const pd_detector *d) { return d->score_mg; }

uint32_t pd_sizeof_detector(void) { return (uint32_t)sizeof(pd_detector); }

uint16_t pd_threshold(const pd_detector *d)
{
    uint32_t th = d->cfg.threshold_mg;
    if (d->cfg.auto_gain_x10) {
        /* 평소흔들림 x 배수. 기준값보다 낮아지진않음 */
        uint32_t a = (uint32_t)(((uint64_t)d->base_q8 * d->cfg.auto_gain_x10) / (10u * 256u));
        if (a > th) th = a;
    }
    return clamp16(th);
}

/* 사진시점: 카메라가 cam_ahead 앞을 보니까 그거리 지나오는데 걸린시간
   t(ms) = 거리(cm) x 360 / 속도(km/h x10) */
static uint16_t photo_back(const pd_detector *d)
{
    uint32_t v = d->speed_kmh10;
    if (!d->cfg.cam_ahead_cm || v == PD_SPEED_UNKNOWN || v < 10) return 0;
    return clamp16((uint32_t)d->cfg.cam_ahead_cm * 360u / v);
}

static int too_slow(const pd_detector *d)
{
    if (d->speed_kmh10 == PD_SPEED_UNKNOWN) return d->cfg.need_speed ? 1 : 0;
    return d->cfg.min_speed_kmh10 && d->speed_kmh10 < d->cfg.min_speed_kmh10;
}

int pd_feed(pd_detector *d, uint32_t t_ms,
            int16_t x_mg, int16_t y_mg, int16_t z_mg, pd_event *ev)
{
    int32_t x = x_mg, y = y_mg, z = z_mg;
    uint32_t mag, shock, th;

    /* 1) 충격 = | |a| - 1g |   (int16 이라 제곱합이 uint32 안에들어감) */
    mag = isqrt32((uint32_t)(x * x) + (uint32_t)(y * y) + (uint32_t)(z * z));
    shock = mag > G_MG ? mag - G_MG : G_MG - mag;

    /* 2) 충격점수 = 최근 window개 평균 (합을들고다녀서 매번 다시안더함) */
    if (d->n == d->cfg.window) d->sum -= d->buf[d->idx];
    else d->n++;
    d->buf[d->idx] = clamp16(shock);
    d->sum += d->buf[d->idx];
    if (++d->idx >= d->cfg.window) d->idx = 0;
    d->score_mg = clamp16(d->sum / d->n);

    th = pd_threshold(d);

    /* 3) 감지 */
    if (d->score_mg > th && (!d->has_last || (uint32_t)(t_ms - d->last_ms) > d->cfg.cooldown_ms)) {
        d->has_last = 1;
        d->last_ms = t_ms;          /* 무시해도 쿨다운은 걸어둠 */
        if (too_slow(d)) return PD_IGNORED;
        if (ev) {
            ev->t_ms = t_ms;
            ev->score_mg = d->score_mg;
            ev->threshold_mg = (uint16_t)th;
            ev->speed_kmh10 = d->speed_kmh10;
            ev->photo_back_ms = photo_back(d);
        }
        return PD_EVENT;
    }

    /* 4) 자동기준용 평소흔들림 갱신: 달리는중 + 충격아닐때만. 아주천천히 따라감 (1/1024) */
    if (d->cfg.auto_gain_x10 && d->score_mg <= th && !too_slow(d)) {
        int32_t target = (int32_t)d->score_mg << 8;
        d->base_q8 = (uint32_t)((int32_t)d->base_q8 + ((target - (int32_t)d->base_q8) >> 10));
    }
    return PD_NONE;
}
