import { spawnSync } from 'node:child_process';
import { cpSync, renameSync, rmSync } from 'node:fs';
import { delimiter } from 'node:path';

/**
 * Platform switches (Catzoid #57). macOS is the home platform; Windows x64 started 2026-10-27 with stage 1: the app
 * itself, Node / Bun / Go sites, the proxy and the local CA. Everything macOS-only (PHP-FPM, launchd forwarders,
 * /etc/resolver, Keychain, the services DevCatz downloads as macOS binaries) stays behind `isMac` until it is ported.
 */
export const isWin = process.platform === 'win32';
export const isMac = process.platform === 'darwin';

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
export function shellCommand(command: string, opts: { exec?: boolean } = {}): [string, string[]] {
  if (isWin) return [process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${command}"`]];
  const shell = process.env.SHELL || '/bin/zsh';
  // `exec` makes a single command the process itself; a chain (`anchor build && solana-test-validator …`, `cd x && …`)
  // keeps its shell, or only its first command would run. Either way the process group is what Stop ends.
  const chain = /&&|\|\||;|\|/.test(command);
  return [shell, ['-c', opts.exec && !chain ? `exec ${command}` : command]];
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
