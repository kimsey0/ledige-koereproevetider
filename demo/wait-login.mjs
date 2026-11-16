// Exits once the launched browser is logged in to the booking app.
import { chromium } from 'playwright-core';

const browser = await chromium.connectOverCDP('http://127.0.0.1:9333');
const deadline = Date.now() + 15 * 60 * 1000;
while (Date.now() < deadline) {
  for (const page of browser.contexts().flatMap((c) => c.pages())) {
    if (!page.url().startsWith('https://onlinebooking.prod.workforce-planner.dk/')) continue;
    const s = await page.evaluate(() => {
      const t = JSON.parse(localStorage.getItem('online-booking:auth:token') || 'null');
      return { token: !!t?.accessToken, extension: !!document.querySelector('#ledige-tider-host'), path: location.pathname };
    }).catch(() => null);
    if (s?.token && !s.path.includes('callback-login')) { console.log('LOGGED IN', JSON.stringify(s)); process.exit(0); }
  }
  await new Promise((r) => setTimeout(r, 2000));
}
console.log('TIMEOUT waiting for login');
process.exit(1);
