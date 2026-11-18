# 서버 (Supabase)

프로젝트 주소: `https://dwejbbhrjfcqcnslheas.supabase.co` (DB 담당 팀원 계정)
앱·파이에는 **공개(publishable) 키**만 넣는다. secret/service_role 키는 절대 넣지 않는다.

## 테이블

| 테이블 | 쓰는 곳 | 주요 칸 |
|---|---|---|
| `potholes` | 지도 핀 | title, description, status(기본 '발견', '수리중' 등), latitude, longitude, image_url |
| `gps_logs` | 지도 위 내 차 위치 (최신 1개) | lat, lon, created_at |
| `shock_events` | A형: 파이가 보낸 충격 신호를 앱이 받아 GPS 위치 붙임 (테스트 앱은 사진도) | t_ms, photo_ms, score, speed_kmh, source |
| `pothole_reviews`, `pothole_comments` | 배상청구 후기 커뮤니티 | (팀 웹 담당) |
| `profile` | 카카오 로그인 프로필 | |
| Storage `pothole-images` | 감지 순간 사진 | 공개 주소를 potholes.image_url 에 저장 |

## 알아둘 것
- `pothole_comments`, `pothole_reviews` 는 대시보드에 **UNRESTRICTED** (보안 규칙 꺼짐) 로 표시됨 → 커뮤니티 담당과 상의해서 RLS 켜기
- 테스트용 정책은 `테스트용_SQL.sql` ④로 닫기
