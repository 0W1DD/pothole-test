// =====================================================================
// 신고 화면 "내 블랙박스 영상" (목록·재생·지도에서 보기·삭제)
//  - 화면은 웹 담당 버전, 안전장치는 앱 private-videos.js 와 같게:
//    내 user_id 행만, 경로가 "<내 user_id>/" 로 시작하는 것만, 계정이 바뀌면 늦게 온 응답은 버림
//  - 반드시 supabaseClient(카카오 로그인 세션)를 써야 함. mapDB 는 익명이라 서버(RLS)가 아무것도 안 줌
//  - 영상 가져오기·업로드는 내정보 화면(private-videos.js, 폰 앱 전용)이 함
// =====================================================================
(function (root) {
  'use strict';
  const BUCKET = 'pothole-videos';
  const SIGNED_URL_SECONDS = 3600;   // 임시 주소 유효시간 1시간
  let videos = [];                   // 지금 화면에 보이는 내 영상
  let epoch = 0;                     // 목록을 새로 그리거나 계정이 바뀔 때마다 +1 → 늦게 온 응답 버리기
  let marker = null;                 // "지도에서 보기" 마커
  let expireTimer = null;

  const byId = id => root.document.getElementById(id);
  const me = () => (typeof currentUser !== 'undefined' && currentUser && currentUser.id) || null;
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const pick = (...values) => values.find(x => x !== undefined && x !== null && x !== '');
  const mine = (row, user) => !!user && row && row.user_id === user
    && typeof row.path === 'string' && row.path.startsWith(user + '/');

  function stopAll() {
    clearTimeout(expireTimer);
    root.document.querySelectorAll('#report-video-list video').forEach(v => {
      v.pause(); v.removeAttribute('src'); v.load();
    });
  }

  // 로그아웃·계정 전환 때 바로 비우기
  function clearMyVideos() {
    epoch++; stopAll(); videos = [];
    const list = byId('report-video-list');
    if (list) list.innerHTML = '';
  }

  function normalize(r, p) {
    return {
      id: r.id, user_id: r.user_id,
      path: pick(r.path, r.video_path),
      time: pick(r.captured_at, r.created_at),
      impact: pick(r.impact, p.impact),
      label: pick(r.label, p.label, p.ai_label),
      confidence: pick(r.confidence),
      title: pick(p.title),
      address: pick(p.address),
      lat: parseFloat(pick(r.lat, p.latitude, p.lat)),
      lon: parseFloat(pick(r.lon, p.longitude, p.lon))
    };
  }

  function card(v, i) {
    const time = v.time ? formatPotholeTime(new Date(v.time)) : '시간 정보 없음';
    const n = Number(v.impact);
    const impact = (v.impact === undefined || isNaN(n)) ? '-' : n.toFixed(2) + 'g';
    const conf = Number(v.confidence);
    const label = v.label ? esc(v.label) + (isFinite(conf) && v.confidence !== undefined ? ` (${Math.round(conf * 100)}%)` : '') : '분석 전';
    const hasPos = isFinite(v.lat) && isFinite(v.lon);
    const pos = v.address ? esc(v.address) : hasPos ? `${v.lat.toFixed(5)}, ${v.lon.toFixed(5)}` : '위치 정보 없음';
    return `
    <div class="video-card">
      <div class="video-box" id="video-box-${i}">
        <button class="video-play-btn" onclick="playMyVideo(${i})">▶ 영상 재생</button>
      </div>
      <div class="video-info">
        <div class="video-time">${esc(time)}</div>
        ${v.title ? `<div class="video-row"><span class="video-key">포트홀</span><span>${esc(v.title)}</span></div>` : ''}
        <div class="video-row"><span class="video-key">충격</span><span>${impact}</span></div>
        <div class="video-row"><span class="video-key">AI 결과</span><span class="video-label">${label}</span></div>
        <div class="video-row"><span class="video-key">위치</span><span id="video-addr-${i}">${pos}</span></div>
      </div>
      <div class="btn-group video-actions">
        ${hasPos ? `<button class="btn btn-sm" style="background:#2667f7; flex:1;" onclick="showVideoOnMap(${i})">지도에서 보기</button>` : ''}
        <button class="btn btn-sm btn-gray" style="flex:1;" onclick="deleteMyVideo(${i})">삭제</button>
      </div>
    </div>`;
  }

  // ① 목록
  async function loadMyVideos() {
    const loginBox = byId('report-videos-login'), list = byId('report-video-list');
    if (!loginBox || !list) return;
    stopAll();
    const token = ++epoch, user = me();
    if (!user) { loginBox.style.display = 'block'; list.innerHTML = ''; videos = []; return; }
    loginBox.style.display = 'none';
    list.innerHTML = '<p class="video-empty">영상 목록을 불러오는 중...</p>';

    const { data, error } = await supabaseClient.from('pothole_videos')
      .select('id,user_id,path,pothole_id,captured_at,created_at,impact,label,confidence,lat,lon')
      .eq('user_id', user)
      .order('created_at', { ascending: false })
      .limit(100);
    if (token !== epoch || me() !== user) return;           // 그 사이 로그아웃·계정 전환 → 버림
    if (error) {
      list.innerHTML = `<p class="video-empty">영상 목록을 불러오지 못했습니다.<br><small>${esc(error.message)}</small></p>`;
      return;
    }
    const rows = (data || []).filter(r => mine(r, user));
    if (rows.length === 0) {
      videos = [];
      list.innerHTML = '<p class="video-empty">아직 저장된 블랙박스 영상이 없습니다.<br><small>내정보 → 블랙박스 영상 가져오기</small></p>';
      return;
    }
    // 영상 행에 위치가 없으면 연결된 포트홀(potholes, 공개)에서 채움
    const ids = [...new Set(rows.map(r => r.pothole_id).filter(Boolean))];
    const byPothole = {};
    if (ids.length > 0) {
      const { data: ps } = await mapDB.from('potholes').select('*').in('id', ids);
      if (token !== epoch || me() !== user) return;
      (ps || []).forEach(p => { byPothole[p.id] = p; });
    }
    videos = rows.map(r => normalize(r, byPothole[r.pothole_id] || {}));
    list.innerHTML = videos.map(card).join('');
    videos.forEach((v, i) => fillAddress(v, i, token));
  }

  async function fillAddress(v, i, token) {
    if (v.address || !isFinite(v.lat) || !isFinite(v.lon) || typeof getPotholeAddress !== 'function') return;
    const addr = await getPotholeAddress(v.lat, v.lon);
    const el = byId(`video-addr-${i}`);
    if (addr && el && token === epoch && videos[i] === v) el.innerText = addr;
  }

  // ② 재생: 비공개 파일 → 1시간짜리 임시 주소
  async function playMyVideo(i) {
    const v = videos[i], box = byId(`video-box-${i}`), user = me(), token = epoch;
    if (!v || !box || !mine(v, user)) return;
    box.innerHTML = '<p class="video-empty">영상 준비 중...</p>';
    const { data, error } = await supabaseClient.storage.from(BUCKET).createSignedUrl(v.path, SIGNED_URL_SECONDS);
    if (token !== epoch || me() !== user || videos[i] !== v) return;   // 늦게 온 남의 주소는 버림
    let url = null;
    try { url = data && data.signedUrl ? new URL(data.signedUrl) : null; } catch (_) { url = null; }
    if (error || !url || url.protocol !== 'https:') {
      box.innerHTML = `<button class="video-play-btn" onclick="playMyVideo(${i})">다시 시도</button>`;
      showAlert('영상을 불러오지 못했습니다.' + (error ? '\n' + error.message : ''));
      return;
    }
    const video = root.document.createElement('video');
    video.src = url.href; video.controls = true; video.playsInline = true; video.preload = 'metadata';
    box.innerHTML = ''; box.appendChild(video);
    clearTimeout(expireTimer);
    expireTimer = setTimeout(() => { if (videos[i] === v) loadMyVideos(); }, SIGNED_URL_SECONDS * 1000);
    video.play().catch(() => {});
  }

  // ③ 지도에서 보기
  function showVideoOnMap(i) {
    const v = videos[i];
    if (!v || !isFinite(v.lat) || !isFinite(v.lon)) return;
    if (typeof kakaoMap === 'undefined' || !kakaoMap) { showAlert('지도가 아직 로드되지 않았습니다.'); return; }
    const position = new kakao.maps.LatLng(v.lat, v.lon);
    if (typeof myLocationCentered !== 'undefined') myLocationCentered = true;   // 내 위치로 자동 이동 막기
    go('map');
    if (marker) marker.setPosition(position);
    else { marker = new kakao.maps.Marker({ position, zIndex: 7 }); marker.setMap(kakaoMap); }
    kakaoMap.setLevel(3); kakaoMap.setCenter(position);
  }

  // ④ 삭제: 표에서 먼저 지움(목록에서 바로 사라짐) → 파일 삭제. 파일 삭제가 실패해도 남은 파일은 화면에 안 보임
  async function deleteMyVideo(i) {
    const v = videos[i], user = me();
    if (!v || !mine(v, user)) return;
    if (!await showConfirm('이 영상을 삭제할까요?\n삭제하면 되돌릴 수 없습니다.')) return;
    const { data: rows, error: rowError } = await supabaseClient.from('pothole_videos')
      .delete().eq('id', v.id).eq('user_id', user).select('id');
    if (rowError) { await showAlert('영상 기록 삭제 실패: ' + rowError.message); return; }
    if (!rows || rows.length === 0) { await showAlert('삭제 권한이 없습니다.\n(서버 담당에게 삭제 규칙을 확인해 주세요)'); return; }
    const { error: fileError } = await supabaseClient.storage.from(BUCKET).remove([v.path]);
    if (fileError) console.warn('영상 파일 삭제 실패 (목록에서는 지워짐):', fileError.message);
    await showAlert('영상이 삭제되었습니다.');
    loadMyVideos();
  }

  root.loadMyVideos = loadMyVideos;
  root.clearMyVideos = clearMyVideos;
  root.stopMyVideos = stopAll;
  root.playMyVideo = playMyVideo;
  root.showVideoOnMap = showVideoOnMap;
  root.deleteMyVideo = deleteMyVideo;
})(typeof window !== 'undefined' ? window : globalThis);
