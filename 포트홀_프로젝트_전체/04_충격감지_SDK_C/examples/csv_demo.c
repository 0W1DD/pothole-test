/*
 * 예제: 기록된 CSV를 SDK에 넣어보기 (C)
 * CSV 형식: calibrate.py 가 만드는거랑같음 → t(초),x(g),y(g),z(g)[,score][,kmh]
 *
 * 만들기: gcc -O2 -Iinclude src/pothole.c examples/csv_demo.c -o csv_demo
 * 실행:   ./csv_demo calib_bump.csv [기준mg]
 */
#include <stdio.h>
#include <stdlib.h>
#include "pothole.h"

int main(int argc, char **argv)
{
    FILE *f;
    char line[256];
    pd_config c;
    pd_detector d;
    pd_event ev;
    unsigned long n = 0, events = 0, ignored = 0;

    if (argc < 2) {
        fprintf(stderr, "쓰는법: %s 파일.csv [기준mg]\n", argv[0]);
        return 1;
    }
    f = fopen(argv[1], "r");
    if (!f) { perror(argv[1]); return 1; }

    pd_default_config(&c);
    if (argc > 2) c.threshold_mg = (uint16_t)atoi(argv[2]);
    pd_init(&d, &c);

    while (fgets(line, sizeof line, f)) {
        double t, x, y, z, score = 0, kmh = -1;
        int k = sscanf(line, "%lf,%lf,%lf,%lf,%lf,%lf", &t, &x, &y, &z, &score, &kmh);
        int r;
        if (k < 4) continue;                       /* 머리줄이나 빈줄은 건너뜀 */
        if (k == 6 && kmh >= 0) pd_set_speed(&d, (uint16_t)(kmh * 10 + 0.5));
        else pd_set_speed(&d, PD_SPEED_UNKNOWN);
        r = pd_feed(&d, (uint32_t)(t * 1000 + 0.5),
                    (int16_t)(x * 1000), (int16_t)(y * 1000), (int16_t)(z * 1000), &ev);
        n++;
        if (r == PD_EVENT) {
            events++;
            printf("감지 %8.2f초  점수 %4u mg  기준 %4u mg  ", ev.t_ms / 1000.0, ev.score_mg, ev.threshold_mg);
            if (ev.speed_kmh10 == PD_SPEED_UNKNOWN) printf("속도모름\n");
            else printf("%5.1f km/h  사진 %u ms 전\n", ev.speed_kmh10 / 10.0, ev.photo_back_ms);
        } else if (r == PD_IGNORED) {
            ignored++;
        }
    }
    fclose(f);
    printf("샘플 %lu개, 감지 %lu번, 느려서무시 %lu번\n", n, events, ignored);
    return 0;
}
