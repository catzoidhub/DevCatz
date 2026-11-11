import { spawn } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, extname, join } from 'node:path';
import { dialog, shell, type BrowserWindow } from 'electron';
import { words } from '@shared/platform';
import { run } from './env';
import { desktopApp, desktopOpensFolders, launchDesktop, launchProgram, linuxEditors } from './linuxapps';
import { isLinux, isWin } from './platform';
import { store } from './store';

/**
 * Settings → General → Open with → Editor on every platform (TODO §39): the editors found on this computer, an editor
 * picked by hand (Other…), and opening a folder or a file in it. An editor that opens single files only (GNOME Text
 * Editor, Notepad++, CotEditor) is never handed a folder: a folder goes to the file manager instead, or the caller's
 * file in it (php.ini).
 *
 * The setting is '' (Auto: the first editor found), a known editor's name, or the path of an app picked with Other…
 * (.app on macOS, .exe on Windows, a .desktop file or a program on Linux).
 */

export interface Editor {
  name: string;
  /** The .app (macOS), .exe (Windows), .desktop file or program (Linux). */
  path: string;
  /** It opens a folder as a project. */
  folders: boolean;
}

/** macOS: known editors → the app names they install as, and their bundle ids (for apps outside /Applications). */
const MAC: { name: string; apps: string[]; ids: string[]; files?: true }[] = [
  { name: 'Visual Studio Code', apps: ['Visual Studio Code'], ids: ['com.microsoft.VSCode'] },
  { name: 'Visual Studio Code - Insiders', apps: ['Visual Studio Code - Insiders'], ids: ['com.microsoft.VSCodeInsiders'] },
  { name: 'VSCodium', apps: ['VSCodium'], ids: ['com.vscodium'] },
  { name: 'Cursor', apps: ['Cursor'], ids: ['com.todesktop.230313mzl4w4u92'] },
  { name: 'Windsurf', apps: ['Windsurf'], ids: ['com.exafunction.windsurf'] },
  { name: 'Zed', apps: ['Zed'], ids: ['dev.zed.Zed'] },
  { name: 'WebStorm', apps: ['WebStorm'], ids: ['com.jetbrains.WebStorm'] },
  { name: 'PhpStorm', apps: ['PhpStorm'], ids: ['com.jetbrains.PhpStorm'] },
  { name: 'IntelliJ IDEA', apps: ['IntelliJ IDEA', 'IntelliJ IDEA Ultimate', 'IntelliJ IDEA CE'], ids: ['com.jetbrains.intellij', 'com.jetbrains.intellij.ce'] },
  { name: 'Fleet', apps: ['Fleet'], ids: ['Fleet.app'] },
  { name: 'Sublime Text', apps: ['Sublime Text'], ids: ['com.sublimetext.4', 'com.sublimetext.3'] },
  { name: 'Nova', apps: ['Nova'], ids: ['com.panic.Nova'] },
  { name: 'BBEdit', apps: ['BBEdit'], ids: ['com.barebones.bbedit'] },
  { name: 'TextMate', apps: ['TextMate'], ids: ['com.macromates.TextMate'] },
  { name: 'CotEditor', apps: ['CotEditor'], ids: ['com.coteditor.CotEditor'], files: true },
];
/** Where macOS apps live besides /Applications: the user's own, JetBrains Toolbox's and Setapp's folders. */
const macDirs = (): string[] => {
  const home = homedir();
  return ['/Applications', join(home, 'Applications'), join(home, 'Applications', 'JetBrains Toolbox'), '/Applications/Setapp'];
};

/** Windows: known editors → the programs their installers (per user, for everyone, Scoop) put on disk. */
const WIN: { name: string; exe: string; dirs: string[]; jetbrains?: string; scoop?: string; files?: true }[] = [
  { name: 'Visual Studio Code', exe: 'Code.exe', dirs: ['Microsoft VS Code'], scoop: 'vscode' },
  { name: 'Visual Studio Code - Insiders', exe: 'Code - Insiders.exe', dirs: ['Microsoft VS Code Insiders'], scoop: 'vscode-insiders' },
  { name: 'VSCodium', exe: 'VSCodium.exe', dirs: ['VSCodium'], scoop: 'vscodium' },
  { name: 'Cursor', exe: 'Cursor.exe', dirs: ['cursor', 'Cursor'] },
  { name: 'Windsurf', exe: 'Windsurf.exe', dirs: ['Windsurf'] },
  { name: 'Zed', exe: 'Zed.exe', dirs: ['Zed'], scoop: 'zed' },
  { name: 'WebStorm', exe: 'webstorm64.exe', dirs: [], jetbrains: 'WebStorm' },
  { name: 'PhpStorm', exe: 'phpstorm64.exe', dirs: [], jetbrains: 'PhpStorm' },
  { name: 'IntelliJ IDEA', exe: 'idea64.exe', dirs: [], jetbrains: 'IntelliJ IDEA' },
  { name: 'Fleet', exe: 'Fleet.exe', dirs: ['Fleet'] },
  { name: 'Sublime Text', exe: 'sublime_text.exe', dirs: ['Sublime Text', 'Sublime Text 3'], scoop: 'sublime-text' },
  { name: 'Notepad++', exe: 'notepad++.exe', dirs: ['Notepad++'], scoop: 'notepadplusplus', files: true },
];

