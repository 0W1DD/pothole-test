# 블랙박스 MP4 수신 검증

최종 앱의 `www/blackbox-wifi.js`는 다음 API를 제공합니다.

```js
const video = await BlackboxWifi.getVideoBlob('/clips/impact_20261119-001.mp4');
// video instanceof Blob, video.type === 'video/mp4'
```

파일명은 영문 대소문자, 숫자, 밑줄, 하이픈을 하나 이상 사용하고 소문자 `.mp4`로 끝나야 합니다. 전체 URL, 하위 폴더, 상대 경로, URL 인코딩, 공백, 쿼리, 프래그먼트는 허용하지 않습니다. 연결된 블랙박스가 해당 `/clips/` 파일을 제공해야 합니다.

기존 네이티브 `BlackboxWifi.get({ url, asBlob: true })`를 사용하고, HTTP 성공 여부를 먼저 확인한 뒤 사진 수신과 공유하는 변환 함수로 Base64를 `Blob(video/mp4)`로 변환합니다. 네이티브 연결 실패와 크기/시간 제한 오류는 호출자에게 그대로 전달됩니다.

## 크기와 호환성

- Android의 `BlackboxHttpPolicy.MAX_BYTES`는 **원본 응답 8 MiB (8,388,608바이트)** 제한입니다. Content-Length와 실제 스트림 읽기에서 검사하며, 그 뒤 Base64로 인코딩합니다. 이 제한은 변경하지 않습니다.
- 1–5 MB 영상과 더 큰 단위인 1–5 MiB 영상도 크기 제한 안에 들어갑니다. 5 MiB를 Base64로 표현하면 6,990,508문자입니다. 이 문자열 크기는 원본 8 MiB 제한과 별개입니다.
- Base64 문자열, 디코딩 문자열, 바이트 배열, Blob이 메모리에 존재할 수 있습니다. 기존 연결/읽기 타임아웃 5초와 응답 읽기 기한 20초도 그대로 적용되므로 실제 전송 성공은 Wi-Fi 상태와 단말 메모리에 영향을 받습니다.
- 단위 테스트의 큰 데이터는 바이트 보존을 확인하기 위한 합성 데이터입니다. 실제 Android–라즈베리파이 전송과 MP4 재생은 별도 실기기 검증이 필요합니다. 파일 확장자와 반환 MIME을 제한하며 영상 컨테이너/코덱 자체를 검증하지는 않습니다.

## 실행

이 `소스코드` 폴더에서 Node.js 18 이상과 JDK로 실행합니다. 추가 패키지 설치는 필요하지 않습니다.

```sh
node --check www/blackbox-wifi.js
node --test tests/blackbox/blackbox-wifi.test.cjs
javac -encoding UTF-8 -d <임시출력폴더> android/app/src/main/java/com/gimmegimme/pothole/BlackboxHttpPolicy.java tests/blackbox/BlackboxHttpPolicyTest.java
java -cp <임시출력폴더> com.gimmegimme.pothole.BlackboxHttpPolicyTest
```

JavaScript 테스트는 허용 경로와 차단 경로, HTTP 오류, 네이티브 오류, 잘못된 Base64, 1/5 MiB의 바이트 보존, 기존 JSON·사진·등록·GPS 동작을 검사합니다. Java 테스트는 실제 운영 코드의 URL 정책과 1/5/8 MiB 읽기 성공, 8 MiB + 1바이트 거부, 시간 초과를 검사합니다.
