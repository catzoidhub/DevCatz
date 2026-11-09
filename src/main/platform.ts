import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, renameSync, rmSync } from 'node:fs';
import { delimiter, isAbsolute, join, resolve } from 'node:path';

/**
 * Platform switches (Catzoid #57). macOS is the home platform; Windows x64 started 2026-10-27 with stage 1: the app
 * itself, Node / Bun / Go sites, the proxy and the local CA. Everything macOS-only (PHP-FPM, launchd forwarders,
 * /etc/resolver, Keychain, the services DevCatz downloads as macOS binaries) stays behind `isMac` until it is ported.
 */
export const isWin = process.platform === 'win32';
export const isMac = process.platform === 'darwin';
/**
 * Linux (started 2026-11-09, Ubuntu 24.04 first). Most branches are still `isWin ? win : mac`, so Linux runs the macOS
 * path; a branch that is ported reads `isWin ? win : isLinux ? linux : mac` (TODO §35).
 */
export const isLinux = process.platform === 'linux';

/** `node` → `node.exe` on Windows. */
export const exe = (name: string): string => (isWin ? `${name}.exe` : name);

/** Windows' own bsdtar (unpacks .zip too); a Git for Windows GNU tar earlier on the Path cannot read `C:\` paths. */
export const TAR = isWin ? `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32\\tar.exe` : 'tar';

/** PATH entries joined / split with the platform's separator (`;` on Windows). */
export const joinPath = (parts: string[]): string => parts.filter(Boolean).join(delimiter);
export const splitPath = (value: string | undefined): string[] => (value ?? '').split(delimiter).filter(Boolean);

/** The environment key that holds the search path (`Path` on Windows, whatever its case). */
export function pathKey(env: NodeJS.ProcessEnv): string {
  if (!isWin) return 'PATH';
  return Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'Path';
}

/** A shell command line → [file, args]: the login shell on macOS, cmd.exe on Windows. */
export function shellCommand(command: string, opts: { exec?: boolean; env?: Record<string, string | undefined> } = {}): [string, string[]] {
  if (isWin) return [process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${winCommand(command, opts.env)}"`]];
  const shell = process.env.SHELL || '/bin/zsh';
  // `exec` makes a single command the process itself; a chain (`anchor build && solana-test-validator …`, `cd x && …`)
  // keeps its shell, or only its first command would run. Either way the process group is what Stop ends.
  const chain = /&&|\|\||;|\|/.test(command);
  return [shell, ['-c', opts.exec && !chain ? `exec ${command}` : command]];
}

/**
 * Windows: a command line written for sh, as cmd.exe reads it — DevCatz builds its commands once, the POSIX way:
 * - `${PORT:-8000}` gets its value from `env` now (the default when unset); `$NAME` / `${NAME}` become `%NAME%`;
 * - `'quoted'` becomes `"quoted"` (cmd knows only double quotes);
 * - `VAR=value cmd` / `env VAR=value cmd` become `set "VAR=value"&& cmd`;
 * - `.venv/bin/python` is `.venv\Scripts\python.exe`, `/dev/null` is `NUL`, `a; b` is `a & b`.
 * Text inside double quotes is left alone (e.g. `php -r "…"`).
 */
export function winCommand(command: string, env: Record<string, string | undefined> = process.env): string {
  // Split into double-quoted parts (kept) and the rest (converted).
  return command
    .split(/("(?:[^"\\]|\\.)*")/)
    .map((part, i) => {
      if (i % 2) return part;
      return part
        .replace(/'\\''/g, "'")
        .replace(/'([^']*)'/g, (_, t: string) => `"${t}"`)
        .replace(/\$\{(\w+):-([^}]*)\}/g, (_, k: string, d: string) => env[k] || d)
        .replace(/\$\{(\w+)\}|\$([A-Za-z_]\w*)/g, (_, a?: string, b?: string) => `%${a ?? b}%`)
        .replace(/\.venv\/bin\/python\b/g, '.venv\\Scripts\\python.exe')
        .replace(/\/dev\/null/g, 'NUL')
        .replace(/\s*;\s*/g, ' & ');
    })
    .join('')
    .replace(/(^|&&\s*|\|\|\s*|&\s*)(?:env\s+)?((?:[A-Za-z_]\w*=(?:"[^"]*"|[^\s"]+)\s+)+)/g, (_, lead: string, vars: string) =>
      lead + [...vars.matchAll(/([A-Za-z_]\w*)=("[^"]*"|[^\s"]+)/g)].map(([, k, v]) => `set "${k}=${v.replace(/^"|"$/g, '')}"&& `).join(''),
    );
}

/** Two folder paths name the same folder (Windows: without case, either slash). */
export const samePath = (a: string, b: string): boolean => (isWin ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : a === b);

const found = new Map<string, string>();
/**
 * A program's full path from the Path (Windows: `<name>.exe`, absolute Path entries only). Windows looks in the
 * current folder before the Path, so spawning a bare "git" in a cloned repository would run a git.exe planted in it.
 * Elsewhere (and when not found) the name as given.
 */
export function exePath(name: string, env: NodeJS.ProcessEnv = process.env): string {
  if (!isWin) return name;
  const hit = found.get(name);
  if (hit) return hit;
  for (const dir of splitPath(env[pathKey(env)])) {
    const d = dir.replace(/^"|"$/g, '');
    if (!isAbsolute(d)) continue;
    const file = join(d, `${name}.exe`);
    if (existsSync(file)) {
      found.set(name, file);
      return file;
    }
  }
  return name;
}

/** Stops a process and everything it started: the process group on macOS, `taskkill /T` on Windows. */
export function killTree(pid: number, signal: NodeJS.Signals = 'SIGTERM'): void {
  if (isWin) {
    // Windows has no SIGTERM for console programs: /F ends the whole tree (dev servers keep no state to flush).
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      /* already gone */
    }
  }
}

/**
 * Moves a freshly unpacked folder into place. On Windows, Defender scans new .exe / .dll files and keeps them locked for
 * a moment (EPERM / EBUSY on rename): try again for ~15 s, then copy and delete instead.
 */
export async function moveDir(from: string, to: string): Promise<void> {
  if (!isWin) return renameSync(from, to);
  for (let i = 0; i < 30; i++) {
    try {
      return renameSync(from, to);
    } catch (e) {
      if (!['EPERM', 'EBUSY', 'EACCES'].includes((e as NodeJS.ErrnoException).code ?? '')) throw e;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  cpSync(from, to, { recursive: true });
  rmSync(from, { recursive: true, force: true });
}

/**
 * Removes a temporary download / unpack folder without failing the install that used it: on Windows a just-finished
 * installer or a virus scan can hold a file for a moment (EPERM / EBUSY). Retried, then left for the next cleanup.
 */
export function removeTemp(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  } catch {
    /* still locked: harmless leftover */
  }
}
