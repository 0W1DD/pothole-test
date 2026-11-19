(function () {
  'use strict';
  const byId = id => document.getElementById(id);
  const client = supabaseClient;
  // 영상 가져오기·업로드만 담당 (내정보). 목록·재생·지도·삭제는 신고 화면 report-videos.js
  let owner = null, epoch = 0, working = false;
  const store = PrivateVideoCore.openStore(window.indexedDB);
  const queue = new PrivateVideoCore.Queue(store, client, {
    getVideoBlob: path => BlackboxWifi.getVideoBlob(path),
    locationAt: timestamp => NearbyAlerts.locationAt(timestamp)
  }, () => owner);
  const state = byId('video-state');
  // 신고 화면 목록 새로고침 (report-videos.js 가 있으면)
  function refreshList() { if (typeof window.loadMyVideos === 'function') Promise.resolve(window.loadMyVideos()).catch(() => {}); }
  function errorMessage(error) { return error?.message || String(error); }
  async function pending() {
    const rows = await store.all();
    const mine = rows.filter(r => !r.done && (!r.owner || r.owner === owner));
    byId('video-pending').textContent = '폰에 보관 중: ' + mine.length + '개 (로그인 후 자동 업로드, 앱 데이터 삭제 시 소실)';
  }
  async function locked(action) {
    if (working) return;
    working = true;
    byId('video-import').disabled = byId('video-sync').disabled = true;
    try {
      if (navigator.locks) await navigator.locks.request('pothole-video-transfer', action);
      else await action();
    } catch (error) { state.textContent = errorMessage(error) + ' · 서버의 비공개 버킷·표·권한과 인터넷을 확인하세요. 보관된 영상은 재시도할 수 있습니다.'; }
    finally { working = false; byId('video-import').disabled = byId('video-sync').disabled = false; await pending().catch(() => {}); }
  }
  async function sync() {
    await locked(async () => {
      if (!owner) { state.textContent = '로그인하면 보관한 영상을 내 계정에 업로드합니다.'; return; }
      state.textContent = '내 계정으로 업로드 중…';
      await queue.flush(); state.textContent = '업로드를 완료했습니다. 신고 화면 아래 "내 블랙박스 영상"에서 볼 수 있어요.';
      refreshList();
    });
  }
  byId('video-import').onclick = () => locked(async () => {
    state.textContent = '블랙박스 영상 기록을 읽는 중…';
    const index = await BlackboxWifi.getJson();
    if (!Array.isArray(index.records)) throw new Error('블랙박스 기록 형식이 올바르지 않습니다.');
    let count = 0, failed = 0, lastError = '';
    for (const row of index.records) {
      if (!row.video) continue;
      try {
        if (await queue.receive(index.device, row)) count++;
        state.textContent = count + '개 영상을 폰에 보관했습니다…';
      } catch (error) { failed++; lastError = errorMessage(error); }
    }
    if (owner) await queue.flush();
    state.textContent = count + '개 영상 가져오기 완료' + (owner ? ' · 내 계정 업로드 완료 (신고 화면 아래에서 보기)' : ' · 로그인 후 업로드됩니다.')
      + (failed ? ' · ' + failed + '개 실패: ' + lastError : '');
    refreshList();
  });
  byId('video-sync').onclick = sync;
  byId('video-login').onclick = () => loginWithKakao();
  function auth(session) {
    const next = session?.user?.id || null;
    if (next === owner) return;
    owner = next; epoch++;
    byId('video-login').hidden = !!owner;
    state.textContent = owner ? '로그인됨 · 가져온 영상은 내 계정으로 업로드됩니다.' : '로그인하면 가져온 영상을 내 계정으로 업로드합니다.';
    // Never await Supabase calls inside its auth callback.
    const token = epoch;
    const resume = () => {
      if (token !== epoch) return;
      if (working) { setTimeout(resume, 250); return; }
      pending().catch(() => {}); sync();
    };
    setTimeout(resume, 0);
  }
  client.auth.onAuthStateChange((_event, session) => auth(session));
  client.auth.getSession().then(({ data, error }) => { if (error) throw error; auth(data.session); }).catch(e => { state.textContent = errorMessage(e); });
  pending().catch(e => { state.textContent = '폰 영상 저장소 사용 불가: ' + errorMessage(e); });
  window.addEventListener('online', sync);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) sync(); });
})();
