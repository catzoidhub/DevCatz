import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, extname, join } from 'node:path';
import { run } from './env';

/**
 * Linux apps (TODO §35): what the desktop knows from its `.desktop` files — browsers, editors and terminals for
 * Settings → Open with, their icons from the icon theme, and starting one with a file or a link. Covers apt / .deb,
 * snap, flatpak and the user's own `~/.local/share/applications`.
 */

export interface DesktopApp {
  /** The .desktop file: what Settings stores and what starts the app. */
  file: string;
  /** Its id, e.g. `google-chrome.desktop`, `firefox_firefox.desktop`. */
  id: string;
  name: string;
  exec: string;
  icon: string;
  mime: string[];
  categories: string[];
}

const home = homedir();
const dataDirs = (): string[] => {
  const xdg = (process.env.XDG_DATA_DIRS || '/usr/local/share:/usr/share').split(':').filter(Boolean);
  return [
    process.env.XDG_DATA_HOME || join(home, '.local', 'share'),
    join(home, '.local', 'share', 'flatpak', 'exports', 'share'),
    '/var/lib/flatpak/exports/share',
    '/var/lib/snapd/desktop',
    ...xdg,
  ].filter((d, i, all) => all.indexOf(d) === i);
};

/** The [Desktop Entry] group of a .desktop file: plain `Key=value` lines, no localised keys. `hidden`: also NoDisplay ones. */
function parse(file: string, hidden = false): DesktopApp | null {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const entry: Record<string, string> = {};
  let inEntry = false;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('[')) {
      inEntry = line === '[Desktop Entry]';
      continue;
    }
    if (!inEntry || !line || line.startsWith('#')) continue;
    const at = line.indexOf('=');
    if (at > 0) entry[line.slice(0, at).trim()] ??= line.slice(at + 1).trim();
  }
  if (entry.Type !== 'Application' || entry.Hidden === 'true' || (entry.NoDisplay === 'true' && !hidden) || !entry.Exec || !entry.Name) return null;
  const list = (v?: string) => (v ?? '').split(';').map((s) => s.trim()).filter(Boolean);
  return { file, id: basename(file), name: entry.Name, exec: entry.Exec, icon: entry.Icon ?? '', mime: list(entry.MimeType), categories: list(entry.Categories) };
}

let cache: { at: number; apps: DesktopApp[] } | null = null;

/** Every app the desktop lists; the first .desktop file with an id wins, as in the XDG spec. Cached for 10 s. */
export function desktopApps(): DesktopApp[] {
  if (cache && Date.now() - cache.at < 10_000) return cache.apps;
  const seen = new Set<string>();
  const apps: DesktopApp[] = [];
  for (const dir of dataDirs()) {
    const appsDir = join(dir, 'applications');
    let names: string[] = [];
    try {
      names = readdirSync(appsDir).filter((n) => n.endsWith('.desktop'));
    } catch {
      continue;
    }
    for (const n of names) {
      if (seen.has(n)) continue;
      seen.add(n);
      const a = parse(join(appsDir, n));
      if (a) apps.push(a);
    }
  }
  cache = { at: Date.now(), apps };
  return apps;
}

/** Browsers: they say so (Categories=WebBrowser) and open https links. */
export function linuxBrowsers(): DesktopApp[] {
  return desktopApps().filter((a) => a.categories.includes('WebBrowser') && a.mime.some((m) => m === 'x-scheme-handler/https' || m === 'text/html'));
}

/** The program an Exec= line starts, for matching aliases (`/usr/bin/google-chrome-stable %U` → google-chrome-stable). */
const program = (exec: string) => basename(exec.trim().split(/\s+/)[0].replace(/^"|"$/g, ''));

/**
 * The default browser among `browsers`: xdg-settings / xdg-mime name a .desktop id, which may be a hidden alias
 * (Chrome's com.google.Chrome.desktop, NoDisplay) of a listed one — then the listed one that starts the same program.
 */
