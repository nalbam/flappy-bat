// Browser evidence for the recent flights on the result card (README "조작", docs/flight-history.mjs).
//
// Needs Playwright outside the repository and a static server at the repository root:
//   (cd /tmp/pw && npm i playwright@1 && npx playwright install chromium)
//   python3 -m http.server 8765 --bind 127.0.0.1        # at the repository root
//   PLAYWRIGHT_MODULE=/tmp/pw/node_modules/playwright/index.mjs node capture.mjs [base url] [out dir]
// Defaults: base url http://127.0.0.1:8765/docs/, out dir = the folder of this script.
//
// Scenario: clean storage, three flights on /docs/ (crash -> restart in the page; every flight draws a new seed,
// so the newest-first order shows in the seeds), reload of /docs/ with one more flight (four records kept), then
// a click on the newest seed link: the URL gets ?seed=<seed>, the click does not start a flight, and the next
// flight uses that seed. Then result cards at 390x844 and 844x390 in the same storage (five records).
// The flights press Space on the planned path of SEED only for the phone flight; timing in headless swiftshader
// is not exact, so scores are what the game reports, not a target.
import { writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, isAbsolute, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const pwPath = process.env.PLAYWRIGHT_MODULE ?? 'playwright';
const { chromium } = await import(isAbsolute(pwPath) ? pathToFileURL(pwPath).href : pwPath);
const { createObstacleGenerator } = await import(new URL('../../../docs/obstacle-generator.mjs', import.meta.url).href);
const base = process.argv[2] ?? 'http://127.0.0.1:8765/docs/';
const out = process.argv[3] ?? here;
const SEED = 20261031, KEYS = ['flappyBatRecent', 'flappyBatBest', 'flappyBatMuted'];

// Flap times (ms after the start press) of the generator's planned path for the first pillars of SEED.
const g = createObstacleGenerator(SEED);
const planned = [0, 1, 2].flatMap(() => g.next().path.flaps).map((t) => t * 1000 / 120);

const log = [];
const note = (line) => { log.push(line); console.log(line); };
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const context = await browser.newContext(); // one context: every page shares the same localStorage

async function openPage(width, height) {
  const page = await context.newPage();
  await page.setViewportSize({ width, height });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`${m.type()}: ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  return { page, errors };
}
const storage = (page) => page.evaluate((keys) => Object.fromEntries(keys.map((k) => [k, localStorage.getItem(k)])), KEYS);
const phase = (page) => page.evaluate(() => document.getElementById('overlay').dataset.phase);

// One flight: Space presses on the planned path until `stopMs`, then no input until the crash.
// A press after a crash would start the next flight, so the presses stop once the result card shows.
async function fly(page, stopMs) {
  await page.evaluate(({ flaps, stopMs }) => new Promise((done) => {
    const key = (type) => window.dispatchEvent(new KeyboardEvent(type, { code: 'Space', key: ' ', bubbles: true, cancelable: true }));
    const over = () => document.getElementById('overlay').dataset.phase === 'over';
    for (const ms of flaps.filter((t) => t <= stopMs)) setTimeout(() => { if (ms > 0 && over()) return; key('keydown'); setTimeout(() => key('keyup'), 20); }, ms);
    setTimeout(done, stopMs + 40);
  }), { flaps: planned, stopMs });
  await page.waitForFunction(() => document.getElementById('overlay').dataset.phase === 'over', null, { timeout: 30000 });
  await page.waitForTimeout(700); // let the crash shake and the card fade settle
  return page.evaluate(() => ({
    score: Number(document.querySelector('.result-score')?.textContent),
    seed: Number(document.querySelector('.result-seed')?.textContent.replace('SEED', '')),
    card: document.querySelector('#overlay .panel').innerText.replace(/\n+/g, ' | '),
    hrefs: [...document.querySelectorAll('#recentList a')].map((a) => a.getAttribute('href')),
  }));
}
async function report(page, label, flight, before) {
  const after = await storage(page);
  note(`${label}: score ${flight.score}, seed ${flight.seed}`);
  note(`  card: ${flight.card}`);
  note(`  link hrefs: ${JSON.stringify(flight.hrefs)}`);
  note(`  localStorage before: ${JSON.stringify(before)}`);
  note(`  localStorage after:  ${JSON.stringify(after)}`);
  return after;
}
// True when every link and the restart button sit inside the viewport and the panel shows them unclipped.
const fits = (page) => page.evaluate(() => {
  const inside = (el) => { const r = el.getBoundingClientRect(); return r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight && r.right <= innerWidth && r.height > 0; };
  return [...document.querySelectorAll('#recentList a'), document.getElementById('restartButton')].every(inside);
});

// Desktop: three flights from a clean storage.
const desk = await openPage(1280, 720);
await desk.page.goto(base);
// Known values for the two existing keys, so the log shows that flights leave them as they are
// (no flight here beats a best score of 3, and nothing presses M).
await desk.page.evaluate(() => { localStorage.clear(); localStorage.setItem('flappyBatBest', '3'); localStorage.setItem('flappyBatMuted', '0'); });
await desk.page.reload();
await desk.page.waitForTimeout(2500);
note(`== 1280x720 ${base}, storage cleared, then flappyBatBest=3 and flappyBatMuted=0`);
let before = await storage(desk.page);
const flown = [];
for (const [i, stopMs] of [[1, 0], [2, 300], [3, 600]].values()) {
  const flight = await fly(desk.page, stopMs);
  flown.push(flight);
  before = await report(desk.page, `flight ${i}`, flight, before);
}
const listed = await desk.page.evaluate(() => [...document.querySelectorAll('#recentList li')].map((li) => li.innerText.replace(/\n+/g, ' ')));
note(`  card list (newest first): ${JSON.stringify(listed)}; flights newest first: ${JSON.stringify(flown.map((f) => `${f.score}점 SEED ${f.seed}`).reverse())}`);
note(`  links and restart button inside 1280x720: ${await fits(desk.page)}`);
await desk.page.screenshot({ path: join(out, 'desktop-1280x720-result-3-flights.jpg') });

// Reload without ?seed: the records stay, and one more flight makes four.
await desk.page.goto(base);
await desk.page.waitForTimeout(2500);
note(`== reload ${base}`);
note(`  phase after reload: ${await phase(desk.page)}, localStorage: ${JSON.stringify(before = await storage(desk.page))}`);
const fourth = await fly(desk.page, 0);
before = await report(desk.page, 'flight 4 (after reload)', fourth, before);
note(`  list length: ${fourth.hrefs.length}`);
await desk.page.screenshot({ path: join(out, 'desktop-1280x720-result-after-reload.jpg') });

// Click the newest seed link with a real mouse press on it: navigation only, no new flight.
const link = desk.page.locator('#recentList a').first();
const href = await link.getAttribute('href');
await Promise.all([desk.page.waitForURL((u) => u.search === href), link.click()]);
await desk.page.waitForTimeout(2500);
const afterClick = await storage(desk.page);
note(`== click on ${href}: url ${desk.page.url()}, phase ${await phase(desk.page)}, records ${JSON.parse(afterClick.flappyBatRecent).length} (unchanged: ${afterClick.flappyBatRecent === before.flappyBatRecent})`);
const replay = await fly(desk.page, 0);
note(`  flight 5 on the link: seed ${replay.seed} (link seed ${fourth.seed}, same: ${replay.seed === fourth.seed}), score ${replay.score}`);
note(`  console errors/warnings/pageerrors 1280x720: ${desk.errors.length ? JSON.stringify(desk.errors) : 'none'}`);
await desk.page.close();

// Phone and a short landscape screen in the same storage: five records and the restart button fit.
for (const [name, w, h] of [['phone-390x844', 390, 844], ['landscape-844x390', 844, 390]]) {
  const { page, errors } = await openPage(w, h);
  await page.goto(`${base}?seed=${SEED}`);
  await page.waitForTimeout(2500);
  const b = await storage(page);
  const flight = await fly(page, 3300);
  await report(page, `== ${name} flight`, flight, b);
  note(`  list length ${flight.hrefs.length}, links and restart button inside ${w}x${h}: ${await fits(page)}`);
  note(`  console errors/warnings/pageerrors ${name}: ${errors.length ? JSON.stringify(errors) : 'none'}`);
  await page.screenshot({ path: join(out, `${name}-result.jpg`) });
  await page.close();
}
await browser.close();
writeFileSync(join(out, 'capture-log.txt'), `${log.join('\n')}\n`);