function winCandidates(e: (typeof WIN)[number]): string[] {
  const local = join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'Programs');
  const pf = [process.env.ProgramFiles ?? 'C:\\Program Files', process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'];
  const out = e.dirs.flatMap((d) => [join(local, d, e.exe), ...pf.map((r) => join(r, d, e.exe))]);
  if (e.scoop) out.push(join(process.env.SCOOP ?? join(homedir(), 'scoop'), 'apps', e.scoop, 'current', e.exe));
  if (e.jetbrains) {
    // A versioned folder per install (Program Files\JetBrains\WebStorm 2026.2), or the Toolbox's.
    out.push(join(local, e.jetbrains, 'bin', e.exe));
    for (const root of pf)
      try {
        for (const d of readdirSync(join(root, 'JetBrains')).filter((x) => x.startsWith(e.jetbrains!)).sort().reverse()) out.push(join(root, 'JetBrains', d, 'bin', e.exe));
      } catch {
        /* no JetBrains folder */
      }
  }
  return out;
}

/** The editors found by looking at the usual folders (quick, synchronous). */
function scan(): Editor[] {
  if (isLinux) return linuxEditors().map((e) => ({ name: e.name, path: e.file, folders: e.folders }));
  if (isWin)
    return WIN.flatMap((e) => {
      const path = winCandidates(e).find((p) => existsSync(p));
      return path ? [{ name: e.name, path, folders: !e.files }] : [];
    });
  return MAC.flatMap((e) => {
    const path = macDirs()
      .flatMap((d) => e.apps.map((a) => join(d, `${a}.app`)))
      .find((p) => existsSync(p));
    return path ? [{ name: e.name, path, folders: !e.files }] : [];
  });
}

let found: Editor[] | null = null;

/** Known editors that are installed somewhere else, found through the system: Spotlight (macOS), App Paths (Windows). */
async function lookElsewhere(have: Editor[]): Promise<Editor[]> {
  const extra: Editor[] = [];
  if (isWin) {
    for (const e of WIN.filter((x) => !have.some((h) => h.name === x.name))) {
      for (const hive of ['HKCU', 'HKLM']) {
        const r = await run('reg', ['query', `${hive}\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${e.exe}`, '/ve'], { timeout: 5000 });
        const path = /REG_(?:EXPAND_)?SZ\s+(.+)$/m.exec(r.stdout)?.[1]?.trim().replace(/^"|"$/g, '');
        if (r.code === 0 && path && existsSync(path)) {
          extra.push({ name: e.name, path, folders: !e.files });
          break;
        }
      }
    }
  } else if (!isLinux) {
    for (const e of MAC.filter((x) => !have.some((h) => h.name === x.name))) {
      const query = e.ids.map((id) => (id.endsWith('.app') ? `kMDItemFSName == '${id}'` : `kMDItemCFBundleIdentifier == '${id}'`)).join(' || ');
      const r = await run('mdfind', [query], { timeout: 5000 });
      const path = r.stdout.split('\n').map((l) => l.trim()).find((l) => l.endsWith('.app') && !l.includes('/Contents/') && !l.startsWith('/Volumes/'));
      if (r.code === 0 && path) extra.push({ name: e.name, path, folders: !e.files });
    }
  }
  return extra;
}

/** The editors installed (cached; refreshEditors looks again). */
export function editors(): Editor[] {
  found ??= scan();
  return found;
}

/** Looks again (the window got focus, Settings opened): true when the list changed. */
let elsewhere: { at: number; list: Editor[] } | null = null;
/** Spotlight / registry lookups are slower than a folder check: at most every 10 minutes (the window gets focus often). */
const ELSEWHERE_EVERY_MS = 10 * 60_000;

export async function refreshEditors(): Promise<boolean> {
  const quick = scan();
  if (!elsewhere || Date.now() - elsewhere.at > ELSEWHERE_EVERY_MS) elsewhere = { at: Date.now(), list: await lookElsewhere(quick) };
  const next = [...quick, ...elsewhere.list.filter((e) => !quick.some((q) => q.name === e.name) && existsSync(e.path))];
  const changed = JSON.stringify(next) !== JSON.stringify(found);
  found = next;
  return changed;
}

/** An editor setting that is a path (Other…), not a known name. */
export const isEditorPath = (setting: string): boolean => setting.includes('/') || setting.includes('\\');

