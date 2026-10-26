import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { app, shell } from 'electron';
import type { DbCatzState, TaskProgress } from '@shared/types';
import { installCatzoidApp, installSteps } from './companion';
import { run } from './env';

/**
 * DevCatz → DialCatz (the Catzoid API client): "Open in DialCatz" on a site. DialCatz reads DevCatz's site list
 * itself and answers `dialcatz://open?site=<site id>` with its "From DevCatz" import for that site (an environment
 * with the site's URL and .env variable names, and its routes), asking before it imports anything.
 * When DialCatz is not installed, `install()` downloads the latest release DMG (checksum verified), copies the app to
 * /Applications and opens the site there — the same Download & Install as DBCatz.
 */

export const DIALCATZ_REPO = 'catzoidhub/DialCatz';
const APP_PATHS = ['/Applications/DialCatz.app', join(homedir(), 'Applications', 'DialCatz.app')];
const BUNDLE_ID = 'com.mrcatz.dialcatz';

export class DialCatz {
  private task: TaskProgress | null = null;
  private abort: AbortController | null = null;
  onChange: () => void = () => undefined;

  /** Where DialCatz was last found (see locate). */
  private found: string | null = APP_PATHS.find((p) => existsSync(p)) ?? null;

  /** Where DialCatz is: the usual folders, the app that opens dialcatz:// links, then Spotlight by bundle id. */
  async locate(): Promise<string | null> {
    const usable = (p: string | null | undefined): p is string => !!p && !p.includes('/.Trash/') && existsSync(join(p, 'Contents', 'Info.plist'));
    let path: string | null = APP_PATHS.find((p) => existsSync(p)) ?? null;
    if (!path) {
      const handler = await app.getApplicationInfoForProtocol('dialcatz://open').catch(() => null);
      if (usable(handler?.path) && /DialCatz/i.test(handler.path)) path = handler.path;
    }
    if (!path) {
      const r = await run('mdfind', [`kMDItemCFBundleIdentifier == '${BUNDLE_ID}'`], { timeout: 10_000 });
      path = r.stdout.split('\n').map((l) => l.trim()).find(usable) ?? null;
    }
    if (path !== this.found) {
      this.found = path;
      this.onChange();
    }
    return path;
  }

  state(): DbCatzState {
    return { installed: this.found !== null, task: this.task };
  }

  link(siteId: string): string {
    if (!/^[\w-]{1,64}$/.test(siteId)) throw new Error('Invalid site id');
    return `dialcatz://open?${new URLSearchParams({ site: siteId })}`;
  }

  /** Opens DialCatz at a DevCatz site; false when DialCatz is not installed (the window then offers the install). */
  async open(siteId: string): Promise<boolean> {
    const link = this.link(siteId);
    const path = await this.locate();
    if (!path) return false;
    // `open -a` hands the link to this very copy, whichever app Launch Services picked for dialcatz://.
    const r = await run('open', ['-a', path, link], { timeout: 30_000 });
    if (r.code !== 0) await shell.openExternal(link);
    return true;
  }

  /** Downloads the latest DialCatz release, installs it to /Applications and opens the site there. */
  async install(siteId: string): Promise<void> {
    if (this.task && !this.task.done && !this.task.error) return;
    const link = this.link(siteId);
    const steps = installSteps('DialCatz');
    const set = (p: Partial<TaskProgress>) => {
      this.task = { ...(this.task as TaskProgress), ...p };
      this.onChange();
    };
    this.task = { kind: 'install', title: 'Installing DialCatz', steps, step: 0 };
    this.abort = new AbortController();
    const signal = this.abort.signal;
    this.onChange();
    try {
      await installCatzoidApp('DialCatz', DIALCATZ_REPO, link, set, signal);
      set({ step: steps.length, done: true, detail: '' });
      void this.locate();
    } catch (e) {
      const cancelled = signal.aborted || (e as Error).name === 'AbortError';
      set({ error: cancelled ? 'Cancelled' : (e as Error).message, cancelled });
    } finally {
      this.abort = null;
      this.onChange();
    }
  }

  cancelInstall(): void {
    this.abort?.abort();
  }

  /** Hides a finished / failed install card. */
  dismiss(): void {
    if (this.task && (this.task.done || this.task.error)) {
      this.task = null;
      this.onChange();
    }
  }
}
