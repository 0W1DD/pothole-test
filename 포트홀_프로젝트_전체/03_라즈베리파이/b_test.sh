#!/bin/bash
# B형 자동 테스트: 핫스팟 ON → --serve + 진짜 센서(ADXL345) → 5분 뒤 원상복구
cd "$(dirname "$0")"
LOG="$PWD/b_test.log"
PREV=$(nmcli -t -f NAME,TYPE connection show --active | grep -E 'wireless|wifi' | head -1 | cut -d: -f1)
echo "$(date) 시작. 원래 와이파이: $PREV" > $LOG
nmcli device wifi hotspot ifname wlan0 ssid PotholeCam password pothole1234 >> $LOG 2>&1
sleep 5
ip -4 addr show wlan0 >> $LOG
tmux kill-session -t bbb 2>/dev/null
tmux new -d -s bbb 'python3 -u pi_blackbox_sim.py sensor --serve 2>&1 | tee -a "$PWD/b_test.log"'
sleep 300                                 # 5분 동안 진짜 센서로 감지 (톡톡 치기)
tmux kill-session -t bbb
nmcli connection down Hotspot >> $LOG 2>&1
sleep 3
# 원래 와이파이(폰 핫스팟)가 다시 켜질때까지 15분 동안 10초마다 재시도
for i in $(seq 1 90); do
  [ -z "$PREV" ] && break
  nmcli connection up "$PREV" >> $LOG 2>&1 && { echo "$(date) 복구 성공" >> $LOG; break; }
  sleep 10
done
echo "$(date) 끝. 원래 와이파이 복구 시도 완료" >> $LOG