/** What a path picked with Other… is: its name and whether it opens folders; null when it is not there any more. */
export function customEditor(path: string): Editor | null {
  if (!existsSync(path)) return null;
  if (isLinux && path.endsWith('.desktop')) {
    const a = desktopApp(path);
    return a ? { name: a.name, path, folders: desktopOpensFolders(a) } : null;
  }
  const name = basename(path, extname(path));
  const known = (isWin ? WIN.find((e) => e.exe.toLowerCase() === basename(path).toLowerCase()) : MAC.find((e) => e.apps.includes(name))) ?? null;
  return { name: known?.name ?? name, path, folders: !known?.files };
}

/** The editor the setting names ('' = Auto: the first one found that suits a folder, when one is opened). */
function chosen(forFolder: boolean): Editor | null {
  const setting = store.settings.editor;
  if (setting) return isEditorPath(setting) ? customEditor(setting) : (editors().find((e) => e.name === setting) ?? null);
  return (forFolder ? editors().find((e) => e.folders) : null) ?? editors()[0] ?? null;
}

/** The chosen editor's display name, for Settings (also an editor picked with Other…). */
export function chosenEditorName(): string | null {
  const setting = store.settings.editor;
  return setting && isEditorPath(setting) ? (customEditor(setting)?.name ?? null) : null;
}

/** Windows: starts a command line detached (an editor's CLI, Windows Terminal); false when it could not start. */
export function startDetached(command: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    // One command line (the caller quotes paths): Node warns about separate args with shell (DEP0190).
    const child = spawn([command, ...args].join(' '), { detached: true, stdio: 'ignore', windowsHide: false, shell: true });
    child.once('error', () => resolve(false));
    child.once('spawn', () => {
      child.unref();
      resolve(true);
    });
  });
}

async function launch(e: Editor, target: string): Promise<boolean> {
  if (isWin) return startDetached(`"${e.path}"`, [`"${target}"`]);
  if (isLinux) return e.path.endsWith('.desktop') ? launchDesktop(e.path, target) : launchProgram(e.path, target);
  return (await run('open', ['-a', e.path, target])).code === 0;
}

const isDir = (path: string): boolean => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

/**
 * Opens a folder or a file in the editor. A folder and an editor that opens files only: `file` (a file in that folder,
 * e.g. php.ini) when given, else the folder in the file manager. Returns a note for the user when it did not open
 * the way they asked, else null.
 */
export async function openInEditor(path: string, file?: string): Promise<string | null> {
  const folder = isDir(path);
  const e = chosen(folder);
  if (e && folder && !e.folders) {
    if (file && (await launch(e, file))) return null;
    await shell.openPath(path);
    return `${e.name} opens single files, not folders, so the folder opened in ${words.fileManager}. Pick an editor that opens folders in Settings → General → Open with.`;
  }
  if (e && (await launch(e, path))) return null;
  // Windows: VS Code's `code` on the Path, even when it is installed somewhere DevCatz does not look.
  if (isWin && (await run('where', ['code'])).code === 0 && (await startDetached('code', [`"${path}"`]))) return null;
  if (!folder && file === undefined) {
    // A file and no editor: the system's app for that kind of file.
    const err = await shell.openPath(path);
    return err ? `Could not open ${basename(path)}: ${err}` : null;
  }
  await shell.openPath(path);
  return e ? `${e.name} did not start, so the folder opened in ${words.fileManager}.` : `No code editor was found, so the folder opened in ${words.fileManager}. Install one, or pick one in Settings → General → Open with.`;
}

/** Other…: pick an editor app by hand. Returns its path, or null when cancelled or not an app. */
export async function pickEditor(win: BrowserWindow | null): Promise<string | null> {
  const opts: Electron.OpenDialogOptions = isWin
    ? { title: 'Choose an editor', defaultPath: process.env.ProgramFiles ?? 'C:\\Program Files', properties: ['openFile'], filters: [{ name: 'Programs', extensions: ['exe'] }] }
    : isLinux
      ? { title: 'Choose an editor (an app in applications, or a program)', defaultPath: '/usr/share/applications', properties: ['openFile'] }
      : { title: 'Choose an editor', defaultPath: '/Applications', properties: ['openFile'], filters: [{ name: 'Applications', extensions: ['app'] }] };
  const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
  const path = r.canceled ? null : (r.filePaths[0] ?? null);
  if (!path) return null;
  if (isLinux && path.endsWith('.desktop') && !desktopApp(path)) throw new Error(`${basename(path)} is not an app that can be started`);
  if (isLinux && !path.endsWith('.desktop')) {
    try {
      // A program: it must be executable.
      if (!(statSync(path).mode & 0o111)) throw new Error('not executable');
    } catch {
      throw new Error(`${basename(path)} is not a program that can be started`);
    }
  }
  if (!isLinux && !isWin && !path.endsWith('.app')) throw new Error(`${basename(path)} is not an app`);
  return path;
}
