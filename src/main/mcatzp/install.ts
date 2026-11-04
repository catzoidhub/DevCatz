import { approvalsAcrossApps, type McatzpApproval, addToClient as add, install as run, type McatzpInstallProgress, type McatzpSetup, type McatzpTarget, removeFromClient as remove, setupState as state, targets as list, type McatzpTargetId, type SetupOptions } from '@catzoid/mcatzp-host';
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
