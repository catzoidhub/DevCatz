import { spawn } from 'node:child_process';
import { app, shell } from 'electron';
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { TaskProgress } from '@shared/types';
import { downloadVerified } from './download';
import { run } from './env';
import { isLinux, isWin, removeTemp } from './platform';
import { githubAsset } from './storage';

/**
 * Which build of a Catzoid app fits this computer (Catzoid family rule, user 2026-10-27): every install and update
 * check of another Catzoid app picks it by platform AND architecture — Windows `<App>-Setup-<v>.exe`, Mac Apple
 * silicon `<App>-<v>-arm64.dmg`, Mac Intel `<App>-<v>-x64.dmg`, Linux `<App>-<v>-<arm64|x64>.AppImage` (the
 * family's artifactName) — and says so when there is none, never another platform's file.
 */
export function platformAsset(name: string): { pattern: RegExp; label: string } {
  if (isWin) return { pattern: new RegExp(`^${name}-Setup-.*\\.exe$`), label: 'Windows' };
  if (isLinux) {
    const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
    return { pattern: new RegExp(`^${name}-.*-${arch}\\.AppImage$`), label: arch === 'arm64' ? 'Linux (ARM64)' : 'Linux (x64)' };
  }
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  return { pattern: new RegExp(`^${name}-.*-${arch}\\.dmg$`), label: arch === 'arm64' ? 'Mac (Apple silicon)' : 'Mac (Intel)' };
}

/**
 * Where a Catzoid app is installed by default: /Applications on a Mac, the per-user NSIS folder on Windows; on Linux
 * the AppImage DevCatz puts in ~/Applications, or a .deb's /opt/<App>.
 */
export function catzoidAppPaths(name: string): string[] {
  if (isLinux) return [join(homedir(), 'Applications', `${name}.AppImage`), `/opt/${name}/${name.toLowerCase()}`, `/opt/${name}/${name}`];
  if (isWin) {
    const local = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local');
    return [join(local, 'Programs', name, `${name}.exe`), join(process.env.ProgramFiles ?? 'C:\\Program Files', name, `${name}.exe`)];
  }
  return [`/Applications/${name}.app`, join(homedir(), 'Applications', `${name}.app`)];
}

/**
 * Finds a Catzoid app: the usual folders, the app that opens its links (`scheme://`), then (macOS) Spotlight by
 * bundle id. Null when it is not installed.
 */
export async function findCatzoidApp(name: string, scheme: string, bundleId: string): Promise<string | null> {
  const usable = (p: string | null | undefined): p is string =>
    !!p && (isWin ? /\.exe$/i.test(p) && existsSync(p) : !p.includes('/.Trash/') && existsSync(join(p, 'Contents', 'Info.plist')));
  const known = catzoidAppPaths(name).find((p) => existsSync(p));
  if (known) return known;
  if (isLinux) return null;
  const handler = await app.getApplicationInfoForProtocol(`${scheme}://open`).catch(() => null);
  if (usable(handler?.path) && new RegExp(name, 'i').test(handler.path)) return handler.path;
  if (isWin) return null;
  const r = await run('mdfind', [`kMDItemCFBundleIdentifier == '${bundleId}'`], { timeout: 10_000 });
  return r.stdout.split('\n').map((l) => l.trim()).find(usable) ?? null;
}

/** Opens a Catzoid app at a link: `open -a` on a Mac (that very copy), the .exe with the link on Windows. */
export async function openCatzoidApp(path: string, link: string): Promise<void> {
  if (isWin || isLinux) {
    const ok = await new Promise<boolean>((resolve) => {
      const child = spawn(path, [link], { detached: true, stdio: 'ignore' });
      child.once('error', () => resolve(false));
      child.once('spawn', () => (child.unref(), resolve(true)));
    });
    if (!ok) await shell.openExternal(link);
    return;
  }
  const r = await run('open', ['-a', path, link], { timeout: 30_000 });
  if (r.code !== 0) await shell.openExternal(link);
}

/**
 * Download & Install for the other Catzoid apps DevCatz opens (DBCatz, DialCatz): the latest release's build for
 * this platform (platformAsset; checksum verified against the release digest) — on a Mac the app copied to
 * /Applications from the DMG, on Windows the NSIS installer run silently — then opened at `link`.
 * `set` reports progress into the caller's TaskProgress; `signal` cancels.
 */
