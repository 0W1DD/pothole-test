// =====================================================================
// 0. Supabase 연결 설정
// =====================================================================
// 💡 게시판·로그인·프로필용 프로젝트 (pothole_reviews, pothole_comments, review-images, profile)
const SUPABASE_URL = 'https://dwejbbhrjfcqcnslheas.supabase.co';
const SUPABASE_KEY = "sb_publishable_sX2k8azs-fszxaFBlg6tWA_TX1l8vrT";
const supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

// 💡 지도·GPS용 프로젝트 (potholes, gps_logs) — 라즈베리파이 gps_upload.py도 여기로 보냄
const MAP_SUPABASE_URL = 'https://dwejbbhrjfcqcnslheas.supabase.co';
const MAP_SUPABASE_KEY = 'sb_publishable_sX2k8azs-fszxaFBlg6tWA_TX1l8vrT';
const mapDB = supabase.createClient(MAP_SUPABASE_URL, MAP_SUPABASE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false, storageKey: 'map-db-auth' }
});

let currentUser = null;
let allReviews = [];
let currentReviewId = null;
let kakaoMap = null;
let activeInfoWindow = null; 
let gpsMarker = null;

let currentSearchKeyword = ''; 
const RECENT_SEARCH_KEY = 'pothole_recent_searches'; 

const RETURN_KEY = 'pothole_return_view';
const RETURN_TTL = 10 * 60 * 1000;
// 💡 기본 프로필 이미지: 이미지 파일 없이 코드 안에 SVG로 직접 넣음 (파일 누락·WebView 깨짐 방지)
const DEFAULT_AVATAR_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <circle cx="256" cy="256" r="256" fill="#D1D5DB"/>
  <circle cx="256" cy="178" r="88" fill="#FFFFFF"/>
  <path d="M88 445 L88 420 C88 345 163 295 256 295 C349 295 424 345 424 420 L424 445 Z" fill="#FFFFFF"/>
