# 라즈베리파이 Claude Code 작업 지시서 — 블랙박스 시뮬레이터 A형·B형 테스트

> 이 파일을 읽은 Claude에게: 아래 순서대로 **직접 명령을 실행해서** 진행해줘. 사용자는 한국어 대학생이고 따뜻한 반말을 좋아해. 단계마다 결과를 짧게 알려주고, 사용자 손이 필요한 곳(⚠️ 표시)에서만 멈춰서 물어봐.

## 배경 (짧게)
- 캡스톤 포트홀 감지 프로젝트. 이 라즈베리파이 5가 "블랙박스" 역할을 한다.
- 지금은 센서·카메라를 떼어 둔 상태다. 그래서 `pi_blackbox_sim.py`가 Enter 키로 가짜 충격을 만든다. 감지 계산은 실제 SDK(`pothole.py`) 그대로다.
- 사진과 GPS는 사용자 폰의 "포트홀 테스트" 앱이 붙여서 Supabase에 올린다.
- 저장소: https://github.com/0W1DD/pothole-test (`pi/` 폴더)
- Supabase 프로젝트: `https://dwejbbhrjfcqcnslheas.supabase.co`
- **A형**: 파이가 인터넷에 붙어서 충격 신호를 `shock_events` 테이블로 직접 보낸다. 폰 앱이 그걸 보고 사진과 GPS를 붙여 `potholes`에 올린다.
- **B형**: 파이가 자기 와이파이(PotholeCam, 인터넷 없음)를 만들고, 기록을 `b_store/`에만 저장한다. 그리고 8080 포트로 내준다. 폰이 거기 붙어서 가져간다.

## 규칙
- secret / service_role 키는 절대 쓰지 말 것. publishable 키(`sb_publishable_...`)만 쓴다.
- `server.json`은 이 파이에만 둔다. 깃에 올리거나 출력에 키 전체를 찍지 않는다.
- **B형 단계에서는 파이 와이파이가 핫스팟으로 바뀌어서 인터넷이 끊긴다.** 그러면 Claude Code(너 자신)도 끊긴다. 그래서 B형은 **자동 복구 스크립트를 백그라운드로** 돌린다(4단계). 직접 핫스팟을 켜고 기다리지 말 것.
- 단, 파이가 **유선 랜(eth0)**으로 인터넷에 붙어 있으면 핫스팟을 켜도 인터넷이 안 끊긴다. 3단계 전에 `ip route | grep default`로 확인한다.

---

## 0단계 — 준비 확인
1. `python3 --version`, `ip route | grep default`(인터넷이 eth0인지 wlan0인지), `nmcli -t -f NAME,DEVICE connection show --active`를 실행한다. 지금 붙어 있는 와이파이 연결 이름을 기억해 둔다.
2. `tmux`가 없으면 `sudo apt-get install -y tmux`.

## 1단계 — 코드 받기
```bash
mkdir -p ~/blackbox_sim && cd ~/blackbox_sim
B=https://raw.githubusercontent.com/0W1DD/pothole-test/main/pi
curl -fsSO $B/pi_blackbox_sim.py
curl -fsSO $B/pothole.py
curl -fsSO $B/data/calib_normal.csv
curl -fsSO $B/data/calib_normal_marks.json
ls -la
```

## 2단계 — 서버 설정
⚠️ 사용자에게 **publishable 키**를 물어본다. "Supabase 대시보드 → Project Settings → API Keys에 있는 `sb_publishable_`로 시작하는 키 붙여줘"라고 하면 된다. 받으면 저장한다.
```bash
cd ~/blackbox_sim
cat > server.json <<'EOF'
{"url": "https://dwejbbhrjfcqcnslheas.supabase.co", "key": "여기에_받은_키"}
EOF
chmod 600 server.json
```
연결을 확인한다. 둘 다 HTTP 200이면 OK. 404나 42P01이 나오면 테이블이 없는 거다.
```bash
K=$(python3 -c "import json;print(json.load(open('server.json'))['key'])")
U=https://dwejbbhrjfcqcnslheas.supabase.co
curl -s -o /dev/null -w "potholes %{http_code}\n" "$U/rest/v1/potholes?select=id&limit=1" -H "apikey: $K"
curl -s -o /dev/null -w "shock_events %{http_code}\n" "$U/rest/v1/shock_events?select=id&limit=1" -H "apikey: $K"
```
⚠️ `shock_events`가 200이 아니면 멈춘다. 그리고 사용자에게 "Supabase SQL Editor에서 `오늘_할일_및_구조설명.md` 5번의 SQL ②를 먼저 실행해줘"라고 알려준다.

## 3단계 — 실차 기록으로 SDK 확인 (서버 안 올림)
```bash
cd ~/blackbox_sim && python3 pi_blackbox_sim.py replay calib_normal.csv --dry
```
기대값: 방지턱 13개 중 **11개 감지**, 오감지 약 14개(분당 1.28회). 결과 요약을 사용자에게 알려준다.

## 3-2단계 — A형 테스트 (파이 → Supabase → 폰)
⚠️ 사용자에게 알려준다. "폰 앱에서 Supabase URL·키 저장 → **'라즈베리파이 센서 사용'** 체크 → **측정 시작** 눌러둬. 다 됐으면 말해줘."

