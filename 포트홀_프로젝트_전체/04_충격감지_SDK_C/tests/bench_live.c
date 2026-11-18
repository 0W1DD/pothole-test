/*
 * 실제처럼 1초에 400번 SDK 돌려보고 CPU 얼마나 쓰는지 잼
 *   ./bench_live 10      (10초동안)
 * 출력: 한줄 JSON {"samples":..,"cpu_ms":..,"cpu_pct":..,"maxrss_kb":..}
 */
#define _POSIX_C_SOURCE 200809L
#include <stdio.h>
#include <stdlib.h>
#include <time.h>
#include <sys/resource.h>
#include "pothole.h"

int main(int argc, char **argv)
{
    double secs = argc > 1 ? atof(argv[1]) : 10.0;
    long n = (long)(secs * 400), i, hits = 0;
    pd_config c; pd_detector d; pd_event ev;
    struct timespec next;
    struct rusage ru;
    unsigned s = 12345;

    pd_default_config(&c);
    pd_init(&d, &c);
    pd_set_speed(&d, 300);
    clock_gettime(CLOCK_MONOTONIC, &next);
    for (i = 0; i < n; i++) {
        /* 가짜 센서값 (평소흔들림) */
        s = s * 1103515245u + 12345u;
        hits += pd_feed(&d, (uint32_t)(i * 5 / 2), (int16_t)((s >> 8) & 63),
                        (int16_t)((s >> 4) & 63), (int16_t)(1000 + (int)((s >> 16) & 127) - 64), &ev) == PD_EVENT;
        next.tv_nsec += 2500000;                 /* 2.5ms = 400Hz */
        if (next.tv_nsec >= 1000000000L) { next.tv_nsec -= 1000000000L; next.tv_sec++; }
        clock_nanosleep(CLOCK_MONOTONIC, TIMER_ABSTIME, &next, NULL);
    }
    getrusage(RUSAGE_SELF, &ru);
    {
        double cpu = ru.ru_utime.tv_sec * 1e3 + ru.ru_utime.tv_usec / 1e3
                   + ru.ru_stime.tv_sec * 1e3 + ru.ru_stime.tv_usec / 1e3;
        printf("{\"samples\":%ld,\"cpu_ms\":%.2f,\"cpu_pct\":%.4f,\"maxrss_kb\":%ld,\"hits\":%ld}\n",
               n, cpu, cpu / (secs * 1e3) * 100.0, ru.ru_maxrss, hits);
    }
    return 0;
}
