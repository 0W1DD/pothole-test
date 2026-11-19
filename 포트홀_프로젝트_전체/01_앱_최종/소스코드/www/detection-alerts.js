(function () {
  'use strict';
  const state = document.getElementById('detection-state');
  let channel, watch, fix, active = false, generation = 0;
  const seen = new Set();
  const native = () => {
    const plugin = window.Capacitor?.Plugins?.DetectionAlerts;
    if (!plugin) throw new Error('새 감지 알림은 Android 앱에서 사용할 수 있습니다.');
    return plugin;
  };
  function distance(a, b, c, d) {
    const radians = Math.PI / 180;
    const h = Math.sin((c-a)*radians/2)**2 + Math.cos(a*radians)*Math.cos(c*radians)*Math.sin((d-b)*radians/2)**2;
    return 12742000 * Math.asin(Math.sqrt(Math.min(1, h)));
  }
  function nearby(row, position, now = Date.now()) {
    if (!position || !Number.isFinite(position.timestamp) || now - position.timestamp > 30000 || now < position.timestamp
        || !Number.isFinite(position.coords.accuracy) || position.coords.accuracy < 0 || position.coords.accuracy > 100
        || !Number.isFinite(position.coords.latitude) || !Number.isFinite(position.coords.longitude)) return false;
    if (['수리완료', '완료', 'repaired'].includes(row.status)) return false;
    const lat = row.latitude, lon = row.longitude;
    if (typeof lat !== 'number' || typeof lon !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lon)
        || Math.abs(lat) > 90 || Math.abs(lon) > 180 || row.id == null) return false;
    return distance(position.coords.latitude, position.coords.longitude, lat, lon) <= 1000;
  }
  async function stop() {
    active = false; generation++; fix = null;
    if (watch !== undefined) navigator.geolocation.clearWatch(watch);
    watch = undefined;
    const old = channel; channel = null;
    if (old) await mapDB.removeChannel(old);
    state.textContent = '새 감지 알림이 꺼져 있습니다.';
  }
  document.getElementById('detection-stop').onclick = () => stop().catch(e => { state.textContent = e.message; });
  document.getElementById('detection-start').onclick = async () => {
    if (active) return;
    active = true; const run = ++generation;
    try {
      await native().enable();
      if (run !== generation) return;
      watch = navigator.geolocation.watchPosition(p => { fix = p; }, () => {
        fix = null; state.textContent = '위치 권한과 GPS를 확인하세요. 정확한 위치가 없으면 알리지 않습니다.';
      }, { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 });
      channel = mapDB.channel('nearby-detections-' + run).on('postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'potholes' }, async payload => {
          if (!active || run !== generation || !nearby(payload.new, fix)) return;
          const row = payload.new, id = String(row.id);
          if (seen.has(id)) return;
          seen.add(id); if (seen.size > 1000) seen.delete(seen.values().next().value);
          try { await native().notifyDetection({ id, lat: row.latitude, lon: row.longitude }); }
          catch (error) { seen.delete(id); state.textContent = error.message; }
        }).subscribe(status => {
          if (run !== generation) return;
          state.textContent = status === 'SUBSCRIBED' ? '내 위치 1km 안의 새 포트홀을 확인합니다. 위치 권한과 GPS를 켜 두세요.'
            : '실시간 연결 확인 중: ' + status + ' · 서버 Realtime 설정과 인터넷을 확인하세요.';
        });
    } catch (error) { await stop(); state.textContent = error.message; }
  };
  async function consume() {
    try { const row = await native().consumeTap(); if (row.id != null) window.showDetectedPothole(row); } catch (_) { }
  }
  try { native().addListener('tap', consume); consume(); } catch (_) { }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) consume(); });
  window.addEventListener('pagehide', stop);
  window.DetectionAlertPolicy = { nearby, distance };
})();
