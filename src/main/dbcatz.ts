import { app, shell } from 'electron';
import { existsSync, mkdirSync, renameSync, writeFileSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { DbServiceState, TaskProgress } from '@shared/types';
import { installCatzoidApp, installSteps, catzoidAppPaths, findCatzoidApp, openCatzoidApp } from './companion';
import { run } from './env';

/**
 * DBCatz, the database viewer, is its own app. DevCatz hands it two things:
 *
 *  · services.json in DevCatz's data folder (owner-only): the database
 *    services DevCatz manages, with their credentials and whether they run.
 *    DBCatz follows the file and lists them as "DevCatz services".
 *  · dbcatz:// links to open a service (at a database) or the Connections tab.
 *
 * When DBCatz is not installed, `install()` downloads the latest release DMG
 * from GitHub (checksum verified), copies the app to /Applications and opens
 * the link that was asked for.
 */

export const DBCATZ_REPO = 'catzoidhub/DBCatz';
export const DBCATZ_RELEASES = `https://github.com/${DBCATZ_REPO}/releases/latest`;
const APP_PATHS = catzoidAppPaths('DBCatz');
const BUNDLE_ID = 'com.mrcatz.dbcatz';

/** What DBCatz reads (DevCatzService / DevCatzServicesFile in DBCatz's types). */
interface ServiceEntry {
  id: string;
  name: string;
  engine: string;
  version: string;
  host: string;
  port: number;
  user: string;
  password: string;
  dataDir: string;
  socket: string;
  running: boolean;
}

export interface DbCatzState {
  installed: boolean;
  task: TaskProgress | null;
}

export class DbCatz {
  private task: TaskProgress | null = null;
  private abort: AbortController | null = null;
  private lastWritten = '';
  private writeTimer: ReturnType<typeof setTimeout> | null = null;
  onChange: () => void = () => undefined;

  /** Where DBCatz was last found (see locate). */
  private found: string | null = APP_PATHS.find((p) => existsSync(p)) ?? null;

  /**
   * Finds DBCatz wherever it lives — /Applications, ~/Applications, or any
   * other folder (a build output, Downloads): the usual places first, then the
   * app Launch Services opens dbcatz:// links with, then Spotlight by bundle id.
   */
  async locate(): Promise<string | null> {
    const path = await findCatzoidApp('DBCatz', 'dbcatz', BUNDLE_ID);
    if (path !== this.found) {
      this.found = path;
      this.onChange();
    }
    return path;
  }

  installed(): boolean {
    return this.found !== null;
  }

  state(): DbCatzState {
    return { installed: this.installed(), task: this.task };
  }

  // ------------------------------------------------------------- services.json

  servicesFile(): string {
    return join(app.getPath('userData'), 'dbcatz', 'services.json');
  }

  /** Writes the services DBCatz should list; debounced, and only when something changed. */
  publish(services: DbServiceState[]): void {
    const entries: ServiceEntry[] = services
      .filter((s) => !s.pending)
      .map((s) => ({
        id: s.id,
        name: s.name,
        engine: s.engine,
        version: s.version,
        host: s.host ?? '127.0.0.1',
        port: s.port,
        user: s.user,
        password: s.password,
        dataDir: s.resolvedDataDir,
        socket: s.resolvedSocket ?? '',
        running: s.status === 'running',
      }));
    const body = JSON.stringify(entries);
    if (body === this.lastWritten) return;
    this.lastWritten = body;
    if (this.writeTimer) clearTimeout(this.writeTimer);
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null;
      try {
        const file = this.servicesFile();
        const dir = join(file, '..');
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
        const tmp = `${file}.tmp`;
        writeFileSync(tmp, JSON.stringify({ version: 1, app: 'DevCatz', written: new Date().toISOString(), services: entries }, null, 2), { mode: 0o600 });
        chmodSync(tmp, 0o600);
        renameSync(tmp, file);
      } catch (e) {
        console.warn('dbcatz/services.json could not be written:', (e as Error).message);
      }
    }, 300);
  }

  // ------------------------------------------------------------- opening

  /** `svc:<id>` (a DevCatz service, optionally at a database) or null for the Connections tab. */
  link(connId: string | null, database?: string): string {
    if (!connId) return 'dbcatz://open';
    const q = new URLSearchParams({ conn: connId });
    if (database) q.set('db', database);
    return `dbcatz://open?${q}`;
  }

  /** Opens DBCatz at `connId`; false when it is not installed (the window then offers the install). */
  async open(connId: string | null, database?: string): Promise<boolean> {
    const path = await this.locate();
    if (!path) return false;
    // On a Mac `open -a` hands the link to this very copy; on Windows the .exe gets it.
    await openCatzoidApp(path, this.link(connId, database));
    return true;
  }

  // ------------------------------------------------------------- install

  /** Downloads the latest DBCatz release, installs it to /Applications and opens `connId`. */
  async install(connId: string | null, database?: string): Promise<void> {
    if (this.task && !this.task.done && !this.task.error) return;
    const steps = installSteps('DBCatz');
    const set = (p: Partial<TaskProgress>) => {
      this.task = { ...(this.task as TaskProgress), ...p };
      this.onChange();
    };
    this.task = { kind: 'install', title: 'Installing DBCatz', steps, step: 0 };
    this.abort = new AbortController();
    const signal = this.abort.signal;
    this.onChange();
    try {
      await installCatzoidApp('DBCatz', DBCATZ_REPO, this.link(connId, database), set, signal);
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
