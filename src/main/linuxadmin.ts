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
    // apt-get waits up to 3 minutes for another package manager (an update, App Center, another app's install) instead
    // of failing at once with "Could not get lock /var/lib/dpkg/lock-frontend" (seen while DBCatz's .deb installed).
    // APT_CONFIG is read on top of the system's configuration.
    const aptConf = join(dir, 'apt.conf');
    writeFileSync(aptConf, 'DPkg::Lock::Timeout "180";\n', { mode: 0o644 });
    writeFileSync(file, `set -e\nexport APT_CONFIG=${JSON.stringify(aptConf)}\n${script}\n`, { mode: 0o600 });
    const r = await run('pkexec', ['/bin/sh', file], { timeout: 600_000 });
    const cancelled = r.code === 126 || r.code === 127;
    const message = cancelled ? 'Cancelled' : (r.stderr || r.stdout).trim() || (r.code === null || r.code === 0 ? 'No answer at the password prompt in 10 minutes' : `exit ${r.code}`);
    return { ok: r.code === 0, cancelled, message };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Single quotes for a value in a root script. */
export const shq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;
