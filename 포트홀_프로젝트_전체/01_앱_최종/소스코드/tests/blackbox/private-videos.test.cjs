const test = require('node:test');
const assert = require('node:assert/strict');
const { IDBFactory } = require('fake-indexeddb');
const { clipPath, record, Queue, openStore } = require('../../www/private-videos-core.js');
const row = { t_ms: 1795040000000, video: 'clips/00001.mp4', score: 2.1 };
function fixture() {
  const store = openStore(new IDBFactory());
  let owner = null, downloads = 0;
  const objects = new Map(), rows = [], uploads = [];
  const faults = {};
  const client = {
    storage: { from(bucket) { assert.equal(bucket, 'pothole-videos'); return {
      async upload(path, blob, options) {
        uploads.push({ path, owner, options });
        assert.ok(path.startsWith(owner + '/'));
        assert.equal(options.upsert, false);
        if (faults.upload) return { error: { message: 'offline' } };
        if (objects.has(path)) return { error: { statusCode: '409' } };
        objects.set(path, blob); return {};
      }
    }; } },
    from(table) { assert.equal(table, 'pothole_videos'); const filters = {}; return {
      select() { return this; }, eq(k, v) { filters[k] = v; return this; },
      async limit() { return faults.query ? { error: { message: 'missing table' } } : {
        data: rows.filter(r => r.user_id === filters.user_id && r.path === filters.path) }; },
      async insert(item) {
        if (faults.insert) return { error: { message: 'offline' } };
        rows.push({ ...item, id: rows.length + 1 }); return {};
      }
    }; }
  };
  const camera = { async getVideoBlob(path) { downloads++; assert.equal(path, '/clips/00001.mp4');
    if (faults.download) throw new Error('Wi-Fi lost');
    return new Blob([new Uint8Array([0, 128, 255])], { type: 'video/mp4' }); } };
  const queue = new Queue(store, client, camera, () => owner);
  return { queue, store, client, camera, rows, objects, uploads, faults, login: id => { owner = id; }, downloads: () => downloads };
}
test('Pi relative video path is completed, unsafe paths are never normalized', () => {
  assert.equal(clipPath('clips/a_001-2.mp4'), '/clips/a_001-2.mp4');
  assert.equal(clipPath('/clips/a.mp4'), '/clips/a.mp4');
  for (const path of ['//clips/a.mp4', 'clips/../a.mp4', 'clips/a.mp4?x', 'clips/%61.mp4', 'http://10.42.0.1:8080/clips/a.mp4', 'clips/a.mp4\n', null])
    assert.throws(() => clipPath(path));
});
test('metadata uses captured coordinates only and validates device and timestamp', () => {
  assert.equal(record('pi-blackbox', row).metadata.lat, null);
  assert.equal(record('pi-blackbox', { ...row, lat: 37, lon: 127 }).metadata.lat, 37);
  assert.equal(record('pi-blackbox', { ...row, lat: 91, lon: 127 }).metadata.lat, null);
  for (const device of ['../pi', 'pi/a', '', 'x'.repeat(81)]) assert.throws(() => record(device, row));
  for (const t_ms of [NaN, null, '123', -1, 1e18]) assert.throws(() => record('pi', { ...row, t_ms }));
});
test('anonymous import survives IndexedDB reopen and uploads on login only', async () => {
  const f = fixture();
  await f.queue.receive('pi-blackbox', row);
  await f.queue.flush(); assert.equal(f.uploads.length, 0);
  const saved = await f.store.get('pi-blackbox_' + row.t_ms);
  assert.deepEqual([...new Uint8Array(await saved.blob.arrayBuffer())], [0, 128, 255]);
  f.login('user-A'); await f.queue.flush();
  assert.equal(f.rows[0].path, 'user-A/pi-blackbox_' + row.t_ms + '.mp4');
  assert.equal(f.rows[0].user_id, 'user-A');
  assert.equal(f.rows[0].impact, 2.1);
  assert.equal((await f.store.get(saved.key)).blob, undefined);
  await f.queue.receive('pi-blackbox', row); await f.queue.flush();
  assert.equal(f.downloads(), 1); assert.equal(f.uploads.length, 1); assert.equal(f.rows.length, 1);
});
test('IndexedDB data persists across separate store instances', async () => {
  const db = new IDBFactory(); const first = openStore(db);
  await first.put({ key: 'a', blob: new Blob(['video']), owner: 'A' });
  const second = openStore(db); assert.equal((await second.get('a')).owner, 'A');
  assert.equal(await (await second.get('a')).blob.text(), 'video');
});
test('failed upload retains Blob and is never reassigned to another account', async () => {
  const f = fixture(); f.login('user-A'); await f.queue.receive('pi-blackbox', row);
  f.faults.upload = true; await assert.rejects(f.queue.flush(), /offline/);
  f.login('user-B'); await f.queue.flush(); assert.equal(f.uploads.length, 1);
  assert.ok((await f.store.all())[0].blob);
  f.login('user-A'); f.faults.upload = false; await f.queue.flush(); assert.equal(f.rows.length, 1);
});
test('object upload followed by metadata failure recovers without overwriting or duplicate rows', async () => {
  const f = fixture(); f.login('user-A'); await f.queue.receive('pi-blackbox', row);
  f.faults.insert = true; await assert.rejects(f.queue.flush(), /목록 저장 실패/);
  assert.equal(f.objects.size, 1); assert.ok((await f.store.all())[0].blob);
  f.faults.insert = false; await f.queue.flush(); await f.queue.flush();
  assert.equal(f.objects.size, 1); assert.equal(f.rows.length, 1);
});
test('missing server table retains local video without attempting object upload', async () => {
  const f = fixture(); f.login('user-A'); await f.queue.receive('pi-blackbox', row);
  f.faults.query = true; await assert.rejects(f.queue.flush(), /조회 실패/);
  assert.equal(f.uploads.length, 0); assert.ok((await f.store.all())[0].blob);
});
test('account change during download keeps original owner', async () => {
  const f = fixture(); f.login('user-A');
  f.camera.getVideoBlob = async () => { f.login('user-B'); return new Blob(['video']); };
  await f.queue.receive('pi-blackbox', row); await f.queue.flush();
  assert.equal((await f.store.all())[0].owner, 'user-A'); assert.equal(f.uploads.length, 0);
});
test('account change after upload stops metadata write and retains the original queue entry', async () => {
  const f = fixture(); f.login('user-A'); await f.queue.receive('pi-blackbox', row);
  f.client.storage.from = () => ({ upload: async () => { f.login('user-B'); return {}; } });
  await assert.rejects(f.queue.flush(), /계정이 변경/);
  assert.equal(f.rows.length, 0); assert.equal((await f.store.all())[0].owner, 'user-A');
});
test('failed Wi-Fi download and empty or oversize clips never create queue entries', async () => {
  const f = fixture(); f.faults.download = true;
  await assert.rejects(f.queue.receive('pi-blackbox', row), /Wi-Fi/);
  for (const size of [0, 8 * 1024 * 1024 + 1]) {
    f.camera.getVideoBlob = async () => new Blob([new Uint8Array(size)]);
    await assert.rejects(f.queue.receive('pi-blackbox', row), /크기/);
  }
  assert.equal((await f.store.all()).length, 0);
});
test('full offline queue is bounded before another camera download', async () => {
  const f = fixture();
  await f.store.put({ key: 'full', blob: new Blob([new Uint8Array(100 * 1024 * 1024)]) });
  await assert.rejects(f.queue.receive('pi-blackbox', row), /공간/); assert.equal(f.downloads(), 0);
});
