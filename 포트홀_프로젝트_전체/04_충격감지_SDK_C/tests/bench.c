/* 속도재기: 샘플하나 처리하는데 몇ns */
#include <stdio.h>
#include <time.h>
#include "pothole.h"
int main(void){
    pd_config c; pd_detector d; pd_event ev; pd_default_config(&c); pd_init(&d,&c); pd_set_speed(&d,400);
    const long N=20000000; long hits=0; unsigned s=1;
    struct timespec a,b; clock_gettime(CLOCK_MONOTONIC,&a);
    for(long i=0;i<N;i++){ s=s*1103515245u+12345u; int16_t z=(int16_t)(1000+((s>>16)&255)-128);
        hits+=pd_feed(&d,(uint32_t)(i*5/2),(int16_t)((s>>8)&63),(int16_t)((s>>4)&63),z,&ev)==PD_EVENT; }
    clock_gettime(CLOCK_MONOTONIC,&b);
    double ns=((b.tv_sec-a.tv_sec)*1e9+(b.tv_nsec-a.tv_nsec))/N;
    printf("C: 샘플당 %.1f ns  (400Hz 기준 CPU사용 %.4f%%)  hits=%ld\n",ns,ns*400/1e9*100,hits);
    return 0;}
