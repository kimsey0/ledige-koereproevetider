// Drives the demo in the already-running, logged-in browser while ffmpeg
// records that window's page area from the screen, then cuts the final video.
// Never clicks the site's "Book" buttons.
import { chromium } from 'playwright-core';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { prepareWindow, W, H } from './window.mjs';

const START_URL = 'https://onlinebooking.prod.workforce-planner.dk/microsites/6a53be98-4705-43e6-be57-72e7218d448b';
const AREAS = ['København Syd', 'Midtsjælland', 'Nordsjælland', 'Sydsjælland og Lolland Falster', 'Fyn'];
const SCAN_SECONDS = 6;   // how long the sped-up scan lasts in the final video
const here = import.meta.dirname;
const rawDir = path.join(here, '.raw');
const raw = path.join(rawDir, 'raw.mkv');
const out = path.join(here, 'demo.mp4');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.connectOverCDP('http://127.0.0.1:9333');
const ctx = browser.contexts()[0];
const page = ctx.pages().find((p) => p.url().includes('onlinebooking.prod.workforce-planner.dk')) ?? ctx.pages()[0];
const cdp = await ctx.newCDPSession(page);
const region = await prepareWindow(ctx, cdp, page);
if (region.w !== 1920 || region.h !== 1080) console.log('WARNING: unexpected capture size', JSON.stringify(region));

// ---------- cursor ----------
let mx = W * 0.45, my = H * 0.6;
async function addCursor() {
  await page.evaluate(([x, y]) => {
    if (document.getElementById('demo-cursor')) return;
    const c = document.createElement('div');
    c.id = 'demo-cursor';
    c.style.cssText = `position:fixed;left:0;top:0;z-index:2147483647;pointer-events:none;transform:translate(${x}px,${y}px)`;
    c.innerHTML = '<div style="position:absolute;left:-22px;top:-22px;width:44px;height:44px;border-radius:50%;background:rgba(255,170,0,.45);opacity:0"></div>'
      + '<svg width="26" height="26" viewBox="0 0 24 24" style="position:absolute;left:-3px;top:-2px;filter:drop-shadow(0 1px 2px rgba(0,0,0,.45))"><path d="M4 2 L4 19 L8.5 15 L11.5 22 L14.5 20.7 L11.5 14 L18 14 Z" fill="#111" stroke="#fff" stroke-width="1.4" stroke-linejoin="round"/></svg>';
    document.documentElement.append(c);
    const ring = c.firstChild;
    addEventListener('mousemove', (e) => { c.style.transform = `translate(${e.clientX}px,${e.clientY}px)`; }, true);
    addEventListener('mousedown', () => {
      ring.style.transition = 'none'; ring.style.opacity = '1'; ring.style.transform = 'scale(.3)';
      requestAnimationFrame(() => requestAnimationFrame(() => { ring.style.transition = 'opacity .5s, transform .5s'; ring.style.opacity = '0'; ring.style.transform = 'scale(1.2)'; }));
    }, true);
  }, [mx, my]);
}
async function moveTo(x, y, ms = 650) {
  const sx = mx, sy = my, n = Math.max(10, Math.round(ms / 16));
  for (let i = 1; i <= n; i++) {
    const t = i / n, e = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
    await page.mouse.move(sx + (x - sx) * e, sy + (y - sy) * e);
    await sleep(16);
  }
  mx = x; my = y;
}
async function point(locator) {
  await locator.waitFor({ state: 'visible', timeout: 20000 });
  await locator.scrollIntoViewIfNeeded();
  await sleep(150);
  const b = await locator.boundingBox();
  await moveTo(b.x + Math.min(b.width / 2, 80), b.y + b.height / 2);
}
async function click(locator, pause = 700) {
  await point(locator);
  await sleep(250);
  await page.mouse.down(); await sleep(70); await page.mouse.up();
  await sleep(pause);
}
async function wheel(total, ms = 900) {
  const n = Math.round(ms / 16);
  for (let i = 0; i < n; i++) { await page.mouse.wheel(0, total / n); await sleep(16); }
}

// ---------- prepare (not recorded) ----------
// The start page sometimes fails to load the exam track (the API answers 500
// under load) and then claims the user cannot book. Retry calmly.
await page.evaluate(() => localStorage.removeItem('ledige-tider:prefs')).catch(() => {});
for (let attempt = 1; ; attempt++) {
  await page.goto(START_URL, { waitUntil: 'domcontentloaded' });
  const ok = await page.getByRole('heading', { name: 'Vælg område' }).waitFor({ timeout: 15000 }).then(() => true, () => false);
  if (ok) break;
  if (attempt === 4) throw new Error('Start page did not load: ' + (await page.locator('main').innerText()).slice(0, 120));
  await sleep(8000);
}
const panel = page.locator('#ledige-tider-host');
await panel.locator('.launch').waitFor({ timeout: 10000 });
await addCursor();
await page.mouse.move(mx, my);
await sleep(800);

