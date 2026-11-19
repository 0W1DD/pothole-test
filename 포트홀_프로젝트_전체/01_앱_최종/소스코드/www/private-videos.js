(function () {
  'use strict';
  const byId = id => document.getElementById(id);
  const client = supabaseClient;
  let owner = null, epoch = 0, working = false, page = 0, playTimer;
  const store = PrivateVideoCore.openStore(window.indexedDB);
  const queue = new PrivateVideoCore.Queue(store, client, BlackboxWifi, () => owner);
  const state = byId('video-state'), list = byId('video-list'), player = byId('private-video-player');
  function stopVideo() { clearTimeout(playTimer); player.pause(); player.removeAttribute('src'); player.load(); player.hidden = true; }
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
      await queue.flush(); state.textContent = '업로드를 완료했습니다.';
      await loadList(true);
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
    state.textContent = count + '개 영상 가져오기 완료' + (owner ? ' · 내 계정 업로드 완료' : ' · 로그인 후 업로드됩니다.')
      + (failed ? ' · ' + failed + '개 실패: ' + lastError : '');
    await loadList(true);
  });
  byId('video-sync').onclick = sync;
  byId('video-login').onclick = () => loginWithKakao();
  byId('video-refresh').onclick = () => loadList(true).catch(e => { state.textContent = errorMessage(e); });
  byId('video-more').onclick = () => loadList(false).catch(e => { state.textContent = errorMessage(e); });
  async function play(row) {
    const token = epoch, user = owner;
    if (!user || row.user_id !== user || !row.path.startsWith(user + '/')) return;
    stopVideo();
    const { data, error } = await client.storage.from('pothole-videos').createSignedUrl(row.path, 3600);
    if (token !== epoch) return;
    if (error) throw error;
    const url = new URL(data.signedUrl);
    if (url.protocol !== 'https:') throw new Error('영상 주소가 올바르지 않습니다.');
    player.src = url.href; player.hidden = false;
    playTimer = setTimeout(() => { stopVideo(); state.textContent = '재생 주소가 만료됐습니다. 재생 버튼을 다시 눌러 주세요.'; }, 3600000);
    player.play().catch(() => { state.textContent = '재생 버튼을 누르세요. 재생되지 않으면 파일·코덱을 확인하세요.'; });
  }
  player.onerror = () => { state.textContent = '영상 재생 실패: 인터넷·주소 만료·MP4 코덱을 확인하고 다시 재생하세요.'; };
  async function loadList(reset) {
    const token = epoch, user = owner;
    if (reset) { page = 0; list.replaceChildren(); }
    byId('video-more').hidden = true;
    if (!user) return;
    const currentPage = page;
    const { data, error } = await client.from('pothole_videos').select('id,user_id,path,captured_at,impact,label,confidence,lat,lon')
      .eq('user_id', user).order('created_at', { ascending: false }).order('id', { ascending: false }).range(currentPage * 30, currentPage * 30 + 29);
    if (token !== epoch || currentPage !== page) return;
    if (error) throw error;
    for (const row of data) {
      if (row.user_id !== user || typeof row.path !== 'string' || !row.path.startsWith(user + '/')) continue;
      const card = document.createElement('div'); card.className = 'card';
      const text = document.createElement('p');
      text.textContent = (row.captured_at ? new Date(row.captured_at).toLocaleString('ko-KR') : '시각 미상')
        + ' · 충격 ' + (row.impact ?? '-') + 'g · ' + (row.label || 'AI 판정 대기')
        + (row.confidence === null ? '' : ' (' + Math.round(row.confidence * 100) + '%)')
        + ' · 위치 ' + (row.lat === null || row.lon === null ? '없음' : row.lat + ', ' + row.lon);
      const button = document.createElement('button'); button.className = 'btn'; button.textContent = '재생';
      button.onclick = () => play(row).catch(e => { state.textContent = errorMessage(e); });
      card.append(text, button); list.append(card);
    }
    if (reset && data.length === 0) list.textContent = '아직 업로드한 영상이 없습니다.';
    page++; byId('video-more').hidden = data.length < 30;
  }
  function auth(session) {
    const next = session?.user?.id || null;
    if (next === owner) return;
    owner = next; epoch++; stopVideo(); list.replaceChildren(); page = 0;
    byId('video-login').hidden = !!owner;
    byId('video-more').hidden = true;
    state.textContent = owner ? '내 영상 목록을 불러오는 중…' : '로그인하면 내 블랙박스 영상을 볼 수 있어요.';
    // Never await Supabase calls inside its auth callback.
    const token = epoch;
    const resume = () => {
      if (token !== epoch) return;
      if (working) { setTimeout(resume, 250); return; }
      pending().catch(() => {}); sync();
      loadList(true).catch(e => { if (token === epoch) state.textContent = errorMessage(e); });
    };
    setTimeout(resume, 0);
  }
  client.auth.onAuthStateChange((_event, session) => auth(session));
  client.auth.getSession().then(({ data, error }) => { if (error) throw error; auth(data.session); }).catch(e => { state.textContent = errorMessage(e); });
  pending().catch(e => { state.textContent = '폰 영상 저장소 사용 불가: ' + errorMessage(e); });
  window.addEventListener('online', sync);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) sync(); else stopVideo(); });
  window.addEventListener('pagehide', stopVideo);
})();
