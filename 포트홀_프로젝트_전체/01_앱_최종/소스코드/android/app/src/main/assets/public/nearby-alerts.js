(function () {
  'use strict';
  const native = () => {
    const plugin = window.Capacitor?.Plugins?.NearbyAlerts;
    if (!plugin) throw new Error('주변 포트홀 백그라운드 안내는 Android 앱에서 사용할 수 있습니다.');
    return plugin;
  };
  window.NearbyAlerts = Object.freeze({
    start: (radius = 300, voice = true, upload = false) => native().start({ radius, voice, upload }),
    stop: () => native().stop(),
    status: () => native().status(),
    locationAt: timestamp => native().locationAt({ timestamp })
  });
  function setup() {
    const panel = document.getElementById('nearby-alert-panel');
    if (!panel) return;
    const byId = id => document.getElementById(id);
    const radius = byId('nearby-radius'), voice = byId('nearby-voice'), upload = byId('nearby-upload'), state = byId('nearby-state');
    const start = byId('nearby-start'), stop = byId('nearby-stop');
    let busy = false, timer;
    try {
      const stored = JSON.parse(localStorage.getItem('nearby-alert-options') || '{}');
      if ([100, 200, 300, 500, 1000].includes(stored.radius)) radius.value = String(stored.radius);
      if (typeof stored.voice === 'boolean') voice.checked = stored.voice;
      if (upload && typeof stored.upload === 'boolean') upload.checked = stored.upload;
    } catch (_) { }
    function show(status) {
      state.textContent = status.message + (status.running && status.voice ? ' · ' + status.voiceStatus : '');
      if (status.running && status.upload && !status.uploadStatus) state.textContent += ' · 위치 전송 대기';
      if (status.running && (!status.notificationsEnabled || !status.warningChannelEnabled)) {
        state.textContent += ' · 앱 설정에서 주변 포트홀 알림을 켜 주세요.';
      }
      stop.disabled = busy || !status.running;
      start.disabled = busy;
      start.textContent = status.running ? '설정 적용' : '안내 시작';
      if (status.running && !busy && document.activeElement !== radius && document.activeElement !== voice && document.activeElement !== upload) {
        // Only hydrate once; polling must not overwrite a setting being edited.
        if (!panel.dataset.hydrated) {
          radius.value = String(status.radius); voice.checked = status.voice; if (upload) upload.checked = !!status.upload; panel.dataset.hydrated = '1';
        }
      }
    }
    async function run(action) {
      if (busy) return;
      busy = true; start.disabled = true; stop.disabled = true;
      state.textContent = '권한과 안내 상태를 확인하고 있습니다…';
      try { await action(); }
      catch (error) { state.textContent = error.message || String(error); }
      finally { busy = false; start.disabled = false; stop.disabled = false; }
    }
    start.onclick = () => run(async () => {
      const options = { radius: Number(radius.value), voice: voice.checked, upload: !!(upload && upload.checked) };
      const result = await window.NearbyAlerts.start(options.radius, options.voice, options.upload);
      try { localStorage.setItem('nearby-alert-options', JSON.stringify(options)); } catch (_) { }
      panel.dataset.hydrated = '1'; show(result);
    });
    stop.onclick = () => run(async () => show(await window.NearbyAlerts.stop()));
    async function refresh() {
      if (busy || document.hidden) return;
      try { show(await window.NearbyAlerts.status()); } catch (_) { }
    }
    function visible() {
      clearInterval(timer);
      if (!document.hidden) { refresh(); timer = setInterval(refresh, 3000); }
    }
    try {
      native(); visible();
      document.addEventListener('visibilitychange', visible);
      window.addEventListener('pagehide', () => clearInterval(timer));
      window.addEventListener('pageshow', visible);
    } catch (error) { state.textContent = error.message; start.disabled = true; stop.disabled = true; }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', setup, { once: true });
  else setup();
})();