</svg>`.trim();
const PLACEHOLDER_LOGIN = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(DEFAULT_AVATAR_SVG);
// 예전에 DB에 저장된 기본 이미지 주소(외부 CDN, 로컬 png)는 SVG 기본 이미지로 대체
function fixAvatarUrl(url) {
  if (!url || url.includes('flaticon.com') || url.includes('default-profile.png')) return PLACEHOLDER_LOGIN;
  // 💡 카카오 프로필 주소가 http:// 로 오는 경우가 있음 → 안드로이드 WebView는 https 페이지에서 http 이미지를 차단(Mixed Content)하므로 https로 바꿔줌
  return url.replace(/^http:\/\//i, 'https://');
}

// 💡 그래도 로드에 실패한 프로필 이미지는 기본 SVG로 교체 (만료된 카카오 이미지, 삭제된 파일 등)
document.addEventListener('error', (e) => {
  const img = e.target;
  if (!(img instanceof HTMLImageElement)) return;
  const isAvatar = img.alt === '프로필' || img.id === 'profile-image';
  if (isAvatar && img.src !== PLACEHOLDER_LOGIN) img.src = PLACEHOLDER_LOGIN;
}, true);

// =====================================================================
// 1. 화면 전환
// =====================================================================
function go(view, opts = {}) {
  if (view === 'write' && !currentUser) {
    showAlert('로그인 후 이용 가능합니다!', () => { go('mypage'); });
    return;
  }

  closeInfoWindow();

  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById(view + '-view').classList.add('active');

  const navKey = (view === 'detail' || view === 'write' || view === 'search' || view === 'notification') ? 'board' : view;
  document.querySelectorAll('.nav-item').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.view === navKey);
  });

  document.body.classList.toggle('map-mode', view === 'map');

  // 💡 화면 안쪽 스크롤을 맨 위로 (body는 스크롤하지 않음)
  document.getElementById(view + '-view').scrollTop = 0;
  refreshNav();

  if (view === 'map') {
    if (kakaoMap) { kakaoMap.relayout(); centerOnMyLocationOnce(); }
  } else if (view === 'board') {
    currentReviewId = null;
    loadReviews();
  } else if (view === 'write') {
    resetWriteForm(opts.review || null);
  } else if (view === 'mypage') {
    renderMyPage();
  }
  // 💡 배상청구 도우미는 들어갈 때 자동으로 위치를 잡지 않음 ("현재 내 위치" 버튼을 눌러야 실행)
}

// 💡 메뉴바를 숨겼다 다시 보이던 방식은 화면이 튀어서 제거 (위치만 다시 계산)
function refreshNav() {
  const nav = document.getElementById('bottom-nav');
  if (!nav) return;
  void nav.offsetHeight;
}

document.addEventListener('focusout', () => setTimeout(refreshNav, 100));
document.addEventListener('change', (e) => {
  if (e.target.type === 'file') setTimeout(refreshNav, 100);
});
window.addEventListener('pageshow', refreshNav);
window.addEventListener('focus', refreshNav);
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', () => setTimeout(refreshNav, 100));
}

// 💡 사파리 주소창이 접히거나 펴져서 화면 크기가 바뀌면 지도 크기 다시 맞추기
function relayoutMap() {
  if (kakaoMap && document.getElementById('map-view').classList.contains('active')) {
    const center = kakaoMap.getCenter();
    kakaoMap.relayout();
    kakaoMap.setCenter(center);
  }
}
window.addEventListener('resize', () => setTimeout(relayoutMap, 100));
window.addEventListener('orientationchange', () => setTimeout(relayoutMap, 300));

// =====================================================================
// 2. 지도 및 라즈베리파이 GPS 연동
// =====================================================================
const MARKER_IMAGES = { '발견': './red_pin.svg', '수리중': './blue_pin.svg' };

function closeInfoWindow() {
  hidePotholeCopyMenu();
  closePotholeList();
  if (activeInfoWindow) { activeInfoWindow.close(); activeInfoWindow = null; }
}

// 💡 지도 로드 실패 시 화면에 원인 표시 (흰 화면 대신)
function showMapError(reason) {
  const el = document.getElementById('map');
  if (!el) return;
  el.innerHTML = `
    <div style="display:flex; flex-direction:column; align-items:center; justify-content:center; height:100%; padding:20px; text-align:center; color:#555; background:#f7f9fa;">
      <div style="font-size:40px; margin-bottom:10px;">🗺️</div>
      <b style="font-size:16px; margin-bottom:8px;">지도를 불러오지 못했습니다</b>
      <span style="font-size:13px; color:#888; line-height:1.5;">${reason}</span>
    </div>
  `;
}

function initKakaoMap() {
  const container = document.getElementById('map');
  kakaoMap = new kakao.maps.Map(container, {
    center: new kakao.maps.LatLng(37.5665, 126.9780),
    level: 5
  });

  kakao.maps.event.addListener(kakaoMap, 'click', closeInfoWindow);
  kakao.maps.event.addListener(kakaoMap, 'click', hideMapSearchResults);
  kakao.maps.event.addListener(kakaoMap, 'dragstart', closeInfoWindow);
  kakao.maps.event.addListener(kakaoMap, 'dragstart', hideMapSearchResults);
  kakao.maps.event.addListener(kakaoMap, 'zoom_start', closeInfoWindow);

  startMyLocation();

  fetchAndDisplayPotholes(kakaoMap);
  fetchLatestGpsLog();
  subscribeGpsLogs();
}

// 💡 SDK가 없으면 여기서 멈추지 않고 나머지 기능(게시판 등)은 계속 동작하게 함
if (typeof kakao !== 'undefined' && kakao.maps && typeof kakao.maps.load === 'function') {
  kakao.maps.load(initKakaoMap);
} else {
  console.error('카카오 지도 SDK 로드 실패: 앱 키 / 도메인 등록 / 카카오맵 활성화 확인 필요');
  window.addEventListener('DOMContentLoaded', () =>
    showMapError('카카오 SDK 로드 실패<br>앱 키·플랫폼 도메인 등록·카카오맵 사용 설정을 확인하세요.'));
  showMapError('카카오 SDK 로드 실패<br>앱 키·플랫폼 도메인 등록·카카오맵 사용 설정을 확인하세요.');
}

setTimeout(() => {
  if (!kakaoMap) showMapError('카카오 지도 응답 없음<br>현재 접속 도메인이 카카오 개발자 콘솔에 등록됐는지 확인하세요.');
}, 6000);

// ---------------------------------------------------------------------
// 내 현위치 표시 (파란 점, 실시간 갱신)
// ---------------------------------------------------------------------
let myLocationOverlay = null;
let myLastPosition = null;
let myLocationCentered = false;

function startMyLocation() {
  if (!navigator.geolocation) return;

  const onFix = (position) => {
    const { latitude, longitude } = position.coords;
    updateMyLocation(latitude, longitude);
    centerOnMyLocationOnce();
  };
  const onError = (error) => console.warn('현위치를 가져오지 못했습니다:', error.message);

  navigator.geolocation.getCurrentPosition(onFix, onError,
    { enableHighAccuracy: false, maximumAge: 60000, timeout: 10000 });

  navigator.geolocation.watchPosition(onFix, onError,
    { enableHighAccuracy: true, maximumAge: 0 });
}

function centerOnMyLocationOnce() {
  if (myLocationCentered || !myLastPosition || !kakaoMap) return;
  if (!document.getElementById('map-view').classList.contains('active')) return;
  myLocationCentered = true;
  kakaoMap.relayout();
  kakaoMap.setLevel(4);
  kakaoMap.setCenter(myLastPosition);
}

function updateMyLocation(lat, lon) {
  myLastPosition = new kakao.maps.LatLng(lat, lon);

  if (!myLocationOverlay) {
    myLocationOverlay = new kakao.maps.CustomOverlay({
      position: myLastPosition,
      content: '<div class="my-location-dot"></div>',
      xAnchor: 0.5,
      yAnchor: 0.5,
      zIndex: 10
    });
    myLocationOverlay.setMap(kakaoMap);
  } else {
    myLocationOverlay.setPosition(myLastPosition);
  }
}

function moveToMyLocation() {
  if (!kakaoMap) { showAlert('지도가 아직 로드되지 않았습니다.'); return; }
  if (!navigator.geolocation) { showAlert('이 브라우저는 위치 정보를 지원하지 않습니다.'); return; }

  if (myLastPosition) {
    kakaoMap.setLevel(4);
    kakaoMap.panTo(myLastPosition);
    return;
  }

  navigator.geolocation.getCurrentPosition(
    (position) => {
      const { latitude, longitude } = position.coords;
      updateMyLocation(latitude, longitude);
      kakaoMap.setLevel(4);
      kakaoMap.panTo(myLastPosition);
    },
    () => { showAlert('위치를 가져오지 못했습니다.\n브라우저의 위치 권한을 허용해주세요.'); },
    { enableHighAccuracy: true, timeout: 10000 }
  );
}

// ---------------------------------------------------------------------
// 💡 포트홀 팝업 주소 표시 + 주소 복사
// ---------------------------------------------------------------------
let potholeGeocoder = null;
const potholeAddressCache = {}; // 포트홀 uid별 주소 저장

// 좌표 → 주소 변환 (도로명 우선, 없으면 지번)
function getPotholeAddress(lat, lng) {
  return new Promise((resolve) => {
    if (typeof kakao === 'undefined' || !kakao.maps.services) { resolve(null); return; }
    if (!potholeGeocoder) potholeGeocoder = new kakao.maps.services.Geocoder();

    let done = false;
    const timer = setTimeout(() => { if (!done) { done = true; resolve(null); } }, 3000);

    potholeGeocoder.coord2Address(lng, lat, (result, status) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (status === kakao.maps.services.Status.OK && result.length > 0) {
        const r = result[0];
        const road = r.road_address ? r.road_address.address_name : '';
        const jibun = r.address ? r.address.address_name : '';
        resolve(road || jibun || null);
      } else {
        resolve(null);
      }
    });
  });
}

// 💡 팝업 밖에 따로 뜨는 흰색 복사 메뉴 (아이폰 텍스트 선택 메뉴 스타일)
let potholeCopyMenu = null;
let potholeCopyUid = null;
let potholeCopyTarget = null;

function getPotholeCopyMenu() {
  if (potholeCopyMenu) return potholeCopyMenu;
  const menu = document.createElement('div');
  menu.id = 'pothole-copy-menu';
  menu.style.cssText = `
    display:none; position:fixed; z-index:10000;
    background:#ffffff; color:#111; font-size:13px; font-weight:500;
    padding:8px 18px; border-radius:10px; cursor:pointer; white-space:nowrap;
    border:1px solid rgba(0,0,0,0.06); box-shadow:0 4px 14px rgba(0,0,0,0.18);
    -webkit-user-select:none; user-select:none;
  `;
  menu.innerText = '복사';
  menu.addEventListener('click', (e) => { e.stopPropagation(); copyPotholeAddress(); });
  document.body.appendChild(menu);
  potholeCopyMenu = menu;
  return menu;
}

function hidePotholeCopyMenu() {
  if (potholeCopyMenu) potholeCopyMenu.style.display = 'none';
  if (potholeCopyTarget) potholeCopyTarget.style.background = '';
  potholeCopyUid = null;
  potholeCopyTarget = null;
}

// 주소 클릭 → 주소 위에 복사 메뉴 띄우기 (다시 누르면 닫힘)
function togglePotholeCopy(event, uid, el) {
  if (event) event.stopPropagation();
  if (!potholeAddressCache[uid]) return;

  const menu = getPotholeCopyMenu();
  if (menu.style.display === 'block' && potholeCopyUid === uid) { hidePotholeCopyMenu(); return; }

  hidePotholeCopyMenu();
  potholeCopyUid = uid;
  potholeCopyTarget = el;
  el.style.background = 'rgba(38,103,247,0.15)'; // 선택된 것처럼 하이라이트

  menu.innerText = '복사';
  menu.style.visibility = 'hidden';
  menu.style.display = 'block';

  const rect = el.getBoundingClientRect();
  const mw = menu.offsetWidth;
  const mh = menu.offsetHeight;

  let top = rect.top - mh - 8;              // 기본: 주소 위쪽
  if (top < 8) top = rect.bottom + 8;       // 위에 공간 없으면 아래쪽
  let left = rect.left + rect.width / 2 - mw / 2;
  left = Math.max(8, Math.min(left, window.innerWidth - mw - 8));

  menu.style.top = top + 'px';
  menu.style.left = left + 'px';
  menu.style.visibility = 'visible';
}

// 메뉴·주소 바깥을 누르거나 스크롤하면 닫기
document.addEventListener('click', (e) => {
  if (!potholeCopyMenu || potholeCopyMenu.style.display !== 'block') return;
  if (e.target.closest('#pothole-copy-menu') || e.target.closest('.pothole-addr')) return;
  hidePotholeCopyMenu();
});
window.addEventListener('scroll', hidePotholeCopyMenu, true);
window.addEventListener('resize', hidePotholeCopyMenu);

// 주소 복사
async function copyPotholeAddress() {
  const text = potholeAddressCache[potholeCopyUid];
  const btn = potholeCopyMenu;
  if (!text) return;

  let success = false;
  try {
    await navigator.clipboard.writeText(text);
    success = true;
  } catch (e) {
    const temp = document.createElement('textarea');
    temp.value = text;
    temp.style.position = 'fixed';
    temp.style.opacity = '0';
    document.body.appendChild(temp);
    temp.select();
    success = document.execCommand('copy');
    document.body.removeChild(temp);
  }

  if (btn) {
    btn.innerText = success ? '복사됨' : '복사 실패';
    setTimeout(hidePotholeCopyMenu, 1000);
  }
}

function formatPotholeTime(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// 포트홀 팝업 HTML
function buildPotholeInfo(item, status, uid, addressText) {
  const badgeColor = status === '발견' ? '#EF4444' : '#3B82F6';
  // 💡 짧은 형식(2026.11.16 22:43)으로 표시 → 줄바꿈되어 팝업 밖으로 넘치는 현상 방지
  const timeString = item.created_at ? formatPotholeTime(new Date(item.created_at)) : '시간 정보 없음';
  const imageTag = item.image_url ? `<img src="${item.image_url}" style="width:100%; height:100px; object-fit:cover; margin-top:8px; border-radius:4px;">` : '';
  const canCopy = !!potholeAddressCache[uid];

  return `
    <div style="padding:10px 10px 12px; font-size:12px; width:200px; box-sizing:border-box;">
      <span style="background-color:${badgeColor}; color:white; padding:2px 6px; border-radius:4px;">${status}</span>
      <strong style="display:block; margin-top:6px; font-size:13px;">${item.title}</strong>

      <p class="pothole-addr" onclick="togglePotholeCopy(event, '${uid}', this)"
         style="margin:4px 0 0 0; color:#2667f7; font-size:11px; line-height:1.4; word-break:keep-all; overflow-wrap:anywhere; border-radius:3px; ${canCopy ? 'cursor:pointer; text-decoration:underline dotted;' : ''}">
        ${escapeText(addressText)}
      </p>

      ${imageTag}
      <p style="margin:4px 0 0 0; color:#666;">${item.description || '상세 내용 없음'}</p>
      <p style="margin:6px 0 2px 0; color:#888; font-size:11px; white-space:nowrap;">발견: ${timeString}</p>
    </div>
  `;
}

// ---------------------------------------------------------------------
// 💡 가까이 붙어 있는 포트홀 → 목록으로 먼저 보여주고, 고르면 상세 팝업
// ---------------------------------------------------------------------
const potholeEntries = [];      // { uid, item, status, lat, lng, position, marker, infowindow, addressLoaded }
const NEARBY_PX = 40;           // 화면상 이 거리(px) 안에 있으면 "겹친 포트홀"로 판단
let potholeListOverlay = null;
let potholeListOwner = null;

function closePotholeList() {
  if (potholeListOverlay) { potholeListOverlay.setMap(null); potholeListOverlay = null; }
  potholeListOwner = null;
}

// 클릭한 마커 주변(화면 기준 NEARBY_PX 이내)의 포트홀 찾기 → 가까운 순 정렬
function findNearbyPotholes(entry) {
  const proj = kakaoMap.getProjection();
  const p0 = proj.containerPointFromCoords(entry.position);
  return potholeEntries
    .map(e => {
      const p = proj.containerPointFromCoords(e.position);
      return { e, d: Math.hypot(p.x - p0.x, p.y - p0.y) };
    })
    .filter(o => o.d <= NEARBY_PX)
    .sort((a, b) => a.d - b.d)
    .map(o => o.e);
}

// 포트홀 상세 팝업 열기
async function openPotholeInfo(entry) {
  closeInfoWindow();
  entry.infowindow.open(kakaoMap, entry.marker);
  activeInfoWindow = entry.infowindow;

  // 처음 열 때만 주소 조회 (이후에는 저장된 주소 사용)
  if (!entry.addressLoaded) {
    // 💡 데이터에 주소가 들어 있으면(테스트 포트홀 등) 그대로 사용, 없으면 좌표로 조회
    const address = entry.item.address || await getPotholeAddress(entry.lat, entry.lng);
    entry.addressLoaded = true;
    potholeAddressCache[entry.uid] = address;
    entry.infowindow.setContent(buildPotholeInfo(entry.item, entry.status, entry.uid, address || '주소 정보 없음'));
    // 💡 내용이 바뀌면 카카오 팝업이 크기를 다시 계산하지 않음 → 닫았다 다시 열어서 높이 맞춤
    if (activeInfoWindow === entry.infowindow) {
      entry.infowindow.close();
      entry.infowindow.open(kakaoMap, entry.marker);
    }
  }
}

// 겹친 포트홀 목록 팝업
function showPotholeList(owner, list) {
  closeInfoWindow();

  const rows = list.map(e => {
    const idx = potholeEntries.indexOf(e);
    const badgeColor = e.status === '발견' ? '#EF4444' : '#3B82F6';
    const time = e.item.created_at ? new Date(e.item.created_at).toLocaleDateString() : '';
    return `
      <div class="ph-list-item" onclick="selectPotholeFromList(event, ${idx})">
        <span class="ph-list-badge" style="background:${badgeColor};">${e.status}</span>
        <div class="ph-list-main">
          <div class="ph-list-title">${escapeText(e.item.title || '포트홀')}</div>
          ${time ? `<div class="ph-list-time">${time}</div>` : ''}
        </div>
        <span class="ph-list-arrow">›</span>
      </div>
    `;
  }).join('');

  const html = `
    <div class="ph-list"
         onmousedown="kakao.maps.event.preventMap()"
         ontouchstart="kakao.maps.event.preventMap()"
         onclick="event.stopPropagation()"
         onwheel="event.stopPropagation()">
      <div class="ph-list-body">${rows}</div>
    </div>
  `;

  potholeListOverlay = new kakao.maps.CustomOverlay({
    position: owner.position,
    content: html,
    xAnchor: 0.5,
    yAnchor: 1,
    zIndex: 20
  });
  potholeListOverlay.setMap(kakaoMap);
  potholeListOwner = owner;
}

// 목록에서 하나 고르면 → 그 포트홀 상세 팝업
function selectPotholeFromList(event, idx) {
  if (event) event.stopPropagation();
  const entry = potholeEntries[idx];
  if (entry) openPotholeInfo(entry);
}

// 마커 클릭: 근처에 다른 포트홀이 있으면 목록, 혼자면 바로 상세
function onPotholeMarkerClick(entry) {
  // 같은 마커를 다시 누르면 닫기
  if (potholeListOwner === entry || activeInfoWindow === entry.infowindow) { closeInfoWindow(); return; }

  const nearby = findNearbyPotholes(entry);
  if (nearby.length > 1) showPotholeList(entry, nearby);
  else openPotholeInfo(entry);
}

// ---------------------------------------------------------------------
// 🧪 테스트용 가짜 포트홀 (DB에 저장하지 않음, 화면에만 표시)
//    확인 끝나면 USE_TEST_POTHOLES = false 로 바꾸면 됨
// ---------------------------------------------------------------------
const USE_TEST_POTHOLES = true;
const TEST_CENTER = { lat: 37.5665, lng: 126.9780 }; // 서울시청
// 💡 사진을 코드 안에 직접 넣음 (파일 경로 문제 없이 항상 표시됨)
const TEST_IMAGE_URL = 'data:image/jpeg;base64,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';

function makeTestPotholes() {
  const now = new Date();
  const hoursAgo = (h) => new Date(now.getTime() - h * 3600 * 1000).toISOString();
  const { lat, lng } = TEST_CENTER;
  return [
    // ① 혼자 있는 포트홀 → 누르면 바로 상세 팝업
    { id: 'test-1', title: '시청 앞 포트홀', description: '지름 약 40cm, 깊이 5cm', status: '발견',
      address: '서울특별시 중구 세종대로 110',
      latitude: lat, longitude: lng, created_at: hoursAgo(1), image_url: TEST_IMAGE_URL },
    // ② 수리중 상태 (파란 핀)
    { id: 'test-2', title: '세종대로 수리중', description: '보수 공사 진행 중', status: '수리중',
      address: '서울특별시 종로구 세종대로 172',
      latitude: lat + 0.004, longitude: lng - 0.003, created_at: hoursAgo(30), image_url: TEST_IMAGE_URL },
    // ③~⑤ 서로 붙어 있는 포트홀 3개 → 누르면 목록 팝업
    { id: 'test-3', title: '을지로 겹침 A', description: '차선 중앙', status: '발견',
      address: '서울특별시 중구 을지로 30',
      latitude: lat - 0.003, longitude: lng + 0.004, created_at: hoursAgo(2), image_url: TEST_IMAGE_URL },
    { id: 'test-4', title: '을지로 겹침 B', description: '우측 차선', status: '발견',
      address: '서울특별시 중구 을지로 35',
      latitude: lat - 0.00305, longitude: lng + 0.00408, created_at: hoursAgo(5), image_url: TEST_IMAGE_URL },
    { id: 'test-5', title: '을지로 겹침 C', description: '맨홀 주변 침하', status: '수리중',
      address: '서울특별시 중구 을지로 42',
      latitude: lat - 0.00296, longitude: lng + 0.00395, created_at: hoursAgo(50), image_url: TEST_IMAGE_URL },
  ];
}


async function fetchAndDisplayPotholes(map) {
  const { data: dbData, error } = await mapDB.from('potholes').select('*');
  if (error) console.error('포트홀 데이터 로드 실패:', error);

  let data = error ? [] : (dbData || []);
  if (USE_TEST_POTHOLES) {
    data = data.concat(makeTestPotholes());
    // 내 위치로 자동 이동하지 않고 테스트 포트홀 위치에 지도 고정
    myLocationCentered = true;
    map.setLevel(4);
    map.setCenter(new kakao.maps.LatLng(TEST_CENTER.lat, TEST_CENTER.lng));
  }
  if (data.length === 0) return;

  const todayString = toDateString(new Date());
  let todayPotholeCount = 0;

  data.forEach((item, index) => {
    const uid = item.id !== undefined && item.id !== null ? String(item.id) : `idx${index}`;
    const lat = parseFloat(item.latitude);
    const lng = parseFloat(item.longitude);
    const position = new kakao.maps.LatLng(lat, lng);
    const status = item.status === '수리중' ? '수리중' : '발견';
    const markerImage = new kakao.maps.MarkerImage(MARKER_IMAGES[status], new kakao.maps.Size(30, 30));
    const marker = new kakao.maps.Marker({ position, image: markerImage });
    marker.setMap(map);

    const infowindow = new kakao.maps.InfoWindow({
      content: buildPotholeInfo(item, status, uid, item.address || '주소 확인 중...'),
      removable: false
    });

    const entry = { uid, item, status, lat, lng, position, marker, infowindow, addressLoaded: false };
    potholeEntries.push(entry);

    kakao.maps.event.addListener(marker, 'click', () => onPotholeMarkerClick(entry));

    if (item.created_at && toDateString(new Date(item.created_at)) === todayString) todayPotholeCount++;
  });

  document.getElementById('today-count').innerText = todayPotholeCount;
}

async function fetchLatestGpsLog() {
  const { data, error } = await mapDB.from('gps_logs').select('*').order('created_at', { ascending: false }).limit(1);
  if (!error && data.length > 0) updateGpsMarker(data[0].lat, data[0].lon);
}

function updateGpsMarker(lat, lon) {
  if (!kakaoMap) return;
  const position = new kakao.maps.LatLng(lat, lon);
  if (gpsMarker) gpsMarker.setPosition(position);
  else {
    gpsMarker = new kakao.maps.Marker({ position: position, image: new kakao.maps.MarkerImage('./blue_pin.svg', new kakao.maps.Size(30, 30)) });
    gpsMarker.setMap(kakaoMap);
  }
}

function subscribeGpsLogs() {
  mapDB.channel('public:gps_logs').on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'gps_logs' }, payload => {
    updateGpsMarker(payload.new.lat, payload.new.lon);
  }).subscribe();
}

function toDateString(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

// ---------------------------------------------------------------------
// 지도 검색 (장소명 → 키워드 검색, 실패 시 주소 검색)
// ---------------------------------------------------------------------
let mapSearchResults = [];
let searchMarker = null;
let searchLabel = null;

function searchOnMap() {
  const input = document.getElementById('map-search-input');
  const keyword = input.value.trim();
  if (!keyword) return;

  if (!kakaoMap || typeof kakao === 'undefined' || !kakao.maps.services) {
    showAlert('지도가 아직 준비되지 않았습니다.');
    return;
  }

  input.blur(); // 모바일 키보드 닫기
  closeInfoWindow();

  const ps = new kakao.maps.services.Places();
  const options = myLastPosition ? { location: myLastPosition } : {};

  ps.keywordSearch(keyword, (places, status) => {
    if (status === kakao.maps.services.Status.OK && places.length > 0) {
      mapSearchResults = places.map(p => ({
        name: p.place_name,
        address: p.road_address_name || p.address_name,
        category: p.category_group_name || '',
        distance: p.distance ? Number(p.distance) : null,
        lat: parseFloat(p.y),
        lng: parseFloat(p.x)
      }));
      renderMapSearchResults();
      return;
    }

    // 장소가 없으면 주소로 다시 검색
    const geocoder = new kakao.maps.services.Geocoder();
    geocoder.addressSearch(keyword, (result, addrStatus) => {
      if (addrStatus === kakao.maps.services.Status.OK && result.length > 0) {
        mapSearchResults = result.map(r => ({
          name: r.road_address ? r.road_address.address_name : r.address_name,
          address: r.address ? r.address.address_name : r.address_name,
          category: '주소',
          distance: null,
          lat: parseFloat(r.y),
          lng: parseFloat(r.x)
        }));
        renderMapSearchResults();
      } else {
        mapSearchResults = [];
        renderMapSearchResults('검색 결과가 없습니다.');
      }
    });
  }, options);
}

function formatDistance(m) {
  return m >= 1000 ? (m / 1000).toFixed(1) + 'km' : m + 'm';
}

function renderMapSearchResults(emptyMessage) {
  const box = document.getElementById('map-search-results');
  if (mapSearchResults.length === 0) {
    box.innerHTML = `<div class="msr-empty">${emptyMessage || '검색 결과가 없습니다.'}</div>`;
    box.classList.add('open');
    return;
  }

  box.innerHTML = mapSearchResults.map((r, i) => `
    <div class="msr-item" onclick="moveToSearchResult(${i})">
      <div class="msr-main">
        <div class="msr-name">${escapeText(r.name)}</div>
        <div class="msr-addr">${escapeText(r.address || '')}</div>
      </div>
      <div class="msr-side">
        ${r.category ? `<span class="msr-cat">${escapeText(r.category)}</span>` : ''}
        ${r.distance !== null ? `<span class="msr-dist">${formatDistance(r.distance)}</span>` : ''}
      </div>
    </div>
  `).join('');
  box.classList.add('open');
}

function moveToSearchResult(index) {
  const r = mapSearchResults[index];
  if (!r) return;

  const position = new kakao.maps.LatLng(r.lat, r.lng);

  if (searchMarker) searchMarker.setPosition(position);
  else {
    searchMarker = new kakao.maps.Marker({ position, zIndex: 5 });
    searchMarker.setMap(kakaoMap);
  }

  const labelHtml = `<div class="search-label">${escapeText(r.name)}</div>`;
  if (searchLabel) { searchLabel.setPosition(position); searchLabel.setContent(labelHtml); }
  else {
    searchLabel = new kakao.maps.CustomOverlay({ position, content: labelHtml, yAnchor: 2.6, zIndex: 6 });
    searchLabel.setMap(kakaoMap);
  }

  kakaoMap.setLevel(3);
  kakaoMap.panTo(position);

  document.getElementById('map-search-input').value = r.name;
  toggleMapSearchClear();
  hideMapSearchResults();
}

function hideMapSearchResults() {
  const box = document.getElementById('map-search-results');
  if (box) box.classList.remove('open');
}

function toggleMapSearchClear() {
  const input = document.getElementById('map-search-input');
  document.getElementById('map-search-clear').style.display = input.value ? 'flex' : 'none';
}

function clearMapSearch() {
  const input = document.getElementById('map-search-input');
  input.value = '';
  toggleMapSearchClear();
  hideMapSearchResults();
  mapSearchResults = [];
  if (searchMarker) { searchMarker.setMap(null); searchMarker = null; }
  if (searchLabel) { searchLabel.setMap(null); searchLabel = null; }
}

// =====================================================================
// 3. 공통 알림 / 확인 팝업
// =====================================================================
function showAlert(message, callback = null) {
  return new Promise(resolve => {
    const modal = document.getElementById('custom-modal');
    document.getElementById('modal-message').innerText = message;
    document.getElementById('modal-buttons').innerHTML = `<button class="btn" style="background:#2667f7;" onclick="closeModal()">확인</button>`;
    modal.style.display = 'flex';
    window.closeModal = () => { modal.style.display = 'none'; if (callback) callback(); resolve(); };
  });
}

function showConfirm(message) {
  return new Promise(resolve => {
    const modal = document.getElementById('custom-modal');
    document.getElementById('modal-message').innerText = message;
    document.getElementById('modal-buttons').innerHTML = `
      <button class="btn" style="background:#2667f7;" onclick="handleConfirm(true)">확인</button>
      <button class="btn btn-gray" onclick="handleConfirm(false)">취소</button>
    `;
    modal.style.display = 'flex';
    window.handleConfirm = (result) => { modal.style.display = 'none'; resolve(result); };
  });
}

// =====================================================================
// 4. 로그인 및 사용자 정보 불러오기 유틸
// =====================================================================
async function checkUser() {
  const { data: { session } } = await supabaseClient.auth.getSession();
  currentUser = session ? session.user : null;
  renderAuthBar();
  renderMyPage();
}

function getUserName(user) { return user ? (user.user_metadata.name || user.user_metadata.full_name || '사용자') : '익명'; }
function getUserAvatar(user) { return user ? fixAvatarUrl(user.user_metadata.avatar_url) : PLACEHOLDER_LOGIN; }
function escapeText(str) { return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function authorOf(item) { return escapeText(item.author_name || '익명'); }
function avatarOf(item) { return fixAvatarUrl(item.author_avatar_url); }

function saveReturnView() {
  const current = document.querySelector('.view.active');
  const view = current ? current.id.replace('-view', '') : 'map';
  try { localStorage.setItem(RETURN_KEY, JSON.stringify({ view, reviewId: view === 'detail' ? currentReviewId : null, time: Date.now() })); } catch (e) {}
}

function popReturnView() {
  try {
    const raw = localStorage.getItem(RETURN_KEY);
    localStorage.removeItem(RETURN_KEY);
    if (!raw) return null;
    const saved = JSON.parse(raw);
    if (Date.now() - saved.time > RETURN_TTL) return null;
    return saved;
  } catch (e) { return null; }
}

async function loginWithKakao() {
  saveReturnView();
  const { error } = await supabaseClient.auth.signInWithOAuth({
    provider: 'kakao', options: { redirectTo: window.location.origin + window.location.pathname, queryParams: { scope: 'profile_nickname,profile_image' } }
  });
  if (error) await showAlert('로그인 실패: ' + error.message);
}

async function logout() { saveReturnView(); await supabaseClient.auth.signOut(); window.location.reload(); }

function renderAuthBar() {
  const statusDiv = document.getElementById('user-status');
  const btnBox = document.getElementById('auth-btn-container');
  if (!statusDiv || !btnBox) return;

  if (currentUser) {
    statusDiv.innerHTML = `<b>${escapeText(getUserName(currentUser))}</b>님 환영합니다!`;
    btnBox.innerHTML = `<button class="btn btn-gray btn-sm" onclick="logout()">로그아웃</button>`;
  } else {
    statusDiv.innerHTML = '로그인이 필요합니다.';
    btnBox.innerHTML = `<button class="btn btn-kakao btn-sm" onclick="loginWithKakao()">카카오 로그인</button>`;
  }
}

// =====================================================================
// 5. 게시판 및 전체화면 검색 기능
// =====================================================================
async function loadReviews() {
  const { data: reviews, error: reviewError } = await supabaseClient.from('pothole_reviews').select('*').order('created_at', { ascending: false });
  if (reviewError) { document.getElementById('review-list').innerHTML = '후기를 불러오지 못했습니다.'; return; }

  const { data: comments, error: commentError } = await supabaseClient.from('pothole_comments').select('review_id');
  
  const commentCountMap = {};
  if (!commentError && comments) {
    comments.forEach(c => {
      commentCountMap[c.review_id] = (commentCountMap[c.review_id] || 0) + 1;
    });
  }

  allReviews = reviews.map(r => ({
    ...r,
    _comment_count: commentCountMap[r.id] || 0
  }));
  
  displayReviews(allReviews, 'review-list');

  if (document.getElementById('search-view').classList.contains('active') && currentSearchKeyword) {
    executeSearch(currentSearchKeyword);
  }

  checkNotifications();
}

function displayReviews(reviews, containerId = 'review-list') {
  const listDiv = document.getElementById(containerId);
  if (reviews.length === 0) { listDiv.innerHTML = '<p style="text-align:center; color:#888; padding:20px;">검색된 후기가 없습니다.</p>'; return; }
  
  listDiv.innerHTML = reviews.map(review => {
    const dateStr = review.created_at ? review.created_at.substring(0, 10) : '';
    const contentPreview = escapeText(review.content || '');
    const locationText = review.location ? escapeText(review.location) : '위치 미지정';
    const commentCount = review._comment_count !== undefined ? review._comment_count : 0;
    const hasImage = !!review.image_url;
    
    const locationHtml = `
      <div style="background-color: #2667f7; color: white; font-size: 13px; font-weight: bold; padding: 4px 14px; border-radius: 8px; width: fit-content; margin-bottom: 8px;">
        ${locationText}
      </div>
    `;

    const thumbnailHtml = hasImage
      ? `<img src="${review.image_url}" style="position:absolute; top:20px; right:0; width:80px; height:80px; object-fit:cover; border-radius:10px; border:1px solid #e2e8f0; z-index:2;">`
      : ``;
    
    return `
      <div class="review-item" onclick="showDetailView(${review.id})" style="position:relative; display:flex; flex-direction:column; align-items:stretch; text-align:left; padding:20px 0; border-bottom:1px solid #e5e7eb;">
        <div style="width:100%; box-sizing:border-box; min-width:0; ${hasImage ? 'padding-right:96px;' : ''}">
          ${locationHtml}
          <div style="font-weight:bold; font-size:16px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; width:100%; color:#111; margin-bottom:4px;">
            ${review.title}
          </div>
          <div style="font-size:13px; color:#555; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; text-overflow:ellipsis; white-space:normal; line-height:1.4;">
            ${contentPreview}
          </div>
        </div>
        <div style="width:100%; display:flex; align-items:center; justify-content:space-between; margin-top:8px; position:relative; z-index:1;">
          <div style="font-size:12px; color:#888;">${dateStr}</div>
          <div style="display:flex; align-items:center; gap:4px; font-size:12px; color:#666; font-weight:500;">
            <!-- 💡 talk.svg 이미지로 대체 -->
            <img src="talk.svg" style="width: 14px; height: 14px; object-fit: contain; opacity: 0.75;" alt="댓글">
            <span>${commentCount}</span>
          </div>
        </div>
        ${thumbnailHtml}
      </div>
    `;
  }).join('');
}

function getRecentSearches() {
  try { return JSON.parse(localStorage.getItem(RECENT_SEARCH_KEY)) || []; } 
  catch (e) { return []; }
}

function saveRecentSearch(keyword) {
  if (!keyword) return;
  let searches = getRecentSearches();
  searches = searches.filter(k => k !== keyword);
  searches.unshift(keyword);
  if (searches.length > 10) searches.pop();
  localStorage.setItem(RECENT_SEARCH_KEY, JSON.stringify(searches));
}

function removeRecentSearch(keyword) {
  let searches = getRecentSearches();
  searches = searches.filter(k => k !== keyword);
  localStorage.setItem(RECENT_SEARCH_KEY, JSON.stringify(searches));
  renderRecentSearches();
}

function renderRecentSearches() {
  const listDiv = document.getElementById('recent-search-list');
  const searches = getRecentSearches();
  if (searches.length === 0) {
    listDiv.innerHTML = '<div style="color: #888; font-size: 13px;">최근 검색어가 없습니다.</div>';
    return;
  }
  listDiv.innerHTML = searches.map(keyword => `
    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px; font-size: 15px;">
      <div style="display: flex; align-items: center; gap: 10px; cursor: pointer; flex: 1;" onclick="executeSearch('${escapeHtml(keyword)}')">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#888" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>
        <span>${escapeHtml(keyword)}</span>
      </div>
      <button onclick="removeRecentSearch('${escapeHtml(keyword)}')" style="background: none; border: none; color: #999; cursor: pointer; font-size: 20px; padding: 0 5px;">×</button>
    </div>
  `).join('');
}

function openSearchView() {
  go('search');
  const searchInput = document.getElementById('real-search-input');
  if (searchInput) searchInput.focus();
  renderRecentSearches();
}

function executeSearch(keyword = null) {
  const finalKeyword = keyword !== null ? keyword : document.getElementById('real-search-input').value.trim();
  
  if (!finalKeyword) {
    document.getElementById('recent-search-section').style.display = 'block';
    document.getElementById('search-result-list').style.display = 'none';
    renderRecentSearches();
    return;
  }
  
  saveRecentSearch(finalKeyword);
  currentSearchKeyword = finalKeyword.toLowerCase();
  document.getElementById('real-search-input').value = finalKeyword;
  
  const filtered = allReviews.filter(r =>
    (r.title || '').toLowerCase().includes(currentSearchKeyword) || 
    (r.location || '').toLowerCase().includes(currentSearchKeyword) ||
    (r.content || '').toLowerCase().includes(currentSearchKeyword) || 
    (r.author_name || '').toLowerCase().includes(currentSearchKeyword)
  );
  
  document.getElementById('recent-search-section').style.display = 'none';
  document.getElementById('search-result-list').style.display = 'block';
  
  displayReviews(filtered, 'search-result-list');
}

window.handleSearchInput = function() {
  const val = document.getElementById('real-search-input').value.trim();
  if (!val) {
    currentSearchKeyword = '';
    document.getElementById('recent-search-section').style.display = 'block';
    document.getElementById('search-result-list').style.display = 'none';
    renderRecentSearches();
  }
};

window.closeSearch = function() {
  currentSearchKeyword = '';
  document.getElementById('real-search-input').value = '';
  document.getElementById('recent-search-section').style.display = 'block';
  document.getElementById('search-result-list').style.display = 'none';
  go('board');
};

// =====================================================================
// 5-1. 알림 기능 로직
// =====================================================================
function openNotificationView() {
  if (!currentUser) {
    showAlert('로그인 후 이용 가능합니다!', () => { go('mypage'); });
    return;
  }
  
  localStorage.setItem(`last_noti_${currentUser.id}`, Date.now());
  const badge = document.getElementById('noti-badge');
  if (badge) badge.style.display = 'none';

  go('notification');
  loadNotifications();
}

async function loadNotifications() {
  const listDiv = document.getElementById('notification-list');
  listDiv.innerHTML = '<div style="text-align:center; padding:20px; color:#888;">알림을 불러오는 중...</div>';

  const myReviews = allReviews.filter(r => r.user_id === currentUser.id);
  if (myReviews.length === 0) {
    listDiv.innerHTML = '<div style="text-align:center; padding:20px; color:#888;">아직 작성한 게시글이 없습니다.</div>';
    return;
  }

  const myReviewIds = myReviews.map(r => r.id);

  const { data: comments, error } = await supabaseClient.from('pothole_comments')
    .select('*')
    .in('review_id', myReviewIds)
    .neq('user_id', currentUser.id)
    .order('created_at', { ascending: false });

  if (error || !comments || comments.length === 0) {
    listDiv.innerHTML = '<div style="text-align:center; padding:20px; color:#888;">새로운 알림이 없습니다.</div>';
    return;
  }

  listDiv.innerHTML = comments.map(comment => {
    const review = myReviews.find(r => r.id === comment.review_id);
    const date = new Date(comment.created_at);
    const dateStr = `${date.getMonth() + 1}/${date.getDate()} ${date.getHours()}:${String(date.getMinutes()).padStart(2, '0')}`;
    
    return `
      <div onclick="showDetailView(${comment.review_id})" style="padding: 16px 0; border-bottom: 1px solid #e5e7eb; cursor: pointer;">
        <div style="font-size: 14px; margin-bottom: 6px; color: #111; line-height: 1.4;">
          <b style="color: #2667f7;">${escapeText(comment.author_name)}</b>님이 내 글 <b>'${escapeText(review.title)}'</b>에 댓글을 남겼습니다.
        </div>
        <div style="font-size: 13px; color: #666; margin-bottom: 8px; background: #f9fafb; padding: 10px; border-radius: 8px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;">
          "${escapeText(comment.content)}"
        </div>
        <div style="font-size: 12px; color: #999;">${dateStr}</div>
      </div>
    `;
  }).join('');
}

async function checkNotifications() {
  if (!currentUser) return;
  const badge = document.getElementById('noti-badge');
  if (!badge) return;

  const myReviews = allReviews.filter(r => r.user_id === currentUser.id);
  if (myReviews.length === 0) return;

  const myReviewIds = myReviews.map(r => r.id);
  
  const { data: comments, error } = await supabaseClient.from('pothole_comments')
    .select('created_at')
    .in('review_id', myReviewIds)
    .neq('user_id', currentUser.id)
    .order('created_at', { ascending: false })
    .limit(1);

  if (!error && comments && comments.length > 0) {
    const lastNotiTime = localStorage.getItem(`last_noti_${currentUser.id}`) || 0;
    const latestCommentTime = new Date(comments[0].created_at).getTime();
    badge.style.display = latestCommentTime > lastNotiTime ? 'block' : 'none';
  }
}

// =====================================================================
// 6. 게시글 상세 및 댓글 / 답글 
// =====================================================================
function showDetailView(id) {
  const review = allReviews.find(r => r.id === id);
  if (!review) return;
  go('detail');
  currentReviewId = review.id;

  const actions = document.getElementById('author-actions');
  const isAuthor = currentUser && review.user_id === currentUser.id;

  actions.innerHTML = `
    <div style="position:relative; display:inline-block;">
      <button onclick="toggleDetailMenu(event)" style="background:none; border:none; font-size:22px; padding:0 5px; cursor:pointer; color:#555; font-weight:bold;">⋮</button>
      <div id="detail-menu" class="pop-menu" style="top:35px;">
        ${isAuthor ? `
          <div class="pop-item" onclick="closeDetailMenu(); editReview(${review.id});">${menuIcon('edit')}<span>수정</span></div>
          <div class="pop-item" onclick="closeDetailMenu(); deleteReview(${review.id});">${menuIcon('trash')}<span>삭제</span></div>
        ` : ''}
        <div class="pop-item" onclick="closeDetailMenu(); shareUrl(${review.id});">${menuIcon('share')}<span>URL 공유</span></div>
      </div>
    </div>
  `;

  const imgHtml = review.image_url ? `<img src="${review.image_url}" class="review-img" style="max-width:100%; margin-top:15px; border-radius:8px;">` : '';
  const detailDateStr = review.created_at ? review.created_at.substring(0, 10) : '';

  document.getElementById('detail-content').innerHTML = `
    <div style="display:flex; align-items:center; margin-bottom:15px;">
      <img src="${avatarOf(review)}" style="width:44px; height:44px; border-radius:50%; margin-right:12px; object-fit:cover; background:#eee;" alt="프로필">
      <div>
        <div style="color:#333; font-size:15px; font-weight:bold;">${authorOf(review)}</div>
        <div style="color:#888; font-size:12px;">${detailDateStr}</div>
      </div>
    </div>
    <h3 style="margin-top:0; margin-bottom:8px; color: #2667f7;">${review.title}</h3>
    <p style="color:#666; font-size:14px; margin-bottom:10px;">위치: ${review.location}</p>
    <hr class="divider" style="margin-top:0;">
    <p style="line-height:1.6; white-space:pre-line;">${review.content}</p>
    ${imgHtml}
  `;

  loadComments(review.id);
}

function toggleDetailMenu(e) {
  if (e) e.stopPropagation();
  const menu = document.getElementById('detail-menu');
  if (!menu) return;
  closeCommentMenus();
  menu.classList.toggle('open');
}

function closeDetailMenu() {
  const menu = document.getElementById('detail-menu');
  if (menu) menu.classList.remove('open');
}

document.addEventListener('click', function(e) {
  if (!e.target.closest('#author-actions')) closeDetailMenu();
});

async function shareUrl(id) {
  const shareLink = window.location.origin + window.location.pathname + '?review=' + id;
  try {
    await navigator.clipboard.writeText(shareLink);
    showAlert('링크가 클립보드에 복사되었습니다!');
  } catch (err) {
    const tempInput = document.createElement('input');
    tempInput.value = shareLink;
    document.body.appendChild(tempInput);
    tempInput.select();
    document.execCommand('copy');
    document.body.removeChild(tempInput);
    showAlert('링크가 클립보드에 복사되었습니다!');
  }
}

function editReview(id) { const review = allReviews.find(r => r.id === id); if (review) go('write', { review }); }

function resetWriteForm(review) {
  document.getElementById('form-title').innerText = review ? '후기 수정하기' : '새로운 후기 작성하기';
  document.getElementById('edit-id').value = review ? review.id : '';
  document.getElementById('title').value = review ? review.title : '';
  document.getElementById('location').value = review ? review.location : '';
  document.getElementById('content').value = review ? review.content : '';
  document.getElementById('imageFile').value = '';
}

async function saveReview() {
  if (!currentUser) { await showAlert('로그인이 필요합니다!', () => { go('mypage'); }); return; }

  const editId = document.getElementById('edit-id').value;
  const title = document.getElementById('title').value;
  const location = document.getElementById('location').value;
  const content = document.getElementById('content').value;
  const imageInput = document.getElementById('imageFile');

  if (!title || !location || !content) { await showAlert('제목, 위치, 내용은 필수 입력 항목입니다!'); return; }

  let imageUrl = '';
  if (imageInput.files.length > 0) {
    const file = imageInput.files[0];
    const fileName = `${Date.now()}.${file.name.split('.').pop()}`;
    const { error: uploadError } = await supabaseClient.storage.from('review-images').upload(fileName, file);
    if (uploadError) { await showAlert('이미지 업로드 실패: ' + uploadError.message); return; }
    imageUrl = supabaseClient.storage.from('review-images').getPublicUrl(fileName).data.publicUrl;
  }

  const authorName = getUserName(currentUser);
  const authorAvatarUrl = getUserAvatar(currentUser);

  if (editId) {
    const updateData = { title, location, content, author_name: authorName, author_avatar_url: authorAvatarUrl };
    if (imageUrl) updateData.image_url = imageUrl;
    const { error } = await supabaseClient.from('pothole_reviews').update(updateData).eq('id', editId);
    if (error) { await showAlert('후기 수정 실패: ' + error.message); return; }
    await showAlert('후기가 수정되었습니다!');
  } else {
    const { error } = await supabaseClient.from('pothole_reviews').insert([{ 
      title, location, content, image_url: imageUrl, user_id: currentUser.id, author_name: authorName, author_avatar_url: authorAvatarUrl 
    }]);
    if (error) { await showAlert('후기 등록 실패: ' + error.message); return; }
    await showAlert('후기가 성공적으로 등록되었습니다!');
  }
  go('board');
}

async function deleteReview(reviewId) {
  const { error } = await supabaseClient.from('pothole_reviews').delete().eq('id', reviewId);
  if (error) {
    await showAlert('삭제 실패: ' + error.message);
  } else {
    await showAlert('후기가 삭제되었습니다.');
    go('board');
  }
}

async function loadComments(reviewId) {
  const listDiv = document.getElementById('comment-list');
  listDiv.innerHTML = '불러오는 중...';

  const { data, error } = await supabaseClient.from('pothole_comments').select('*').eq('review_id', reviewId).order('created_at', { ascending: true });
  if (error) { listDiv.innerHTML = '댓글을 불러오지 못했습니다.'; return; }
  if (data.length === 0) { listDiv.innerHTML = '<p style="color:#888; font-size:14px;">작성된 댓글이 없습니다. 첫 댓글을 남겨보세요!</p>'; return; }

  const topComments = data.filter(c => !c.parent_id);
  const replies = data.filter(c => c.parent_id);
  // 💡 점 세개(⋮) 메뉴: 누르면 답글쓰기 / 수정 / 삭제가 뜸
  const commentMenu = (c, isTop) => {
    const isOwner = currentUser && c.user_id === currentUser.id;
    const items = [];
    if (isTop) items.push(`<div class="pop-item" onclick="closeCommentMenus(); toggleReplyBox('${c.id}')">${menuIcon('reply')}<span>답글쓰기</span></div>`);
    if (isOwner) {
      items.push(`<div class="pop-item" onclick="closeCommentMenus(); showEditCommentBox('${c.id}', '${escapeHtml(c.content)}')">${menuIcon('edit')}<span>수정</span></div>`);
      items.push(`<div class="pop-item" onclick="closeCommentMenus(); deleteComment('${c.id}', ${reviewId})">${menuIcon('trash')}<span>삭제</span></div>`);
    }
    if (items.length === 0) return '';
    return `
      <div class="cm-wrap">
        <button class="cm-dots" onclick="toggleCommentMenu(event, '${c.id}')">⋮</button>
        <div class="pop-menu cm-menu" id="cm-menu-${c.id}">${items.join('')}</div>
      </div>
    `;
  };

  const metaHTML = (c) => `
    <div style="display:flex; align-items:center; gap:8px;">
      <img src="${avatarOf(c)}" style="width:24px; height:24px; border-radius:50%; object-fit:cover; background:#eee;" alt="프로필">
      <span><b style="color:#333; font-size:13px;">${authorOf(c)}</b> <span style="color:#888; font-size:11px; margin-left:4px;">${c.created_at ? c.created_at.substring(0, 10) : ''}</span></span>
    </div>
  `;

  listDiv.innerHTML = topComments.map(comment => {
    const repliesHtml = replies.filter(r => r.parent_id === comment.id).map(reply => `
      <div class="reply-box" id="comment-container-${reply.id}">
        <div class="comment-meta" style="margin-bottom:6px;">${metaHTML(reply)}${commentMenu(reply, false)}</div>
        <p style="margin:0 0 4px 0; font-size:13px;" id="comment-text-${reply.id}">↳ ${reply.content}</p>
      </div>
    `).join('');

    return `
      <div class="comment-box" id="comment-container-${comment.id}">
        <div class="comment-meta" style="margin-bottom:6px;">
          ${metaHTML(comment)}
          ${commentMenu(comment, true)}
        </div>
        <p style="margin:0 0 5px 0; font-size:14px;" id="comment-text-${comment.id}">${comment.content}</p>
        <div id="reply-box-${comment.id}" style="display:none; margin-top:8px;">
          <textarea id="reply-input-${comment.id}" rows="2" placeholder="답글을 남겨보세요" style="font-size:13px; margin-bottom:5px;"></textarea>
          <button class="btn btn-sm" style="background:#2667f7;" onclick="writeReply(${reviewId}, '${comment.id}')">답글 등록</button>
        </div>
        ${repliesHtml}
      </div>
    `;
  }).join('');
}

function escapeHtml(str) { return str.replace(/'/g, "\\'").replace(/"/g, '&quot;'); }

// 💡 메뉴 아이콘 (검정 선 아이콘)
function menuIcon(name) {
  const paths = {
    edit:  '<path d="M12 20h9"></path><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path>',
    trash: '<polyline points="3 6 5 6 21 6"></polyline><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path><path d="M10 11v6"></path><path d="M14 11v6"></path><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"></path>',
    share: '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line>',
    reply: '<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"></path>'
  };
  return `<svg viewBox="0 0 24 24" fill="none" stroke="#111" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${paths[name] || ''}</svg>`;
}

// 💡 댓글 점 세개 메뉴 열기/닫기
function toggleCommentMenu(e, commentId) {
  e.stopPropagation();
  const menu = document.getElementById(`cm-menu-${commentId}`);
  if (!menu) return;
  const willOpen = !menu.classList.contains('open');
  closeCommentMenus();
  closeDetailMenu();
  if (willOpen) menu.classList.add('open');
}

function closeCommentMenus() {
  document.querySelectorAll('.cm-menu.open').forEach(m => m.classList.remove('open'));
}

document.addEventListener('click', (e) => {
  if (!e.target.closest('.cm-wrap')) closeCommentMenus();
});

function showEditCommentBox(commentId, currentContent) {
  document.getElementById(`comment-text-${commentId}`).innerHTML = `
    <textarea id="edit-comment-input-${commentId}" rows="2" style="font-size:13px; margin-bottom:5px;">${currentContent}</textarea>
    <div class="btn-group">
      <button class="btn btn-sm" style="background:#2667f7;" onclick="updateComment('${commentId}')">저장</button>
      <button class="btn btn-gray btn-sm" onclick="loadComments(currentReviewId)">취소</button>
    </div>
  `;
}

async function updateComment(commentId) {
  const newContent = document.getElementById(`edit-comment-input-${commentId}`).value.trim();
  if (!newContent) { await showAlert('내용을 입력해주세요!'); return; }
  const { error } = await supabaseClient.from('pothole_comments').update({ content: newContent }).eq('id', commentId);
  if (error) await showAlert('댓글 수정 실패: ' + error.message); else loadComments(currentReviewId);
}

async function deleteComment(commentId, reviewId) {
  if (!await showConfirm('정말 이 댓글을 삭제하시겠습니까?')) return;
  const { error } = await supabaseClient.from('pothole_comments').delete().eq('id', commentId);
  if (error) await showAlert('댓글 삭제 실패: ' + error.message); else loadComments(reviewId);
}

function toggleReplyBox(commentId) {
  if (!currentUser) { showAlert('로그인이 필요합니다!', () => { go('mypage'); }); return; }
  const box = document.getElementById(`reply-box-${commentId}`);
  box.style.display = box.style.display === 'none' ? 'block' : 'none';
}

async function writeComment() {
  if (!currentUser) { await showAlert('로그인이 필요합니다!', () => { go('mypage'); }); return; }
  const content = document.getElementById('comment-content').value;
  if (!content) { await showAlert('댓글 내용을 입력해주세요!'); return; }
  
  const authorName = getUserName(currentUser);
  const authorAvatarUrl = getUserAvatar(currentUser);

  const { error } = await supabaseClient.from('pothole_comments').insert([{
    review_id: currentReviewId, content, parent_id: null, user_id: currentUser.id, author_name: authorName, author_avatar_url: authorAvatarUrl
  }]);
  if (error) await showAlert('댓글 등록 실패: ' + error.message); 
  else {
    const input = document.getElementById('comment-content');
    input.value = '';
    input.style.height = ''; // 입력창 높이 원래대로
    loadComments(currentReviewId);
  }
}

// 💡 댓글 입력창: 줄이 늘어나면 높이 자동 증가 (최대 120px)
function autoGrowComment(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 120) + 'px';
}

async function writeReply(reviewId, parentId) {
  if (!currentUser) { await showAlert('로그인이 필요합니다!', () => { go('mypage'); }); return; }
  const content = document.getElementById(`reply-input-${parentId}`).value;
  if (!content) { await showAlert('답글 내용을 입력해주세요!'); return; }
  
  const authorName = getUserName(currentUser);
  const authorAvatarUrl = getUserAvatar(currentUser);

  const { error } = await supabaseClient.from('pothole_comments').insert([{
    review_id: reviewId, content, parent_id: parentId, user_id: currentUser.id, author_name: authorName, author_avatar_url: authorAvatarUrl
  }]);
  if (error) await showAlert('답글 등록 실패: ' + error.message); else loadComments(reviewId);
}

// =====================================================================
// 7. 긴급신고 (배상청구 도우미 로직)
// =====================================================================
function startReport() {
  const resultDiv = document.getElementById('result');

  if (!navigator.geolocation) {
    showAlert('이 브라우저는 위치 정보를 지원하지 않습니다.\n주소를 직접 입력해주세요.');
    return;
  }

  resultDiv.style.display = 'block';
  resultDiv.innerHTML = '<p style="color:#888; font-size:14px;">현재 위치를 확인하는 중...</p>';

  navigator.geolocation.getCurrentPosition(
    (position) => {
      processLocation(position.coords.latitude, position.coords.longitude);
    },
    () => {
      resultDiv.innerHTML = '<p style="color:#d32f2f; font-size:14px;">위치를 가져오지 못했습니다. 위치 권한을 허용하거나 주소를 직접 입력해주세요.</p>';
    },
    { enableHighAccuracy: true, timeout: 10000 }
  );
}

function handleManualAddressSearch() {
  const inputVal = document.getElementById('manual-address-input').value.trim();
  if (!inputVal) {
    showAlert('주소를 입력해주세요!');
    return;
  }

  if (typeof kakao === 'undefined' || !kakao.maps || !kakao.maps.services) { 
    showAlert('카카오 지도 API를 불러올 수 없습니다.'); 
    return; 
  }

  const geocoder = new kakao.maps.services.Geocoder();
  const ps = new kakao.maps.services.Places();

  geocoder.addressSearch(inputVal, function(result, status) {
    if (status === kakao.maps.services.Status.OK && result.length > 0) {
      const item = result[0];
      const addressName = item.road_address ? item.road_address.address_name : item.address.address_name;
      document.getElementById('result').style.display = 'block';
      renderReportResult(addressName);
    } else {
      ps.keywordSearch(inputVal, function(places, placeStatus) {
        if (placeStatus === kakao.maps.services.Status.OK && places.length > 0) {
          const item = places[0];
          const addressName = item.road_address_name || item.address_name || inputVal;
          document.getElementById('result').style.display = 'block';
          renderReportResult(addressName);
        } else {
          showAlert('검색된 주소가 없습니다.\n정확한 도로명이나 장소명을 입력해주세요.');
          const resultDiv = document.getElementById('result');
          if (resultDiv) {
            resultDiv.style.display = 'none';
            resultDiv.innerHTML = '';
          }
        }
      });
    }
  });
}

function clearManualAddress() {
  const manualInput = document.getElementById('manual-address-input');
  if (manualInput) manualInput.value = '';
  const resultDiv = document.getElementById('result');
  if (resultDiv) {
    resultDiv.style.display = 'none';
    resultDiv.innerHTML = '';
  }
}

function processLocation(lat, lng) {
  if (typeof kakao === 'undefined' || !kakao.maps || !kakao.maps.services) { 
    renderReportResult('카카오 맵 API 로드 실패'); 
    return; 
  }
  
  const geocoder = new kakao.maps.services.Geocoder();
  let isDone = false;
  
  const timeoutId = setTimeout(() => { 
    if (!isDone) { 
      isDone = true; 
      renderReportResult('위치 응답 시간 초과'); 
    } 
  }, 3000);
  
  geocoder.coord2Address(lng, lat, function (result, status) {
    if (isDone) return; 
    isDone = true; 
    clearTimeout(timeoutId);
    
    if (status !== kakao.maps.services.Status.OK || !result || result.length === 0) { 
      renderReportResult('주소를 찾을 수 없는 위치입니다'); 
      return; 
    }
    
    const item = result[0];
    const addressName = item.road_address 
      ? item.road_address.address_name 
      : (item.address ? item.address.address_name : '주소 정보 없음');
      
    renderReportResult(addressName);
  });
}

window.updateCheckCount = function() {
  const checkboxes = document.querySelectorAll('.custom-chk');
  const checkedCount = Array.from(checkboxes).filter(chk => chk.checked).length;
  const totalCount = checkboxes.length;
  
  const percentage = totalCount === 0 ? 0 : Math.round((checkedCount / totalCount) * 100);
  
  const progressBar = document.getElementById('checklist-progress-bar');
  const progressText = document.getElementById('checklist-progress-text');
  
  if (progressBar && progressText) {
    progressBar.style.width = percentage + '%';
    progressText.innerText = percentage + '%';
    progressText.style.color = percentage > 0 ? '#ffffff' : '#5484FF';

    if (percentage === 100 && typeof confetti === 'function') {
      confetti({
        particleCount: 150,      
        spread: 80,              
        origin: { y: 0.6 },      
        colors: ['#5484FF', '#2ed573', '#FFD700', '#FF6B6B'], 
        zIndex: 99999            
      });
    }
  }
};

function renderReportResult(address) {

  const regionMap = {
    '서울': '02', '부산': '051', '대구': '053', '인천': '032', '광주': '062', '대전': '042', '울산': '052', '세종': '044',
    '경기': '031', '강원': '033', '충북': '043', '충청북도': '043', '충남': '041', '충청남도': '041',
    '전북': '063', '전라북도': '063', '전북특별자치도': '063', '전남': '061', '전라남도': '061',
    '경북': '054', '경상북도': '054', '경남': '055', '경상남도': '055', '제주': '064'
  };

  let localCallNumber = '120';
  for (const [region, code] of Object.entries(regionMap)) {
    if (address.startsWith(region) || address.includes(region)) {
      localCallNumber = code + '120'; 
      break;
    }
  }

  const isHighway = address.includes('고속도로') || address.includes('고속') || address.includes('IC') || address.includes('JC');

  let buttonsHtml = '';

  if (isHighway) {
    buttonsHtml = `
      <a href="https://www.ex.co.kr/portal/biz/roadDamage/roadDamage.do" target="_blank" style="text-decoration: none; display: flex; flex-direction: column; align-items: center; flex: 1; min-width: 0;">
        <div style="background-color: #F44336; border-radius: 30px; width: 100%; aspect-ratio: 1; display: flex; justify-content: center; align-items: center; margin-bottom: 10px;">
          <svg width="45%" height="45%" viewBox="0 0 24 24" fill="none" stroke="black" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="2" y1="12" x2="22" y2="12"></line><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path></svg>
        </div>
        <span style="font-size: 13px; color: #111; font-weight: 500; text-align: center; white-space: nowrap;">웹으로 신고하기</span>
      </a>

      <a href="tel:1588-2504" style="text-decoration: none; display: flex; flex-direction: column; align-items: center; flex: 1; min-width: 0;">
        <div style="background-color: #3b82f6; border-radius: 30px; width: 100%; aspect-ratio: 1; display: flex; justify-content: center; align-items: center; margin-bottom: 10px;">
          <svg width="45%" height="45%" viewBox="0 0 24 24" fill="none" stroke="black" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z" fill="black"></path><path d="M14.05 2a9 9 0 0 1 8 7.94" stroke-width="2.5"></path><path d="M14.05 6A5 5 0 0 1 18 10" stroke-width="2.5"></path></svg>
        </div>
        <span style="font-size: 13px; color: #111; font-weight: 500; text-align: center; white-space: nowrap;">전화로 신고하기</span>
      </a>

      <a href="tel:${localCallNumber}" style="text-decoration: none; display: flex; flex-direction: column; align-items: center; flex: 1; min-width: 0;">
        <div style="background-color: #a8a8a8; border-radius: 30px; width: 100%; aspect-ratio: 1; display: flex; justify-content: center; align-items: center; margin-bottom: 10px;">
          <svg width="45%" height="45%" viewBox="0 0 24 24" fill="none" stroke="black" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon><line x1="22" y1="2" x2="11" y2="13"></line></svg>
        </div>
        <span style="font-size: 12px; color: #111; font-weight: 500; text-align: center; line-height: 1.3; word-break: keep-all;">다른 도로<br>배상청구하러 가기</span>
      </a>
    `;
  } else {
    buttonsHtml = `
      <a href="tel:${localCallNumber}" style="text-decoration: none; display: flex; flex-direction: column; align-items: center; flex: 1; max-width: 33%; margin: 0 auto;">
        <div style="background-color: #a8a8a8; border-radius: 30px; width: 100%; aspect-ratio: 1; display: flex; justify-content: center; align-items: center; margin-bottom: 10px;">
          <svg width="45%" height="45%" viewBox="0 0 24 24" fill="none" stroke="black" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon><line x1="22" y1="2" x2="11" y2="13"></line></svg>
        </div>
        <span style="font-size: 12px; color: #111; font-weight: 500; text-align: center; line-height: 1.3; word-break: keep-all;">일반 도로<br>관할기관 전화</span>
      </a>
    `;
  }

  // 💡 신고 버튼만 갱신 (체크리스트는 별도 영역이라 체크 상태가 유지됨)
  document.getElementById('result').innerHTML = `
    <div style="display: flex; justify-content: space-between; gap: 15px;">
      ${buttonsHtml}
    </div>
  `;
}

// 💡 피해배상 체크리스트 — 위치 인식과 무관하게 페이지 로드 시 한 번만 그림
// 💡 피해배상 체크리스트 — 위치 인식과 무관하게 페이지 로드 시 한 번만 그림
function renderChecklist() {
  const section = document.getElementById('checklist-section');
  if (!section || section.dataset.rendered) return;
  section.dataset.rendered = '1';

  const checkItems = [
    '스마트폰 카메라 위치 태그 "on" 확인',
    '도로 파손 지점 사진 + 차량 파손 부위 사진 촬영',
    '블랙박스 원본 영상 저장',
    '정비소 수리 견적서/ 영수증 확보',
    '(선택) 보험사 출동 확인서'
  ];

  const checkListHtml = checkItems.map((text) => `
    <label class="checklist-label">
      <input type="checkbox" class="custom-chk" onchange="updateCheckCount()">
      <div class="chk-icon"></div>
      <span style="font-size: 15px; color: #111; font-weight: 500;">${text}</span>
    </label>
  `).join('');

  section.innerHTML = `
    <!-- 💡 도우미 영역과 체크리스트 사이 연한 회색 구분선 추가 -->
    <hr class="divider" style="margin: 30px 0 25px 0;">

    <div style="text-align: left; margin-bottom: 20px;">
      <h2 style="margin: 0 0 20px 0; padding: 0 5px; font-size: 25px; font-weight: bold; color: #111; text-align: left;">
        배상청구 필요서류 체크리스트
      </h2>
      
      <div style="width: 100%; height: 26px; background-color: #CDE2FF; border-radius: 13px; position: relative; margin-bottom: 25px; display: flex; align-items: center; overflow: hidden;">
        <div id="checklist-progress-bar" style="width: 0%; height: 100%; background-color: #5484FF; border-radius: 13px; transition: width 0.3s ease; position: absolute; left: 0; top: 0;"></div>
        <span id="checklist-progress-text" style="position: relative; z-index: 1; margin-left: 10px; font-size: 13px; font-weight: bold; color: #5484FF;">0%</span>
      </div>

      <div style="display: flex; flex-direction: column; gap: 15px;">
        ${checkListHtml}
      </div>
    </div>
  `;
}

// =====================================================================
// 8. 마이페이지 
// =====================================================================
function renderMyPage() {
  const img = document.getElementById('profile-image'); const name = document.getElementById('profile-name'); const email = document.getElementById('profile-email');
  const loginSection = document.getElementById('login-section'); const settingsSection = document.getElementById('settings-section');
  if (!img || !name) return;

  if (currentUser) {
    img.src = getUserAvatar(currentUser); name.innerText = getUserName(currentUser); email.innerText = currentUser.email || '';
    document.getElementById('nickname-input').value = getUserName(currentUser);
    loginSection.style.display = 'none'; settingsSection.style.display = 'block';
  } else {
    img.src = PLACEHOLDER_LOGIN; name.innerText = '로그인이 필요합니다'; email.innerText = '';
    loginSection.style.display = 'block'; settingsSection.style.display = 'none';
  }
}

async function updateNickname() {
  if (!currentUser) return;
  const newNickname = document.getElementById('nickname-input').value.trim();
  if (!newNickname) { await showAlert('새로운 닉네임을 입력해주세요!'); return; }
  const { error } = await supabaseClient.auth.updateUser({ data: { name: newNickname, full_name: newNickname } });
  if (error) { await showAlert('닉네임 변경 실패: ' + error.message); return; }

  await supabaseClient.from('pothole_reviews').update({ author_name: newNickname }).eq('user_id', currentUser.id);
  await supabaseClient.from('pothole_comments').update({ author_name: newNickname }).eq('user_id', currentUser.id);

  await showAlert('닉네임이 성공적으로 변경되었습니다!'); checkUser();
}

async function uploadProfileImage(input) {
  if (!currentUser) { await showAlert('로그인 후 이용 가능합니다!', () => { go('mypage'); }); return; }
  if (!input.files || !input.files[0]) return;

  const file = input.files[0];
  const fileName = `profile_${currentUser.id}_${Date.now()}.${file.name.split('.').pop()}`;

  const { error: uploadError } = await supabaseClient.storage.from('profile').upload(fileName, file);
  if (uploadError) { await showAlert('이미지 업로드 실패: ' + uploadError.message); return; }

  const avatarUrl = supabaseClient.storage.from('profile').getPublicUrl(fileName).data.publicUrl;
  const { error: updateError } = await supabaseClient.auth.updateUser({ data: { avatar_url: avatarUrl } });

  if (updateError) { 
    await showAlert('프로필 사진 적용 실패: ' + updateError.message); 
  } else {
    await supabaseClient.from('pothole_reviews').update({ author_avatar_url: avatarUrl }).eq('user_id', currentUser.id);
    await supabaseClient.from('pothole_comments').update({ author_avatar_url: avatarUrl }).eq('user_id', currentUser.id);
    await showAlert('프로필 사진이 변경되었습니다!'); checkUser();
  }
}

// =====================================================================
// 9. 시작
// =====================================================================
(async function init() {
  renderChecklist();
  await checkUser();
  const urlParams = new URLSearchParams(window.location.search);
  const sharedReviewId = urlParams.get('review');
  
  if (sharedReviewId) {
    await loadReviews();
    const targetId = parseInt(sharedReviewId, 10);
    if (allReviews.some(r => r.id === targetId)) showDetailView(targetId);
    else go('board');
    window.history.replaceState({}, document.title, window.location.pathname);
  } else {
    const saved = popReturnView();
    if (saved && saved.view === 'detail' && saved.reviewId) {
      await loadReviews();
      if (allReviews.some(r => r.id === saved.reviewId)) showDetailView(saved.reviewId);
      else go('board');
    } else if (saved && ['map', 'board', 'report', 'mypage'].includes(saved.view)) {
      go(saved.view);
    } else if (saved && saved.view === 'write') {
      go(currentUser ? 'write' : 'board');
    } else { 
      go('map'); 
    }
  }

  supabaseClient.auth.onAuthStateChange((_event, session) => {
    currentUser = session ? session.user : null; renderAuthBar(); renderMyPage();
  });
})();