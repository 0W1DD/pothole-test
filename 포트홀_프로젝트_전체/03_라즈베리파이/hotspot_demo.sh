#!/bin/bash
# 시연용: PotholeCam 와이파이만 3분 켜고 원래 와이파이로 복구
cd "$(dirname "$0")"
LOG="$PWD/hotspot_demo.log"
PREV=$(nmcli -t -f NAME,TYPE connection show --active | grep -E 'wireless|wifi' | head -1 | cut -d: -f1)
echo "$(date) 시작. 원래 와이파이: $PREV" > $LOG
nmcli device wifi hotspot ifname wlan0 ssid PotholeCam password pothole1234 >> $LOG 2>&1
sleep 180
nmcli connection down Hotspot >> $LOG 2>&1
sleep 3
for i in $(seq 1 90); do
  [ -z "$PREV" ] && break
  nmcli connection up "$PREV" >> $LOG 2>&1 && { echo "$(date) 복구 성공" >> $LOG; break; }
  sleep 10
done
echo "$(date) 끝" >> $LOG
