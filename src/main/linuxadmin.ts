import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from './env';

/**
 * Linux (TODO §35): a shell script as root through polkit — `pkexec` shows the desktop's own password dialog (GNOME,
 * KDE …), like macOS's admin prompt and Windows' UAC. The script goes in a fresh private temp folder for the one run.
 * pkexec answers 126 when the dialog was dismissed and 127 when the user is not allowed.
 */
export async function runAsRootLinux(script: string): Promise<{ ok: boolean; cancelled: boolean; message: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'devcatz-admin-'));
  const file = join(dir, 'step.sh');
  try {
    writeFileSync(file, `set -e\n${script}\n`, { mode: 0o600 });
    const r = await run('pkexec', ['/bin/sh', file], { timeout: 600_000 });
    const cancelled = r.code === 126 || r.code === 127;
    const message = cancelled ? 'Cancelled' : (r.stderr || r.stdout).trim();
    return { ok: r.code === 0, cancelled, message };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Single quotes for a value in a root script. */
export const shq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;
