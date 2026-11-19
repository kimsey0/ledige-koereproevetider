// Offline smoke test: runs content.js against a stubbed copy of the booking
// site and API, in Chromium and (if it starts) Firefox. Nothing is sent to the
// real site. It checks the script's own logic, not extension-specific
// behaviour such as how Firefox isolates content scripts from the page.
//
// Two scenarios: a citizen booking for themselves, and a driving instructor
// booking on behalf of a student (the API then needs impersonatedPersonId).
import { chromium, firefox } from 'playwright-core';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const script = readFileSync(path.resolve(import.meta.dirname, '..', 'extension', 'content.js'), 'utf8');
const pw = path.join(process.env.LOCALAPPDATA ?? '', 'ms-playwright');
const find = (prefix, rel) => readdirSync(pw).filter((d) => d.startsWith(prefix + '-')).sort().reverse().flatMap((d) => rel.map((r) => path.join(pw, d, r))).find(existsSync);

const SITE = 'https://onlinebooking.prod.workforce-planner.dk';
const API = 'https://onlinebooking-api.prod.workforce-planner.dk';
const MS = '00000000-0000-4000-8000-000000000001';
const OWN_PROCESS = '11111111-1111-4111-8111-111111111111';
const STUDENT_PROCESS = '22222222-2222-4222-8222-222222222222';
const STUDENT = '33333333-3333-4333-8333-333333333333';
const cat = (id, name, parent, offers = []) => ({ onlineCategoryId: id, name, parentOnlineCategoryId: parent, childrenOnlineCategoryIds: [], onlineOfferIds: offers });
const offer = (id, name) => ({ onlineOfferId: id, name, defaultDuration: 60, daysInFuture: 42 });
const options = {
  onlineCategories: [cat('a1', 'Fyn', null), cat('a2', 'Midtsjælland', null), cat('c1', 'Odense, Testvej 1', 'a1', ['o1', 'o2']), cat('c2', 'Nyborg, Testvej 2 ', 'a1', ['o3']), cat('c3', 'Roskilde, Testvej 3', 'a2', ['o4'])],
  onlineOffers: [offer('o1', 'Bil (B) - Praktisk prøve'), offer('o2', 'Bil (B) - Teoriprøve'), offer('o3', 'Bil (B) - Praktisk prøve'), offer('o4', 'Bil (B) - Praktisk prøve')],
};
const slots = { o1: ['2030-01-08T08:10:00', '2030-01-08T08:10:00', '2030-01-09T11:00:00'], o2: ['2030-01-10T09:00:00'], o4: 'fail' };
const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' }, body: JSON.stringify(body) });

