// 폰 앱 카카오 로그인 딥링크(www/native-auth.js) 테스트
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const tick = () => new Promise(resolve => setTimeout(resolve, 10));
const REDIRECT = 'com.gimmegimme.pothole://login-callback';

function fixture({ native = true, launchUrl = null } = {}) {
  const log = [], alerts = [], views = [];
  let urlListener = null;
  const ctx = {
    console, URL, URLSearchParams, setTimeout, clearTimeout,
    location: { href: '' },
    showAlert: async m => { alerts.push(m); },
    go: v => views.push(v),
    popReturnView: () => ({ view: 'report' }),
    supabaseClient: { auth: {
      signInWithOAuth: async a => { log.push(['oauth', a]); return { data: { url: 'https://example.supabase.co/auth/v1/authorize?provider=kakao' }, error: null }; },
      setSession: async s => { log.push(['setSession', s]); return { error: null }; },
      exchangeCodeForSession: async c => { log.push(['exchange', c]); return { error: null }; }
    } },
    Capacitor: native ? {
      isNativePlatform: () => true,
      Plugins: {
        App: { addListener: (name, fn) => { assert.equal(name, 'appUrlOpen'); urlListener = fn; },
          getLaunchUrl: async () => (launchUrl ? { url: launchUrl } : {}) },
        Browser: { open: async o => { log.push(['open', o.url]); }, close: async () => { log.push(['close']); } }
      }
    } : undefined
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../../www/native-auth.js'), 'utf8'), ctx);
  return { ctx, log, alerts, views, open: url => urlListener && urlListener({ url }), hasListener: () => !!urlListener };
}

test('website: not native, no deep-link listener', () => {
  const f = fixture({ native: false });
  assert.equal(f.ctx.NativeAuth.isNative(), false);
  assert.equal(f.hasListener(), false);
});
test('app login asks Supabase for the app redirect and opens the browser tab', async () => {
  const f = fixture();
  await f.ctx.NativeAuth.login('profile_nickname,profile_image');
  const [, args] = f.log.find(x => x[0] === 'oauth');
  assert.equal(args.provider, 'kakao');
  assert.equal(args.options.redirectTo, REDIRECT);
  assert.equal(args.options.skipBrowserRedirect, true);
  assert.ok(f.log.some(x => x[0] === 'open' && x[1].startsWith('https://')));
});
test('implicit tokens in the hash create the session and return to the saved screen', async () => {
  const f = fixture();
  f.open(REDIRECT + '#access_token=AT&refresh_token=RT&expires_in=3600&token_type=bearer'); await tick();
  const s = f.log.find(x => x[0] === 'setSession');
  assert.deepEqual({ ...s[1] }, { access_token: 'AT', refresh_token: 'RT' });
  assert.deepEqual(f.views, ['report']);
  assert.ok(f.log.some(x => x[0] === 'close'));
});
test('PKCE code is exchanged for a session', async () => {
  const f = fixture();
  f.open(REDIRECT + '?code=abc123'); await tick();
  assert.deepEqual(f.log.find(x => x[0] === 'exchange'), ['exchange', 'abc123']);
});
test('error redirect shows a message and makes no session', async () => {
  const f = fixture();
  f.open(REDIRECT + '?error=access_denied&error_description=cancelled'); await tick();
  assert.equal(f.log.some(x => x[0] === 'setSession' || x[0] === 'exchange'), false);
  assert.match(f.alerts[0], /cancelled/);
});
test('other deep links are ignored', async () => {
  const f = fixture();
  assert.equal(await f.ctx.NativeAuth.handleUrl('https://evil.example/#access_token=a&refresh_token=b'), false);
  assert.equal(await f.ctx.NativeAuth.handleUrl('com.other.app://login-callback#access_token=a&refresh_token=b'), false);
  assert.equal(f.log.some(x => x[0] === 'setSession'), false);
});
test('cold start launch URL is handled once even if the event repeats it', async () => {
  const url = REDIRECT + '#access_token=AT&refresh_token=RT';
  const f = fixture({ launchUrl: url }); await tick();
  f.open(url); await tick();
  assert.equal(f.log.filter(x => x[0] === 'setSession').length, 1);
});
