// Offline smoke test: runs content.js against a stubbed copy of the booking
// site and API, in Chromium and (if it starts) Firefox. Nothing is sent to the
// real site. It checks the script's own logic, not extension-specific
// behaviour such as how Firefox isolates content scripts from the page.
import { chromium, firefox } from 'playwright-core';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const script = readFileSync(path.resolve(import.meta.dirname, '..', 'extension', 'content.js'), 'utf8');
const pw = path.join(process.env.LOCALAPPDATA ?? '', 'ms-playwright');
const find = (prefix, rel) => readdirSync(pw).filter((d) => d.startsWith(prefix + '-')).sort().reverse().flatMap((d) => rel.map((r) => path.join(pw, d, r))).find(existsSync);

const SITE = 'https://onlinebooking.prod.workforce-planner.dk';
const MS = '00000000-0000-4000-8000-000000000001';
const cat = (id, name, parent, offers = []) => ({ onlineCategoryId: id, name, parentOnlineCategoryId: parent, childrenOnlineCategoryIds: [], onlineOfferIds: offers });
const offer = (id, name) => ({ onlineOfferId: id, name, defaultDuration: 60, daysInFuture: 42 });
const options = {
  onlineCategories: [cat('a1', 'Fyn', null), cat('a2', 'Midtsjælland', null), cat('c1', 'Odense, Testvej 1', 'a1', ['o1', 'o2']), cat('c2', 'Nyborg, Testvej 2 ', 'a1', ['o3']), cat('c3', 'Roskilde, Testvej 3', 'a2', ['o4'])],
  onlineOffers: [offer('o1', 'Bil (B) - Praktisk prøve'), offer('o2', 'Bil (B) - Teoriprøve'), offer('o3', 'Bil (B) - Praktisk prøve'), offer('o4', 'Bil (B) - Praktisk prøve')],
};
const slots = { o1: ['2030-01-08T08:10:00', '2030-01-08T08:10:00', '2030-01-09T11:00:00'], o2: ['2030-01-10T09:00:00'], o4: 'fail' };
const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' }, body: JSON.stringify(body) });

async function run(name, type, executablePath) {
  const browser = await type.launch({ executablePath, headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route(SITE + '/**', (r) => r.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Stub</title><main><h1>Stub</h1></main>' }));
  await page.route('https://onlinebooking-api.prod.workforce-planner.dk/**', (r) => {
    const p = new URL(r.request().url()).pathname;
    if (r.request().method() === 'OPTIONS') return json(r, {});
    if (p === '/auth/user-info') return json(r, { fullName: 'Test Person', isBookOnBehalf: true, isMitIdProfessional: true });
    if (p === '/person/associated-persons') return json(r, { loggedInPerson: { fullName: 'Test Person', civilRegistrationIdentifier: '0101901234' }, associatedPersons: [{ fullName: 'Elev Et' }] });
    if (p === '/processes/applicant-processes') return json(r, [{ processId: 'p1', taskTypeId: 't1', taskTypeName: 'B' }]);
    if (p.endsWith('/booking-options')) return json(r, options);
    const m = p.match(/time-slots\/[^/]+\/(\w+)/);
    if (m) return slots[m[1]] === 'fail' ? json(r, {}, 500) : json(r, { timeSlots: (slots[m[1]] ?? []).map((s) => ({ startTime: s, resources: [{ email: 'examiner@example.com' }] })) });
    return json(r, {}, 404);
  });
  await page.goto(`${SITE}/microsites/${MS}/processes`);
  await page.evaluate((ms) => localStorage.setItem('online-booking:auth:token', JSON.stringify({ accessToken: 'aaaaaaaaaaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbbbbbbbbbb.cccccccccccccccc', refreshToken: 'x', expiresAt: Date.now() + 300000, tokenType: 'bearer', micrositeId: ms, isImpersonating: false, isMitIdCitizenLogin: false })), MS);
  await page.addScriptTag({ content: script });
  const host = page.locator('#ledige-tider-host');
  await host.locator('.launch').click();
  await host.locator('.status', { hasText: 'ledige tider på' }).waitFor({ timeout: 15000 });
  const status = await host.locator('.status span').innerText();
  const chips = await host.locator('.chip').allInnerTexts();
  const times = await host.locator('a.time').allInnerTexts();
  const warn = await host.locator('.warn').allInnerTexts();
  await host.locator('a.time').first().click();
  await page.waitForTimeout(4600);
  const landed = new URL(page.url()).pathname;
  await host.locator('.launch').click();
  await host.locator('footer .link').click();
  const logText = await host.locator('textarea').inputValue();
  const leaks = ['Test Person', 'Elev Et', '0101901234', 'examiner@example.com', 'aaaaaaaaaaaa'].filter((s) => logText.includes(s));
  const types = [...logText.matchAll(/"type":"([\w-]+)"/g)].map((m) => m[1]);
  const checks = {
    'status text': status === '3 ledige tider på 2 af 4 prøvesteder',
    'type and area chips': chips.length === 4,
    'seat count shown': times.some((t) => t.replace(/\s/g, '') === '08:10×2'),
    'failed center reported': warn.length === 1,
    'handover navigated': /\/offers\/o\d\/time-slots\/2030-01-0\d$/.test(landed),
    'log has key events': ['init', 'open', 'user-info', 'associated-persons', 'processes', 'booking-options', 'scan-end', 'slots-failed', 'handover-start', 'handover-result'].every((t) => types.includes(t)),
    'log has no errors': !types.includes('error'),
    'log leaks nothing personal': leaks.length === 0,
    'no page errors': errors.length === 0,
  };
  await browser.close();
  const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([k]) => k);
  console.log(`${name}: ${failed.length ? 'FAILED ' + failed.join('; ') : 'all ' + Object.keys(checks).length + ' checks passed'}`);
  if (failed.length) console.log({ status, chips, times, warn, landed, leaks, errors, types: [...new Set(types)] });
  return failed.length === 0;
}

let ok = true;
ok = await run('chromium', chromium, find('chromium', ['chrome-win64/chrome.exe', 'chrome-win/chrome.exe'])) && ok;
try { ok = await run('firefox', firefox, find('firefox', ['firefox/firefox.exe'])) && ok; }
catch (e) { console.log('firefox: could not run (' + e.message.split('\n')[0].slice(0, 140) + ')'); }
process.exit(ok ? 0 : 1);
