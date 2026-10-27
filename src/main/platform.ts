import { spawnSync } from 'node:child_process';
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
  return [shell, ['-c', opts.exec ? `exec ${command}` : command]];
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