export async function installCatzoidApp(
  name: string,
  repo: string,
  link: string,
  set: (p: Partial<TaskProgress>) => void,
  signal: AbortSignal,
): Promise<void> {
  const releases = `https://github.com/${repo}/releases/latest`;
  const tmp = join(app.getPath('temp'), `${name.toLowerCase()}-install-${process.pid}`);
  let mounted: string | null = null;
  try {
    const want = platformAsset(name);
    const asset = await githubAsset(repo, want.pattern).catch((e: Error) => {
      // 404 = the repository cannot be seen without signing in (private until the public repos, Catzoid #52).
      if (/HTTP 404/.test(e.message)) throw new Error(`${name}'s releases are not public yet, so DevCatz cannot download it (${releases})`);
      throw new Error(/No (macOS|Windows|Linux) build/.test(e.message) ? `There is no ${name} build for ${want.label} yet (${releases})` : e.message);
    });
    if (signal.aborted) throw new Error('cancelled');
    set({ step: 1, title: `Installing ${name} ${asset.tag.replace(/^v/, '')}`, detail: asset.url });
    removeTemp(tmp);
    mkdirSync(tmp, { recursive: true });
    if (isWin) {
      // The NSIS installer, silently (/S, per user: no administrator prompt), then the app at the link.
      const exe = join(tmp, `${name}-Setup.exe`);
      await downloadVerified(asset.url, exe, asset.sha256, (received, total) => set({ received, total }), undefined, signal);
      set({ step: 2, received: undefined, total: undefined, detail: 'SHA-256 matches the release digest' });
      set({ step: 3, detail: catzoidAppPaths(name)[0] });
      const r = await run(exe, ['/S'], { timeout: 600_000 });
      if (r.code !== 0) throw new Error(`The ${name} installer failed (exit ${r.code})`);
      const installed = await findCatzoidApp(name, name.toLowerCase(), '');
      if (!installed) throw new Error(`${name} was installed but could not be found`);
      set({ step: 4, detail: '' });
      await openCatzoidApp(installed, link);
      return;
    }
    if (isLinux) {
      // The AppImage into ~/Applications (no administrator needed), a menu entry that also opens its links, then the app.
      const file = join(tmp, `${name}.AppImage`);
      await downloadVerified(asset.url, file, asset.sha256, (received, total) => set({ received, total }), undefined, signal);
      set({ step: 2, received: undefined, total: undefined, detail: 'SHA-256 matches the release digest' });
      const target = catzoidAppPaths(name)[0];
      set({ step: 3, detail: target });
      mkdirSync(join(target, '..'), { recursive: true });
      rmSync(target, { force: true });
      renameSync(file, target);
      chmodSync(target, 0o755);
      writeDesktopEntry(name, target);
      set({ step: 4, detail: '' });
      await openCatzoidApp(target, link);
      return;
    }
    const dmg = join(tmp, `${name}.dmg`);
    await downloadVerified(asset.url, dmg, asset.sha256, (received, total) => set({ received, total }), undefined, signal);
    set({ step: 2, received: undefined, total: undefined, detail: 'SHA-256 matches the release digest' });
    // downloadVerified already threw on a mismatch; this step is the record of it.
    set({ step: 3, detail: `/Applications/${name}.app` });
    const att = await run('hdiutil', ['attach', '-nobrowse', '-readonly', '-noautoopen', '-mountrandom', tmp, dmg], { timeout: 120_000 });
    if (att.code !== 0) throw new Error(`The disk image could not be opened: ${att.stderr.trim()}`);
    mounted = att.stdout.split('\n').map((l) => l.trim().split(/\t+/).pop() ?? '').find((p) => p.startsWith(tmp)) ?? null;
    if (!mounted || !existsSync(join(mounted, `${name}.app`))) throw new Error(`${name}.app was not found in the disk image`);
    if (signal.aborted) throw new Error('cancelled');
    const target = `/Applications/${name}.app`;
    rmSync(target, { recursive: true, force: true });
    const cp = await run('ditto', [join(mounted, `${name}.app`), target], { timeout: 300_000 });
    if (cp.code !== 0) throw new Error(`Copying to /Applications failed: ${cp.stderr.trim()}`);
    // Downloaded from the internet: clear the quarantine mark so Gatekeeper does not hold up the first launch.
    await run('xattr', ['-dr', 'com.apple.quarantine', target], { timeout: 60_000 });
    set({ step: 4, detail: '' });
    // `open -a` reaches the app before Launch Services has registered its URL scheme.
    const op = await run('open', ['-a', target, link], { timeout: 60_000 });
    if (op.code !== 0) throw new Error(`${name} did not open: ${op.stderr.trim()}`);
  } finally {
    if (mounted) await run('hdiutil', ['detach', mounted, '-quiet'], { timeout: 60_000 }).catch(() => undefined);
    removeTemp(tmp);
  }
}

/** A menu entry for an AppImage, registered for the app's `scheme://` links (xdg-mime), like a .deb would. */
function writeDesktopEntry(name: string, exe: string): void {
  const scheme = name.toLowerCase();
  const dir = join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'applications');
  mkdirSync(dir, { recursive: true });
  const id = `${scheme}.desktop`;
  writeFileSync(
    join(dir, id),
    ['[Desktop Entry]', 'Type=Application', `Name=${name}`, `Exec="${exe}" %U`, `Icon=${scheme}`, 'Terminal=false', 'Categories=Development;', `MimeType=x-scheme-handler/${scheme};`, ''].join('\n'),
  );
  void run('xdg-mime', ['default', id, `x-scheme-handler/${scheme}`], { timeout: 10_000 }).catch(() => undefined);
  void run('update-desktop-database', [dir], { timeout: 10_000 }).catch(() => undefined);
}

/** The steps every Catzoid app install shows. */
export const installSteps = (name: string) => ['Find the latest release', 'Download', 'Verify the checksum', isWin ? 'Install' : isLinux ? 'Install to ~/Applications' : 'Install to Applications', `Open ${name}`];
