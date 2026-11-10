import { approvalsAcrossApps, type McatzpUninstall, uninstall as removeAll, type McatzpApproval, addToClient as add, install as run, type McatzpInstallProgress, type McatzpSetup, type McatzpTarget, removeFromClient as remove, setupState as state, targets as list, type McatzpTargetId, type SetupOptions } from '@catzoid/mcatzp-host';
import { installPath } from '@catzoid/mcatzp-host/setup';
import { randomBytes } from 'node:crypto';
import { closeSync, existsSync, openSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getShellEnv } from '../env';
import { siteBase } from '../shared';

/** The shared copy of MCatzP and the assistants' entries: the rules live in the shared package, for every Catzoid app. */
const options = (): SetupOptions => ({ site: siteBase(), env: getShellEnv() });

export const approvals = (): McatzpApproval[] => approvalsAcrossApps(options());
/** The version to update to: only a copy these apps installed, a Homebrew or npm copy updates its own way. Null when up to date. */
export async function availableUpdate(): Promise<string | null> {
  const { source, version, latest } = await setupState();
  return source === 'catzoid' && version && latest && version.localeCompare(latest, undefined, { numeric: true }) < 0 ? latest : null;
}
export const setupState = (askSite = true): Promise<McatzpSetup> => state(options(), askSite);
/**
 * Windows (MCatzP #29, the same as DBCatz 887513b): an AI assistant running MCatzP keeps mcatzp.exe locked, and the
 * host's install gave up with "MCatzP is in use: close the AI assistant using it" — on the Windows PC no update was
 * possible while Claude Code sessions ran it. Windows lets a running .exe be moved, not replaced: it goes into the temp
 * folder under the name the host sweeps once it has stopped (mcatzp-<hex>.exe.old), the new copy is written, and the
 * assistants already running keep the old one until they restart. Put back when the install fails.
 */
function moveAsideIfRunning(target: string): string | null {
  if (process.platform !== 'win32' || !existsSync(target)) return null;
  try {
    closeSync(openSync(target, 'r+'));
    return null; // not running: the host replaces it itself
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== 'EBUSY' && code !== 'EPERM') return null;
  }
  const aside = join(process.env.TEMP || tmpdir(), `mcatzp-${randomBytes(4).toString('hex')}.exe.old`);
  renameSync(target, aside);
  return aside;
}

/** Installs or updates MCatzP. True when a copy an assistant was running had to be moved aside (Windows). */
export async function install(progress: (p: McatzpInstallProgress) => void, signal: AbortSignal): Promise<boolean> {
  const o = options();
  const target = installPath(o);
  const aside = moveAsideIfRunning(target);
  try {
    await run(o, progress, signal);
  } catch (e) {
    if (aside && !existsSync(target)) {
      try {
        renameSync(aside, target);
      } catch {
        /* the host's next install writes a new one */
      }
    }
    throw e;
  }
  return aside !== null;
}
export const targets = (): Promise<McatzpTarget[]> => list(options());
export const addToClient = (id: McatzpTargetId): Promise<void> => add(options(), id);
export const removeFromClient = (id: McatzpTargetId): Promise<void> => remove(options(), id);

/**
 * Uninstall MCatzP (user, 2026-11-10; the same in every Catzoid app): @catzoid/mcatzp-host's own (1.0.3), which takes it
 * out of every assistant (one failing does not stop the others: `failed`), removes the shared copy under the install
 * lock, and keeps a Homebrew / npm copy (`kept`, its path).
 */
export const uninstall = (): Promise<McatzpUninstall> => removeAll(options());
