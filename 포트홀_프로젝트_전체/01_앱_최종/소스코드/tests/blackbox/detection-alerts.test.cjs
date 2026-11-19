const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const root = { addEventListener() {} };
const elements = {};
vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../../www/detection-alerts.js'), 'utf8'), {
  window: root, document: { getElementById(id) { return elements[id] ||= {}; }, addEventListener() {} },
  navigator: {}, console
});
const { nearby } = root.DetectionAlertPolicy;
const fix = { timestamp: 100000, coords: { latitude: 37, longitude: 127, accuracy: 10 } };
test('new detections require a fresh, accurate fix and valid coordinates within 1km', () => {
  assert.equal(nearby({ id: 1, latitude: 37.001, longitude: 127 }, fix, 100001), true);
  for (const row of [{ id: 1, latitude: 38, longitude: 127 }, { id: 1, latitude: null, longitude: 127 },
    { id: 1, latitude: 91, longitude: 127 }, { latitude: 37, longitude: 127 }]) assert.equal(nearby(row, fix, 100001), false);
  assert.equal(nearby({ id: 1, latitude: 37, longitude: 127 }, fix, 130001), false);
  assert.equal(nearby({ id: 1, latitude: 37, longitude: 127 }, null, 100001), false);
  assert.equal(nearby({ id: 1, latitude: 37, longitude: 127 }, { ...fix, coords: { ...fix.coords, accuracy: 150 } }, 100001), false);
});
