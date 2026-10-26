// Rasterises scripts/icons/*.svg into resources/ through a running Electron
// instance's DevTools protocol (no image library needed):
//   bun run build && electron . --user-data-dir=/tmp/devcatz-icons --remote-debugging-port=9222 &
//   bun scripts/render-icons.ts [port]
// Writes icon.png (1024), trayTemplate.png (18/36) and trayActiveTemplate.png.
import { readFileSync, writeFileSync } from 'node:fs';

const port = Number(process.argv[2] ?? 9222);
const targets = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()) as { type: string; url: string; webSocketDebuggerUrl: string }[];
const page = targets.find((t) => t.type === 'page' && !t.url.startsWith('devtools'));
if (!page) throw new Error('No page target');
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map<number, (v: { result?: Record<string, unknown>; error?: unknown }) => void>();
ws.onmessage = (e) => {
  const m = JSON.parse(String(e.data));
  if (m.id && pending.has(m.id)) pending.get(m.id)!(m);
};
await new Promise((r) => (ws.onopen = r));
const send = (method: string, params: Record<string, unknown> = {}) =>
  new Promise<Record<string, unknown>>((resolve, reject) => {
    pending.set(++id, (m) => (m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result ?? {})));
    ws.send(JSON.stringify({ id, method, params }));
  });

async function render(svgFile: string, out: string, size: number, scale: number) {
  const svg = readFileSync(svgFile, 'utf8');
  const html = `<!doctype html><html><body style="margin:0;background:transparent;width:${size}px;height:${size}px;overflow:hidden">${svg.replace(
    /width="\d+" height="\d+"/,
    `width="${size}" height="${size}"`,
  )}</body></html>`;
  await send('Page.navigate', { url: `data:text/html;charset=utf-8,${encodeURIComponent(html)}` });
  await new Promise((r) => setTimeout(r, 400));
  await send('Emulation.setDeviceMetricsOverride', { width: size, height: size, deviceScaleFactor: scale, mobile: false });
  await send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
  const r = (await send('Page.captureScreenshot', {
    format: 'png',
    clip: { x: 0, y: 0, width: size, height: size, scale: 1 },
    captureBeyondViewport: true,
  })) as { data: string };
  writeFileSync(out, Buffer.from(r.data, 'base64'));
  console.log('wrote', out, size * scale);
}

await render('scripts/icons/app.svg', 'resources/icon.png', 512, 2);
await render('scripts/icons/tray.svg', 'resources/trayTemplate.png', 18, 1);
await render('scripts/icons/tray.svg', 'resources/trayTemplate@2x.png', 18, 2);
await render('scripts/icons/tray-active.svg', 'resources/trayActiveTemplate.png', 18, 1);
await render('scripts/icons/tray-active.svg', 'resources/trayActiveTemplate@2x.png', 18, 2);
await send('Emulation.clearDeviceMetricsOverride');
ws.close();
process.exit(0);
