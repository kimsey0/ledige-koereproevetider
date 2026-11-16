// Prints whether the demo browser is running and logged in.
import { chromium } from 'playwright-core';
const b = await chromium.connectOverCDP('http://127.0.0.1:9333', { timeout: 5000 }).catch(() => null);
if (!b) { console.log('BROWSER NOT RUNNING'); process.exit(0); }
const pages = b.contexts()[0].pages();
let page = pages.find((p) => p.url().includes('onlinebooking.prod')) ?? pages[0];
await page.goto('https://onlinebooking.prod.workforce-planner.dk/microsites/6a53be98-4705-43e6-be57-72e7218d448b', { waitUntil: 'domcontentloaded' }).catch(() => {});
await page.waitForTimeout(7000);
console.log(page.url().slice(0, 90), '|', await page.title(), '|', (await page.evaluate(() => document.body.innerText.slice(0, 100)).catch(() => '')).replace(/\s+/g, ' '));
await b.close(); process.exit(0);
