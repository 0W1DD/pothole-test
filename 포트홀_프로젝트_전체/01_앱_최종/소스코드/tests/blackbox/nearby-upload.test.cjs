const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
test('PR3 upload option survives settings UI, native forwarding and saved preferences alongside PR6 radius', async () => {
  const ids = ['nearby-alert-panel','nearby-radius','nearby-voice','nearby-upload','nearby-state','nearby-start','nearby-stop'];
  const elements = Object.fromEntries(ids.map(id => [id, { dataset: {}, value: '300', checked: true }]));
  const html = fs.readFileSync(path.resolve(__dirname, '../../www/index.html'), 'utf8');
  for (const id of ids) assert.ok(html.includes('id="' + id + '"'), id);
  let received, saved;
  const status = { running: true, radius: 300, voice: true, upload: true, message: '전송 중',
    voiceStatus: '', notificationsEnabled: true, warningChannelEnabled: true };
  const plugin = { start: async options => { received = options; return status; }, status: async () => status };
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../../www/nearby-alerts.js'), 'utf8'), {
    window: { Capacitor: { Plugins: { NearbyAlerts: plugin } }, addEventListener() {} },
    document: { readyState: 'complete', getElementById: id => elements[id], addEventListener() {} },
    localStorage: { getItem: () => null, setItem: (_key, value) => { saved = JSON.parse(value); } },
    setInterval() {}, clearInterval() {}
  });
  await elements['nearby-start'].onclick();
  assert.equal(received.radius, 300); assert.equal(received.voice, true); assert.equal(received.upload, true);
  assert.equal(saved.upload, true);
  elements['nearby-upload'].checked = false; await elements['nearby-start'].onclick();
  assert.equal(received.upload, false); assert.equal(saved.upload, false);
});
