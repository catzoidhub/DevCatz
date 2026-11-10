import { app } from 'electron';
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { writeFileAtomic } from './atomicfile';
import { join } from 'node:path';
import type { DbBinary, DbServiceConfig, ProjectConfig, SearchConfig, SearchKind, Settings, StorageConfig, StorageKind, WsConfig, WsKind } from '@shared/types';

/** Current default TLD for new and renamed sites (Settings → Default domain). */
export const tld = (): string => store.settings.tld || 'localhost';

interface StoreData {
  projects: ProjectConfig[];
  settings: Settings;
  /** Managed dev ports, keyed `<projectId>:<appDir>`; stable across restarts. */
  ports: Record<string, number>;
  /** `<runtime>@<version>` updates already announced, so each is notified once. */
  notifiedUpdates?: string[];
  /** Installed object storage services, one per kind. */
  storage?: Partial<Record<StorageKind, StorageConfig>>;
  /** Installed WebSocket servers, one per kind. */
  websockets?: Partial<Record<WsKind, WsConfig>>;
  /** Installed search engines, one per kind. */
  searchEngines?: Partial<Record<SearchKind, SearchConfig>>;
  /** Database service instances. */
  dbServices?: DbServiceConfig[];
  /** Server builds installed by DevCatz (downloads, source builds, Homebrew formulas it installed). */
  dbBinaries?: DbBinary[];
  /** Other sections' own records (Git accounts with encrypted tokens …), by key. */
  extra?: Record<string, unknown>;
}

const DEFAULT_SETTINGS: Settings = {
  tld: 'localhost',
  theme: 'system',
  // Off: with many sites, starting every dev server at launch can eat the Mac's memory; sites opt in one by one.
  startAllOnLaunch: false,
  nodeDefault: null,
  bunDefault: null,
  goDefault: null,
  pythonDefault: null,
  rubyDefault: null,
  phpDefault: null,
  httpsPort: 8443,
  httpPort: 8180,
  editor: '',
  browser: '',
  parkedDirs: [],
  parkGroups: {},
  parkIgnore: [],
  updateNotifications: true,
  appUpdateAuto: true,
  appUpdateChannel: 'stable',
  appUpdateNotify: true,
  appUpdateSkip: null,
  appUpdateNotified: null,
  resumeSites: [],
  crashReports: false,
  crashAsked: false,
  welcomeSeen: false,
  favorites: [],
  siteGroups: [],
  siteOrder: [],
  worktreeAutoAdd: false,
  worktreeIgnore: [],
  dbFavorites: [],
  dbGroups: [],
  dbOrder: [],
  s3Region: 'us-east-1',
  storageRoot: '',
  storageBinRoot: '',
  s3EnvEndpoint: 'domain',
  dbDataRoot: '',
  dbBinRoot: '',
  dbEnvHost: 'local',
  dbDomain: '',
  monitorLiveInterval: 2,
  monitorBackground: true,
  monitorAlerts: false,
  monitorCpuAlert: 90,
  monitorMemAlertMb: 2048,
  monitorAlertMinutes: 5,
  monitorDiskAlertGb: 10,
  monitorMenuBar: true,
  wsAllowedOrigins: '*',
  wsTestEvents: 200,
  searchAllowedOrigins: '*',
  searchOpenSearchHeapMb: 512,
  mailPort: 2525,
  mailDomain: 'mail',
  mailAutoStart: true,
  mailNotify: true,
  mailKeep: 500,
  waNotify: true,
  waKeep: 500,
  exposeExpiryMinutes: 0,
};

export function dataDir(...parts: string[]): string {
  const dir = app.getPath('userData');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return join(dir, ...parts);
}

class Store {
  private data: StoreData;
  private file = dataDir('config.json');

