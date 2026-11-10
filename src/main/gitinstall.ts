import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { shell } from 'electron';
import { getShellEnv, run as runEnv } from './env';
import { gitVersion } from './git';
import { runAsRootLinux } from './linuxadmin';
import { isLinux, isWin, pathKey } from './platform';

/**
 * Install Git from the app (user, 2026-11-10; the same in DevCatz and DialCatz). Each OS's own way, with its own prompt:
 * - macOS: `xcode-select --install` opens Apple's installer for the Command Line Tools (git included); it runs on its
 *   own, so DevCatz waits for git to answer (up to 30 minutes).
 * - Windows: winget (`Git.Git`, Windows asks for administrator rights); without winget the download page opens.
 * - Linux: the package manager through pkexec (the desktop's password dialog): apt, dnf, pacman or zypper.
 * The result says whether git answers now; `cancelled` when the password / administrator prompt was dismissed.
 */

export type GitInstallResult = { ok: boolean; cancelled?: boolean; opened?: boolean; message?: string; version: string | null };

const run = async (cmd: string, args: string[], timeout: number) => {
  const r = await runEnv(cmd, args, { timeout });
  return { code: r.code, out: `${r.stdout}${r.stderr}`.trim() };
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Windows: the folders Git for Windows puts git.exe in, added to this process's Path and to the environment DevCatz
 * starts git with (neither sees the new user / machine Path until a restart).
 */
function windowsGitOnPath(): void {
  const dirs = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Programs')]
    .filter((d): d is string => !!d)
    .map((d) => join(d, 'Git', 'cmd'))
    .filter((d) => existsSync(join(d, 'git.exe')));
  for (const env of new Set([process.env, getShellEnv()])) {
    const key = pathKey(env);
    const path = env[key] ?? '';
    const add = dirs.filter((d) => !path.toLowerCase().split(';').includes(d.toLowerCase()));
    if (add.length) env[key] = [path, ...add].filter(Boolean).join(';');
  }
}

let running: Promise<GitInstallResult> | null = null;

export function installGit(): Promise<GitInstallResult> {
  running ??= doInstall().finally(() => (running = null));
  return running;
}

async function doInstall(): Promise<GitInstallResult> {
  if (await gitVersion()) return { ok: true, version: await gitVersion() };
  if (isLinux) {
    const r = await runAsRootLinux(
      'if command -v apt-get >/dev/null 2>&1; then DEBIAN_FRONTEND=noninteractive apt-get install -y -qq git >/dev/null; ' +
        'elif command -v dnf >/dev/null 2>&1; then dnf install -y -q git >/dev/null; ' +
        'elif command -v pacman >/dev/null 2>&1; then pacman -S --noconfirm --needed git >/dev/null; ' +
        'elif command -v zypper >/dev/null 2>&1; then zypper --non-interactive install git >/dev/null; ' +
        'else echo "No apt, dnf, pacman or zypper here: install git with your package manager" >&2; exit 3; fi',
    );
    if (r.cancelled) return { ok: false, cancelled: true, version: null };
    const v = await gitVersion();
    return v ? { ok: true, version: v } : { ok: false, message: r.message || 'git did not install', version: null };
  }
  if (isWin) {
    const winget = await run('winget', ['--version'], 20_000);
    if (winget.code !== 0) {
      await shell.openExternal('https://git-scm.com/download/win');
      return { ok: false, opened: true, message: 'The Git for Windows download page is open: run the installer, then come back.', version: null };
    }
    const r = await run('winget', ['install', '--id', 'Git.Git', '-e', '--source', 'winget', '--silent', '--accept-package-agreements', '--accept-source-agreements', '--disable-interactivity'], 20 * 60_000);
    windowsGitOnPath();
    const v = await gitVersion();
    if (v) return { ok: true, version: v };
    // 0x8A150011-ish codes and "cancelled" text when the administrator prompt was dismissed.
    if (/cancel|denied|1223|0x800704c7/i.test(r.out)) return { ok: false, cancelled: true, version: null };
    return { ok: false, message: r.out.split('\n').filter(Boolean).pop() || `winget exit ${r.code}`, version: null };
  }
  // macOS: Apple's installer window; its progress is its own, so wait for git to answer.
  const r = await run('xcode-select', ['--install'], 30_000);
  if (r.code !== 0 && !/already installed|install requested/i.test(r.out)) return { ok: false, message: r.out || 'xcode-select --install failed', version: null };
  // `xcode-select -p` first: /usr/bin/git without the tools would open Apple's prompt again on every try.
  for (let i = 0; i < 360; i++) {
    await sleep(5000);
    if ((await run('xcode-select', ['-p'], 10_000)).code !== 0) continue;
    const v = await gitVersion();
    if (v) return { ok: true, version: v };
  }
  return { ok: false, message: 'Git did not answer yet: finish Apple’s installer, then try again.', version: null };
}

/**
 * Git updates (user, 2026-11-10: "kalau ada update, seharusnya bisa di cek juga dan ada tombol update nya"; the same
 * in DevCatz and DialCatz). Checked where git came from, updated the same way it was installed:
 * - Windows: winget (`Git.Git`; its Available column), else Git for Windows' latest GitHub release (the download page).
 * - Linux: the package manager's candidate (apt-cache policy / dnf check-update / pacman -Qu / zypper list-updates);
 *   updated through pkexec like Install Git.
 * - macOS: Homebrew's git → `brew upgrade git`; Apple's git (Command Line Tools) → `softwareupdate -l` lists a newer
 *   Command Line Tools, and Update opens Software Update (Apple's own installer, its own prompt).
 */
export type GitUpdateInfo = {
  current: string | null;
  /** The newer version (a git version, or the Command Line Tools' on a Mac with Apple's git); null when up to date. */
  latest: string | null;
  /** What `latest` is: 'git' or 'Command Line Tools'. */
  what: 'git' | 'Command Line Tools';
  source: 'winget' | 'github' | 'apt' | 'dnf' | 'pacman' | 'zypper' | 'brew' | 'apple' | null;
};

let checked: { at: number; info: GitUpdateInfo } | null = null;

/** Strips Windows' `.windows.N` and Debian's epoch / revision: `2.56.0.windows.1` → 2.56.0, `1:2.43.0-1ubuntu7.4` → 2.43.0. */
const plain = (v: string) => v.replace(/^\d+:/, '').replace(/\.windows\.\d+$/, '').replace(/[-+~].*$/, '');
const newer = (a: string, b: string) => {
  const pa = plain(a).split('.').map(Number);
  const pb = plain(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  return false;
};

async function linuxManager(): Promise<'apt' | 'dnf' | 'pacman' | 'zypper' | null> {
  for (const m of ['apt-get', 'dnf', 'pacman', 'zypper'] as const)
    if ((await run('/bin/sh', ['-c', `command -v ${m}`], 10_000)).code === 0) return m === 'apt-get' ? 'apt' : m;
  return null;
}

async function macGitSource(): Promise<'brew' | 'apple'> {
  const r = await run('/bin/sh', ['-c', 'p=$(command -v git) && (readlink -f "$p" 2>/dev/null || echo "$p")'], 10_000);
  return /\/Cellar\/|\/homebrew\//.test(r.out) || /^\/opt\/homebrew\//.test(r.out) ? 'brew' : 'apple';
}

async function lookUp(current: string): Promise<GitUpdateInfo> {
  const none = (source: GitUpdateInfo['source'], what: GitUpdateInfo['what'] = 'git'): GitUpdateInfo => ({ current, latest: null, what, source });
  if (isWin) {
    if ((await run('winget', ['--version'], 20_000)).code === 0) {
      const r = await run('winget', ['list', '--id', 'Git.Git', '-e', '--upgrade-available', '--accept-source-agreements', '--disable-interactivity'], 60_000);
      // Columns: Name Id Version Available Source — the row with Git.Git, the 4th value is the newer one.
      const row = r.out.split('\n').find((l) => /\bGit\.Git\b/.test(l));
      const latest = row?.trim().split(/\s{1,}/).slice(-2, -1)[0];
      // winget writes Git for Windows' 2.56.0.windows.4 as 2.56.0.4: shown as git's own 2.56.0.
      return latest && /^\d+(\.\d+)+/.test(latest) && newer(latest, current) ? { current, latest: latest.split('.').slice(0, 3).join('.'), what: 'git', source: 'winget' } : none('winget');
    }
    const res = await fetch('https://api.github.com/repos/git-for-windows/git/releases/latest', { headers: { accept: 'application/vnd.github+json' } }).catch(() => null);
    const tag = res?.ok ? String(((await res.json()) as { tag_name?: string }).tag_name ?? '').replace(/^v/, '') : '';
    return tag && newer(tag, current) ? { current, latest: plain(tag), what: 'git', source: 'github' } : none('github');
  }
  if (isLinux) {
    const m = await linuxManager();
    if (m === 'apt') {
      const r = await run('apt-cache', ['policy', 'git'], 30_000);
      const inst = r.out.match(/Installed:\s*(\S+)/)?.[1];
      const cand = r.out.match(/Candidate:\s*(\S+)/)?.[1];
      return inst && cand && inst !== '(none)' && cand !== inst ? { current, latest: plain(cand), what: 'git', source: 'apt' } : none('apt');
    }
    if (m === 'dnf') {
      const r = await run('dnf', ['-q', 'check-update', 'git'], 120_000);
      const v = r.out.split('\n').find((l) => /^git\.\S+\s/.test(l))?.trim().split(/\s+/)[1];
      return v && newer(v, current) ? { current, latest: plain(v), what: 'git', source: 'dnf' } : none('dnf');
    }
    if (m === 'pacman') {
      const v = (await run('pacman', ['-Qu', 'git'], 30_000)).out.match(/^git \S+ -> (\S+)/m)?.[1];
      return v && newer(v, current) ? { current, latest: plain(v), what: 'git', source: 'pacman' } : none('pacman');
    }
    if (m === 'zypper') {
      const r = await run('zypper', ['--non-interactive', '--no-refresh', 'list-updates'], 120_000);
      const v = r.out.split('\n').find((l) => /\|\s*git\s*\|/.test(l))?.split('|').map((s) => s.trim())[4];
      return v && newer(v, current) ? { current, latest: plain(v), what: 'git', source: 'zypper' } : none('zypper');
    }
    return none(null);
  }
  if ((await macGitSource()) === 'brew') {
    const r = await run('brew', ['outdated', '--json=v2', 'git'], 120_000);
    try {
      const f = (JSON.parse(r.out.slice(r.out.indexOf('{'))) as { formulae?: { current_version?: string }[] }).formulae?.[0];
      return f?.current_version ? { current, latest: f.current_version, what: 'git', source: 'brew' } : none('brew');
    } catch {
      return none('brew');
    }
  }
  // Apple's git: a newer Command Line Tools in Software Update (no password to look).
  const r = await run('softwareupdate', ['-l'], 180_000);
  const v = r.out.match(/Label:\s*Command Line Tools[^\n]*?([\d.]+)\s*$/m)?.[1] ?? r.out.match(/Title:\s*Command Line Tools[^,]*,\s*Version:\s*([\d.]+)/)?.[1];
  return v ? { current, latest: v, what: 'Command Line Tools', source: 'apple' } : none('apple', 'Command Line Tools');
}

/** Whether a newer git is available; kept for 6 hours unless `force`. */
export async function checkGitUpdate(force = false): Promise<GitUpdateInfo> {
  if (!force && checked && Date.now() - checked.at < 6 * 3_600_000) return checked.info;
  const current = await gitVersion();
  const info: GitUpdateInfo = current ? await lookUp(current).catch(() => ({ current, latest: null, what: 'git' as const, source: null })) : { current: null, latest: null, what: 'git', source: null };
  checked = { at: Date.now(), info };
  return info;
}

let updating: Promise<GitInstallResult> | null = null;

/** Updates git the way it came; the result says the version git answers with now. */
export function updateGit(): Promise<GitInstallResult> {
  updating ??= doUpdate().finally(() => {
    updating = null;
    checked = null;
  });
  return updating;
}

async function doUpdate(): Promise<GitInstallResult> {
  const info = await checkGitUpdate();
  const before = info.current;
  const done = async (): Promise<GitInstallResult> => {
    const v = await gitVersion();
    return v && v !== before ? { ok: true, version: v } : { ok: false, message: 'Git was not updated', version: v };
  };
  switch (info.source) {
    case 'winget': {
      const r = await run('winget', ['upgrade', '--id', 'Git.Git', '-e', '--source', 'winget', '--silent', '--accept-package-agreements', '--accept-source-agreements', '--disable-interactivity'], 20 * 60_000);
      windowsGitOnPath();
      const res = await done();
      if (!res.ok && /cancel|denied|1223|0x800704c7/i.test(r.out)) return { ok: false, cancelled: true, version: res.version };
      return res.ok ? res : { ...res, message: r.out.split('\n').filter(Boolean).pop() || res.message };
    }
    case 'github':
      await shell.openExternal('https://git-scm.com/download/win');
      return { ok: false, opened: true, message: 'The Git for Windows download page is open: run the installer, then come back.', version: before };
    case 'apt':
    case 'dnf':
    case 'pacman':
    case 'zypper': {
      const cmd = {
        apt: 'DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --only-upgrade git >/dev/null',
        dnf: 'dnf upgrade -y -q git >/dev/null',
        pacman: 'pacman -S --noconfirm --needed git >/dev/null',
        zypper: 'zypper --non-interactive update git >/dev/null',
      }[info.source];
      const r = await runAsRootLinux(cmd);
      if (r.cancelled) return { ok: false, cancelled: true, version: before };
      const res = await done();
      return res.ok ? res : { ...res, message: r.message || res.message };
    }
    case 'brew': {
      const r = await run('brew', ['upgrade', 'git'], 20 * 60_000);
      const res = await done();
      return res.ok ? res : { ...res, message: r.out.split('\n').filter(Boolean).pop() || res.message };
    }
    case 'apple':
      await shell.openExternal('x-apple.systempreferences:com.apple.Software-Update-Settings.extension');
      return { ok: false, opened: true, message: 'Software Update is open: install the Command Line Tools update there.', version: before };
    default:
      return { ok: false, message: 'No update for git was found', version: before };
  }
}
