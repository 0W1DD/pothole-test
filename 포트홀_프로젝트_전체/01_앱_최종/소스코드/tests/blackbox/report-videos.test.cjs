// 신고 화면 "내 블랙박스 영상"(www/report-videos.js) 안전장치 테스트
// private-videos-ui 에 있던 목록·재생 검사(본인만, 로그아웃 즉시 비움, 늦게 온 응답 버림)를 이쪽으로 옮김
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const tick = () => new Promise(resolve => setTimeout(resolve, 15));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

function fixture() {
  class Element {
    constructor(id) { this.id = id; this.innerHTML = ''; this.style = {}; this.children = []; }
    appendChild(c) { this.children.push(c); this.innerHTML = '<video>'; }
    pause() {} load() {} removeAttribute(name) { delete this[name]; }
    play() { return Promise.resolve(); }
  }
  const elements = {};
  const el = id => (elements[id] = elements[id] || new Element(id));
  let signed, queryDeferred;
  const rows = [], calls = [];
  const ctx = {
    currentUser: null, console,
    URL, setTimeout(fn, ms) { const t = setTimeout(fn, ms); t.unref(); return t; }, clearTimeout,
    document: { getElementById: el, createElement: () => new Element('video'), querySelectorAll: () => [] },
    formatPotholeTime: d => d.toISOString(), getPotholeAddress: async () => null,
    showAlert: async () => {}, showConfirm: async () => true, go() {},
    mapDB: { from() { return { select() { return this; }, in: async () => ({ data: [] }) }; } },
    supabaseClient: {
      storage: { from(bucket) { assert.equal(bucket, 'pothole-videos'); return {
        createSignedUrl(p, seconds) { assert.equal(seconds, 3600); signed.path = p; return signed.promise; },
        remove: async paths => { calls.push(['remove', paths[0]]); return { data: [{}], error: null }; }
      }; } },
      from(table) {
        assert.equal(table, 'pothole_videos');
        const q = { filters: {} };
        q.select = () => q; q.order = () => q;
        q.eq = (k, v) => { q.filters[k] = v; return q; };
        q.limit = () => queryDeferred ? queryDeferred.promise
          : Promise.resolve({ data: rows.filter(r => !q.filters.user_id || r.user_id === q.filters.user_id) });
        q.delete = () => { q.del = true; return q; };
        const sel = q.select;
        q.select = (...a) => { if (q.del) { calls.push(['deleteRow', q.filters.id]); return Promise.resolve({ data: [{ id: q.filters.id }] }); } return sel(...a); };
        return q;
      }
    }
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../../www/report-videos.js'), 'utf8'), ctx);
  return { ctx, elements, rows, calls, login: id => { ctx.currentUser = id ? { id } : null; },
    sign() { signed = deferred(); return signed; }, deferQuery() { queryDeferred = deferred(); return queryDeferred; } };
}
const cards = f => (f.elements['report-video-list'].innerHTML.match(/class="video-card"/g) || []).length;

test('only my rows under my folder are listed, played with a 1h signed URL', async () => {
  const f = fixture(); f.login('A');
  f.rows.push({ id: 1, user_id: 'A', path: 'A/pi_1.mp4' }, { id: 2, user_id: 'B', path: 'B/pi_2.mp4' },
    { id: 3, user_id: 'A', path: 'B/sneaky.mp4' });
  await f.ctx.loadMyVideos();
  assert.equal(cards(f), 1);
  const r = f.sign(); const playing = f.ctx.playMyVideo(0);
  r.resolve({ data: { signedUrl: 'https://example.supabase.co/storage/v1/object/sign/x?token=t' } }); await playing;
  assert.equal(r.path, 'A/pi_1.mp4');
  assert.equal(f.elements['video-box-0'].children.length, 1);
});
test('logged out shows login box and no rows', async () => {
  const f = fixture(); f.rows.push({ id: 1, user_id: 'A', path: 'A/pi_1.mp4' });
  await f.ctx.loadMyVideos();
  assert.equal(f.elements['report-videos-login'].style.display, 'block'); assert.equal(cards(f), 0);
});
test('late signed URL from prior account never appears after account switch', async () => {
  const f = fixture(); f.login('A'); f.rows.push({ id: 1, user_id: 'A', path: 'A/pi_1.mp4' });
  await f.ctx.loadMyVideos();
  const r = f.sign(); const playing = f.ctx.playMyVideo(0);
  f.login('B'); f.ctx.clearMyVideos();
  r.resolve({ data: { signedUrl: 'https://example.supabase.co/private-A' } }); await playing;
  assert.equal(f.elements['video-box-0'].children.length, 0);
  assert.equal(f.elements['report-video-list'].innerHTML, '');
});
test('late list from prior account never appears after logout', async () => {
  const f = fixture(); f.login('A'); const q = f.deferQuery();
  const loading = f.ctx.loadMyVideos();
  f.login(null); f.ctx.clearMyVideos();
  q.resolve({ data: [{ id: 1, user_id: 'A', path: 'A/pi_1.mp4' }] }); await loading; await tick();
  assert.equal(cards(f), 0);
});
test('delete removes the row first, then the file', async () => {
  const f = fixture(); f.login('A'); f.rows.push({ id: 7, user_id: 'A', path: 'A/pi_7.mp4' });
  await f.ctx.loadMyVideos();
  await f.ctx.deleteMyVideo(0);
  assert.deepEqual(f.calls.slice(0, 2), [['deleteRow', 7], ['remove', 'A/pi_7.mp4']]);
});
test('non-https signed URL is refused', async () => {
  const f = fixture(); f.login('A'); f.rows.push({ id: 1, user_id: 'A', path: 'A/pi_1.mp4' });
  await f.ctx.loadMyVideos();
  const r = f.sign(); const playing = f.ctx.playMyVideo(0);
  r.resolve({ data: { signedUrl: 'http://example.com/x' } }); await playing;
  assert.equal(f.elements['video-box-0'].children.length, 0);
});
