// 내정보 "블랙박스 영상 가져오기" 패널(www/private-videos.js) 테스트
// 목록·재생은 신고 화면으로 옮겨서 report-videos.test.cjs 에서 검사함
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { IDBFactory } = require('fake-indexeddb');
const core = require('../../www/private-videos-core.js');
const tick = () => new Promise(resolve => setTimeout(resolve, 15));
function fixture() {
  class Element { constructor() { this.hidden = false; this.textContent = ''; this.disabled = false; } }
  const elements = {};
  const html = fs.readFileSync(path.resolve(__dirname, '../../www/index.html'), 'utf8');
  for (const match of html.matchAll(/id="([^"]+)"/g)) elements[match[1]] = new Element();
  let onAuth, refreshed = 0;
  const client = {
    auth: { onAuthStateChange(fn) { onAuth = fn; }, getSession: async () => ({ data: { session: null } }) },
    storage: { from() { return {}; } }, from() { return {}; }
  };
  const root = { indexedDB: new IDBFactory(), addEventListener() {}, loadMyVideos() { refreshed++; } };
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../../www/private-videos.js'), 'utf8'), {
    window: root, supabaseClient: client, PrivateVideoCore: core,
    BlackboxWifi: { getJson: async () => ({ device: 'pi-blackbox', records: [] }) },
    document: { getElementById: id => elements[id], addEventListener() {} },
    navigator: {}, URL, setTimeout(fn, ms) { const timer = setTimeout(fn, ms); timer.unref(); return timer; }, clearTimeout,
    loginWithKakao() {}, console
  });
  return { elements, refreshed: () => refreshed, auth: id => onAuth('SIGNED_IN', id ? { user: { id } } : null) };
}
test('mypage panel is import-only: no list or player elements left', () => {
  const f = fixture();
  for (const id of ['video-list', 'private-video-player', 'video-refresh', 'video-more']) assert.equal(f.elements[id], undefined, id);
  for (const id of ['video-import', 'video-sync', 'video-pending', 'video-state', 'video-login', 'report-video-list'])
    assert.ok(f.elements[id], id);
});
test('login hides the login button, logout shows it again', async () => {
  const f = fixture(); await tick();
  f.auth('A'); await tick();
  assert.equal(f.elements['video-login'].hidden, true);
  f.auth(null); await tick();
  assert.equal(f.elements['video-login'].hidden, false);
});
test('import refreshes the report-screen list', async () => {
  const f = fixture(); await tick();
  const before = f.refreshed();
  await f.elements['video-import'].onclick(); await tick();
  assert.ok(f.refreshed() > before);
  assert.match(f.elements['video-state'].textContent, /가져오기 완료/);
});
