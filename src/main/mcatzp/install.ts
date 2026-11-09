import { existsSync, readdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { approvalsAcrossApps, installPath, type McatzpApproval, addToClient as add, install as run, type McatzpInstallProgress, type McatzpSetup, type McatzpTarget, removeFromClient as remove, setupState as state, targets as list, type McatzpTargetId, type SetupOptions } from '@catzoid/mcatzp-host';
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
export const install = (progress: (p: McatzpInstallProgress) => void, signal: AbortSignal): Promise<void> => run(options(), progress, signal);
export const targets = (): Promise<McatzpTarget[]> => list(options());
export const addToClient = (id: McatzpTargetId): Promise<void> => add(options(), id);
export const removeFromClient = (id: McatzpTargetId): Promise<void> => remove(options(), id);

/**
 * Uninstall MCatzP (user, 2026-11-10; the same in every Catzoid app): its entry is taken out of every AI assistant that
 * has one, and the shared copy goes when a Catzoid app installed it (~/.catzoid/bin/mcatzp, %LOCALAPPDATA%\\Catzoid\\bin);
 * a Homebrew / npm / other copy is left to the tool that put it there, and its path is returned to say so. The other
 * Catzoid apps lose MCatzP too: the window asks first.
 */
export async function uninstall(): Promise<{ removedFrom: string[]; binary: 'removed' | 'kept' | 'none'; keptPath: string | null }> {
  const o = options();
  const removedFrom: string[] = [];
  for (const t of await list(o)) {
    if (!t.current) continue;
    await remove(o, t.id);
    removedFrom.push(t.label);
  }
  const s = await state(o, false);
  if (!s.path) return { removedFrom, binary: 'none', keptPath: null };
  if (s.source !== 'catzoid') return { removedFrom, binary: 'kept', keptPath: s.path };
  const file = installPath(o);
  rmSync(file, { force: true });
  // The bin folder too, when MCatzP was all it held.
  try {
    if (existsSync(dirname(file)) && !readdirSync(dirname(file)).length) rmSync(dirname(file), { recursive: true, force: true });
  } catch {
    /* in use or not ours to clear */
  }
  return { removedFrom, binary: 'removed', keptPath: null };
}
