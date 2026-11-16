// Reloads the unpacked extension in the running browser after editing it.
// A reload leaves it disabled when developer mode is off, so enable it again.
import { chromium } from 'playwright-core';
const b = await chromium.connectOverCDP('http://127.0.0.1:9333');
const p = await b.contexts()[0].newPage();
await p.goto('chrome://extensions');
console.log(await p.evaluate(async () => {
  const find = async () => (await chrome.developerPrivate.getExtensionsInfo()).find((e) => e.name.includes('køreprøvetider'));
  const x = await find();
  await chrome.developerPrivate.reload(x.id, { failQuietly: true });
  await new Promise((r) => chrome.management.setEnabled(x.id, true, r));
  await new Promise((r) => setTimeout(r, 500));
  return `reloaded ${x.name} ${x.version}: ${(await find()).state}`;
}));
await p.close(); await b.close(); process.exit(0);
