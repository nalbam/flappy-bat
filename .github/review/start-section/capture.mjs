// Capture script for the start-section screenshots. Needs Playwright in /tmp/pw and
// `python3 -m http.server 8765 --bind 127.0.0.1` at the repository root. Run: node capture.mjs <out dir> 2200
import { chromium } from '/tmp/pw/node_modules/playwright/index.mjs';
import { createObstacleGenerator } from '/workspace/repo/docs/obstacle-generator.mjs';
const out = process.argv[2], stopMs = Number(process.argv[3] ?? 2200);
const g = createObstacleGenerator(20261031);
const flaps = [...g.next().path.flaps, ...g.next().path.flaps].map((t) => t * 1000 / 120).filter((ms) => ms < stopMs);
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
for (const [name, w, h] of [['desktop-1280x720', 1280, 720], ['phone-390x844', 390, 844]]) {
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`${m.type()}: ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  await page.goto('http://127.0.0.1:8765/docs/?seed=20261031');
  await page.waitForTimeout(2500);
  await page.evaluate(({ flaps, stopMs }) => new Promise((done) => {
    const key = (code, type) => window.dispatchEvent(new KeyboardEvent(type, { code, key: code === 'Space' ? ' ' : 'p', bubbles: true }));
    const t0 = performance.now();
    for (const ms of flaps) setTimeout(() => { key('Space', 'keydown'); setTimeout(() => key('Space', 'keyup'), 20); }, ms);
    setTimeout(() => { key('KeyP', 'keydown'); key('KeyP', 'keyup'); done(); }, stopMs);
  }), { flaps, stopMs });
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${out}/${name}-first-pillar-paused.jpg` });
  const score = await page.evaluate(() => document.body.innerText.match(/SCORE\s*(\d+)/)?.[1]);
  const over = await page.evaluate(() => /다시 시작/.test(document.body.innerText) && !/일시정지/.test(document.body.innerText));
  console.log(name, 'flaps', flaps.length, 'score', score, 'over?', over, 'console errors/warnings:', errors.length ? errors : 'none');
  await page.close();
}
await browser.close();
