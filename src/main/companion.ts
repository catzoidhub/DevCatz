import { app } from 'electron';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { TaskProgress } from '@shared/types';
import { downloadVerified } from './download';
import { run } from './env';
import { githubAsset } from './storage';

/**
 * Download & Install for the other Catzoid apps DevCatz opens (DBCatz, DialCatz): the latest release DMG from
 * GitHub (checksum verified against the release digest), the app copied to /Applications, then opened at `link`.
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
    const asset = await githubAsset(repo, new RegExp(`^${name}-.*-arm64\\.dmg$`)).catch((e: Error) => {
      // 404 = the repository cannot be seen without signing in (private until the public repos, Catzoid #52).
      if (/HTTP 404/.test(e.message)) throw new Error(`${name}'s releases are not public yet, so DevCatz cannot download it (${releases})`);
      throw new Error(/No macOS build/.test(e.message) ? `No ${name} release is published yet (${releases})` : e.message);
    });
    if (signal.aborted) throw new Error('cancelled');
    set({ step: 1, title: `Installing ${name} ${asset.tag.replace(/^v/, '')}`, detail: asset.url });
    rmSync(tmp, { recursive: true, force: true });
    mkdirSync(tmp, { recursive: true });
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
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** The steps every Catzoid app install shows. */
export const installSteps = (name: string) => ['Find the latest release', 'Download', 'Verify the checksum', 'Install to Applications', `Open ${name}`];
