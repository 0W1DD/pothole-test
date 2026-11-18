/* comma2k19 가속도 데이터를 SDK에 넣어봄 */
#include <stdio.h>
#include <stdlib.h>
#include "pothole.h"
int main(int argc,char**argv){
  FILE*f=fopen(argv[1],"r"); char line[256]; pd_config c; pd_detector d; pd_event ev;
  int thr=atoi(argv[2]), win=atoi(argv[3]); unsigned long n=0,events=0,ign=0; unsigned maxs=0;
  pd_default_config(&c); c.threshold_mg=thr; c.window=win; pd_init(&d,&c);
  while(fgets(line,sizeof line,f)){double t,x,y,z,s,k; if(sscanf(line,"%lf,%lf,%lf,%lf,%lf,%lf",&t,&x,&y,&z,&s,&k)<6)continue;
    pd_set_speed(&d,(uint16_t)(k*10+.5));
    int r=pd_feed(&d,(uint32_t)(t*1000+.5),(int16_t)(x*1000),(int16_t)(y*1000),(int16_t)(z*1000),&ev); n++;
    if(pd_score(&d)>maxs)maxs=pd_score(&d);
    if(r==PD_EVENT){events++; printf("  감지! %.1f초  점수 %umg  속도 %.0fkm/h  사진은 %ums 전 프레임\n",t,ev.score_mg,ev.speed_kmh10/10.0,ev.photo_back_ms);}
    if(r==PD_IGNORED)ign++;}
  printf("샘플 %lu개, 감지 %lu번, 무시 %lu번, 최대점수 %umg (기준 %dmg, 평균창 %d샘플)\n",n,events,ign,maxs,thr,win);
}
