# 블랙박스 Wi-Fi 기능

기존 `com.gimmegimme.pothole` Capacitor 8 앱에 추가한 기능입니다. 원본 참고:
https://github.com/0W1DD/pothole-test/blob/main/android/app/src/main/java/kr/ac/kongju/pothole/BlackboxWifiPlugin.java

## 앱에서 사용

1. Android 10 이상 휴대폰에서 Wi-Fi, 위치, 모바일 데이터를 켭니다.
2. 블랙박스를 켭니다. 휴대폰 설정에서 PotholeCam에 수동 접속하지 말고 앱의 **내정보 → 블랙박스 연결**을 사용합니다.
3. 이름 `PotholeCam`, 비밀번호 `pothole1234`를 입력하고 **등록·연결**을 누릅니다.
4. 정확한 위치, Android 13 이상의 주변 기기 권한, Android Wi-Fi 연결 안내를 허용합니다.
5. **기록 조회**로 `/index.json`을 확인합니다. JSON에 실제로 있는 사진 경로를 입력하고 **사진 확인**을 누릅니다.
6. **현재 GPS 확인**으로 위치를 확인합니다. 현재 GPS를 과거 기록의 감지 위치로 사용하면 안 됩니다.
7. 재연결은 **저장된 기기 연결**을 누릅니다. SSID와 BSSID를 기억하며 Android가 저장한 승인이 유효하면 승인 단계가 생략될 수 있습니다. 기기 교체·BSSID 변경 시 **등록 삭제** 후 다시 등록합니다.

앱이 닫힌 동안 자동으로 연결·수집하는 백그라운드 서비스는 없습니다. 연결 해제 후 다시 연결하거나 앱을 재실행해 저장된 기기에 연결할 수 있습니다.

## JavaScript API

`www/blackbox-wifi.js`는 `index.html`에서 자동으로 로드됩니다. 기존 `app.js`는 수정하지 않았습니다.

```javascript
await BlackboxWifi.register('PotholeCam', 'pothole1234');
await BlackboxWifi.connect();
const status = await BlackboxWifi.status();
const records = await BlackboxWifi.getJson(); // 기본 /index.json; JSON 객체 또는 배열
const photo = await BlackboxWifi.getPhoto('/photos/실제파일.jpg'); // data: base64, dataUrl, contentType, size
const blob = await BlackboxWifi.getPhotoBlob('/photos/실제파일.jpg'); // 기존 업로드 코드에 전달 가능한 Blob
const position = await BlackboxWifi.currentPosition(); // latitude, longitude, accuracy, timestamp
const listener = await BlackboxWifi.addListener(status => console.log(status.state));
await listener.remove();
await BlackboxWifi.disconnect();
// await BlackboxWifi.forget(); // 등록 정보까지 삭제
```

기존 테스트 앱과 같은 네이티브 API도 유지합니다.

```javascript
const wifi = window.Capacitor.Plugins.BlackboxWifi;
await wifi.register({ ssid: 'PotholeCam', password: 'pothole1234' });
await wifi.connect();
const json = await wifi.get({ url: 'http://10.42.0.1:8080/index.json', asBlob: false });
// {status, data: UTF-8 문자열, encoding: 'utf8', contentType, size}
const photo = await wifi.get({ url: 'http://10.42.0.1:8080/photos/실제파일.jpg', asBlob: true });
// {status, data: base64 문자열, encoding: 'base64', contentType, size}
```

`get()`은 HTTP 4xx/5xx도 status와 body를 반환합니다. 편의 함수 `getJson()`/`getPhoto()`는 비정상 HTTP 상태를 오류로 처리합니다. 잘못된 주소, 3xx 리디렉션, 연결 없음, 전송 실패, 크기 제한 초과는 Promise rejection입니다. 응답 한도는 8 MiB, 연결/읽기 대기는 각각 5초, 전체 응답 읽기는 약 20초로 제한합니다. 동시 GET은 2개, 대기열은 4개입니다.

## 네트워크·권한·보존 범위

- `WifiNetworkSpecifier` + `ConnectivityManager.requestNetwork()`로 인터넷 기능 없는 전용 Wi-Fi를 요청합니다.
- 블랙박스 GET만 해당 `Network.openConnection()`을 사용합니다. 앱 전체 네트워크 바인딩이나 전역 fetch 교체는 없습니다.
- 서버 업로드·지도·로그인 등은 Android 기본 인터넷 경로를 따릅니다. 모바일 데이터가 켜져 있고 기본 인터넷이 셀룰러이면 LTE/5G를 사용합니다. 모바일 데이터가 꺼져 있거나 VPN/제조사 설정이 영향을 주면 인터넷이 안 될 수 있습니다. `status()`의 `internetTransport`/`internetValidated`로 확인합니다.
- 네이티브 허용 주소는 `http://10.42.0.1:8080`뿐입니다. 다른 호스트·포트·프로토콜·사용자정보·fragment를 거절하고 리디렉션을 따라가지 않습니다. HTTP 프록시도 사용하지 않습니다.
- Android XML의 HTTP 예외는 IP에 적용됩니다. XML에는 포트 제한 기능이 없으므로 플러그인이 8080 포트를 별도로 검사합니다. 그 외 일반 HTTP는 허용하지 않습니다.
- Wi-Fi 상태/변경, 네트워크 상태/변경, 주변 Wi-Fi, 위치 권한을 선언했습니다. 연결 시 정확한 위치와 필요한 주변 기기 권한을 요청합니다. GPS 사용 때문에 위치 권한에 maxSdkVersion 제한을 두지 않았습니다.
- BSSID는 API 31 이상에서 요청한 Network의 `onCapabilitiesChanged()`와 위치 정보 플래그로 가져옵니다. API 29~30은 연결된 SSID를 확인한 뒤 기존 Wi-Fi 정보를 이용합니다. 실제 BSSID가 노출되지 않으면 저장을 생략합니다.
- SSID·비밀번호·BSSID는 Android Keystore AES-GCM으로 암호화하여 앱 전용 백업 제외 디렉터리에 저장합니다. 비밀번호는 상태 응답이나 localStorage에 넣지 않습니다.
- Capacitor의 기존 JavaScript/localStorage/GPS 설정과 WebChromeClient를 그대로 사용합니다. 카메라 권한은 선언했고 실제 촬영 시 Capacitor가 런타임 권한을 처리합니다. FileProvider, 로그인, 지도, 게시판, Supabase 설정을 보존합니다.
- 기존 Supabase 공개 anon 키를 유지했습니다. 새 키나 secret/service_role 키를 추가하지 않았습니다. 현재 코드의 `anon`은 기존 형식의 공개 클라이언트 키이며 새 `sb_publishable_...` 키를 임의로 만들 수는 없습니다.