준비됐다고 하면 실행한다.
```bash
cd ~/blackbox_sim
tmux kill-session -t bb 2>/dev/null
tmux new -d -s bb 'python3 pi_blackbox_sim.py key --phone 2>&1 | tee a_test.log'
sleep 3
for i in 1 2 3; do tmux send-keys -t bb Enter; sleep 4; done
sleep 2; tail -20 a_test.log
tmux kill-session -t bb
```
Supabase에 들어갔는지 확인한다.
```bash
curl -s "$U/rest/v1/shock_events?select=id,t_ms,score,source&order=id.desc&limit=3" -H "apikey: $K"
```
⚠️ 사용자에게 "폰 감지 기록에 3개 떴어? 팀 웹 지도에 핀 생겼어?"라고 물어본다.

## 4단계 — B형 테스트 (파이 와이파이, 인터넷 없음)
핫스팟을 켜면 wlan0 인터넷이 끊긴다. 그래서 아래 스크립트를 만든다. 이 스크립트는 **약 5분 동안 핫스팟과 서버를 켜고, 20초마다 자동으로 충격을 넣고, 끝나면 원래 와이파이로 돌아온다.**

`~/blackbox_sim/b_test.sh`:
```bash
#!/bin/bash
# B형 자동 테스트: 핫스팟 ON → --serve + 20초마다 가짜 충격 → 5분 뒤 원상복구
cd ~/blackbox_sim
LOG=~/blackbox_sim/b_test.log
PREV=$(nmcli -t -f NAME,TYPE connection show --active | grep -E 'wireless|wifi' | head -1 | cut -d: -f1)
echo "$(date) 시작. 원래 와이파이: $PREV" > $LOG
sudo nmcli device wifi hotspot ifname wlan0 ssid PotholeCam password pothole1234 >> $LOG 2>&1
sleep 5
ip -4 addr show wlan0 >> $LOG
tmux kill-session -t bbb 2>/dev/null
tmux new -d -s bbb 'python3 pi_blackbox_sim.py key --serve 2>&1 | tee -a ~/blackbox_sim/b_test.log'
sleep 60                                  # 폰이 PotholeCam에 붙을 시간
for i in $(seq 1 12); do tmux send-keys -t bbb Enter; sleep 20; done   # 4분 동안 12번 충격
sleep 20
tmux kill-session -t bbb
sudo nmcli connection down Hotspot >> $LOG 2>&1
sleep 3
[ -n "$PREV" ] && sudo nmcli connection up "$PREV" >> $LOG 2>&1
echo "$(date) 끝. 원래 와이파이 복구 시도 완료" >> $LOG
```

⚠️ 실행 전에 사용자에게 안내한다.
> "지금부터 약 6분 동안 파이 인터넷이 끊겨서 나(Claude)도 대답을 못 해. 그동안 이렇게 해줘:
> 1. 폰 앱: **'B형: 파이 와이파이에서 가져오기'** 체크(라즈베리파이 센서 사용은 끄기), 파이 주소 `http://10.42.0.1:8080`, **측정 시작**
> 2. 1분 안에 폰 와이파이를 **PotholeCam**(비번 pothole1234)에 연결. '인터넷 없음' 경고가 나오면 '연결 유지'
> 3. 20초마다 폰 감지 기록에 하나씩 뜨는지 보기. 상단바 아이콘도 캡처하기
> 4. 끝나면 폰 와이파이를 끄거나 원래대로 → '업로드 대기'가 자동으로 올라가는지 보기
> 6분 뒤에 나한테 다시 말 걸어줘."

사용자가 OK하면 실행한다. 반드시 백그라운드로, 내 세션이 끊겨도 계속 돌게 한다.
```bash
chmod +x ~/blackbox_sim/b_test.sh
sudo -v    # sudo 비밀번호가 필요하면 사용자에게 입력 부탁
nohup setsid ~/blackbox_sim/b_test.sh > /dev/null 2>&1 &
```

사용자가 돌아오면 확인한다.
```bash
cat ~/blackbox_sim/b_test.log | tail -40
cat ~/blackbox_sim/b_store/index.json | head -50
ip route | grep default
```
- `b_store/index.json`에 기록이 12개 안팎이면 파이 쪽은 성공이다.
- 폰에서 가져갔는지, 업로드됐는지는 사용자에게 물어보고, Supabase `potholes`에 "블랙박스(B형)" 설명 행이 생겼는지 확인한다.
```bash
curl -s "$U/rest/v1/potholes?select=id,description,image_url,created_at&order=id.desc&limit=5" -H "apikey: $K"
```
- 인터넷이 안 돌아왔으면 `sudo nmcli connection down Hotspot; sudo nmcli device wifi connect "<원래 와이파이>"`를 시도한다. 그래도 안 되면 사용자에게 모니터와 키보드로 이 명령을 쳐 달라고 한다.

## 5단계 — 결과 정리
`~/blackbox_sim/RESULT.md`에 아래 결과를 짧게 적고 사용자에게 보여준다.
- 3단계 replay 결과
- A형: shock_events 행 수, 폰과 지도 반영 여부
- B형: 파이 기록 수, 폰 수신, 업로드, 상단바 아이콘

## 문제 해결
| 증상 | 조치 |
|---|---|
| `ModuleNotFoundError` | `pothole.py`가 같은 폴더에 있는지 확인. 1단계 다시 |
| `server.json` 없음 오류 | 2단계 |
| shock_events 404 / 42P01 | SQL ② 안 돌림 → 사용자에게 요청 |
| 핫스팟 `Error: ... wlan0` | `nmcli radio wifi on`; `rfkill unblock wifi` 후 재시도 |
| 8080 사용 중 | `sudo fuser -k 8080/tcp` |
| 폰 "파이 연결 안됨" | 폰이 PotholeCam에 붙었는지 / 웹 버전이 아닌 **APK**인지 |
