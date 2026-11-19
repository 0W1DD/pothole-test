const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const localScript = path.join(__dirname, 'blackbox-wifi.js');
const source = fs.readFileSync(fs.existsSync(localScript) ? localScript : path.resolve(__dirname, '../../www/blackbox-wifi.js'), 'utf8');
function setup(plugin = {}) {
  const root = {
    Capacitor: { Plugins: { BlackboxWifi: plugin } },
    document: { readyState: 'loading', addEventListener() {} },
    atob,
    navigator: { geolocation: { getCurrentPosition(ok) {
      ok({ coords: { latitude: 36.1, longitude: 127.1, accuracy: 3 }, timestamp: 123 });
    } } }
  };
  vm.runInNewContext(source, { window: root, URL, Uint8Array, Blob });
  return { api: root.BlackboxWifi, root };
}
test('JSON uses local plugin GET and parses body', async () => {
  let received;
  const { api } = setup({ get: async (options) => {
    received = options; return { status: 200, data: '{"records":[1]}' };
  } });
  const result = await api.getJson();
  assert.equal(JSON.stringify(result), '{"records":[1]}');
  assert.equal(received.url, 'http://10.42.0.1:8080/index.json');
  assert.equal(received.asBlob, false);
});
test('foreign URLs and credentials are rejected before native I/O', async () => {
  let calls = 0;
  const { api } = setup({ get: async () => { calls++; } });
  for (const url of ['https://10.42.0.1:8080/a', 'http://10.42.0.1:80/a', '//example.com/a',
    'http://10.42.0.2:8080/a', 'file:///a', 'http://user@10.42.0.1:8080/a',
    'http://10.42.0.1:8080/#frag', '/foo\nbar', 'http://10.42.0.1:8080\\@example.com/a']) {
    await assert.rejects(api.get(url));
  }
  assert.equal(calls, 0);
});
test('HTTP errors and malformed JSON never become records', async () => {
  await assert.rejects(setup({ get: async () => ({ status: 404, data: '{}' }) }).api.getJson(), /404/);
  await assert.rejects(setup({ get: async () => ({ status: 200, data: '<html>' }) }).api.getJson(), /JSON/);
});
test('photo is requested as base64 and converted to uploadable Blob', async () => {
  const data = '/9j/AA==';
  const { api } = setup({ get: async (options) => {
    assert.equal(options.asBlob, true);
    return { status: 200, data, size: 4, contentType: 'application/octet-stream' };
  } });
  assert.equal((await api.getPhoto('/photos/a.jpg')).dataUrl, 'data:image/jpeg;base64,' + data);
  const blob = await api.getPhotoBlob('/photos/a.jpg');
  assert.equal(blob.type, 'image/jpeg');
  assert.deepEqual([...new Uint8Array(await blob.arrayBuffer())], [255, 216, 255, 0]);
});
test('HTML/SVG from camera is not rendered as a photo', async () => {
  const { api } = setup({ get: async () => ({ status: 200, data: btoa('<svg>bad</svg>') }) });
  await assert.rejects(api.getPhoto('/photo'), /사진 형식/);
});
test('registration forwards credentials and GPS preserves measurement time/accuracy', async () => {
  let received;
  const { api } = setup({ register: async (options) => { received = options; return { registered: true }; } });
  assert.equal((await api.register('PotholeCam', 'pothole1234')).registered, true);
  assert.equal(received.password, 'pothole1234');
  assert.equal(received.ssid, 'PotholeCam');
  const gps = await api.currentPosition();
  assert.equal(gps.timestamp, 123); assert.equal(gps.accuracy, 3);
});
test('normal browser shows unsupported instead of falling back to ordinary fetch', () => {
  const { api, root } = setup();
  delete root.Capacitor;
  assert.throws(() => api.connect(), /Android/);
});

test('MP4 uses native binary GET and preserves every byte with video/mp4 MIME', async () => {
  const bytes = Buffer.from([0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109, 0, 128, 255]);
  const { api } = setup({ get: async (options) => {
    assert.equal(options.url, 'http://10.42.0.1:8080/clips/impact_20261119-001.mp4');
    assert.equal(options.asBlob, true);
    return { status: 200, encoding: 'base64', data: bytes.toString('base64'),
      size: bytes.length, contentType: 'application/octet-stream' };
  } });
  const blob = await api.getVideoBlob('/clips/impact_20261119-001.mp4');
  assert.ok(blob instanceof Blob);
  assert.equal(blob.type, 'video/mp4');
  assert.equal(blob.size, bytes.length);
  assert.deepEqual(Buffer.from(await blob.arrayBuffer()), bytes);
});

