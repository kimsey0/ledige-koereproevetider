// Starts Playwright's Chromium with the extension loaded and a debugging port,
// then leaves it running so the recording script can attach to it.
import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

export const PORT = 9333;
export const START_URL = 'https://onlinebooking.prod.workforce-planner.dk/microsites/6a53be98-4705-43e6-be57-72e7218d448b';

const here = import.meta.dirname;
const ext = path.resolve(here, '..', 'extension');
const pw = path.join(process.env.LOCALAPPDATA, 'ms-playwright');
const builds = readdirSync(pw).filter((d) => /^chromium-\d+$/.test(d)).sort((a, b) => b.split('-')[1] - a.split('-')[1]);
let exe;
for (const b of builds) for (const sub of ['chrome-win64', 'chrome-win']) {
  const p = path.join(pw, b, sub, 'chrome.exe');
  if (!exe && existsSync(p)) exe = p;
}
if (!exe) throw new Error('No Playwright Chromium found in ' + pw);

const args = [
  `--user-data-dir=${path.join(here, '.profile')}`,
  `--remote-debugging-port=${PORT}`,
  `--load-extension=${ext}`,
  `--disable-extensions-except=${ext}`,
  '--disable-features=DisableLoadExtensionCommandLineSwitch',
  '--no-first-run', '--no-default-browser-check',
  '--window-position=60,40', '--window-size=1400,950',
  START_URL,
];
spawn(exe, args, { detached: true, stdio: 'ignore' }).unref();
console.log('Started', exe);