async function run(name, type, executablePath, instructor) {
  const browser = await type.launch({ executablePath, headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route(SITE + '/**', (r) => r.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Stub</title><main><h1>Stub</h1></main>' }));
  await page.route(API + '/**', (r) => {
    const url = new URL(r.request().url()), p = url.pathname;
    // As an instructor, calls about the student only work with the student's id.
    const forStudent = url.searchParams.get('impersonatedPersonId') === STUDENT;
    if (r.request().method() === 'OPTIONS') return json(r, {});
    if (p === '/auth/user-info') return json(r, { fullName: 'Test Person', isBookOnBehalf: false, isMitIdProfessional: instructor });
    if (p === '/person/associated-persons') return json(r, { loggedInPerson: { fullName: 'Test Person', civilRegistrationIdentifier: '0101901234' }, associatedPersons: [{ fullName: 'Elev Et' }] });
    if (p === '/processes/applicant-processes') return json(r, instructor ? [] : [{ processId: OWN_PROCESS, taskTypeId: 't1', taskTypeName: 'B' }]);
    if (p.endsWith('/booking-options')) return p.includes(instructor ? STUDENT_PROCESS : OWN_PROCESS) && forStudent === instructor ? json(r, options) : json(r, {}, 400);
    const m = p.match(/time-slots\/[^/]+\/(\w+)/);
    if (m) return forStudent !== instructor || slots[m[1]] === 'fail' ? json(r, {}, 500) : json(r, { timeSlots: (slots[m[1]] ?? []).map((s) => ({ startTime: s, resources: [{ email: 'examiner@example.com' }] })) });
    return json(r, {}, 404);
  });
  await page.goto(`${SITE}/microsites/${MS}/booking-options${instructor ? '' : '/process/' + OWN_PROCESS}`);
  await page.evaluate(([ms, imp]) => localStorage.setItem('online-booking:auth:token', JSON.stringify({ accessToken: 'aaaaaaaaaaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbbbbbbbbbb.cccccccccccccccc', refreshToken: 'x', expiresAt: Date.now() + 300000, tokenType: 'bearer', micrositeId: ms, isImpersonating: imp, isMitIdCitizenLogin: !imp })), [MS, instructor]);
  // The site's own call that reveals which student is selected.
  if (instructor) await page.evaluate((u) => new Promise((done) => { const x = new XMLHttpRequest(); x.open('GET', u); x.onloadend = done; x.send(); }), `${API}/process/${STUDENT_PROCESS}/booking-options?impersonatedPersonId=${STUDENT}`);
  await page.addScriptTag({ content: script });
  const host = page.locator('#ledige-tider-host');
  await host.locator('.launch').click();
  await host.locator('.status', { hasText: 'ledige tider på' }).waitFor({ timeout: 15000 });
  const status = await host.locator('.status span').innerText();
  const chips = await host.locator('.chip').allInnerTexts();
  const times = await host.locator('a.time').allInnerTexts();
  const warn = await host.locator('.warn').allInnerTexts();
  const sub = await host.locator('.sub').innerText();
  await host.locator('a.time').first().click();
  await page.waitForTimeout(1000);
  const landed = new URL(page.url()).pathname;
  // From one slot page to another: goes through the detour.
  await host.locator('.launch').click();
  await host.locator('a.time').last().click();
  await page.waitForTimeout(instructor ? 10000 : 10000);
  const landed2 = new URL(page.url()).pathname;
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
    'header names the student mode': sub.includes('den valgte elev') === instructor,
    'handover navigated': /\/offers\/o1\/time-slots\/2030-01-08$/.test(landed),
    'second handover navigated': /\/offers\/o2\/time-slots\/2030-01-10$/.test(landed2),
    'detour kept to the right flow': instructor ? !logText.includes('/appointments') : logText.includes('/appointments'),
    'log has key events': ['init', 'open', 'user-info', 'associated-persons', 'processes', 'context', 'booking-options', 'scan-end', 'slots-failed', 'handover-start', 'handover-detour', 'handover-result'].every((t) => types.includes(t)),
    'log shows parameter names only': logText.includes('booking-options?impersonatedPersonId"') === instructor && !logText.includes('impersonatedPersonId='),
    'log has no errors': !types.includes('error'),
    'log leaks nothing personal': leaks.length === 0,
    'no page errors': errors.length === 0,
  };
  await browser.close();
  const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([k]) => k);
  console.log(`${name}: ${failed.length ? 'FAILED ' + failed.join('; ') : 'all ' + Object.keys(checks).length + ' checks passed'}`);
  if (failed.length) console.log({ status, chips, times, warn, sub, landed, landed2, leaks, errors, types: [...new Set(types)], log: logText.split('\n').filter((l) => /handover|context|"error"/.test(l)) });
  return failed.length === 0;
}

let ok = true;
const chromePath = find('chromium', ['chrome-win64/chrome.exe', 'chrome-win/chrome.exe']);
ok = await run('chromium, citizen', chromium, chromePath, false) && ok;
ok = await run('chromium, instructor', chromium, chromePath, true) && ok;
try { ok = await run('firefox, instructor', firefox, find('firefox', ['firefox/firefox.exe']), true) && ok; }
catch (e) { console.log('firefox: could not run (' + e.message.split('\n')[0].slice(0, 140) + ')'); }
process.exit(ok ? 0 : 1);
