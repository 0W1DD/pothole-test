(function (root) {
  'use strict';
  const MAX_BYTES = 8 * 1024 * 1024;
  const MAX_QUEUE = 100 * 1024 * 1024;
  function clipPath(value) {
    if (typeof value !== 'string' || !/^\/?clips\/[A-Za-z0-9_-]+\.mp4$/.test(value) || /[\r\n]/.test(value))
      throw new Error('영상 경로는 clips/파일명.mp4 형식이어야 합니다.');
    return value.startsWith('/') ? value : '/' + value;
  }
  function record(device, row) {
    if (typeof device !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(device)) throw new Error('기기 이름이 올바르지 않습니다.');
    if (!Number.isSafeInteger(row.t_ms) || row.t_ms <= 0 || !Number.isFinite(new Date(row.t_ms).getTime()))
      throw new Error('영상의 충격 시각이 올바르지 않습니다.');
    const number = v => typeof v === 'number' && Number.isFinite(v) ? v : null;
    const lat = number(row.lat ?? row.latitude), lon = number(row.lon ?? row.longitude);
    const located = lat !== null && lon !== null && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
    return { key: device + '_' + row.t_ms, source: clipPath(row.video), owner: null, done: false,
      metadata: { captured_at: new Date(row.t_ms).toISOString(), impact: number(row.score),
        label: typeof row.label === 'string' ? row.label.slice(0, 200) : null,
        confidence: number(row.confidence), lat: located ? lat : null, lon: located ? lon : null } };
  }
  class Queue {
    constructor(store, client, camera, user) { Object.assign(this, { store, client, camera, user }); }
    async ensureLocation(item) {
      if (item.locationSource === 'phone_at_receipt') {
        item.metadata.lat = null; item.metadata.lon = null;
        delete item.locationTimestamp; delete item.locationSource;
      }
      const { lat, lon } = item.metadata;
      if (typeof lat === 'number' && Number.isFinite(lat) && Math.abs(lat) <= 90
          && typeof lon === 'number' && Number.isFinite(lon) && Math.abs(lon) <= 180) return;
      // Match the measurement time to the impact; never substitute the download location.
      const timestamp = Date.parse(item.metadata.captured_at);
      const fix = await this.camera.locationAt(timestamp);
      const delta = Math.abs(fix?.timestamp - timestamp);
      if (!fix || !Number.isFinite(fix.latitude) || Math.abs(fix.latitude) > 90
          || !Number.isFinite(fix.longitude) || Math.abs(fix.longitude) > 180
          || !Number.isFinite(fix.accuracy) || fix.accuracy <= 0 || fix.accuracy > 30
          || !Number.isFinite(delta) || delta > 2000)
        throw new Error('충격 시각의 GPS 기록이 없습니다. 영상은 폰에 보관합니다.');
      item.metadata.lat = fix.latitude; item.metadata.lon = fix.longitude;
      item.locationSource = 'phone_at_impact'; item.locationTimestamp = fix.timestamp;
    }
    async receive(device, row) {
      const item = record(device, row);
      if (await this.store.get(item.key)) return false;
      const items = await this.store.all();
      const used = items.reduce((n, r) => n + (r.blob?.size || 0), 0);
      if (used + MAX_BYTES > MAX_QUEUE) throw new Error('폰의 영상 대기 공간이 가득 찼습니다. 업로드 후 다시 가져오세요.');
      // Bind logged-in imports before network I/O; an account switch must not reassign them.
      item.owner = this.user();
      try { await this.ensureLocation(item); } catch (_) { /* Keep the clip offline until its impact can be located. */ }
      const blob = await this.camera.getVideoBlob(item.source);
      if (!(blob instanceof Blob) || blob.size === 0 || blob.size > MAX_BYTES) throw new Error('영상 크기가 올바르지 않습니다.');
      item.blob = blob;
      await this.store.put(item);
      return true;
    }
    async flush() {
      const owner = this.user();
      if (!owner) return;
      const same = () => { if (this.user() !== owner) throw new Error('계정이 변경되어 업로드를 중단했습니다.'); };
      let missing = 0;
      for (const item of await this.store.all()) {
        same();
        if (item.done || (item.owner && item.owner !== owner)) continue;
        if (!item.owner) { item.owner = owner; await this.store.put(item); }
        same();
        const path = owner + '/' + item.key + '.mp4';
        const query = () => this.client.from('pothole_videos').select('id').eq('user_id', owner).eq('path', path).limit(1);
        const existing = await query();
        same();
        if (existing.error) throw new Error('내 영상 표 조회 실패: ' + existing.error.message);
        if (!existing.data.length) {
          // Re-resolve legacy receipt locations too; one missing fix must not block other clips.
          try { await this.ensureLocation(item); } catch (_) {
            same(); await this.store.put(item); missing++; continue;
          }
          same();
          await this.store.put(item);
          same();
          const uploaded = await this.client.storage.from('pothole-videos').upload(path, item.blob,
            { contentType: 'video/mp4', upsert: false });
          same();
          // A deterministic path can already exist after an interrupted metadata insert.
          if (uploaded.error && !['409', 'Duplicate'].includes(String(uploaded.error.statusCode || uploaded.error.code)))
            throw new Error('영상 업로드 실패: ' + uploaded.error.message);
          const inserted = await this.client.from('pothole_videos').insert({ ...item.metadata, user_id: owner, path });
          same();
          if (inserted.error) {
            const retry = await query();
            same();
            if (retry.error || !retry.data.length) throw new Error('영상 목록 저장 실패: ' + inserted.error.message);
          }
        }
        // Keep a small tombstone for repeat imports; release the large local Blob only after success.
        item.done = true; delete item.blob;
        await this.store.put(item);
      }
      if (missing) throw new Error('충격 시각의 GPS 기록이 없는 영상 ' + missing + '개는 폰에 보관 중입니다.');
    }
  }
  function openStore(indexedDB) {
    const db = new Promise((resolve, reject) => {
      const request = indexedDB.open('pothole-private-videos', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('queue', { keyPath: 'key' });
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const transaction = async (write, action) => {
      const connection = await db;
      return new Promise((resolve, reject) => {
        const tx = connection.transaction('queue', write ? 'readwrite' : 'readonly');
        const request = action(tx.objectStore('queue'));
        tx.oncomplete = () => resolve(request.result);
        tx.onerror = tx.onabort = () => reject(tx.error || new Error('폰 영상 저장 실패'));
      });
    };
    return { get: key => transaction(false, s => s.get(key)), all: () => transaction(false, s => s.getAll()),
      put: item => transaction(true, s => s.put(item)) };
  }
  const api = { clipPath, record, Queue, openStore };
  if (typeof module !== 'undefined') module.exports = api;
  else root.PrivateVideoCore = api;
})(globalThis);