export async function defaultBrowser(browsers: DesktopApp[]): Promise<DesktopApp | null> {
  const id = await defaultBrowserId();
  if (!id) return null;
  const direct = browsers.find((b) => b.id === id);
  if (direct) return direct;
  for (const dir of dataDirs()) {
    const alias = parse(join(dir, 'applications', id), true);
    if (alias) return browsers.find((b) => program(b.exec) === program(alias.exec)) ?? null;
  }
  return null;
}

/** The default browser's .desktop id (xdg-settings, else the https handler in mimeapps.list). */
async function defaultBrowserId(): Promise<string | null> {
  for (const [cmd, args] of [
    ['xdg-settings', ['get', 'default-web-browser']],
    ['xdg-mime', ['query', 'default', 'x-scheme-handler/https']],
  ] as const) {
    const r = await run(cmd, [...args], { timeout: 5000 });
    const id = r.stdout.trim();
    if (r.code === 0 && id.endsWith('.desktop')) return id;
  }
  return null;
}

/** Known editors by display name → the .desktop ids their packages install (deb / rpm, snap, flatpak, Toolbox). */
const EDITOR_IDS: Record<string, string[]> = {
  'Visual Studio Code': ['code.desktop', 'code_code.desktop', 'com.visualstudio.code.desktop'],
  Cursor: ['cursor.desktop', 'cursor_cursor.desktop', 'co.anysphere.cursor.desktop'],
  Windsurf: ['windsurf.desktop'],
  Zed: ['dev.zed.Zed.desktop', 'zed.desktop'],
  WebStorm: ['jetbrains-webstorm.desktop', 'webstorm_webstorm.desktop', 'com.jetbrains.WebStorm.desktop'],
  PhpStorm: ['jetbrains-phpstorm.desktop', 'phpstorm_phpstorm.desktop', 'com.jetbrains.PhpStorm.desktop'],
  'Sublime Text': ['sublime_text.desktop', 'sublime-text_subl.desktop', 'com.sublimetext.three.desktop'],
  Kate: ['org.kde.kate.desktop'],
  // GNOME's own (Ubuntu's default), so there is always something to open a file with.
  'Text Editor': ['org.gnome.TextEditor.desktop', 'org.gnome.gedit.desktop'],
};
export const LINUX_EDITORS = Object.keys(EDITOR_IDS);

/** The editor's .desktop file, when it is installed (JetBrains Toolbox names its files jetbrains-<product>-<hash>). */
export function linuxEditorFile(name: string): string | null {
  const ids = EDITOR_IDS[name];
  if (!ids) return null;
  const apps = desktopApps();
  const hit = apps.find((a) => ids.includes(a.id)) ?? apps.find((a) => ids.some((id) => id.startsWith('jetbrains-') && a.id.startsWith(id.replace(/\.desktop$/, '-'))));
  return hit?.file ?? null;
}

// ---- icons

const ICON_SIZES = ['256x256', '128x128', '96x96', '64x64', '48x48', 'scalable'];

/** The icon file for an `Icon=` value: an absolute path, or a name looked up in hicolor (and pixmaps). */
function iconFile(icon: string): string | null {
  if (!icon) return null;
  if (icon.startsWith('/')) return existsSync(icon) ? icon : null;
  const roots = dataDirs().map((d) => join(d, 'icons'));
  for (const root of roots)
    for (const size of ICON_SIZES)
      for (const ext of size === 'scalable' ? ['.svg'] : ['.png', '.svg']) {
        const p = join(root, 'hicolor', size, 'apps', icon + ext);
        if (existsSync(p)) return p;
      }
  for (const ext of ['.png', '.svg', '.xpm']) {
    const p = join('/usr/share/pixmaps', icon + ext);
    if (existsSync(p)) return p;
  }
  return null;
}

/** The app's icon as a data URL (PNG or SVG) for the window, '' when there is none. */
export function linuxIconUrl(desktopFile: string): string {
  const a = parse(desktopFile);
  const f = a ? iconFile(a.icon) : null;
  if (!f) return '';
  const type = extname(f).toLowerCase() === '.svg' ? 'image/svg+xml' : extname(f).toLowerCase() === '.png' ? 'image/png' : '';
  if (!type) return '';
  try {
    return `data:${type};base64,${readFileSync(f).toString('base64')}`;
  } catch {
    return '';
  }
}

