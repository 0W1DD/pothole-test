/* Local Capacitor plugin wrapper. Never replaces window.fetch or Supabase networking. */
(function (root) {
  'use strict';
  const BASE = 'http://10.42.0.1:8080';
  let registeredPlugin;

  function native() {
    const cap = root.Capacitor;
    const plugin = cap?.Plugins?.BlackboxWifi || registeredPlugin;
    if (plugin) return plugin;
    if (cap?.isNativePlatform?.() && cap?.registerPlugin) {
      registeredPlugin = cap.registerPlugin('BlackboxWifi');
      return registeredPlugin;
    }
    throw new Error('블랙박스 연결은 Android 앱에서 사용할 수 있습니다.');
  }

  function target(path = '/index.json') {
    if (typeof path !== 'string' || /[\x00-\x20\\]/.test(path)) {
      throw new Error('블랙박스 파일 주소가 올바르지 않습니다.');
    }
    const url = new URL(path, BASE + '/');
    if (url.origin !== BASE || url.username || url.password || url.hash) {
      throw new Error('http://10.42.0.1:8080 주소만 사용할 수 있습니다.');
    }
    return url.href;
  }

  async function get(path, asBlob = false) {
    const url = target(path);
    return native().get({ url, asBlob });
  }

  function requireSuccess(response) {
    if (response.status < 200 || response.status >= 300) {
      throw new Error('블랙박스 응답 오류: HTTP ' + response.status);
    }
    return response;
  }

  function base64ToBlob(data, type) {
    const binary = root.atob(data);
    // Avoid Uint8Array.from's intermediate array for multi-megabyte clips.
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type });
  }

  const api = {
    register: (ssid, password) => native().register({ ssid, password }),
    connect: () => native().connect(),
    status: () => native().status(),
    disconnect: () => native().disconnect(),
    forget: () => native().forget(),
    addListener: (listener) => native().addListener('change', listener),
    get,
    async getJson(path = '/index.json') {
      const response = requireSuccess(await get(path));
      try { return JSON.parse(response.data); }
      catch (_) { throw new Error('블랙박스가 올바른 JSON을 반환하지 않았습니다.'); }
    },
    async getPhoto(path) {
      const response = requireSuccess(await get(path, true));
      // Render raster images only, including servers that return generic binary MIME types.
      let type;
      if (response.data.startsWith('/9j/')) type = 'image/jpeg';
      else if (response.data.startsWith('iVBORw0KGgo')) type = 'image/png';
      else if (response.data.startsWith('R0lGOD')) type = 'image/gif';
      else {
        const header = root.atob(response.data.slice(0, 16));
        if (header.startsWith('RIFF') && header.slice(8, 12) === 'WEBP') type = 'image/webp';
        else throw new Error('지원하는 사진 형식(JPEG·PNG·GIF·WebP)이 아닙니다.');
      }
      return { ...response, contentType: type, dataUrl: 'data:' + type + ';base64,' + response.data };
    },
    async getPhotoBlob(path) {
      const photo = await api.getPhoto(path);
      return base64ToBlob(photo.data, photo.contentType);
    },
    async getVideoBlob(path) {
      // Accept only a single ASCII filename; never normalize URLs or traversal paths.
      if (typeof path !== 'string' || !/^\/clips\/[A-Za-z0-9_-]+\.mp4$/.test(path)) {
        throw new Error('영상 파일 주소는 /clips/<영문·숫자·밑줄·하이픈 파일명>.mp4 형식이어야 합니다.');
      }
      const response = requireSuccess(await get(path, true));
      // Android enforces 8 MiB on raw bytes before Base64 encoding (1–5 MB clips fit).
      return base64ToBlob(response.data, 'video/mp4');
    },
    currentPosition() {
      return new Promise((resolve, reject) => {
        if (!root.navigator.geolocation) { reject(new Error('GPS를 지원하지 않습니다.')); return; }
        root.navigator.geolocation.getCurrentPosition(
          (position) => resolve({
            latitude: position.coords.latitude, longitude: position.coords.longitude,
            accuracy: position.coords.accuracy, timestamp: position.timestamp
          }),
          (error) => reject(new Error('GPS: ' + error.message)),
          { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 }
        );
      });
    }
  };
  root.BlackboxWifi = Object.freeze(api);

  function setup() {
    const panel = root.document.getElementById('blackbox-panel');
    if (!panel) return;
    const byId = (id) => root.document.getElementById(id);
    const message = byId('blackbox-message');
    let busy = false;
    let listener;
    const labels = { idle: '연결 안 됨', requesting_permissions: '권한 확인 중', connecting: '연결 중',
      connected: '연결됨', unavailable: '연결 실패', lost: '연결 끊김' };
    function showStatus(status) {
      const internet = status.internetTransport === 'cellular' ? 'LTE/5G' : status.internetTransport;
      byId('blackbox-state').textContent = (labels[status.state] || status.state)
        + ' · 인터넷: ' + internet + (status.internetValidated ? ' (사용 가능)' : ' (연결 확인 필요)')
        + (status.bssid ? ' · 기기 기억됨' : '');
      if (status.storageError) message.textContent = status.storageError;
    }
    async function run(action) {
      if (busy) return;
      busy = true;
      panel.querySelectorAll('button').forEach((button) => { button.disabled = true; });
      message.textContent = '처리 중…';
      try { await action(); }
      catch (error) { message.textContent = error.message || String(error); }
      finally {
        busy = false;
        panel.querySelectorAll('button').forEach((button) => { button.disabled = false; });
      }
    }
    byId('blackbox-register').onclick = () => run(async () => {
      await api.register(byId('blackbox-ssid').value, byId('blackbox-password').value);
      byId('blackbox-password').value = '';
      showStatus(await api.connect());
      message.textContent = '블랙박스에 연결했습니다. 기록 조회를 눌러 확인하세요.';
    });
    byId('blackbox-connect').onclick = () => run(async () => {
      showStatus(await api.connect()); message.textContent = '저장된 블랙박스에 연결했습니다.';
    });
    byId('blackbox-disconnect').onclick = () => run(async () => {
      showStatus(await api.disconnect()); message.textContent = '연결을 해제했습니다.';
    });
    byId('blackbox-forget').onclick = () => run(async () => {
      showStatus(await api.forget()); message.textContent = '등록을 삭제했습니다. 다시 등록하면 새 기기를 찾습니다.';
    });
    byId('blackbox-status').onclick = () => run(async () => {
      showStatus(await api.status()); message.textContent = '상태를 확인했습니다.';
    });
    byId('blackbox-records').onclick = () => run(async () => {
      const records = await api.getJson();
      const preview = JSON.stringify(records, null, 2);
      byId('blackbox-json').textContent = preview.length > 16000 ? preview.slice(0, 16000) + '\n… (미리보기 생략)' : preview;
      message.textContent = 'index.json을 받았습니다.';
    });
    byId('blackbox-photo').onclick = () => run(async () => {
      const photo = await api.getPhoto(byId('blackbox-photo-path').value);
      const preview = byId('blackbox-preview');
      preview.src = photo.dataUrl; preview.hidden = false;
      message.textContent = '사진을 받았습니다. ' + photo.size + '바이트';
    });
    byId('blackbox-gps').onclick = () => run(async () => {
      const position = await api.currentPosition();
      message.textContent = '현재 위치: ' + position.latitude.toFixed(6) + ', ' + position.longitude.toFixed(6)
        + ' · 오차 약 ' + Math.round(position.accuracy) + 'm (과거 기록의 감지 위치가 아닙니다)';
    });
    // Refresh state on foreground return, but never create a permission prompt automatically.
    const refresh = () => { if (!root.document.hidden) api.status().then(showStatus).catch(() => {}); };
    try {
      native();
      api.status().then((status) => {
        showStatus(status);
        if (status.ssid) byId('blackbox-ssid').value = status.ssid;
      }).catch((error) => { message.textContent = error.message; });
      Promise.resolve(api.addListener(showStatus)).then((handle) => { listener = handle; }).catch(() => {});
      root.document.addEventListener('visibilitychange', refresh);
      root.addEventListener('pagehide', () => {
        root.document.removeEventListener('visibilitychange', refresh);
        if (listener) Promise.resolve(listener.remove()).catch(() => {});
      }, { once: true });
    } catch (error) {
      message.textContent = error.message;
      panel.querySelectorAll('button').forEach((button) => { button.disabled = true; });
    }
  }
  if (root.document.readyState === 'loading') root.document.addEventListener('DOMContentLoaded', setup, { once: true });
  else setup();
})(window);
