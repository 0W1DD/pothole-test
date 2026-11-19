# 포트홀 알리미 최종 앱

## 1.0.5-test (versionCode 6, 2026-11-19)

- 마이페이지 → **내 블랙박스 영상**: 블랙박스 영상 가져오기, 폰 보관, 로그인 후 자동 업로드, 재시도, 내 영상 목록과 임시 주소 재생.
- 파이의 `record.video = "clips/00001.mp4"`를 `/clips/00001.mp4`로 보완합니다. 임의 URL, 상위 폴더, URL 인코딩 경로는 거부합니다.
- 업로드 경로는 `<로그인 user ID>/<index.device>_<record.t_ms>.mp4`입니다. `index.device`는 장치마다 고유한 영문·숫자·밑줄·하이픈 이름(80자 이하)을 사용해야 합니다. 기본값 `pi-blackbox`를 여러 장치가 공유하면 같은 시각의 기록이 충돌할 수 있습니다.
- 폰 대기 영상은 IndexedDB에 최대 약 100 MiB 보관합니다. 로그인한 상태에서 가져온 영상은 해당 계정에 묶이고, 비로그인 영상은 처음 업로드하는 계정에 묶입니다. 로그아웃/계정 전환 때 다른 계정의 보관 영상을 올리지 않습니다. 앱 데이터 삭제·재설치·저장소 정리 시 미업로드 영상이 사라질 수 있습니다.
- 8 MiB 원본 수신 제한은 유지합니다. 파이 Wi-Fi는 기존 네이티브 `BlackboxWifi.get`만 사용하고 Supabase 요청은 기존 인터넷 경로(LTE/5G)를 사용합니다.
- 파일 경로 고정, 덮어쓰기 금지, 업로드 전 목록 확인, 완료 기록으로 중복을 방지합니다. 파일만 업로드된 뒤 실패해도 다음 시도에서 목록 저장을 이어갑니다. 여러 폰의 동시 업로드까지 막으려면 아래 서버 UNIQUE 인덱스가 필요합니다.
- 충격 당시 좌표가 기록에 없다면 `lat/lon`은 null입니다. 현재 폰 좌표를 과거 감지 위치로 저장하지 않습니다.
- **전방 음성 안내**: GPS 진행 방향 ±30도, 300/100/50m 구간마다 한 번. 설정 거리보다 먼 포트홀은 제외합니다. 속도 1m/s 미만, 방향 없음/불확실, 오래되거나 부정확한 GPS에서는 안내하지 않습니다. 가까운 구간부터 시작하면 지나친 구간은 소급 안내하지 않습니다. 안내를 중지하고 재시작하면 안내 이력이 초기화됩니다. 기존 무음·방해금지·위치 서비스 수명 처리는 유지합니다.
- **새 감지 알림**: 마이페이지에서 시작하면 `potholes INSERT`를 구독합니다. 신선하고 정확한 위치의 1km 안만 Android 알림을 표시하며 알림을 누르면 해당 좌표로 지도를 이동합니다. 앱이 살아 있고 Realtime 연결이 유지되는 동안만 수신합니다. 앱 종료/절전 이후에도 알림을 보장하는 서버 푸시(FCM)는 별도 범위입니다.
- 목록은 로그인한 `user_id`만 최신순 30개씩 조회합니다. `createSignedUrl(path, 3600)`으로 재생하며 공개 URL을 만들지 않습니다. 로그아웃/계정 전환 시 목록·플레이어를 지우고 늦게 도착한 이전 계정 응답을 버립니다. 이미 발급된 임시 URL은 로그아웃으로 취소되지 않고 발급 후 1시간까지 유효할 수 있습니다.

## 서버 담당자가 먼저 준비할 사항

앱에서는 서버 권한이나 테이블을 만들지 않습니다. 카카오 로그인과 같은 Supabase 프로젝트에 다음 설정이 필요합니다.