이번 변경은 요청한 **전용 네트워크와 JSON·사진 수신 API**입니다. 마이페이지 조회는 서버에 기록을 자동 저장하지 않습니다. 기존 앱에는 블랙박스 자동 업로드 흐름이 없었으며, 실제 index.json 형식·서버 삽입 규칙을 추정해 새 레코드를 쓰지 않았습니다. 향후 자동 업로드를 연결할 때는 감지 시각의 GPS 이력, 재시도·중복 방지, Storage 버킷/테이블/RLS 정책을 맞춰야 합니다. 제공한 Blob과 위치 API를 기존 업로드 흐름에서 사용할 수 있습니다.

## 실기기 테스트 순서

1. 첫 실행: 정확한 위치·주변 기기·Wi-Fi 승인 후 연결, 기록·사진 수신.
2. 같은 연결에서 인터넷 상태가 cellular/사용 가능인지 확인하고 지도·게시판·로그인이 정상인지 확인.
3. GPS와 기존 사진 첨부 기능 확인. 기존 Supabase 업로드를 수행할 경우 실제 서버 성공 여부 확인.
4. 연결 해제 → 저장된 기기 연결, 앱 종료 → 재실행 → 저장된 기기 연결. BSSID 기억 여부와 승인 창 재표시 여부 확인.
5. 권한 거절/위치 끄기/Wi-Fi 끄기/블랙박스 전원 끄기/잘못된 비밀번호에 대해 안내가 나오고 재시도 가능한지 확인.
6. 사진 404/잘못된 JSON/8 MiB 초과 응답/다른 IP·포트/HTTP 리디렉션이 오류 처리되는지 확인.
7. 모바일 데이터를 끄면 블랙박스 수신은 가능하더라도 인터넷 업로드는 성공하지 않는지 구분해 확인.

위 자동 승인 동작의 근거: https://developer.android.com/develop/connectivity/wifi/wifi-bootstrap
권한 문서: https://developer.android.com/develop/connectivity/wifi/wifi-permissions

자동 검증: `tests/blackbox/blackbox-wifi.test.cjs` (Node), `tests/blackbox/BlackboxHttpPolicyTest.java` (JDK).
실제 Wi-Fi 분리·권한 UI·GPS·Supabase 업로드 결과는 휴대폰과 블랙박스로 확인해야 합니다.

## 전달 및 검증 결과 (2026-11-11)

- 원본 C:\Projects\PotholeApp은 쓰기 권한이 허용되지 않아 변경하지 않았습니다. 수정된 전체 복사본은 이 PotholeApp-blackbox 폴더입니다.
- Android Studio에서는 이 폴더 안의 android 폴더를 열면 됩니다. 필요한 node_modules도 프로젝트 ZIP에 포함했습니다. 파일별 복사·붙여넣기는 필요하지 않습니다.
- 테스트 APK: PotholeApp-blackbox-debug.apk. 앱의 내정보 → 블랙박스 연결에서 시작합니다.
- JDK 21 / Android SDK 36 / Gradle 8.14.3: assembleDebug 성공, APK v2 서명 검증 성공.
- Java 주소·응답 제한 검사 24개, JavaScript 테스트 7개 통과.
- APK 내부의 웹 스크립트가 최종 수정본과 같은지 확인했습니다. 기존 app.js와 원본 프로젝트 파일의 변경 없음도 해시로 확인했습니다.
- Android Lint 분석은 실행했으나 보고서 저장 단계가 환경의 파일 권한 검사에서 중단되어 lintDebug 전체 통과로 보지는 않습니다. 앱 컴파일 및 APK 생성과는 별개입니다.
- adb에 연결된 기기가 없어 Wi-Fi 연결, 권한 창, LTE/5G 병행, GPS, Supabase 실통신은 미검증입니다.
- 한글 경로의 Windows 복사본에서 빌드하기 위해 android/gradle.properties에 android.overridePathCheck=true를 추가했습니다.
- 빌드에는 기존 로컬 디버그 서명키의 복사본을 사용했습니다. 키 파일은 전달 ZIP에 포함하지 않았습니다.
