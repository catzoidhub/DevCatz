import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { app, shell } from 'electron';
import type { DbCatzState, TaskProgress } from '@shared/types';
import { installCatzoidApp, installSteps, catzoidAppPaths, findCatzoidApp, openCatzoidApp } from './companion';
import { run } from './env';

/**
 * DevCatz → DoCatz (the Catzoid container manager; DoCatz TODO #22 / #23): "Open in DoCatz" on a site's Docker tab.
 * `docatz://compose?path=<compose file>` opens that compose project in DoCatz (its containers, logs, rebuild);
 * `docatz://open?site=<site id>` the site's containers. DoCatz is also the container engine DevCatz recommends.
 * When DoCatz is not installed, `install()` downloads the latest release (checksum verified), installs it and opens
 * the link there — the same Download & Install as DBCatz and DialCatz.
 */

export const DOCATZ_REPO = 'catzoidhub/DoCatz';

/**
 * DoCatz's bridge.json (in DoCatz's data folder): its proxy ports (`proxy: { httpsPort, httpPort }`) and its engine
 * (`engine: "running" | "stopped"`). Read at most every few seconds (route updates and status checks are frequent).
 * DOCATZ_BRIDGE points elsewhere, for tests.
 */
type DocatzBridge = { proxy?: { httpPort?: number; httpsPort?: number }; engine?: string };
let bridgeCache: { at: number; value: DocatzBridge | null } = { at: 0, value: null };
function docatzBridge(): DocatzBridge | null {
  if (Date.now() - bridgeCache.at < 5000) return bridgeCache.value;
  let value = null;
  try {
    value = JSON.parse(readFileSync(process.env.DOCATZ_BRIDGE || join(app.getPath('appData'), 'DoCatz', 'bridge.json'), 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    /* DoCatz not installed, or not started yet */
  }
  bridgeCache = { at: Date.now(), value };
  return value;
}

/** DoCatz's proxy HTTP port, or null when DoCatz has not published one. */
export function docatzProxyPort(): number | null {
  const p = Number(docatzBridge()?.proxy?.httpPort);
  return Number.isInteger(p) && p > 0 && p < 65536 ? p : null;
}

/** DoCatz's own HTTPS port (its names answer there when :443 is not forwarded), default 8743. */
export function docatzHttpsPort(): number {
  const p = Number(docatzBridge()?.proxy?.httpsPort);
  return Number.isInteger(p) && p > 0 && p < 65536 ? p : 8743;
}

/** DoCatz's engine as its bridge.json says: running / stopped, null when DoCatz is not there. */
export function docatzEngine(): 'running' | 'stopped' | null {
  const e = docatzBridge()?.engine;
  return e === 'running' ? 'running' : e ? 'stopped' : null;
}
const APP_PATHS = catzoidAppPaths('DoCatz');
const BUNDLE_ID = 'com.mrcatz.docatz';

export class DoCatz {
  private task: TaskProgress | null = null;
  private abort: AbortController | null = null;
  onChange: () => void = () => undefined;

  /** Where DoCatz was last found (see locate). */
  private found: string | null = APP_PATHS.find((p) => existsSync(p)) ?? null;

  /** Where DoCatz is: the usual folders, the app that opens docatz:// links, then Spotlight by bundle id. */
  async locate(): Promise<string | null> {
    const path = await findCatzoidApp('DoCatz', 'docatz', BUNDLE_ID);
    if (path !== this.found) {
      this.found = path;
      this.onChange();
    }
    return path;
  }

  state(): DbCatzState {
    return { installed: this.found !== null, task: this.task };
  }

  /** A compose file (absolute path) → its compose project; else the site's containers. */
  link(siteId: string, composePath?: string | null): string {
    if (!/^[\w-]{1,64}$/.test(siteId)) throw new Error('Invalid site id');
    return composePath ? `docatz://compose?${new URLSearchParams({ path: composePath, site: siteId })}` : `docatz://open?${new URLSearchParams({ site: siteId })}`;
  }

  /** Opens DoCatz at a site's compose project; false when DoCatz is not installed (the window then offers the install). */
  async open(siteId: string, composePath?: string | null): Promise<boolean> {
    const link = this.link(siteId, composePath);
    const path = await this.locate();
    if (!path) return false;
    // On a Mac `open -a` hands the link to this very copy; on Windows the .exe gets it.
    await openCatzoidApp(path, link);
    return true;
  }

  /** Downloads the latest DoCatz release, installs it and opens the link there. */
  async install(siteId: string, composePath?: string | null): Promise<void> {
    if (this.task && !this.task.done && !this.task.error) return;
    const link = this.link(siteId, composePath);
    const steps = installSteps('DoCatz');
    const set = (p: Partial<TaskProgress>) => {
      this.task = { ...(this.task as TaskProgress), ...p };
      this.onChange();
    };
    this.task = { kind: 'install', title: 'Installing DoCatz', steps, step: 0 };
    this.abort = new AbortController();
    const signal = this.abort.signal;
    this.onChange();
    try {
      await installCatzoidApp('DoCatz', DOCATZ_REPO, link, set, signal);
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