1. `pothole-videos`: **비공개**, MIME `video/mp4`, 원본 한도 20 MB. 기존 공개 버킷이 있다면 `on conflict do nothing`만으로 비공개로 바뀌지 않으므로 실제 설정을 확인합니다.
2. Storage SELECT/INSERT/DELETE는 authenticated이며 첫 폴더가 `auth.uid()`인 객체만. 기존의 넓은 공개 허용 정책이 이 버킷에도 적용되지 않는지 확인합니다.
3. `pothole_videos`: 사용자 요청의 열과 user_id RLS, authenticated SELECT/INSERT 권한. anon 읽기/쓰기 금지.
4. 재시도와 여러 폰의 동시 등록에서 중복 목록을 막도록 기존 중복을 검토한 후 `create unique index pothole_videos_user_path_unique on public.pothole_videos (user_id, path);` 적용. 이 문서의 SQL은 앱에서 자동 실행하지 않습니다.
5. `potholes`를 `supabase_realtime` publication에 추가하고 현재 지도 클라이언트가 읽을 수 있어야 합니다.
6. 파이 `/index.json`에 `device`, `records[].video`, `t_ms`, `score`를 넣고 `/clips/*.mp4`를 실제 제공해야 합니다. 앱은 파이의 촬영/서버 기능을 구현하지 않습니다.

서버 미설정/인터넷 단절 때는 오류를 표시하고 폰 보관 영상을 남깁니다. 표의 RLS와 버킷 비공개 상태는 앱 필터만으로 대체할 수 없습니다.

## 빌드·테스트

Node.js와 JDK 21, Android SDK 36, Gradle 8.14.3을 사용합니다.

```sh
npm ci
npm test
npx cap sync android
cd android
./gradlew assembleDebug lintDebug
```

Windows에서는 `gradlew.bat`을 사용합니다. APK는 `android/app/build/outputs/apk/debug/app-debug.apk`에 생성됩니다. `www` 수정 후에는 반드시 `cap sync android`를 실행해 APK 자산에 복사합니다.

저장소 루트의 기존 `build.yml`은 루트의 이전 테스트 앱을 빌드합니다. 이번 최종 앱은 위 `소스코드` 폴더에서 빌드해야 합니다.

이번 검증: JavaScript 31개 테스트, Java HTTP 정책 30개·전방 안내 정책 34개 검사 통과. `assembleDebug lintDebug` 성공(앱 lint 오류 0개, 경고 21개). APK에 들어간 7개 웹 자산과 테스트한 소스의 바이트 일치 및 기존 테스트 APK와 동일한 서명 확인. 이 결과는 아래 실기기/서버 검증을 대신하지 않습니다.

네이티브 정책은 기존 `tests/blackbox/README.md` 방식으로 `BlackboxHttpPolicyTest`와 `NearbyAlertPolicyTest`를 JDK에서 실행할 수 있습니다.

## 실기기/서버 검증 체크리스트 — 현재 미확인

- 비로그인 상태로 1~5MB 영상 수신 → 앱 재시작 → 같은 데이터 보관 → 카카오 로그인 시 업로드.
- 서버 없는 상태/네트워크 단절/목록 저장 실패 → 데이터 보존과 재시도, 중복 객체·목록 없음.
- 계정 A 영상 업로드 → 로그아웃 → 계정 B 목록·Storage 접근 불가. A 보관 영상은 B로 업로드되지 않음.
- 1시간 임시 URL 만료, 로그아웃 시 플레이어 즉시 제거. MP4 코덱 실제 재생 확인.
- Wi-Fi로 파이 수신 중 LTE/5G 업로드와 지도·커뮤니티·카카오 로그인 정상 동작.
- 전방/후방, 방향 0도 경계, 300/100/50m 주행, GPS 불량·무음·화면 꺼짐 상황에서 안내 확인.
- 근처/1km 밖 새 행 INSERT, 권한 거부, Realtime 재연결, 알림 탭 후 실행 중/앱 재시작 지도 이동 확인.

공식 API 근거: [Supabase upload](https://supabase.com/docs/reference/javascript/storage-from-upload), [createSignedUrl](https://supabase.com/docs/reference/javascript/storage-from-createsignedurl), [Realtime Postgres Changes](https://supabase.com/docs/guides/realtime/postgres-changes).
