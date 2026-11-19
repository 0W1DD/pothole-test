const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { IDBFactory } = require('fake-indexeddb');
const core = require('../../www/private-videos-core.js');
const tick = () => new Promise(resolve => setTimeout(resolve, 15));
function fixture() {
  class Element {
    constructor() { this.children = []; this.hidden = false; this.textContent = ''; }
    append(...items) { this.children.push(...items); }
    replaceChildren() { this.children = []; this.textContent = ''; }
    pause() {} load() {} removeAttribute(name) { delete this[name]; }
    play() { return Promise.resolve(); }
  }
  const elements = {};
  const html = fs.readFileSync(path.resolve(__dirname, '../../www/index.html'), 'utf8');
  for (const match of html.matchAll(/id="([^"]+)"/g)) elements[match[1]] = new Element();
  let onAuth, signed, queryDeferred;
  const rows = [];
  const client = {
    auth: { onAuthStateChange(fn) { onAuth = fn; }, getSession: async () => ({ data: { session: null } }) },
    storage: { from(bucket) { assert.equal(bucket, 'pothole-videos'); return {
      createSignedUrl(path, seconds) { assert.equal(seconds, 3600); signed.path = path; return signed.promise; }
    }; } },
    from() { let owner; return { select() { return this; }, eq(_key, value) { owner = value; return this; }, order() { return this; },
      range() { return queryDeferred ? queryDeferred.promise : Promise.resolve({ data: rows.filter(r => r.user_id === owner) }); }
    }; }
  };
  const root = { indexedDB: new IDBFactory(), addEventListener() {} };
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../../www/private-videos.js'), 'utf8'), {
    window: root, supabaseClient: client, PrivateVideoCore: core, BlackboxWifi: {},
    document: { getElementById: id => elements[id], createElement: () => new Element(), addEventListener() {} },
    navigator: {}, URL, setTimeout(fn, ms) { const timer = setTimeout(fn, ms); timer.unref(); return timer; }, clearTimeout,
    loginWithKakao() {}, console
  });
  const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
  return { elements, rows, auth: id => onAuth('SIGNED_IN', id ? { user: { id } } : null),
    sign() { signed = deferred(); return signed; }, deferQuery() { queryDeferred = deferred(); return queryDeferred; } };
}
test('own list uses signed URL and logout clears playback and rows immediately', async () => {
  const f = fixture(); await tick();
  f.rows.push({ id: 1, user_id: 'A', path: 'A/pi_1.mp4', captured_at: null, lat: null, lon: null, confidence: null },
    { id: 2, user_id: 'B', path: 'B/pi_2.mp4' });
  f.auth('A'); await tick(); await tick();
  const list = f.elements['video-list']; assert.equal(list.children.length, 1);
  const request = f.sign(); const playing = list.children[0].children[1].onclick();
  request.resolve({ data: { signedUrl: 'https://example.supabase.co/storage/v1/object/sign/video?token=test' } });
  await playing;
  assert.equal(request.path, 'A/pi_1.mp4'); assert.equal(f.elements['private-video-player'].hidden, false);
  f.auth(null);
  assert.equal(list.children.length, 0); assert.equal(f.elements['private-video-player'].src, undefined);
  assert.equal(f.elements['private-video-player'].hidden, true);
});
test('late signed URL from prior account never appears after account switch', async () => {
  const f = fixture(); await tick();
  f.rows.push({ id: 1, user_id: 'A', path: 'A/pi_1.mp4', lat: null, lon: null, confidence: null });
  f.auth('A'); await tick(); await tick();
  const request = f.sign(); const playing = f.elements['video-list'].children[0].children[1].onclick();
  f.auth('B'); request.resolve({ data: { signedUrl: 'https://example.supabase.co/private-A' } }); await playing;
  assert.equal(f.elements['private-video-player'].src, undefined);
  assert.equal(f.elements['video-list'].children.length, 0);
});
test('late list from prior account never appears after logout', async () => {
  const f = fixture(); await tick(); const response = f.deferQuery();
  f.auth('A'); await tick(); f.auth(null);
  response.resolve({ data: [{ user_id: 'A', path: 'A/pi_1.mp4' }] }); await tick();
  assert.equal(f.elements['video-list'].children.length, 0);
});
