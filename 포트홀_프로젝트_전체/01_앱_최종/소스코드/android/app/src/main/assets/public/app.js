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
let detectedMarker = null;
window.showDetectedPothole = function (row) {
  if (!Number.isFinite(row.lat) || !Number.isFinite(row.lon) || Math.abs(row.lat) > 90 || Math.abs(row.lon) > 180) return;
  let attempts = 0;
  const open = () => {
    if (!kakaoMap) {
      if (++attempts < 40) setTimeout(open, 500);
      else showAlert('지도를 불러오지 못했습니다. 인터넷 연결을 확인하세요.');
      return;
    }
    myLocationCentered = true;
    go('map');
    const position = new kakao.maps.LatLng(row.lat, row.lon);
    kakaoMap.relayout(); kakaoMap.setLevel(3); kakaoMap.setCenter(position);
    if (detectedMarker) detectedMarker.setMap(null);
    detectedMarker = new kakao.maps.Marker({ position, map: kakaoMap });
    const entry = potholeEntries.find(e => e.uid === String(row.id));
    if (entry) openPotholeInfo(entry);
  };
  open();
};

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
  if (typeof stopMyVideos === 'function') stopMyVideos();   // 💡 화면 바꾸면 "내 블랙박스 영상" 재생 멈춤

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
  } else if (view === 'report') {
    if (typeof loadMyVideos === 'function') loadMyVideos();   // 💡 체크리스트 아래 "내 블랙박스 영상" (report-videos.js)
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
// 💡 테스트 사진(아주 긴 글자 데이터)은 웹 업로드 때 파일이 잘리는 원인이라 제거함 (웹 담당 수정 반영)
const TEST_IMAGE_URL = '';

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
    const prev = currentUser ? currentUser.id : null;
    currentUser = session ? session.user : null; renderAuthBar(); renderMyPage();
    // 💡 로그아웃·계정 전환이면 "내 블랙박스 영상" 즉시 비우고, 신고 화면이면 다시 불러옴
    if (prev !== (currentUser ? currentUser.id : null)) {
      if (typeof clearMyVideos === 'function') clearMyVideos();
      if (typeof loadMyVideos === 'function' && document.getElementById('report-view').classList.contains('active')) setTimeout(loadMyVideos, 0);
    }
  });
})();
