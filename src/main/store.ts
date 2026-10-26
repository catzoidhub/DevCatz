import { app } from 'electron';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
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
  startAllOnLaunch: true,
  nodeDefault: null,
  bunDefault: null,
  goDefault: null,
  pythonDefault: null,
  phpDefault: null,
  httpsPort: 8443,
  httpPort: 8180,
  editor: '',
  browser: '',
  parkedDirs: [],
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
      loaded = JSON.parse(readFileSync(this.file, 'utf8'));
    } catch {
      /* first run */
    }
    // Keep every saved field (storage, notified updates …), not only the ones listed here.
    this.data = {
      ...loaded,
      projects: loaded.projects ?? [],
      settings: { ...DEFAULT_SETTINGS, ...loaded.settings },
      ports: loaded.ports ?? {},
    };
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
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    renameSync(tmp, this.file);
  }
}

export const store = new Store();