  constructor() {
    let loaded: Partial<StoreData> = {};
    try {
      // A byte-order mark (an editor on Windows) is not JSON: dropped first.
      loaded = JSON.parse(readFileSync(this.file, 'utf8').replace(/^\uFEFF/, ''));
    } catch (e) {
      // First run (no file). A file that is there but cannot be read is kept aside before the defaults replace it,
      // so the sites and settings in it are not lost.
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT' && existsSync(this.file)) {
        try {
          copyFileSync(this.file, `${this.file}.unreadable-${Date.now()}`);
        } catch {
          /* best effort */
        }
        console.error(`config.json could not be read (${(e as Error).message}); a copy was kept next to it`);
      }
    }
    // Keep every saved field (storage, notified updates …), not only the ones listed here.
    this.data = {
      ...loaded,
      projects: loaded.projects ?? [],
      settings: { ...DEFAULT_SETTINGS, ...loaded.settings },
      ports: loaded.ports ?? {},
    };
    // One entry per MCatzP client, the oldest: two sessions of a client could be approved at the same moment.
    const clients = this.data.settings.mcatzpClients;
    if (clients) {
      const oldest = new Map<string, (typeof clients)[number]>();
      for (const c of clients) {
        const seen = oldest.get(c.name);
        if (!seen || c.approvedAt < seen.approvedAt) oldest.set(c.name, c);
      }
      this.data.settings.mcatzpClients = [...oldest.values()];
    }
  }

  get projects(): ProjectConfig[] {
    return this.data.projects;
  }

  get settings(): Settings {
    return this.data.settings;
  }

  get ports(): Record<string, number> {
    return this.data.ports;
  }

  setPort(key: string, port: number): void {
    this.data.ports[key] = port;
    this.save();
  }

  /** Forgets the managed ports of one site (`<id>:<app dir>` keys). */
  removePorts(siteId: string): void {
    for (const key of Object.keys(this.data.ports)) if (key.startsWith(`${siteId}:`)) delete this.data.ports[key];
    this.save();
  }

  setProjects(projects: ProjectConfig[]): void {
    this.data.projects = projects;
    this.save();
  }

  get storage(): Partial<Record<StorageKind, StorageConfig>> {
    return this.data.storage ?? {};
  }

  setStorage(kind: StorageKind, config: StorageConfig | null): void {
    const next = { ...(this.data.storage ?? {}) };
    if (config) next[kind] = config;
    else delete next[kind];
    this.data.storage = next;
    this.save();
  }

  get websockets(): Partial<Record<WsKind, WsConfig>> {
    return this.data.websockets ?? {};
  }

  setWebsocket(kind: WsKind, config: WsConfig | null): void {
    const next = { ...(this.data.websockets ?? {}) };
    if (config) next[kind] = config;
    else delete next[kind];
    this.data.websockets = next;
    this.save();
  }

  extra<T>(key: string): T | undefined {
    return this.data.extra?.[key] as T | undefined;
  }

  setExtra(key: string, value: unknown): void {
    this.data.extra = { ...(this.data.extra ?? {}), [key]: value };
    this.save();
  }

  get searchEngines(): Partial<Record<SearchKind, SearchConfig>> {
    return this.data.searchEngines ?? {};
  }

  setSearchEngine(kind: SearchKind, config: SearchConfig | null): void {
    const next = { ...(this.data.searchEngines ?? {}) };
    if (config) next[kind] = config;
    else delete next[kind];
    this.data.searchEngines = next;
    this.save();
  }

  get dbServices(): DbServiceConfig[] {
    return this.data.dbServices ?? [];
  }

  setDbServices(list: DbServiceConfig[]): void {
    this.data.dbServices = list;
    this.save();
  }

  get dbBinaries(): DbBinary[] {
    return this.data.dbBinaries ?? [];
  }

  setDbBinaries(list: DbBinary[]): void {
    this.data.dbBinaries = list;
    this.save();
  }

  get notifiedUpdates(): string[] {
    return this.data.notifiedUpdates ?? [];
  }

  setNotifiedUpdates(list: string[]): void {
    this.data.notifiedUpdates = list.slice(-200);
    this.save();
  }

  updateSettings(patch: Partial<Settings>): void {
    this.data.settings = { ...this.data.settings, ...patch };
    this.save();
  }

  private save(): void {
    writeFileAtomic(this.file, JSON.stringify(this.data, null, 2));
  }
}

export const store = new Store();