// ---------- record ----------
mkdirSync(rawDir, { recursive: true });
const topmost = (mode) => console.log(String(execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(here, 'topmost.ps1'), mode])).trim());
topmost('on');
process.on('exit', () => { try { topmost('off'); } catch {} });
await sleep(500);
const ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-nostats', '-progress', 'pipe:1',
  '-f', 'gdigrab', '-framerate', '30', '-draw_mouse', '0',
  '-offset_x', String(region.x), '-offset_y', String(region.y), '-video_size', `${region.w}x${region.h}`, '-i', 'desktop',
  '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '12', '-pix_fmt', 'yuv420p', raw], { stdio: ['pipe', 'pipe', 'inherit'] });
const ffDone = new Promise((r) => ff.on('exit', r));
const t0 = await new Promise((resolve) => ff.stdout.on('data', function on(d) { if (/frame=\s*[1-9]/.test(String(d))) { ff.stdout.off('data', on); resolve(Date.now()); } }));
ff.stdout.resume();
const marks = {};
const mark = (name) => { marks[name] = (Date.now() - t0) / 1000; };

// 1. The site's own flow: one area, one center, one calendar at a time.
await sleep(600);
mark('start');
await sleep(1500);
await click(page.getByRole('heading', { name: 'København Syd' }), 1100);
await click(page.getByRole('heading', { name: /^Kastrup/ }), 1100);
await click(page.getByRole('button', { name: /Vælg dato & tidspunkt/ }).first(), 2600);

// 2. Open the panel and let it scan every center.
await click(panel.locator('.launch'), 600);
await moveTo(W - 330, 300, 500);
await sleep(1500);
mark('scanFast');
await panel.locator('.status', { hasText: 'ledige tider på' }).waitFor({ timeout: 180000 });
mark('scanEnd');
await sleep(2200);
if (await panel.locator('.body h2').count() > 1) { await moveTo(W - 330, 520, 400); await wheel(300); await sleep(1600); await wheel(-300, 600); await sleep(500); }

// 3. Narrow down to the areas he would actually drive to.
await click(panel.locator('.link', { hasText: 'Fravælg alle' }).nth(1), 900);
for (const a of AREAS) await click(panel.locator('.chip', { hasText: new RegExp('^' + a) }), 450);
await panel.locator('.status', { hasText: 'ledige tider på' }).waitFor({ timeout: 60000 });
await sleep(2500);

// 4. Hand over to the site's own page for the first free slot.
let slot = panel.locator('a.time').first();
if (await slot.count() === 0) {
  await click(panel.locator('.link', { hasText: 'Vælg alle' }).nth(1), 1500);
  slot = panel.locator('a.time').first();
}
await click(slot, 400);
const book = page.locator('main button:visible', { hasText: /^\s*Book\s*$/ }).first();
await book.waitFor({ timeout: 20000 }).catch((e) => console.log('WARNING: no visible Book button:', e.message.split('\n')[0]));
await sleep(1200);
await point(book).catch(() => {});   // hover only
await sleep(2800);
mark('end');

ff.stdin.write('q');
await ffDone;
topmost('off');
await page.evaluate(() => document.getElementById('demo-cursor')?.remove());

// ---------- cut ----------
const f = (n) => n.toFixed(3);
const scan = marks.scanEnd - marks.scanFast;
const k = Math.max(1, Math.round(scan / SCAN_SECONDS));
const label = `drawtext=fontfile='C\\:/Windows/Fonts/segoeuib.ttf':text='Søgning vist i ${k}× hastighed':x=36:y=h-96:fontsize=34:fontcolor=white:box=1:boxcolor=black@0.65:boxborderw=16`;
const graph = k > 1
  ? `[0:v]trim=start=${f(marks.start)}:end=${f(marks.scanFast)},setpts=PTS-STARTPTS[a];`
    + `[0:v]trim=start=${f(marks.scanFast)}:end=${f(marks.scanEnd)},setpts=(PTS-STARTPTS)/${k},${label}[b];`
    + `[0:v]trim=start=${f(marks.scanEnd)}:end=${f(marks.end)},setpts=PTS-STARTPTS[c];`
    + '[a][b][c]concat=n=3:v=1,fps=30,format=yuv420p[v]'
  : `[0:v]trim=start=${f(marks.start)}:end=${f(marks.end)},setpts=PTS-STARTPTS,fps=30,format=yuv420p[v]`;
writeFileSync(path.join(rawDir, 'graph.txt'), graph);
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', raw, '-filter_complex_script', path.join(rawDir, 'graph.txt'), '-map', '[v]',
  '-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-movflags', '+faststart', out], { stdio: 'inherit' });
console.log(JSON.stringify({ marks, speedup: k, region, out }));
await browser.close().catch(() => {});
process.exit(0);
