const { chromium } = require('playwright');
const { spawn } = require('child_process');
const mode = process.argv[2] || 'test';
(async () => {
  const b = await chromium.launch({ args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader'] });
  const p = await b.newPage({ viewport: { width: 1920, height: 1080 } });
  p.on('pageerror', e => console.log('ERR', e.message));
  await p.goto('http://localhost:8765/assembly.html'); await p.waitForFunction('window.ready === true', null, { timeout: 90000 });
  if (mode === 'test') {
    for (const t of [1.5, 7.5, 14.5, 17.8, 24]) { await p.evaluate(t => window.setT(t), t); await p.screenshot({ path: `f_${t}.jpg`, type: 'jpeg', quality: 92 }); }
  } else {
    const FPS = 30, T = 26, N = FPS * T;
    const ff = spawn('ffmpeg', ['-y','-loglevel','error','-f','image2pipe','-framerate',String(FPS),'-c:v','mjpeg','-i','-','-c:v','libx264','-crf','18','-preset','veryfast','-pix_fmt','yuv420p','asm.tmp.mp4'], { stdio: ['pipe','inherit','inherit'] });
    const t0 = Date.now();
    for (let i = 0; i < N; i++) {
      await p.evaluate(t => window.setT(t), i / FPS);
      const buf = await p.screenshot({ type: 'jpeg', quality: 92 });
      if (!ff.stdin.write(buf)) await new Promise(r => ff.stdin.once('drain', r));
      if (i % 120 === 0) console.log(i, ((Date.now() - t0) / 1000).toFixed(0) + 's');
    }
    ff.stdin.end(); await new Promise(r => ff.on('close', c => { console.log('ffmpeg', c); r(); }));
  }
  await b.close();
})();
