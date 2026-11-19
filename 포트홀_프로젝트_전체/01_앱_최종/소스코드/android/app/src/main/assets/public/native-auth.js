// =====================================================================
// 폰 앱(Capacitor) 카카오 로그인 → 앱으로 돌아오기 (딥링크)
//  - 웹사이트: 지금처럼 사이트 주소로 돌아감 (이 파일은 아무것도 안 함)
//  - 앱: 로그인 페이지를 폰 브라우저 탭으로 열고, 끝나면
//        com.gimmegimme.pothole://login-callback 으로 앱이 다시 열림 → 받은 토큰/코드로 세션 만들기
//  - Supabase 대시보드 Auth → URL Configuration → Redirect URLs 에
//    com.gimmegimme.pothole://login-callback 이 등록돼 있어야 함 (없으면 웹사이트로 감)
// =====================================================================
(function (root) {
  'use strict';
  const REDIRECT = 'com.gimmegimme.pothole://login-callback';
  const cap = () => root.Capacitor;
  const isNative = () => !!(cap() && cap().isNativePlatform && cap().isNativePlatform());
  const plugin = name => (cap() && cap().Plugins && cap().Plugins[name]) || null;
  let handling = null;

  // 돌아온 주소에서 세션 만들기. 처리했으면 true
  async function handleUrl(url) {
    if (typeof url !== 'string' || !url.startsWith(REDIRECT)) return false;
    let u;
    try { u = new URL(url); } catch (_) { return false; }
    const query = u.searchParams, hash = new URLSearchParams((u.hash || '').replace(/^#/, ''));
    const browser = plugin('Browser');
    if (browser && browser.close) browser.close().catch(() => {});
    const err = query.get('error_description') || hash.get('error_description') || query.get('error') || hash.get('error');
    if (err) { await showAlert('로그인 실패: ' + err); return true; }
    let result;
    if (query.get('code')) {
      result = await supabaseClient.auth.exchangeCodeForSession(query.get('code'));          // PKCE 방식
    } else if (hash.get('access_token') && hash.get('refresh_token')) {
      result = await supabaseClient.auth.setSession({                                          // implicit 방식
        access_token: hash.get('access_token'), refresh_token: hash.get('refresh_token') });
    } else {
      await showAlert('로그인 정보를 받지 못했습니다. 다시 시도해 주세요.');
      return true;
    }
    if (result && result.error) { await showAlert('로그인 실패: ' + result.error.message); return true; }
    // 로그인 누르기 전 화면으로
    const saved = typeof popReturnView === 'function' ? popReturnView() : null;
    if (saved && ['map', 'board', 'report', 'mypage', 'write'].includes(saved.view)) go(saved.view);
    return true;
  }

  function onUrl(url) {
    // 같은 주소가 두 번 들어와도(앱 시작 + 이벤트) 한 번만 처리
    if (handling === url) return;
    handling = url;
    handleUrl(url).catch(e => showAlert('로그인 처리 실패: ' + (e && e.message ? e.message : e)));
  }

  async function login(scope) {
    const { data, error } = await supabaseClient.auth.signInWithOAuth({
      provider: 'kakao',
      options: { redirectTo: REDIRECT, skipBrowserRedirect: true, queryParams: { scope } }
    });
    if (error) { await showAlert('로그인 실패: ' + error.message); return; }
    const browser = plugin('Browser');
    if (browser && browser.open) await browser.open({ url: data.url });
    else root.location.href = data.url;            // 플러그인이 없으면 바깥 브라우저로
  }

  function init() {
    if (!isNative()) return;
    const app = plugin('App');
    if (!app) return;
    app.addListener('appUrlOpen', e => onUrl(e && e.url));
    // 앱이 꺼져 있다가 로그인 주소로 켜진 경우
    if (app.getLaunchUrl) app.getLaunchUrl().then(r => { if (r && r.url) onUrl(r.url); }).catch(() => {});
  }

  root.NativeAuth = { isNative, login, handleUrl, REDIRECT };
  init();
})(typeof window !== 'undefined' ? window : globalThis);
