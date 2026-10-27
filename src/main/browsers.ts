import { app, nativeImage, shell } from 'electron';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { BrowserInfo, BrowsersState } from '@shared/types';
import { run } from './env';
import { store } from './store';
import { isWin } from './platform';

/**
 * Web browsers for Settings → General → Browser: the ones installed here, the
 * system default (whatever macOS opens https links with), and opening a page
 * in the chosen one. Only http(s) links go to the chosen browser; other links
 * (dbcatz://, mailto: …) keep going to the app macOS picks for them.
 */

const KNOWN = [
  'Safari',
  'Google Chrome',
  'Firefox',
  'Arc',
  'Brave Browser',
  'Microsoft Edge',
  'Opera',
  'Opera GX',
  'Vivaldi',
  'Orion',
  'Zen',
  'Zen Browser',
  'Dia',
  'Comet',
  'DuckDuckGo',
  'Chromium',
  'Google Chrome Beta',
  'Google Chrome Dev',
  'Google Chrome Canary',
  'Firefox Developer Edition',
  'Firefox Nightly',
  'Safari Technology Preview',
  'Microsoft Edge Beta',
  'Microsoft Edge Dev',
  'LibreWolf',
  'Waterfox',
  'Tor Browser',
  'Thorium',
  'Sidekick',
  'SigmaOS',
  'Min',
];
const FOLDERS = ['/Applications', join(homedir(), 'Applications'), '/System/Cryptexes/App/System/Applications', '/System/Applications'];

let state: BrowsersState = { list: [], systemDefault: null };
const icons = new Map<string, string>();

async function iconOf(path: string): Promise<string> {
  const known = icons.get(path);
  if (known) return known;
  // Quick Look's thumbnail of an .app is its real icon (getFileIcon can hand back a generic one). It needs the
  // real bundle: /Applications/Safari.app is a symlink into the system cryptex.
  const real = (() => {
    try {
      return realpathSync(path);
    } catch {
      return path;
    }
  })();
  let img = await nativeImage.createThumbnailFromPath(real, { width: 64, height: 64 }).catch(() => null);
  if (!img || img.isEmpty()) img = await icnsImage(real);
  if (!img || img.isEmpty()) img = await app.getFileIcon(real, { size: 'normal' }).catch(() => null);
  const url = img && !img.isEmpty() ? img.toDataURL() : '';
  icons.set(path, url);
  return url;
}

const nameOf = (path: string) => basename(path).replace(/\.app$/i, '');