// ---- starting apps

/** Exec= split into words (double quotes), its field codes filled with `arg` (%u %U %f %F) or dropped. */
function execArgs(exec: string, arg: string | null, a: DesktopApp): string[] {
  const words: string[] = [];
  let cur = '';
  let quoted = false;
  let started = false;
  for (let i = 0; i < exec.length; i++) {
    const c = exec[i];
    if (quoted && c === '\\' && i + 1 < exec.length) {
      cur += exec[++i];
      continue;
    }
    if (c === '"') {
      quoted = !quoted;
      started = true;
      continue;
    }
    if (!quoted && /\s/.test(c)) {
      if (started) words.push(cur);
      cur = '';
      started = false;
      continue;
    }
    cur += c;
    started = true;
  }
  if (started) words.push(cur);
  const out: string[] = [];
  let used = false;
  for (const w of words) {
    if (/^%[uUfF]$/.test(w)) {
      if (arg !== null) out.push(arg);
      used = true;
    } else if (w === '%i') {
      if (a.icon) out.push('--icon', a.icon);
    } else if (w === '%c') out.push(a.name);
    else if (w === '%k') out.push(a.file);
    else if (/^%[dDnNvm]$/.test(w)) continue;
    else out.push(w.replace(/%%/g, '%'));
  }
  if (!used && arg !== null) out.push(arg);
  return out;
}

/** Starts a .desktop app with a file, folder or link (or nothing); false when it could not start. */
export function launchDesktop(file: string, arg: string | null): Promise<boolean> {
  const a = parse(file);
  if (!a) return Promise.resolve(false);
  const [cmd, ...args] = execArgs(a.exec, arg, a);
  if (!cmd) return Promise.resolve(false);
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    child.once('error', () => resolve(false));
    child.once('spawn', () => {
      child.unref();
      resolve(true);
    });
  });
}

/** A terminal in a folder: the desktop's own first (GNOME Console / Terminal, Ptyxis, Konsole …), then the Debian alternative. */
export async function openLinuxTerminal(dir: string): Promise<boolean> {
  const tries: [string, string[]][] = [
    ['ptyxis', ['--new-window', '--working-directory', dir]],
    ['gnome-terminal', [`--working-directory=${dir}`]],
    ['kgx', [`--working-directory=${dir}`]],
    ['konsole', ['--workdir', dir]],
    ['xfce4-terminal', [`--working-directory=${dir}`]],
    ['tilix', [`--working-directory=${dir}`]],
    ['alacritty', ['--working-directory', dir]],
    ['kitty', ['--directory', dir]],
    ['wezterm', ['start', '--cwd', dir]],
    ['x-terminal-emulator', []],
  ];
  for (const [cmd, args] of tries) {
    if ((await run('which', [cmd], { timeout: 3000 })).code !== 0) continue;
    const ok = await new Promise<boolean>((resolve) => {
      const child = spawn(cmd, args, { detached: true, stdio: 'ignore', cwd: dir });
      child.once('error', () => resolve(false));
      child.once('spawn', () => {
        child.unref();
        resolve(true);
      });
    });
    if (ok) return true;
  }
  return false;
}

/** Unpacks a .zip on Linux: `unzip` when there, else Python's zipfile (one of the two is on nearly every system). */
export async function unzipLinux(archive: string, dir: string): Promise<{ code: number; stdout: string; stderr: string }> {
  if ((await run('which', ['unzip'], { timeout: 3000 })).code === 0) return run('unzip', ['-q', '-o', archive, '-d', dir], { timeout: 120_000 });
  if ((await run('which', ['python3'], { timeout: 3000 })).code === 0) return run('python3', ['-m', 'zipfile', '-e', archive, dir], { timeout: 120_000 });
  return { code: 1, stdout: '', stderr: 'neither unzip nor python3 is installed (sudo apt install unzip)' };
}
