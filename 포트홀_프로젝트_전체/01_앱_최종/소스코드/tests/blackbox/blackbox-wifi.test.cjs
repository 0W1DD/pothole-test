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