test('unsafe MP4 paths are rejected before native I/O', async () => {
  let calls = 0;
  const { api } = setup({ get: async () => { calls++; throw new Error('Unexpected native I/O'); } });
  const invalid = [undefined, null, 1, {}, ['/clips/a.mp4'], '', 'clips/a.mp4',
    '/photos/a.mp4', '/clips/.mp4', '/clips/a.MP4', '/clips/a.jpg', '/clips/a.mp4.exe',
    '/clips/../a.mp4', '/clips/../clips/a.mp4', '/clips/nested/a.mp4', '/clips//a.mp4',
    '/clips/./a.mp4', '/clips/%2e%2e/a.mp4', '/clips/a%2fb.mp4', '/clips/a%5cb.mp4',
    '/clips/a%252fb.mp4', '/clips/%61.mp4', '/clips/a.mp4?x=1', '/clips/a.mp4#x',
    '/clips/a b.mp4', '/clips/영상.mp4', '/clips/a\\b.mp4', '/clips/a\0.mp4',
    '/clips/a.mp4\n', '/clips/a.mp4\r\n', '/clips/a\t.mp4',
    'http://10.42.0.1:8080/clips/a.mp4', 'https://example.com/clips/a.mp4',
    '//10.42.0.1:8080/clips/a.mp4', 'file:///clips/a.mp4'];
  for (const path of invalid) {
    await assert.rejects(api.getVideoBlob(path), /주소/, String(path));
  }
  assert.equal(calls, 0);
});

test('MP4 HTTP failures are checked before Base64 decoding', async () => {
  for (const status of [199, 300, 302, 400, 404, 500]) {
    const { api, root } = setup({ get: async () => ({ status, data: '<html>error</html>' }) });
    root.atob = () => { assert.fail('Failed HTTP bodies must not be decoded'); };
    await assert.rejects(api.getVideoBlob('/clips/a.mp4'), new RegExp('HTTP ' + status));
  }
});

test('MP4 propagates native failures including the 8 MiB limit', async () => {
  for (const message of ['블랙박스 Wi-Fi에 연결하세요.', '응답 시간 초과', '응답 크기 제한 초과 (최대 8 MiB)']) {
    const error = new Error(message);
    const { api } = setup({ get: async () => { throw error; } });
    await assert.rejects(api.getVideoBlob('/clips/a.mp4'), (actual) => actual === error);
  }
});

test('invalid MP4 Base64 rejects instead of returning a Blob', async () => {
  const { api } = setup({ get: async () => ({ status: 200, data: '%%%invalid-base64%%%' }) });
  await assert.rejects(api.getVideoBlob('/clips/a.mp4'), { name: 'InvalidCharacterError' });
});

for (const mib of [1, 5]) {
  test(`${mib} MiB video payload survives the native Base64 response byte-for-byte`, async () => {
    const bytes = Buffer.alloc(mib * 1024 * 1024);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i % 256;
    const { api } = setup({ get: async () => ({ status: 200, data: bytes.toString('base64') }) });
    const blob = await api.getVideoBlob('/clips/large.mp4');
    assert.equal(blob.type, 'video/mp4');
    assert.equal(blob.size, bytes.length);
    assert.deepEqual(Buffer.from(await blob.arrayBuffer()), bytes);
  });
}

test('MP4 does not fall back to browser fetch when the plugin is unavailable', async () => {
  const { api, root } = setup();
  delete root.Capacitor;
  root.fetch = () => { assert.fail('Must use the native Wi-Fi route'); };
  await assert.rejects(api.getVideoBlob('/clips/a.mp4'), /Android/);
});

test('shared Blob conversion preserves PNG, GIF and WebP photo types and bytes', async () => {
  for (const [type, bytes] of [
    ['image/png', Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0])],
    ['image/gif', Buffer.from('GIF89a\0', 'binary')],
    ['image/webp', Buffer.from('RIFF\0\0\0\0WEBP', 'binary')]
  ]) {
    const { api } = setup({ get: async () => ({ status: 200, data: bytes.toString('base64') }) });
    const blob = await api.getPhotoBlob('/photos/a');
    assert.equal(blob.type, type);
    assert.deepEqual(Buffer.from(await blob.arrayBuffer()), bytes);
  }
});
