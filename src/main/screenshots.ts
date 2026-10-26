import { BrowserWindow, session } from 'electron';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir } from './store';

const WIDTH = 1280;
const HEIGHT = 800;
/** Time after `did-finish-load` for hydration, fonts and client-side data. */
const SETTLE_MS = 2500;
const LOAD_TIMEOUT_MS = 30_000;

function dir(): string {
  const d = dataDir('screenshots');
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
  return d;
}

const fileFor = (projectId: string) => join(dir(), `${projectId}.jpg`);

/** Capture time (ms) of the stored screenshot, or null. */
export function screenshotTime(projectId: string): number | null {
  try {
    return statSync(fileFor(projectId)).mtimeMs;
  } catch {
    return null;
  }
}

export function screenshotDataUrl(projectId: string): string | null {
  try {
    return `data:image/jpeg;base64,${readFileSync(fileFor(projectId)).toString('base64')}`;
  } catch {
    return null;
  }
}

const inFlight = new Map<string, Promise<boolean>>();

/**
 * Renders the site in a hidden, sandboxed window (its own in-memory session,
 * no cookies shared with anything) and stores a 640×400 JPEG thumbnail, the
 * way Laravel Herd shows a preview of each site.
 */
export function captureScreenshot(projectId: string, url: string): Promise<boolean> {
  const running = inFlight.get(projectId);
  if (running) return running;
  const job = capture(projectId, url).finally(() => inFlight.delete(projectId));
  inFlight.set(projectId, job);
  return job;
}

let screenshotSession: Electron.Session | null = null;

function getSession(): Electron.Session {
  if (!screenshotSession) {
    // In-memory partition (no `persist:` prefix): nothing is written to disk or shared.
    screenshotSession = session.fromPartition('mrcatz-herd-screenshots');
    screenshotSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
    screenshotSession.on('will-download', (e) => e.preventDefault());
    // HTTPS sites: accept certificates issued by DevCatz's own CA in this session
    // (the user may not have trusted the CA in the keychain yet); everything else
    // goes through Chromium's normal verification.
    screenshotSession.setCertificateVerifyProc((req, cb) => cb(['DevCatz Local CA', 'MrCatz Herd Local CA'].includes(req.certificate.issuerName) ? 0 : -3));
  }
  return screenshotSession;
}

async function capture(projectId: string, url: string): Promise<boolean> {
  const ses = getSession();

  const win = new BrowserWindow({
    width: WIDTH,
    height: HEIGHT,
    show: false,
    paintWhenInitiallyHidden: true,
    webPreferences: { session: ses, offscreen: true, sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  win.webContents.setAudioMuted(true);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  try {
    await Promise.race([
      win.loadURL(url),
      new Promise((_, reject) => setTimeout(() => reject(new Error('load timeout')), LOAD_TIMEOUT_MS)),
    ]);
    await new Promise((r) => setTimeout(r, SETTLE_MS));
    if (win.isDestroyed()) return false;
    const image = await win.webContents.capturePage();
    if (image.isEmpty()) return false;
    writeFileSync(fileFor(projectId), image.resize({ width: 640, quality: 'best' }).toJPEG(82));
    return true;
  } catch (err) {
    console.warn(`screenshot ${projectId} (${url}) failed:`, (err as Error).message);
    return false;
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}
