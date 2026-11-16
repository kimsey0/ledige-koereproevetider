// Puts the browser window at a known place and size with the page at 150 %
// browser zoom, so a 1280x720 layout fills 1920x1080 real pixels, and returns
// the screen region of the page for ffmpeg to capture.
export const W = 1280, H = 720, ZOOM = 1.5;

export async function prepareWindow(ctx, cdp, page) {
  // Real browser zoom; device emulation does not scale what the window shows.
  const settings = await ctx.newPage();
  await settings.goto('chrome://settings');
  await settings.evaluate((z) => new Promise((r) => chrome.settingsPrivate.setDefaultZoom(z, r)), ZOOM);
  await settings.close();

  const { windowId } = await cdp.send('Browser.getWindowForTarget');
  await cdp.send('Emulation.clearDeviceMetricsOverride').catch(() => {});
  // Minimise and restore to bring the window to the front.
  await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } });
  await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
  // Outer size that gives a 1920x1080 page area with this browser's toolbars.
  await cdp.send('Browser.setWindowBounds', { windowId, bounds: { left: 0, top: 0, width: 1936, height: 1231 } });
  await page.bringToFront();
  await new Promise((r) => setTimeout(r, 1000));
  const m = await page.evaluate(() => ({ sx: screenX, sy: screenY, ow: outerWidth, oh: outerHeight, iw: innerWidth, ih: innerHeight, dpr: devicePixelRatio }));
  // screenX and outerWidth are in screen pixels; innerWidth is in zoomed CSS
  // pixels, so only the inner size is scaled.
  const w = Math.round(m.iw * m.dpr), h = Math.round(m.ih * m.dpr);
  const border = (m.ow - w) / 2;
  return { x: Math.round(m.sx + border), y: Math.round(m.sy + m.oh - h - border), w, h, metrics: m };
}