/** The bundle's .icns (CFBundleIconFile) turned into a 64 px PNG with sips. */
async function icnsImage(app: string): Promise<Electron.NativeImage | null> {
  const plist = await run('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIconFile', join(app, 'Contents', 'Info.plist')]);
  const name = plist.stdout.trim();
  if (plist.code !== 0 || !name) return null;
  const icns = join(app, 'Contents', 'Resources', /\.icns$/i.test(name) ? name : `${name}.icns`);
  if (!existsSync(icns)) return null;
  const dir = mkdtempSync(join(tmpdir(), 'devcatz-icon-'));
  try {
    const png = join(dir, 'icon.png');
    const r = await run('sips', ['-s', 'format', 'png', '-Z', '64', icns, '--out', png]);
    return r.code === 0 && existsSync(png) ? nativeImage.createFromPath(png) : null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Apps Launch Services lists for https links: bundle path of each (JXA, no extra tools). */
async function httpsHandlers(): Promise<string[]> {
  const js = [
    'ObjC.import("CoreServices"); ObjC.import("AppKit");',
    'const ids = ObjC.deepUnwrap(ObjC.castRefToObject($.LSCopyAllHandlersForURLScheme($("https")))) || [];',
    'ids.map((id) => { const u = $.NSWorkspace.sharedWorkspace.URLForApplicationWithBundleIdentifier(id); return u.isNil() ? "" : ObjC.unwrap(u.path); }).filter(Boolean).join("\\n")',
  ].join(' ');
  const r = await run('osascript', ['-l', 'JavaScript', '-e', js], { timeout: 15_000 });
  return r.code === 0 ? r.stdout.split('\n').map((l) => l.trim()).filter(Boolean) : [];
}

/** A web browser, not just an app that also takes https links: it opens HTML documents. Hidden folders (test builds in ~/.cache) are left out. */
async function isBrowser(path: string): Promise<boolean> {
  if (path.split('/').some((part) => part.startsWith('.')) || /for Testing\.app$/i.test(path)) return false;
  const r = await run('plutil', ['-convert', 'json', '-o', '-', join(path, 'Contents', 'Info.plist')], { timeout: 10_000 });
  if (r.code !== 0) return false;
  try {
    const info = JSON.parse(r.stdout) as { CFBundleDocumentTypes?: { LSItemContentTypes?: string[]; CFBundleTypeExtensions?: string[] }[] };
    return (info.CFBundleDocumentTypes ?? []).some((t) => [...(t.LSItemContentTypes ?? []), ...(t.CFBundleTypeExtensions ?? [])].some((v) => ['public.html', 'public.xhtml', 'html', 'htm'].includes(v.toLowerCase())));
  } catch {
    return false;
  }
}

/** The path to show and open: /Applications/Safari.app rather than its cryptex target. */
function friendlyPath(path: string): string {
  const name = basename(path);
  for (const dir of FOLDERS.slice(0, 2)) {
    const p = join(dir, name);
    try {
      if (existsSync(p) && realpathSync(p) === realpathSync(path)) return p;
    } catch {
      /* keep the original */
    }
  }
  return path;
}

/**
 * Looks again: every app macOS registers for https links that also opens HTML
 * (so Firefox, Arc, Brave … appear as soon as they are installed), plus the
 * well-known browsers in the usual folders, plus the system default. True when
 * anything changed.
 */
export async function refreshBrowsers(): Promise<boolean> {
  // Windows, stage 1: links open in the system default browser; no list to pick from.
  if (isWin) return false;
  const found = new Map<string, string>(); // name → path
  for (const p of await httpsHandlers().catch(() => [])) if (existsSync(p) && (await isBrowser(p))) found.set(nameOf(p), friendlyPath(p));
  for (const name of KNOWN)
    for (const dir of FOLDERS) {
      const p = join(dir, `${name}.app`);
      if (!found.has(name) && existsSync(p)) {
        found.set(name, friendlyPath(p));
        break;
      }
    }
  const handler = await app.getApplicationInfoForProtocol('https://example.com').catch(() => null);
  const defPath = handler?.path && existsSync(handler.path) ? friendlyPath(handler.path) : null;
  if (defPath && !found.has(nameOf(defPath))) found.set(nameOf(defPath), defPath);
  const list: BrowserInfo[] = [];
  for (const [name, path] of found) list.push({ name, path, icon: await iconOf(path) });
  list.sort((a, b) => a.name.localeCompare(b.name));
  const systemDefault = defPath ? (list.find((b) => b.name === nameOf(defPath)) ?? null) : null;
  const next: BrowsersState = { list, systemDefault };
  const changed = JSON.stringify(next) !== JSON.stringify(state);
  state = next;
  return changed;
}

// ---- editors: their app icons for Settings → Open with → Editor

let editorIconMap: Record<string, string> = {};

/** Reads the icons of the installed editors (name → app path); true when anything changed. */
export async function refreshEditorIcons(editors: { name: string; path: string }[]): Promise<boolean> {
  const next: Record<string, string> = {};
  for (const e of editors) next[e.name] = await iconOf(e.path);
  const changed = JSON.stringify(next) !== JSON.stringify(editorIconMap);
  editorIconMap = next;
  return changed;
}

export function editorIcons(): Record<string, string> {
  return editorIconMap;
}

export function browsersState(): BrowsersState {
  return state;
}

/** A browser setting is '' (system default) or the path of an installed browser. */
export function validBrowser(path: string): boolean {
  return path === '' || (/\.app$/i.test(path) && existsSync(join(path, 'Contents', 'Info.plist')));
}

/** Opens a link: http(s) in the browser chosen in Settings (else the system default), anything else as macOS decides. */
export async function openWeb(url: string): Promise<void> {
  const chosen = store.settings.browser;
  if (/^https?:\/\//i.test(url) && chosen && existsSync(chosen)) {
    const r = await run('open', ['-a', chosen, url], { timeout: 30_000 });
    if (r.code === 0) return;
    console.warn(`open in ${chosen} failed (${r.stderr.trim()}); using the system default`);
  }
  await shell.openExternal(url);
}
