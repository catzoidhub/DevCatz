import { app, shell } from 'electron';
import { existsSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { AiProvider, TaskProgress, UninstallPlan } from '@shared/types';
import { spawn } from 'node:child_process';
import { removeSystemLeftovers, systemLeftovers } from './cleanurls';
import { isWin } from './platform';
import { run } from './env';
import { readShared, setSharedKey, SHARED_DIR } from './shared';

/**
 * Uninstall DevCatz (Catzoid family #55, DevCatz TODO §24). Removes what DevCatz put on the Mac, never the user's
 * own files (projects, exports, backups, database / storage folders placed outside DevCatz's data folder):
 *  1. stops every site and service;
 *  2. one admin prompt: the clean-URL LaunchDaemons and DevCatz's /etc/resolver files;
 *  3. the local certificate authority from the login keychain (macOS asks to confirm);
 *  4. the login item;
 *  5. optionally the data folder (sites list, runtimes, database and storage services with their data, logs) and
 *     its keychain item, plus caches and preferences;
 *  6. the shared Catzoid settings and the "Catzoid AI" keys when asked (the switch is on by default only when no
 *     other Catzoid app is installed);
 *  7. the app: moved to the Trash (a Homebrew install: `brew uninstall --cask devcatz`), then DevCatz quits.
 * The same list is the Homebrew cask's `zap` (Catzoid #20) and catzoid.com/docs/uninstall.
 */

const OTHER_APPS = ['DBCatz', 'DialCatz', 'DoCatz'];

/** The .app bundle this DevCatz runs from (null in a development build). */
function appBundle(): string | null {
  if (!app.isPackaged) return null;
  // Windows: the NSIS uninstaller next to DevCatz.exe removes the app (it runs once DevCatz has quit).
  if (isWin) {
    const u = join(dirname(process.execPath), `Uninstall ${app.getName()}.exe`);
    return existsSync(u) ? u : null;
  }
  const m = process.execPath.match(/^(.*?\.app)\//);
  return m ? m[1] : null;
}

function caskroom(): string | null {
  return ['/opt/homebrew/Caskroom/devcatz', '/usr/local/Caskroom/devcatz'].find((p) => existsSync(p)) ?? null;
}

/** Caches and preferences macOS / Electron keep for DevCatz outside its data folder. */
function smallLeftovers(): string[] {
  const lib = join(homedir(), 'Library');
  return [
    join(lib, 'Caches', 'DevCatz'),
    join(lib, 'Caches', 'com.mrcatz.devcatz'),
    join(lib, 'Caches', 'com.mrcatz.devcatz.ShipIt'),
    join(lib, 'HTTPStorages', 'com.mrcatz.devcatz'),
    join(lib, 'Preferences', 'com.mrcatz.devcatz.plist'),
    join(lib, 'Saved Application State', 'com.mrcatz.devcatz.savedState'),
    join(lib, 'Logs', 'DevCatz'),
  ].filter((p) => existsSync(p));
}

export function uninstallPlan(): UninstallPlan {
  const others = OTHER_APPS.filter((n) => ['/Applications', join(homedir(), 'Applications')].some((d) => existsSync(join(d, `${n}.app`))));
  return {
    app: appBundle(),
    homebrew: caskroom() !== null,
    dataDir: app.getPath('userData'),
    systemFiles: systemLeftovers(),
    otherCatzoidApps: others,
    sharedDir: SHARED_DIR,
    sharedKeys: readShared().ai?.keys ?? [],
  };
}

export interface UninstallHooks {
  stopAll(): Promise<void>;
  untrustCa(): Promise<void>;
}

/** Runs the uninstall; `set` reports progress. Quits DevCatz at the end (unless it fails before the app step). */
export async function uninstall(opts: { removeData: boolean; removeShared: boolean }, hooks: UninstallHooks, set: (p: Partial<TaskProgress>) => void): Promise<void> {
  const plan = uninstallPlan();
  const removeShared = opts.removeShared;
  set({ step: 0, detail: 'Sites, databases, storage, mail and the other services' });
  await hooks.stopAll();

  set({ step: 1, detail: plan.systemFiles.join(', ') || 'Nothing to remove' });
  if (plan.systemFiles.length) {
    const r = await removeSystemLeftovers();
    if (!r.ok) throw new Error(r.message.includes('-128') ? 'Cancelled at the password prompt: nothing was removed after stopping the services.' : r.message);
  }

  set({ step: 2, detail: 'DevCatz Local CA, from the login keychain' });
  await hooks.untrustCa().catch((e: Error) => console.warn('uninstall: CA', e.message));
  app.setLoginItemSettings({ openAtLogin: false });

  set({ step: 3, detail: opts.removeData ? plan.dataDir : 'Kept: the data folder' });
  if (opts.removeData) {
    await run('/usr/bin/security', ['delete-generic-password', '-s', 'DevCatz Safe Storage'], { timeout: 15_000 }).catch(() => undefined);
    for (const p of [...smallLeftovers(), plan.dataDir]) await shell.trashItem(p).catch(() => rmSync(p, { recursive: true, force: true }));
  }
  if (removeShared) {
    for (const k of plan.sharedKeys) await setSharedKey(k as AiProvider, '').catch(() => undefined);
    if (existsSync(plan.sharedDir)) await shell.trashItem(plan.sharedDir).catch(() => undefined);
  }

  set({ step: 4, detail: plan.homebrew ? 'brew uninstall --cask devcatz' : (plan.app ?? 'A development build: the app stays') });
  if (plan.homebrew) {
    const brew = ['/opt/homebrew/bin/brew', '/usr/local/bin/brew'].find((b) => existsSync(b));
    if (brew) await run(brew, ['uninstall', '--cask', 'devcatz'], { timeout: 300_000 });
  } else if (plan.app && isWin) {
    // Silent (/S) and after DevCatz is gone: the uninstaller cannot remove a running DevCatz.exe.
    spawn(plan.app, ['/S'], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } else if (plan.app) {
    await shell.trashItem(plan.app);
  }
  set({ step: 5, done: true, detail: '' });
}

export const UNINSTALL_STEPS = ['Stop everything', 'Remove port forwarding and DNS files', 'Remove the local certificate authority', 'Remove data and settings', 'Move DevCatz to the Trash'];
