import { shell } from 'electron';
import { probeOpenApi, specFiles, writeBridge, type BridgeSite } from './bridge';
import { depFolders, isRealDirInside, lastActivity, sizeOf } from './depclean';
import { EventEmitter } from 'node:events';
import { existsSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, watch, writeFileSync, type FSWatcher } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { CertManager } from './certs';
import {
  cleanUrlsCoverIpv4,
  cleanUrlsInstalled,
  cleanUrlsWorking,
  cleanHttpWorking,
  installCleanUrls,
  installResolver,
  resolverStatus,
  uninstallCleanUrls,
  uninstallResolver,
} from './cleanurls';
import { DB_TASK_LABELS, dbStatus, runDbAction, stream } from './database';
import { detectPackageManager, readEnvFiles, readJson, readText, runScriptCommand, slugify, type PackageJson } from './detect';
import { detectStack, isLinkableDir, isProjectDir } from './runtimes';
import { getShellEnv, hasCommand, isListening, isPortOpen, portOwner, run, setUserPath } from './env';
import { isMac, isWin, joinPath, pathKey, shellCommand, splitPath } from './platform';
import { lookup } from 'node:dns/promises';
import { ProcessManager } from './processes';
import { captureScreenshot, screenshotTime } from './screenshots';
import * as nodes from './node';
import * as buns from './bun';
import * as golang from './golang';
import * as rusts from './rust';
import * as phps from './php';
import * as phpext from './phpext';
import { detectRealtime } from './realtime';
import * as bcast from './broadcasting';
import { request as httpsRequest } from 'node:https';
import { WsManager, binaryDirOf as wsBinaryDirOf, setPhpRuntime, wsId } from './websocket';
import { GitService } from './gitservice';
import {
  checkRefName as gitCheckRefName,
  gitOk,
  repoRoot as gitRepoRoot,
  summary as gitSummary,
  unpushed as gitUnpushed,
  worktreeAdd as gitWorktreeAdd,
  worktreePrune as gitWorktreePrune,
  worktreeRemove as gitWorktreeRemove,
  worktrees as gitWorktrees,
} from './git';
import { DevCatzAi } from './ai/devcatz';
import { aiSettings } from './ai/settings';
import { branchLabel, cloneDeps, copyEnvFiles, copyLocalFile, copyName, rewriteEnvDb } from './worktrees';
import { MailManager } from './mail/manager';
import { WaManager } from './whatsapp';
import { GatewayManager } from './gateways/manager';
import { ExposeManager } from './expose';
import { SearchManager, binaryDirOf as searchBinaryDirOf, searchId } from './search';
import { detectSearch } from './searchdetect';
import { detectS3, endpointMatches } from './storagedetect';
import { FpmManager } from './fpm';
import { redisDetails, redisPassword } from './redis';
import { Proxy, type Route } from './proxy';
import { store, tld } from './store';
import { DNS_PORT, DnsServer } from './dns';
import { findUpdates, type RemoteLists } from './updates';
import * as docker from './docker';
import * as gorm from './gorm';
import * as envfiles from './envfiles';
import * as s3 from './s3';
import { ENGINES, StorageManager, binaryDirOf as storageBinaryDirOf, s3Region, seaweedPublic, setSeaweedPublic } from './storage';
import { DB_DOMAIN_LABEL, DbServiceManager, dbProcessId } from './dbservices';
import { DbCatz } from './dbcatz';
import { DialCatz } from './dialcatz';
import { Reports } from './reports';
import { AppUpdater } from './updater';
import { browsersState, editorIcons, validBrowser } from './browsers';
import { Monitor, type MonitorTarget } from './monitor';
import * as pythons from './python';
import type {
  AppInfo,
  AppState,
  BuildTarget,
  SiteOpenApi,
  DepCommand,
  DepFolder,
  SiteDeps,
  LaravelBroadcastInfo,
  S3Info,
  PhpExtensions,
  PhpExtTask,
  HerdSite,
  TldChange,
  InstalledPhp,
  PhpChoice,
  PhpIniSettings,
  BunChoice,
  GoChoice,
  InstalledPython,
  PythonChoice,
  InstalledGo,
  InstalledRust,
  RemoteRust,
  RustChoice,
  RustToolId,
  RustToolState,
  FolderPreview,
  InstalledBun,
  RuntimeInstallProgress,
  RuntimeKind,
  RuntimeUpdate,
  DockerAction,
  S3Bucket,
  StorageKind,
  SearchKind,
  WsKind,
  GoDbInfo,
  EnvFileInfo,
  DockerGenOptions,
  DockerComposeFile,
  DockerService,
  UpdatesState,
  LinkOptions,
  DbAction,
  DbStatus,
  InstalledNode,
  NodeChoice,
  NodeInstallProgress,
  ProjectConfig,
  ProjectState,
  RedisDetails,
  Settings,
  StackInfo,
  WorktreeCheck,
  WorktreeCreateOptions,
  WorktreeList,
  TaskProgress,
  RuntimeNeed,
} from '@shared/types';
import { isPhpFramework } from '@shared/types';
import { words } from '@shared/platform';

/** LTS codenames for `lts/<name>` specs before nodejs.org has been asked. */
/** What a Rust site still needs, as the Start error names it. */
const RUST_NEED_LABEL: Record<RustChoice['needs'][number], string> = {
  trunk: 'Trunk',
  'dioxus-cli': 'the Dioxus CLI',
  'cargo-leptos': 'cargo-leptos',
  'tauri-cli': 'the Tauri CLI',
  solana: 'the Solana CLI',
  anchor: 'Anchor',
  wasm32: 'the WebAssembly target',
  'sqlx-cli': 'the SQLx CLI',
  'sea-orm-cli': 'the SeaORM CLI',
  'diesel-cli': 'the Diesel CLI',
};
const NO_NODE = 'Node.js is not installed. Install it from the site\'s Overview (Install Node.js) or the Node.js page (sidebar), then try again.';

const LTS_NAMES = new Map([
  [18, 'Hydrogen'],
  [20, 'Iron'],
  [22, 'Jod'],
  [24, 'Krypton'],
]);

/** Dockerfile, Dockerfile.prod, docker-compose.yml, compose.prod.yaml, .dockerignore … */
const DOCKER_FILE = /^(Dockerfile(\.[\w.-]+)?|[\w.-]*\.Dockerfile|(docker-)?compose(\.[\w-]+)?\.ya?ml|\.dockerignore)$/;
const idFor = (path: string) => createHash('sha1').update(path).digest('hex').slice(0, 10);

/**
 * Owns the projects (linked + parked), their runtime state, the proxy and
 * the certificates. Emits `change` whenever the UI should refresh.
 */
export class Herd extends EventEmitter {
  readonly processes = new ProcessManager();
  readonly certs = new CertManager();
  readonly proxy = new Proxy(this.certs);
  readonly dns = new DnsServer();
  private resolves = false;
  private ipv4Free = false;
  private projects: ProjectConfig[] = [];
  private stacks = new Map<string, StackInfo>();
  private openPorts = new Map<string, number[]>();
  private dbStates = new Map<string, DbStatus>();
  private redisStates = new Map<string, DbStatus>();
  private dbTasks = new Map<string, string>();
  private caTrusted = false;
  private cleanUrls = false;
  private cleanHttp = false;
  private watchers: FSWatcher[] = [];
  private timers: NodeJS.Timeout[] = [];
  private changeTimer: NodeJS.Timeout | null = null;
  private capturing = new Set<string>();
  /** Sites between Start and their processes spawning (e.g. building shared packages). */
  private launching = new Set<string>();
  private envHints = new Map<string, { key: string; value: string }[]>();
  private envOverrides = new Map<string, Record<string, string>>();
  /** REDIS_DB / REDIS_URL … for the site's chosen Redis DB index (may hold a password, so never sent to the UI). */
  private redisEnv = new Map<string, Record<string, string>>();
  private installedNodes: InstalledNode[] = [];
  private systemNode: string | null = null;
  private nodeInstalling: NodeInstallProgress | null = null;
  private installedBuns: InstalledBun[] = [];
  private bunInstalling: RuntimeInstallProgress | null = null;
  private installedGos: InstalledGo[] = [];
  /** Sites being started: see ProjectState.launch. */
  private launchState = new Map<string, { building: string | null; apps: Record<string, 'waiting' | 'starting'> }>();
  private rustToolchains: InstalledRust[] = [];
  private rustupVer: string | null = null;
  private rustTargets: string[] = [];
  private rustTools: RustToolState[] = [];
  private rustInstalling: RuntimeInstallProgress | null = null;
  private rustLinkerMissing = false;
  private installedPhps: InstalledPhp[] = [];
  private phpInstalling: RuntimeInstallProgress | null = null;
  readonly fpm = new FpmManager();
  readonly storage = new StorageManager();
  readonly ws = new WsManager();
  readonly search = new SearchManager();
  /** Opens a file in the user's editor (set by index.ts, which knows the editors). */
  openFileHook: (path: string) => Promise<void> = async () => undefined;
  /** Mail catcher (SMTP on 127.0.0.1:<mailPort>, web inbox on mail.<tld>); notifications are wired by index.ts. */
  onMail: (m: { subject: string; from: { address: string } | null; siteName: string | null }) => void = () => undefined;
  readonly mail = new MailManager({
    projects: () => this.projects,
    runtime: (id) => this.stacks.get(id)?.runtime ?? null,
    framework: (id) => this.stacks.get(id)?.apps.find((a) => a.kind !== 'assets')?.framework ?? this.stacks.get(id)?.apps[0]?.framework ?? null,
    changed: () => {
      this.updateRoutes();
      this.changed();
    },
    onMail: (m) => this.onMail(m),
  });
  /** Public tunnels; notifications are wired by index.ts. */
  notifyHook: (title: string, body: string) => void = () => undefined;
  /** WhatsApp gateways (GOWA / WAHA) on 127.0.0.1 and <label>.<tld>. */
  readonly whatsapp: WaManager = new WaManager({
    projects: () => this.projects,
    runtime: (id) => this.stacks.get(id)?.runtime ?? null,
    framework: (id) => this.stacks.get(id)?.apps.find((a) => a.kind !== 'assets')?.framework ?? this.stacks.get(id)?.apps[0]?.framework ?? null,
    takenDomains: (): string[] => [
      ...this.projects.flatMap((p) => [p.domain, ...(this.stacks.get(p.id)?.apps.map((a) => a.domain) ?? [])]),
      ...this.storage.routes().map((r) => r.domain),
      ...this.ws.routes().map((r) => r.domain),
      ...this.search.routes().map((r) => r.domain),
      this.mail.domain(),
      ...this.gateways.domains(),
    ],
    changed: () => {
      this.updateRoutes();
      this.changed();
    },
    notify: (t, b) => this.notifyHook(t, b),
  });
  /** Email / push / SMS gateways (Stalwart, Postal, ntfy, Gotify, Jasmin). */
  readonly gateways: GatewayManager = new GatewayManager({
    projects: () => this.projects,
    runtime: (id) => this.stacks.get(id)?.runtime ?? null,
    framework: (id) => this.stacks.get(id)?.apps.find((a) => a.kind !== 'assets')?.framework ?? this.stacks.get(id)?.apps[0]?.framework ?? null,
    takenDomains: (): string[] => [
      ...this.projects.flatMap((p) => [p.domain, ...(this.stacks.get(p.id)?.apps.map((a) => a.domain) ?? [])]),
      ...this.storage.routes().map((r) => r.domain),
      ...this.ws.routes().map((r) => r.domain),
      ...this.search.routes().map((r) => r.domain),
      this.mail.domain(),
      ...this.whatsapp.domains(),
    ],
    takenPorts: () => this.whatsapp.state().flatMap((w) => (w.config ? [w.config.port] : [])),
    urlOf: (h) => `https://${h}${this.portSuffix(true)}`,
    mailPort: () => store.settings.mailPort,
    changed: () => {
      this.updateRoutes();
      this.changed();
    },
    notify: (t, b) => this.notifyHook(t, b),
  });
  readonly expose = new ExposeManager({
    projects: () => this.projects,
    ensureRunning: async (id, report) => {
      const p = this.find(id);
      const stack = this.stacks.get(id);
      if (!p || !stack || stack.runtime === 'php') return; // PHP-FPM serves it; nothing to start
      if (!this.processes.isActive(id) && !(await this.anyPortOpen(id))) {
        report(`Starting ${p.name}’s dev server`);
        await this.start(id);
      }
      const deadline = Date.now() + 90_000;
      while (Date.now() < deadline) {
        if (await this.anyPortOpen(id)) return;
        if (!this.processes.isActive(id)) throw new Error(`${p.name}’s dev server stopped; see its log`);
        report(`Waiting for ${p.name}’s dev server to listen…`);
        await new Promise((r) => setTimeout(r, 1000));
      }
      throw new Error(`${p.name}’s dev server did not start listening within 90 s`);
    },
    domains: (id) => {
      const p = this.find(id);
      return p ? [p.domain, ...(this.stacks.get(id)?.apps.map((a) => a.domain).filter((d): d is string => Boolean(d && d !== p.domain)) ?? [])] : [];
    },
    changed: () => this.changed(),
    notify: (t, b) => this.notifyHook(t, b),
  });
  readonly git = new GitService({
    projects: () => this.projects,
    project: (id) => this.project(id),
    log: (id, text) => this.processes.log(id, 'sys', text),
    busy: this.dbTasks,
    changed: () => this.changed(),
    runtimes: (id) => {
      const s = this.stacks.get(id);
      return s ? [s.runtime, ...(s.apps ?? []).map((a) => a.framework)] : [];
    },
    openFile: (path) => this.openFileHook(path),
    polled: () => void this.autoAddWorktrees(),
  });
  readonly dbs = new DbServiceManager();
  /** AI features (TODO §28): Settings → AI, explain & fix, commit messages, Docker / .env / search / webhook helpers, Ask DevCatz. */
  readonly ai = new DevCatzAi(this);
  /** DBCatz, the database viewer app: gets DevCatz's services through services.json, opened by dbcatz:// links. */
  readonly dbcatz = new DbCatz();
  /** DialCatz, the API client: opened at a site by dialcatz:// links, installed from its release when missing. */
  readonly dialcatz = new DialCatz();
  /** DevCatz's own updates (Catzoid #54). */
  readonly updater = new AppUpdater();
  /** Report a Bug / feedback / crash reports to the Catzoid site (Catzoid #65). */
  readonly reports = new Reports();
  /** Uninstall DevCatz in progress (Catzoid #55). */
  uninstallTask: TaskProgress | null = null;
  readonly monitor = new Monitor(() => this.monitorTargets());
  /** Watches public/hot of running Laravel+Vite sites to point it at the site's own origin. */
  private hotWatchers = new Map<string, FSWatcher>();
  /** Vite of that site serves HTTPS (laravel-vite-plugin used a Herd/Valet certificate). */
  private viteTls = new Map<string, boolean>();
  private viteOrigin = new Map<string, string>();
  private previewQueued = new Set<string>();
  private goInstalling: RuntimeInstallProgress | null = null;
  private installedPythons: InstalledPython[] = [];
  private pythonInstalling: RuntimeInstallProgress | null = null;
  private uvVer: string | null = null;
  private remote: RemoteLists = {};
  private updates: UpdatesState = { list: [], checkedAt: null, checking: false, error: null, updating: null };
  /** Called with updates not announced before (macOS notification). */
  onNewUpdates: (list: RuntimeUpdate[]) => void = () => undefined;

  constructor() {
    super();
    this.processes.on('status', (id: string) => {
      // Up (every port answers), stopped or crashed: the start is over.
      if (this.processes.getStatus(id).status !== 'starting') this.launchState.delete(id);
      this.changed();
    });
    this.fpm.onChange = () => {
      this.updateRoutes();
      this.changed();
    };
    this.storage.onChange = () => {
      this.updateRoutes();
      this.changed();
    };
    this.ws.onChange = () => {
      this.updateRoutes();
      this.changed();
    };
    this.ws.takenDomains = () => [
      ...this.projects.flatMap((p) => [p.domain, ...(this.stacks.get(p.id)?.apps.map((a) => a.domain) ?? [])]),
      ...this.storage.routes().map((r) => r.domain),
      ...this.search.routes().map((r) => r.domain),
      this.mail.domain(),
      ...this.whatsapp.domains(),
      ...this.gateways.domains(),
    ];
    this.search.onChange = () => {
      this.updateRoutes();
      this.changed();
    };
    this.search.takenDomains = () => [
      ...this.projects.flatMap((p) => [p.domain, ...(this.stacks.get(p.id)?.apps.map((a) => a.domain) ?? [])]),
      ...this.storage.routes().map((r) => r.domain),
      ...this.ws.routes().map((r) => r.domain),
      this.mail.domain(),
      ...this.whatsapp.domains(),
      ...this.gateways.domains(),
    ];
    this.dbs.onChange = () => this.changed();
    this.dbcatz.onChange = () => this.changed();
    void this.dbcatz.locate();
    this.dialcatz.onChange = () => this.changed();
    this.updater.onChange = () => this.changed();
    this.updater.headers = () => this.reports.headers();
    this.reports.onChange = () => this.changed();
    void this.dialcatz.locate();
    this.dbs.linkedSites = (sid) => this.projects.filter((p) => p.dbService === sid).map((p) => p.id);
    this.dbs.unlinkSites = (sid) => {
      const linked = store.projects.filter((p) => p.dbService === sid);
      if (linked.length) store.setProjects(store.projects.map((p) => (p.dbService === sid ? { ...p, dbService: undefined } : p)));
      if (linked.length) this.rescan();
    };
    this.storage.siteDomains = () => this.projects.flatMap((p) => [p.domain, ...(this.stacks.get(p.id)?.apps.map((a) => a.domain) ?? [])]).filter(Boolean);
    this.proxy.urlBase = (secure, host) => `${secure ? 'https' : 'http'}://${host}${this.portSuffix(secure)}`;
  }

  async init(): Promise<void> {
    const reaped =
      (await this.processes.reapOrphans()) + (await this.storage.processes.reapOrphans()) + (await this.ws.processes.reapOrphans()) +
      (await this.search.processes.reapOrphans()) +
      (await this.dbs.processes.reapOrphans());
    if (reaped) console.log(`Stopped ${reaped} dev server(s) left over from a previous run`);
    this.rescan();
    await this.proxy.listen(store.settings.httpsPort, store.settings.httpPort);
    this.refreshNodes();
    await this.refreshBuns();
    await this.refreshGos();
    await this.refreshRust();
    await this.refreshPythons();
    // Windows (Catzoid #57): PHP runs as php-cgi workers (fpm.ts); the DNS responder / resolver stay macOS-only.
    await this.refreshPhps();
    await phps.writeCaBundle(this.certs.caPath).catch(() => undefined);
    this.syncFpm();
    this.systemNode = await nodes.systemNode();
    if (isMac) {
      await this.dns.start(tld());
      await this.checkResolution();
    }
    this.caTrusted = await this.certs.isTrusted();
    this.cleanUrls = await cleanUrlsWorking();
    this.cleanHttp = await cleanHttpWorking();
    this.ipv4Free = !(await isListening('127.0.0.1', 443)) || cleanUrlsCoverIpv4();
    this.timers.push(setInterval(() => void this.pollPorts(), 1500));
    void this.pollPorts();
    this.timers.push(setInterval(() => void this.pollDatabases(), 5000));
    void this.pollDatabases();
    this.dbs.autoStart();
    this.timers.push(setTimeout(() => void this.dbs.prefetchVersions(), 20_000));
    // Windows (Catzoid #57): storage, WebSocket and search servers and the monitor are macOS-only so far.
    if (isMac) {
      this.storage.autoStart();
      this.ws.autoStart();
      this.search.autoStart();
      this.monitor.start();
    }
    // Runtime updates: shortly after launch, then every 6 hours.
    this.timers.push(setTimeout(() => void this.autoCheckUpdates(), 30_000));
    this.timers.push(setInterval(() => void this.autoCheckUpdates(), 6 * 3600_000));
  }

  /** Rewrites files that embed the data folder's path (after it moved). Shims are rewritten by the refresh* calls. */
  async rewriteManagedFiles(): Promise<void> {
    for (const p of this.installedPhps) {
      if (p.source !== 'mrcatz') continue;
      await phps.writeIni(p.php, p.version, phps.readIni(p.version)).catch((e) => console.error(`php.ini ${p.version}:`, e));
    }
    this.fpm.restartAll().catch(() => undefined);
  }

  // ------------------------------------------------------------ runtime updates

  /** Remote version lists, remembered so the update list follows what the pages fetched too. */
  async nodeRemote(refresh = false) {
    this.remote.node = await nodes.listRemote(refresh);
    this.recomputeUpdates();
    return this.remote.node;
  }
  async bunRemote(refresh = false) {
    this.remote.bun = await buns.listRemote(refresh);
    this.recomputeUpdates();
    return this.remote.bun;
  }
  async goRemote(refresh = false) {
    this.remote.go = await golang.listRemote(refresh);
    this.recomputeUpdates();
    return this.remote.go;
  }
  async phpRemote(refresh = false) {
    this.remote.php = await phps.listRemote(refresh);
    this.recomputeUpdates();
    return this.remote.php;
  }

  private recomputeUpdates(): void {
    this.updates.list = this.computeUpdates();
    this.changed();
  }

  /** Recomputed on every snapshot too, so installs/uninstalls show up at once. */
  private computeUpdates(): RuntimeUpdate[] {
    const s = store.settings;
    return findUpdates(
      { node: this.installedNodes, bun: this.installedBuns, go: this.installedGos, php: this.installedPhps },
      this.remote,
      { node: s.nodeDefault, bun: s.bunDefault, go: s.goDefault, php: s.phpDefault },
    );
  }

  private async autoCheckUpdates(): Promise<void> {
    if (store.settings.updateNotifications) await this.checkUpdates().catch(() => undefined);
  }

  /** Fetches every runtime's release list (only for runtimes that are installed). */
  async checkUpdates(): Promise<void> {
    if (this.updates.checking) return;
    this.updates.checking = true;
    this.changed();
    const errors: string[] = [];
    const tryList = async (name: string, has: boolean, fn: () => Promise<unknown>) => {
      if (!has) return;
      try {
        await fn();
      } catch (err) {
        errors.push(`${name}: ${(err as Error).message}`);
      }
    };
    await Promise.all([
      tryList('Node.js', this.installedNodes.length > 0, () => this.nodeRemote(true)),
      tryList('Bun', this.installedBuns.some((b) => b.source !== 'system'), () => this.bunRemote(true)),
      tryList('Go', this.installedGos.some((g) => g.source !== 'system'), () => this.goRemote(true)),
      tryList('PHP', this.installedPhps.length > 0, () => this.phpRemote(true)),
    ]);
    this.updates.checking = false;
    this.updates.checkedAt = Date.now();
    this.updates.error = errors.length ? errors.join('; ') : null;
    this.recomputeUpdates();
    if (!store.settings.updateNotifications) return;
    const told = new Set(store.notifiedUpdates);
    const fresh = this.updates.list.filter((u) => !told.has(`${u.runtime}@${u.to}`));
    if (!fresh.length) return;
    store.setNotifiedUpdates([...told, ...fresh.map((u) => `${u.runtime}@${u.to}`)]);
    this.onNewUpdates(fresh);
  }

  /** Installs the newer patch; it takes over as default when the old one was. Old versions stay (sites may pin them). */
  async runtimeUpdate(runtime: RuntimeKind, from: string): Promise<void> {
    const u = this.updates.list.find((x) => x.runtime === runtime && x.from === from);
    if (!u) throw new Error(`No update known for ${runtime} ${from}`);
    if (this.updates.updating) throw new Error('Another update is running');
    this.updates.updating = `${runtime}@${from}`;
    this.changed();
    try {
      if (runtime === 'node') await this.nodeInstall(u.to);
      else if (runtime === 'bun') await this.bunInstall(u.to);
      else if (runtime === 'go') await this.goInstall(u.to);
      else await this.phpInstall(u.to);
      const isDefault = store.settings[`${runtime}Default`] === from;
      if (isDefault) {
        if (runtime === 'node') this.nodeSetDefault(u.to);
        else if (runtime === 'bun') await this.bunSetDefault(u.to);
        else if (runtime === 'go') await this.goSetDefault(u.to);
        else await this.phpSetDefault(u.to);
      }
    } finally {
      this.updates.updating = null;
      this.recomputeUpdates();
    }
  }

  // ---------------------------------------------------------------- projects

  /** Re-reads linked projects, rescans parked folders and re-detects stacks. */
  rescan(): void {
    const linked = store.projects.filter((p) => existsSync(p.path));
    const byPath = new Map(linked.map((p) => [p.path, p]));
    const parked: ProjectConfig[] = [];
    for (const dir of store.settings.parkedDirs) {
      let entries: string[] = [];
      try {
        entries = readdirSync(dir);
      } catch {
        continue;
      }
      for (const entry of entries.sort()) {
        const path = join(dir, entry);
        if (entry.startsWith('.') || byPath.has(path)) continue;
        try {
          if (!statSync(path).isDirectory() || !isProjectDir(path)) continue;
        } catch {
          continue;
        }
        parked.push({ id: idFor(path), name: entry, path, domain: '', parkedFrom: dir });
      }
    }
    // Domains must be unique; explicit ones win, parked ones get a suffix on clash.
    const used = new Set(linked.map((p) => p.domain));
    for (const p of parked) {
      const base = slugify(p.name);
      let domain = `${base}.${tld()}`;
      for (let i = 2; used.has(domain); i++) domain = `${base}-${i}.${tld()}`;
      used.add(domain);
      p.domain = domain;
    }
    this.projects = [...linked, ...parked].sort((a, b) => a.name.localeCompare(b.name));
    for (const p of this.projects) {
      const stack = this.assignPorts(p, this.applyOverrides(p, detectStack(p.path, p.domain)));
      this.stacks.set(p.id, stack);
      this.specFileCache.set(p.id, specFiles(p, stack));
      this.envHints.set(p.id, this.findEnvHints(p, stack));
      this.envOverrides.set(p.id, this.domainOverrides(p, stack));
      this.redisEnv.set(p.id, this.redisOverrides(p, stack));
    }
    this.watchParked();
    this.syncFpm();
    this.updateRoutes();
    this.changed();
  }

  private watchParked(): void {
    for (const w of this.watchers) w.close();
    this.watchers = [];
    let timer: NodeJS.Timeout | null = null;
    for (const dir of store.settings.parkedDirs) {
      try {
        this.watchers.push(
          watch(dir, () => {
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => this.rescan(), 1000);
          }),
        );
      } catch {
        /* folder vanished */
      }
    }
  }

  /** Every site (for the AI features' context). */
  sites(): ProjectConfig[] {
    return this.projects;
  }

  /** Installed runtime versions (DevCatz's own and detected ones), for the AI features. */
  nodeVersions(): string[] {
    return this.installedNodes.map((n) => n.version);
  }
  phpVersions(): string[] {
    return this.installedPhps.map((p) => p.version);
  }
  pythonVersions(): string[] {
    return this.installedPythons.map((p) => p.version);
  }

  find(id: string): ProjectConfig | undefined {
    return this.projects.find((p) => p.id === id);
  }

  private freeDomain(label: string, exceptPath?: string): string {
    const base = slugify(label);
    const taken = new Set(this.projects.filter((p) => p.path !== exceptPath).map((p) => p.domain));
    let domain = `${base}.${tld()}`;
    // Services count too: a folder named gowa must not take gowa.localhost from the WhatsApp gateway.
    const site = this.projects.find((p) => p.path === exceptPath)?.id;
    for (let i = 2; taken.has(domain) || this.domainOwner(domain, site); i++) domain = `${base}-${i}.${tld()}`;
    return domain;
  }

  inspect(path: string): FolderPreview {
    path = resolve(path);
    if (!isLinkableDir(path)) throw new Error('No project in that folder (package.json, composer.json, go.mod, pyproject.toml …), nor project folders inside it');
    const name = basename(path);
    const domain = this.freeDomain(name, path);
    const draft: ProjectConfig = { id: idFor(path), name, path, domain };
    const stack = detectStack(path, domain);
    return {
      path,
      name,
      domain,
      stack,
      autoNode: this.nodeChoice(draft),
      autoGo: this.goChoice(draft, stack),
      autoPhp: this.phpChoice(draft),
      alreadyLinked: store.projects.some((p) => p.path === path),
    };
  }

  link(path: string, opts: LinkOptions = {}): ProjectState | null {
    path = resolve(path);
    if (!isLinkableDir(path)) throw new Error('No project in that folder (package.json, composer.json, go.mod, pyproject.toml …), nor project folders inside it');
    const existing = store.projects.find((p) => p.path === path);
    if (existing) return this.state(existing);
    const name = opts.name?.trim() || basename(path);
    let domain = this.freeDomain(name, path);
    if (opts.domain?.trim()) {
      const label = opts.domain.trim().toLowerCase().replace(new RegExp(`\\.${tld()}$`), '');
      domain = `${slugify(label)}.${tld()}`;
      if (this.projects.some((p) => p.path !== path && p.domain === domain)) throw new Error(`${domain} is already used`);
    }
    const project: ProjectConfig = { id: idFor(path), name, path, domain };
    if (opts.nodeVersion) project.nodeVersion = opts.nodeVersion;
    if (opts.packageManager) project.packageManager = opts.packageManager;
    if (opts.goVersion) project.goVersion = opts.goVersion;
    if (opts.secure === false) project.secure = false;
    if (opts.phpVersion) project.phpVersion = opts.phpVersion;
    if (opts.devCommand?.trim()) project.devCommand = opts.devCommand.trim();
    if (opts.managedPorts === false) project.managedPorts = false;
    if (opts.autoStart) project.autoStart = true;
    store.setProjects([...store.projects, project]);
    this.rescan();
    if (opts.start) this.start(project.id).catch((e) => console.warn(`start ${name}:`, e.message));
    return this.state(this.find(project.id)!);
  }

  async remove(id: string): Promise<void> {
    await this.processes.stop(id);
    // A worktree site removed by hand (its folder kept) is not added back by the automatic adding.
    const wt = this.find(id);
    if (wt?.worktreeOf && existsSync(wt.path) && !store.settings.worktreeIgnore.includes(wt.path)) {
      store.updateSettings({ worktreeIgnore: [...store.settings.worktreeIgnore, wt.path] });
    }
    // A parked project comes back on rescan (with default settings); the UI
    // offers "unpark folder" for those instead.
    store.setProjects(store.projects.filter((x) => x.id !== id));
    this.rescan();
  }

  update(id: string, patch: Partial<Pick<ProjectConfig, 'name' | 'domain' | 'devCommand' | 'autoStart' | 'nodeVersion' | 'managedPorts' | 'packageManager' | 'goVersion' | 'secure' | 'phpVersion' | 'queueWorker' | 'scheduler' | 'reverb' | 'wsServer' | 'wsPath' | 'searchEngine' | 'storageService' | 'envLocked' | 'envDomainOverride' | 'redisDb' | 'redisCacheDb' | 'redisConnDbs' | 'dbService' | 'pythonVersion'>>): void {
    const current = this.find(id);
    if (!current) return;
    if (patch.domain !== undefined) {
      let d = patch.domain.trim().toLowerCase();
      if (!d.endsWith(`.${tld()}`)) d = `${slugify(d)}.${tld()}`;
      const cur = this.find(id);
      if (cur && d !== cur.domain) {
        // The site's apps keep their subdomains under the new domain (admin.<new>): those must be free too.
        const hosts = [d, ...(this.stacks.get(id)?.apps.filter((a) => a.domain && a.domain !== cur.domain && a.domain.endsWith(`.${cur.domain}`)).map((a) => `${a.domain.slice(0, -cur.domain.length)}${d}`) ?? [])];
        for (const h of hosts) {
          const owner = this.domainOwner(h, id);
          if (owner) throw new Error(`${h} is already used by ${owner}`);
        }
      }
      patch.domain = d;
    }
    if (patch.devCommand !== undefined && !patch.devCommand.trim()) patch.devCommand = undefined;
    if (patch.nodeVersion !== undefined && !patch.nodeVersion) patch.nodeVersion = undefined;
    if (patch.managedPorts === true) patch.managedPorts = undefined; // the default
    if (patch.packageManager !== undefined && !patch.packageManager) patch.packageManager = undefined;
    if (patch.goVersion !== undefined && !patch.goVersion) patch.goVersion = undefined;
    if (patch.pythonVersion !== undefined && !patch.pythonVersion) patch.pythonVersion = undefined;
    if (patch.secure === true) patch.secure = undefined; // the default
    if (patch.phpVersion !== undefined && !patch.phpVersion) patch.phpVersion = undefined;
    if (patch.envLocked === true) patch.envLocked = undefined; // locked is the default
    if (patch.envDomainOverride === true) patch.envDomainOverride = undefined; // on by default
    if (patch.dbService !== undefined && !patch.dbService) patch.dbService = undefined;
    if (patch.dbService && !this.dbs.config(patch.dbService)) throw new Error('No such database service');
    // A negative index means "from .env".
    for (const k of ['redisDb', 'redisCacheDb'] as const) {
      const v = patch[k];
      if (v === undefined) continue;
      if (!Number.isInteger(v) || v < 0) patch[k] = undefined;
      else if (v > 255) throw new Error('Redis database index must be 0–255');
    }
    // Per connection: merged into the current map; a negative index means "from .env"; {} clears all.
    if (patch.redisConnDbs !== undefined) {
      const next = Object.keys(patch.redisConnDbs).length ? { ...(current.redisConnDbs ?? {}) } : {};
      for (const [k, v] of Object.entries(patch.redisConnDbs)) {
        if (!/^\w+$/.test(k)) throw new Error(`Invalid env key ${k}`);
        if (!Number.isInteger(v) || v < 0) delete next[k];
        else if (v > 255) throw new Error('Redis database index must be 0–255');
        else next[k] = v;
      }
      patch.redisConnDbs = Object.keys(next).length ? next : undefined;
    }
    const others = store.projects.filter((p) => p.id !== id);
    // Editing a parked project pins its settings as a linked entry.
    store.setProjects([...others, { ...current, ...patch }]);
    this.rescan();
  }

  // ------------------------------------------------------------ Git worktrees

  /** Symlinks resolved (/tmp → /private/tmp …): git reports real paths, sites may be linked through a symlink. */
  private real(path: string): string {
    try {
      return realpathSync(path);
    } catch {
      return resolve(path);
    }
  }

  /** The site a worktree belongs to (the site itself when it is not a worktree). */
  private worktreeParent(p: ProjectConfig): ProjectConfig {
    return (p.worktreeOf && this.find(p.worktreeOf)) || p;
  }

  private async repoTop(p: ProjectConfig): Promise<string> {
    const root = await gitRepoRoot(p.path);
    if (!root) throw new Error(`${p.name} is not in a Git repository`);
    return root;
  }

  /** Every working tree of the site's repository, with the DevCatz site serving each (if any). */
  async worktreeList(id: string): Promise<WorktreeList> {
    const site = this.worktreeParent(this.project(id));
    const root = await this.repoTop(site);
    const rel = relative(this.real(root), this.real(site.path));
    const list = await gitWorktrees(root);
    const main = list.find((w) => w.main)?.path ?? root;
    const real = (path: string) => this.real(path);
    const byPath = new Map(this.projects.map((p) => [real(p.path), p.id]));
    return {
      defaultFolder: join(dirname(main), `${basename(main)}.worktrees`),
      items: list.map((w) => {
        const sitePath = rel ? join(w.path, rel) : w.path;
        return { path: w.path, sitePath, branch: w.branch, head: w.head, main: w.main, locked: w.locked, prunable: w.prunable, siteId: byPath.get(real(sitePath)) ?? null };
      }),
    };
  }

  /** New worktree…: `git worktree add` next to the repository, then a site for it (see worktreeRegister). */
  async worktreeCreate(id: string, o: WorktreeCreateOptions): Promise<string> {
    const parent = this.worktreeParent(this.project(id));
    const root = await this.repoTop(parent);
    const branch = o.create ? await gitCheckRefName(root, o.branch) : o.branch.trim();
    if (!branch) throw new Error('Choose a branch');
    const { defaultFolder } = await this.worktreeList(parent.id);
    const folder = o.folder?.trim() ? resolve(o.folder.trim()) : defaultFolder;
    const dest = join(folder, branchLabel(branch));
    this.processes.log(parent.id, 'sys', `git worktree add ${dest} (${o.create ? `new branch ${branch}${o.from ? ` from ${o.from}` : ''}` : branch})`);
    await gitWorktreeAdd(root, dest, branch, o.create, o.from?.trim() || undefined);
    const rel = relative(this.real(root), this.real(parent.path));
    return this.worktreeRegister(parent, rel ? join(dest, rel) : dest, branch, o.deps, o.database);
  }

  /** "Add as site" for a worktree made outside DevCatz. */
  async worktreeAdd(id: string, sitePath: string): Promise<string> {
    const parent = this.worktreeParent(this.project(id));
    const w = (await this.worktreeList(parent.id)).items.find((x) => this.real(x.sitePath) === this.real(sitePath));
    if (!w) throw new Error(`${sitePath} is not a worktree of ${parent.name}`);
    if (w.siteId) return w.siteId;
    if (store.settings.worktreeIgnore.includes(w.sitePath)) store.updateSettings({ worktreeIgnore: store.settings.worktreeIgnore.filter((x) => x !== w.sitePath) });
    return this.worktreeRegister(parent, w.sitePath, w.branch ?? basename(w.path), 'clone', 'shared');
  }

  /**
   * A worktree becomes a child site of `parent`: `<branch>.<parent domain>`, its own managed ports, the
   * parent's settings (runtime versions, database service, Redis, WebSocket / search / storage targets) but not
   * its background workers (queue, scheduler, Reverb: with a shared database / Redis they would run jobs twice).
   * Then what Git does not bring: the .env files (domain rewritten), dependencies, optionally a database copy.
   */
  private async worktreeRegister(parent: ProjectConfig, sitePath: string, branch: string, deps: WorktreeCreateOptions['deps'], database: WorktreeCreateOptions['database']): Promise<string> {
    const existing = store.projects.find((p) => this.real(p.path) === this.real(sitePath));
    if (existing) return existing.id;
    if (this.real(sitePath) === this.real(parent.path)) throw new Error(`${sitePath} is ${parent.name} itself`);
    if (!isProjectDir(sitePath)) throw new Error(`${sitePath} has no project files (package.json, composer.json, go.mod …)`);
    const label = branchLabel(branch);
    const taken = new Set(this.projects.flatMap((p) => [p.domain, ...(this.stacks.get(p.id)?.apps.map((a) => a.domain) ?? [])]));
    let domain = `${label}.${parent.domain}`;
    for (let i = 2; taken.has(domain) || this.domainOwner(domain); i++) domain = `${label}-${i}.${parent.domain}`;
    const KEEP = ['nodeVersion', 'packageManager', 'goVersion', 'secure', 'phpVersion', 'devCommand', 'managedPorts', 'pythonVersion', 'envDomainOverride', 'envLocked', 'dbService', 'wsServer', 'wsPath', 'searchEngine', 'storageService', 'redisDb', 'redisCacheDb', 'redisConnDbs'] as const;
    const project: ProjectConfig = { id: idFor(sitePath), name: `${parent.name} · ${branch}`, path: sitePath, domain, worktreeOf: parent.id };
    for (const k of KEEP) if (parent[k] !== undefined) (project as unknown as Record<string, unknown>)[k] = parent[k];
    const id = project.id;
    const parentStack = this.stacks.get(parent.id);
    const dirs = (parentStack?.apps ?? []).map((a) => a.dir);
    // .env first, so the first detection already sees the worktree's own values.
    const envFiles = copyEnvFiles(parent.path, sitePath, dirs, parent.domain, domain);
    store.setProjects([...store.projects, project]);
    // Right under its parent in the drag-and-drop order.
    const order = store.settings.siteOrder.filter((x) => x !== id);
    const at = order.indexOf(parent.id);
    if (at >= 0) store.updateSettings({ siteOrder: [...order.slice(0, at + 1), id, ...order.slice(at + 1)] });
    this.rescan();
    const log = (t: string) => this.processes.log(id, 'sys', t);
    log(`Worktree of ${parent.name} on branch ${branch}: ${this.urlFor(project)}`);
    if (envFiles.length) log(`Copied from ${parent.name} with the domain changed to ${domain}: ${envFiles.join(', ')}`);
    if (database === 'copy') {
      try {
        await this.worktreeCopyDb(parent, id, branch, envFiles);
      } catch (e) {
        log(`Database copy failed, the worktree uses ${parent.name}'s database: ${(e as Error).message}`);
      }
    }
    if (deps !== 'none') {
      const runtime = this.stacks.get(id)?.runtime;
      let install = deps === 'install' || runtime === 'python';
      if (!install) {
        try {
          const cloned = await cloneDeps(parent.path, sitePath, dirs);
          if (cloned.length) log(`Cloned from ${parent.name} (copy-on-write, no extra disk until files change): ${cloned.join(', ')}`);
        } catch (e) {
          log(`${(e as Error).message}; installing instead.`);
          install = true;
        }
      }
      if (install) await this.installDeps(id).catch((e) => log(`Installing dependencies failed: ${(e as Error).message}`));
    }
    this.rescan();
    return id;
  }

  /** The worktree's own database: a copy of the parent's, named after the branch, with its .env pointed at it. */
  private async worktreeCopyDb(parent: ProjectConfig, id: string, branch: string, envFiles: string[]): Promise<void> {
    const wt = this.project(id);
    const db = this.stacks.get(parent.id)?.database;
    const log = (t: string) => this.processes.log(id, 'sys', t);
    // SQLite inside the project (Laravel's database/database.sqlite): the file is gitignored, so copy it.
    if (db?.engine === 'sqlite' || (!db?.database && existsSync(join(parent.path, 'database/database.sqlite')))) {
      const file = db?.database ? resolve(parent.path, db.database) : join(parent.path, 'database/database.sqlite');
      const rel = relative(parent.path, file);
      if (rel.startsWith('..')) throw new Error(`${file} is outside the site: share it or copy it by hand`);
      if (copyLocalFile(parent.path, wt.path, rel)) log(`Copied ${rel} from ${parent.name}`);
      if (db?.database && isAbsolute(db.database)) rewriteEnvDb(wt.path, envFiles, db.database, join(wt.path, rel));
      return;
    }
    if (!db?.database) throw new Error(`${parent.name} has no database name in its .env`);
    if (!parent.dbService) throw new Error(`link ${parent.name} to a DevCatz database service first (its Database tab)`);
    const to = copyName(db.database, branch);
    log(`Copying database ${db.database} → ${to} …`);
    await this.dbs.copyDatabase(parent.dbService, db.database, to);
    const changed = rewriteEnvDb(wt.path, envFiles, db.database, to);
    store.setProjects(store.projects.map((p) => (p.id === id ? { ...p, worktreeDb: to } : p)));
    log(`Database ${to} is the worktree's own copy${changed.length ? ` (${changed.join(', ')} updated)` : ''}.`);
    this.rescan();
    // The branch's own migrations on its copy.
    if (this.stacks.get(id)?.apps.some((a) => a.framework === 'laravel')) await this.db(id, 'artisan-migrate').catch((e) => log(`Migrations: ${(e as Error).message}`));
  }

  /** What removing the worktree would lose. */
  async worktreeCheck(id: string): Promise<WorktreeCheck> {
    const p = this.project(id);
    if (!p.worktreeOf) throw new Error(`${p.name} is not a worktree`);
    const s = await gitSummary(p.path).catch(() => null);
    return { branch: s?.branch ?? null, changed: s?.changed ?? 0, unpushed: await gitUnpushed(p.path).catch(() => 0), database: p.worktreeDb ?? null };
  }

  /** Remove worktree: stops it, `git worktree remove` (force throws changes away), the site goes, optionally its database. */
  async worktreeRemove(id: string, force: boolean, dropDatabase: boolean): Promise<void> {
    const p = this.project(id);
    if (!p.worktreeOf) throw new Error(`${p.name} is not a worktree`);
    const top = await this.repoTop(p);
    // Run from the main working tree: the worktree being removed cannot be the current directory.
    const common = resolve(top, (await gitOk(top, ['rev-parse', '--git-common-dir'])).trim());
    const mainTree = basename(common) === '.git' ? dirname(common) : common;
    await this.processes.stop(id);
    await gitWorktreeRemove(mainTree, top, force);
    if (dropDatabase && p.worktreeDb && p.dbService) {
      await this.dbs.dropDatabase(p.dbService, p.worktreeDb).catch((e) => this.processes.log(p.worktreeOf!, 'sys', `Dropping ${p.worktreeDb} failed: ${(e as Error).message}`));
    }
    store.setProjects(store.projects.filter((x) => x.id !== id));
    store.updateSettings({ siteOrder: store.settings.siteOrder.filter((x) => x !== id), favorites: store.settings.favorites.filter((x) => x !== id) });
    this.rescan();
  }

  /** Forgets worktrees whose folder is gone. */
  async worktreePrune(id: string): Promise<void> {
    await gitWorktreePrune(await this.repoTop(this.worktreeParent(this.project(id))));
  }

  /** Settings → "Add worktrees as sites automatically": new worktrees of every site (Claude Code, agents …) become sites. */
  private autoAdding = false;
  private async autoAddWorktrees(): Promise<void> {
    if (!store.settings.worktreeAutoAdd || this.autoAdding) return;
    this.autoAdding = true;
    try {
      for (const site of this.projects.filter((p) => !p.worktreeOf && this.git.summaries.get(p.id))) {
        const list = await this.worktreeList(site.id).catch(() => null);
        for (const w of list?.items ?? []) {
          if (w.main || w.siteId || w.prunable || w.locked || store.settings.worktreeIgnore.includes(w.sitePath) || !isProjectDir(w.sitePath)) continue;
          try {
            const id = await this.worktreeRegister(site, w.sitePath, w.branch ?? basename(w.path), 'clone', 'shared');
            const added = this.find(id);
            if (added) this.notifyHook(`New worktree: ${added.name}`, `Added as a site: ${this.urlFor(added)}`);
          } catch (e) {
            console.warn(`worktree ${w.path}:`, (e as Error).message);
          }
        }
      }
    } finally {
      this.autoAdding = false;
    }
  }

  park(dir: string): void {
    if (!store.settings.parkedDirs.includes(dir)) store.updateSettings({ parkedDirs: [...store.settings.parkedDirs, dir] });
    this.rescan();
  }

  unpark(dir: string): void {
    store.updateSettings({ parkedDirs: store.settings.parkedDirs.filter((d) => d !== dir) });
    this.rescan();
  }

  // ------------------------------------------------------------ dev servers

  async start(id: string): Promise<void> {
    if (this.launching.has(id)) return;
    this.launching.add(id);
    const apps = this.stacks.get(id)?.apps ?? [];
    this.launchState.set(id, { building: null, apps: Object.fromEntries(apps.map((a) => [a.dir, 'waiting' as const])) });
    this.changed();
    try {
      await this.launch(id);
      // For Free up space ("not run for 30 days"); saved without a rescan.
      store.setProjects(store.projects.map((x) => (x.id === id ? { ...x, lastStarted: new Date().toISOString() } : x)));
      // Once it is up, ask its apps for their OpenAPI document (bridge.json → DialCatz imports the routes).
      setTimeout(() => void this.siteOpenApi(id, true).catch(() => undefined), 8000);
    } finally {
      this.launching.delete(id);
      // Failed before anything ran, or a PHP site (served already): nothing is starting.
      if (this.processes.getStatus(id).status !== 'starting') this.launchState.delete(id);
      this.changed();
    }
  }

  /** Apps of a starting site that are launched now (their ports are polled from here on). */
  private launched(id: string, dirs: string[]): void {
    const s = this.launchState.get(id);
    if (!s) return;
    s.building = null;
    for (const d of dirs) s.apps[d] = 'starting';
    this.changed();
  }

  private async launch(id: string): Promise<void> {
    const p = this.find(id);
    const stack = this.stacks.get(id);
    if (!p || !stack || this.processes.isActive(id)) return;
    // The site's database service comes up with it.
    if (p.dbService && this.dbs.config(p.dbService) && !this.dbs.isActive(p.dbService)) {
      await this.dbs.action(p.dbService, 'start').catch((e: Error) => this.processes.log(id, 'sys', `Database service: ${e.message}`));
    }
    if (stack.runtime === 'php') return this.launchPhp(p, stack);
    const command = p.devCommand || stack.devCommand;
    if (!command) {
      this.processes.log(id, 'sys', 'No dev command found. Set one in the project settings.');
      throw new Error('No dev command found. Set one in the project settings.');
    }
    if (stack.depsMissing) {
      const msg =
        stack.runtime === 'python'
          ? 'No virtualenv yet (.venv): use "Install dependencies" first (uv creates it and installs the packages).'
          : stack.layout === 'folders'
            ? `${stack.warnings.find((w) => w.startsWith('Dependencies missing')) ?? 'Dependencies are missing in some folders.'} It installs every folder's (npm / composer / uv / go).`
            : `Dependencies are not installed (node_modules is empty). Use "Install dependencies" (${stack.packageManager} install) first.`;
      this.processes.log(id, 'sys', msg);
      throw new Error(msg);
    }
    // A managed port taken by some other program: move that app to a free one.
    if (await this.reassignBusyPorts(p, stack)) return this.launch(id);
    // Another process (a terminal, another copy of the project) already owns a
    // port: starting anyway would crash half of the stack with EADDRINUSE.
    for (const app of stack.apps) {
      if (app.port && (await isPortOpen(app.port))) {
        const owner = await portOwner(app.port);
        const msg = `Port ${app.port} (${app.name}) is already in use${owner ? ` by ${owner}` : ''}. Stop that process first.`;
        this.processes.log(id, 'sys', msg);
        throw new Error(msg);
      }
    }
    if (stack.runtime === 'python') {
      const py = this.pythonChoice(p, stack);
      this.processes.log(id, 'sys', `Using Python ${py.version ?? '?'} (${py.reason === 'venv' ? `${stack.python?.venv}` : py.reason})`);
    } else {
      const node = this.nodeChoice(p);
      // Nothing to run npm / pnpm / yarn with: say so instead of "npm: command not found".
      if (!node.version && stack.runtime === 'node' && stack.packageManager !== 'bun') {
        this.processes.log(id, 'sys', NO_NODE);
        throw new Error(NO_NODE);
      }
      if (node.missing) this.processes.log(id, 'sys', `Node ${node.spec} (from the project) is not installed; install it under Node.js.`);
      if (node.version) this.processes.log(id, 'sys', `Using Node ${node.version} (${node.reason})`);
    }
    if (this.hasGo(p)) {
      const go = this.goChoice(p);
      if (!go.binDir) {
        const msg = 'Go is not installed. Install it on the Go page (sidebar), then Start again.';
        this.processes.log(id, 'sys', msg);
        throw new Error(msg);
      }
      if (go.missing && go.spec) this.processes.log(id, 'sys', `go.mod asks for Go ${go.spec}; only ${go.version} is installed.`);
      this.processes.log(id, 'sys', `Using Go ${go.version} (${go.reason})`);
    }
    if (this.hasRust(p)) {
      const rust = this.rustChoice(p, stack);
      const fail = (msg: string): never => {
        this.processes.log(id, 'sys', msg);
        throw new Error(msg);
      };
      if (!this.rustupVer) fail('Rust is not installed. Install it on the Rust page (sidebar), then Start again.');
      if (this.rustLinkerMissing) fail('Rust needs the Xcode Command Line Tools to link: run “xcode-select --install” in Terminal, then Start again.');
      if (rust.needs.length) fail(`This site also needs ${rust.needs.map((n) => RUST_NEED_LABEL[n]).join(', ')}: install ${rust.needs.length > 1 ? 'them' : 'it'} on the site's Overview or the Rust page, then Start again.`);
      this.processes.log(id, 'sys', `Using Rust ${rust.version ?? '?'} (${rust.toolchain ?? 'default'}${rust.reason === 'project' ? ', from rust-toolchain.toml' : ''})`);
    }
    if (stack.packageManager === 'bun') {
      const bun = this.bunChoice(p);
      if (!bun.binDir) {
        const msg = 'Bun is not installed. Install it on the Bun page (sidebar), then Start again.';
        this.processes.log(id, 'sys', msg);
        throw new Error(msg);
      }
      if (bun.missing && bun.spec) this.processes.log(id, 'sys', `The project pins Bun ${bun.spec}, which is not installed; using ${bun.version}.`);
      this.processes.log(id, 'sys', `Using Bun ${bun.version} (${bun.reason})`);
    }
    const base = this.runtimeEnv(p);
    const perApp = this.perAppMode(p, stack) && (stack.layout === 'folders' || stack.apps.some((a) => a.managedPort));
    const ports = this.portEnv(p, stack, perApp);
    if (ports.summary) this.processes.log(id, 'sys', ports.summary);
    const celery = stack.runtime === 'python' ? stack.python?.celery : null;
    if (!perApp && celery && (p.queueWorker || p.scheduler)) {
      // Python + Celery: the web server plus the worker / beat the site's switches ask for.
      const env = { ...base, ...ports.shared, ...Object.assign({}, ...ports.apps.values()) };
      this.processes.startMany(id, [
        { label: 'web', cwd: p.path, command, env },
        ...(p.queueWorker ? [{ label: 'worker', cwd: p.path, command: `python -m celery -A ${celery} worker -l info`, env }] : []),
        ...(p.scheduler ? [{ label: 'beat', cwd: p.path, command: `python -m celery -A ${celery} beat -l info`, env }] : []),
      ]);
    } else if (!perApp) {
      const env = { ...base, ...ports.shared, ...Object.assign({}, ...ports.apps.values()) };
      // A single Astro / Vite app reads no port variable: its managed port goes on the command line, so worktrees
      // and copies of one site run side by side.
      const only = stack.apps.length === 1 ? stack.apps[0] : null;
      const run = !p.devCommand && only?.managedPort && only.flagCommand && only.port ? only.flagCommand.replace('{port}', String(only.port)) : command;
      this.processes.start(id, p.path, run, env);
    } else {
      const pm = stack.packageManager ?? 'npm';
      // Like turbo's `dependsOn: ^build`: build shared packages before the apps import them.
      for (const lib of stack.libs.filter((l) => l.build)) {
        const ls = this.launchState.get(id);
        if (ls) {
          ls.building = lib.name;
          this.changed();
        }
        const code = await stream(join(p.path, lib.dir), runScriptCommand(pm, 'build'), (t) => this.processes.log(id, 'sys', t.replace(/^(?=.)/gm, `[${lib.name}] `)), base);
        if (code !== 0) throw new Error(`Building ${lib.name} failed (exit ${code}); see the log`);
      }
      // The root's own app: `api` beside its folders (a Go API next to admin/), else the site's folder name.
      const label = (dir: string) => (dir !== '.' ? basename(dir) : stack.layout === 'folders' ? 'api' : basename(p.path));
      this.processes.startMany(id, [
        ...stack.libs
          .filter((l) => l.dev)
          .map((l) => ({ label: label(l.dir), cwd: join(p.path, l.dir), command: runScriptCommand(pm, 'dev'), env: base })),
        ...stack.apps.map((a) => ({
          label: label(a.dir),
          cwd: join(p.path, a.dir),
          // An app that reads no port variable gets its managed port on the command line (Vite, Astro …).
          command: a.managedPort && a.flagCommand && a.port ? a.flagCommand.replace('{port}', String(a.port)) : (a.command ?? runScriptCommand(pm, 'dev')),
          env: { ...base, ...ports.shared, ...(ports.apps.get(a.dir) ?? {}) },
        })),
      ]);
    }
    this.launched(id, stack.apps.map((a) => a.dir));
    // No port to wait for (a CLI, Burn / Candle, a Bevy game): it runs as soon as it is spawned and stops by itself.
    if (stack.apps.every((a) => a.kind === 'assets' || !a.port)) {
      this.processes.markRunning(id);
      this.processes.log(id, 'sys', 'This app is not a server (no port): its output appears here, and it stops by itself when it is done. The first run compiles it.');
    }
    this.updateRoutes();
  }

  // ------------------------------------------------------------ free up space (TODO §30)

  private depsCache = new Map<string, { at: number; info: SiteDeps }>();

  /** A site's dependency folders, measured with du (cached for 10 minutes). */
  async siteDeps(id: string, fresh = false): Promise<SiteDeps> {
    const p = this.project(id);
    const hit = this.depsCache.get(id);
    if (!fresh && hit && Date.now() - hit.at < 10 * 60_000) return { ...hit.info, running: this.processes.isActive(id) };
    const list = depFolders(p, this.stacks.get(id));
    const folders: DepFolder[] = [];
    for (const f of list) folders.push({ path: f.rel, kind: f.kind, bytes: await sizeOf(f.abs) });
    folders.sort((a, b) => b.bytes - a.bytes);
    const started = p.lastStarted ? Date.parse(p.lastStarted) : null;
    const info: SiteDeps = {
      siteId: id,
      name: p.name,
      folders,
      bytes: folders.reduce((n, f) => n + f.bytes, 0),
      lastStarted: started,
      lastUsed: Math.max(started ?? 0, lastActivity(p) ?? 0) || null,
      running: this.processes.isActive(id),
    };
    this.depsCache.set(id, { at: Date.now(), info });
    return info;
  }

  /** Every site (worktrees too), three measured at a time. */
  async depsReport(fresh = false): Promise<SiteDeps[]> {
    const ids = this.projects.map((p) => p.id);
    const out: SiteDeps[] = [];
    for (let i = 0; i < ids.length; i += 3) out.push(...(await Promise.all(ids.slice(i, i + 3).map((id) => this.siteDeps(id, fresh).catch(() => null)))).filter((x): x is SiteDeps => x !== null));
    return out.sort((a, b) => b.bytes - a.bytes);
  }

  /**
   * Moves dependency folders of a stopped site to the Trash (recoverable). Every path must be one DevCatz lists for
   * that site right now — a real folder inside the project, never a symlink — or nothing is moved.
   */
  async freeDeps(id: string, paths: string[]): Promise<number> {
    const p = this.project(id);
    if (this.processes.isActive(id)) throw new Error(`Stop ${p.name} first`);
    if (this.dbTasks.has(id)) throw new Error(`Busy: ${this.dbTasks.get(id)}`);
    const allowed = depFolders(p, this.stacks.get(id));
    const picked = paths.map((rel) => allowed.find((a) => a.rel === rel));
    if (!paths.length || picked.some((x) => !x)) throw new Error('Only the dependency folders DevCatz lists can be removed');
    let freed = 0;
    for (const f of picked as { abs: string; rel: string }[]) {
      if (!isRealDirInside(f.abs, p.path)) throw new Error(`${f.rel} is not a folder inside the project`);
      const bytes = await sizeOf(f.abs);
      await shell.trashItem(f.abs);
      freed += bytes;
      this.processes.log(id, 'sys', `Free up space: ${f.rel} moved to the Trash (${Math.round(bytes / 1048576)} MB); "Install dependencies" brings it back.`);
    }
    this.depsCache.delete(id);
    this.rescan();
    return freed;
  }

  /**
   * Settings → Apps: the subdomains the user picked for a monorepo / folder site's apps. An app moved onto the site's
   * own domain pushes the app that had it to `<its folder>.<domain>`; a pick that would give two apps one domain is
   * left out (the default stays).
   */
  private applyAppDomains(p: ProjectConfig, stack: StackInfo): void {
    const subs = p.appSubdomains;
    const apps = stack.apps.filter((a) => a.domain);
    if (!subs || apps.length < 2) return;
    const want = new Map(apps.map((a) => [a.dir, a.dir in subs ? (subs[a.dir] ? `${subs[a.dir]}.${p.domain}` : p.domain) : a.domain]));
    const bareTaken = apps.some((a) => a.dir in subs && want.get(a.dir) === p.domain);
    for (const a of apps) if (bareTaken && !(a.dir in subs) && want.get(a.dir) === p.domain) want.set(a.dir, `${a.dir === '.' ? (stack.layout === 'folders' ? 'api' : slugify(basename(p.path))) : slugify(basename(a.dir))}.${p.domain}`);
    const count = new Map<string, number>();
    for (const d of want.values()) count.set(d, (count.get(d) ?? 0) + 1);
    for (const a of apps) {
      const d = want.get(a.dir)!;
      if (count.get(d) === 1) a.domain = d;
    }
  }

  /** Settings → Apps: one app's subdomain ('' = the site's own domain, null = back to the default). */
  async setAppSubdomain(id: string, dir: string, sub: string | null): Promise<void> {
    const p = this.project(id);
    const app = this.stacks.get(id)?.apps.find((a) => a.dir === dir && a.domain);
    if (!app) throw new Error('No such app');
    const next = { ...(p.appSubdomains ?? {}) };
    if (sub === null) delete next[dir];
    else {
      const s = sub.trim().toLowerCase();
      if (s && !/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/.test(s)) throw new Error('A subdomain is letters, digits and dashes (e.g. admin or api.v2)');
      const domain = s ? `${s}.${p.domain}` : p.domain;
      const sameSite = this.stacks.get(id)!.apps.find((a) => a.dir !== dir && a.domain === domain && !(s === '' && !(a.dir in next)));
      if (sameSite) throw new Error(`${sameSite.name} already uses ${domain}`);
      const owner = this.domainOwner(domain, id);
      if (owner) throw new Error(`${domain} is already used by ${owner}`);
      next[dir] = s;
    }
    store.setProjects(store.projects.map((x) => (x.id === id ? { ...x, appSubdomains: Object.keys(next).length ? next : undefined } : x)));
    this.rescan();
  }

  // ------------------------------------------------------------ .gitignore (Git tab)

  /** The .gitignore of the site's repository (its root, like the Git tab's other actions), and a starting one for its stack. */
  async gitignoreRead(id: string): Promise<{ exists: boolean; content: string; suggested: string }> {
    const p = this.project(id);
    const file = join((await gitRepoRoot(p.path)) ?? p.path, '.gitignore');
    const exists = existsSync(file);
    return { exists, content: exists ? readFileSync(file, 'utf8') : '', suggested: gitignoreFor(this.stacks.get(id)) };
  }

  async gitignoreSave(id: string, content: string): Promise<void> {
    const p = this.project(id);
    writeFileSync(join((await gitRepoRoot(p.path)) ?? p.path, '.gitignore'), content.endsWith('\n') || !content ? content : `${content}\n`);
    this.processes.log(id, 'sys', '.gitignore saved');
    void this.git.refresh(id);
  }

  // ------------------------------------------------------------ OpenAPI and DevCatz/bridge.json (for DialCatz)

  /** OpenAPI URLs the sites' running apps answered with, by site (kept until the next probe). */
  private openapiUrls = new Map<string, { app: string; url: string }[]>();

  /** Where a site's OpenAPI document is; `probe` asks its running apps (each app's own port, so subdomains count). */
  async siteOpenApi(id: string, probe = false): Promise<SiteOpenApi> {
    const p = this.project(id);
    const stack = this.stacks.get(id);
    const running = this.processes.isActive(id) || stack?.runtime === 'php';
    if (probe && running && stack) {
      const urls: { app: string; url: string }[] = [];
      for (const a of stack.apps.filter((x) => x.port && x.domain && x.kind !== 'assets')) {
        const path = await probeOpenApi(a.port!);
        if (path) urls.push({ app: a.dir, url: `${this.urlFor(p, a.domain)}${path}` });
      }
      this.openapiUrls.set(id, urls);
      this.changed();
    }
    const specs: SiteOpenApi['specs'] = [...specFiles(p, stack).map((f) => ({ app: f.app, file: f.file })), ...(this.openapiUrls.get(id) ?? [])];
    const fw = new Set(stack?.apps.map((a) => a.framework) ?? []);
    const has = (f: string) => existsSync(join(p.path, f));
    const composer = has('composer.json') ? readFileSync(join(p.path, 'composer.json'), 'utf8') : '';
    let install: SiteOpenApi['install'] = null;
    let hint: string | null = null;
    if (!specs.length) {
      if (fw.has('laravel') && !/dedoc\/scramble/.test(composer)) install = 'scramble';
      else if (fw.has('nestjs')) install = 'nest-swagger';
      else if (fw.has('laravel')) hint = 'Scramble is installed: start the site and its document is served at /docs/api.json (local environment).';
      else if (fw.has('fastapi')) hint = 'FastAPI serves /openapi.json by itself: start the site and look again.';
      else if (fw.has('go')) hint = 'Go: `swag init` (github.com/swaggo/swag) writes docs/swagger.json from your handler comments.';
      else if (fw.has('rust')) hint = 'Rust: utoipa (Axum, Actix Web, Rocket), poem-openapi or aide describe your handlers; serve the document at /openapi.json or save it as openapi.json.';
      else if (fw.has('express') || fw.has('node')) hint = 'Express & co.: put an openapi.yaml / swagger.json in the project (or serve one with swagger-jsdoc); DevCatz finds it.';
      else hint = 'Put an openapi.yaml or swagger.json in the project, or serve one at /openapi.json; DevCatz finds either.';
    }
    return { specs, install, hint, probed: probe && running };
  }

  /** A starter OpenAPI 3 document in an app's folder, for stacks without a generator (or before one is added). */
  async createOpenApi(id: string, format: 'yaml' | 'json', appDir?: string): Promise<string> {
    const p = this.project(id);
    const stack = this.stacks.get(id);
    const apps = (stack?.apps ?? []).filter((a) => a.kind !== 'assets');
    const app = apps.find((a) => a.dir === appDir) ?? apps.find((a) => a.domain) ?? apps[0];
    const dir = join(p.path, !app || app.dir === '.' ? '' : app.dir);
    if (relative(p.path, dir).startsWith('..')) throw new Error('Unknown app');
    const file = join(dir, format === 'yaml' ? 'openapi.yaml' : 'swagger.json');
    if (existsSync(file)) throw new Error(`${relative(p.path, file)} already exists`);
    const pkg = readJson<PackageJson & { version?: string }>(join(dir, 'package.json'));
    const composer = readJson<{ name?: string; version?: string; description?: string }>(join(dir, 'composer.json'));
    const title = pkg?.name ?? composer?.name ?? app?.name ?? p.name;
    const version = pkg?.version ?? composer?.version ?? '1.0.0';
    const server = this.urlFor(p, app?.domain || undefined);
    const doc = {
      openapi: '3.0.3',
      info: { title, version, description: `API of ${p.name}. Describe each route under paths; DialCatz imports them from this file.` },
      servers: [{ url: server, description: 'Local (DevCatz)' }],
      paths: {
        '/health': {
          get: {
            summary: 'Health check (an example: replace it with your routes)',
            operationId: 'health',
            responses: { '200': { description: 'OK', content: { 'application/json': { schema: { type: 'object', properties: { status: { type: 'string', example: 'ok' } } } } } } },
          },
        },
      },
      components: { schemas: {}, securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } } },
    };
    writeFileSync(file, format === 'yaml' ? `# OpenAPI document of ${p.name} (created by DevCatz). DialCatz imports its routes.\n${toYaml(doc)}` : `${JSON.stringify(doc, null, 2)}\n`);
    this.processes.log(id, 'sys', `[openapi] created ${relative(p.path, file)}`);
    this.changed();
    return file;
  }

  /**
   * Adds an OpenAPI generator: Scramble for Laravel (`composer require dedoc/scramble --dev`, serves /docs/api.json
   * in the local environment) or @nestjs/swagger for NestJS (the package, and three lines in src/main.ts before
   * `app.listen` that serve the document at /docs-json). Output in the site's log.
   */
  async addOpenApi(id: string, kind: 'scramble' | 'nest-swagger'): Promise<void> {
    const p = this.project(id);
    const stack = this.stacks.get(id);
    if (this.dbTasks.has(id)) throw new Error(`Busy: ${this.dbTasks.get(id)}`);
    const log = (t: string) => this.processes.log(id, 'sys', t.replace(/^(?=.)/gm, '[openapi] '));
    this.dbTasks.set(id, 'adding OpenAPI');
    this.changed();
    try {
      if (kind === 'scramble') {
        const app = stack?.apps.find((a) => a.framework === 'laravel');
        if (!app) throw new Error('Not a Laravel site');
        const code = await stream(join(p.path, app.dir === '.' ? '' : app.dir), 'composer require dedoc/scramble --dev --no-interaction', log, this.runtimeEnv(p));
        if (code !== 0) throw new Error('composer require dedoc/scramble failed; see Logs');
        log('Scramble serves the document at /docs/api.json and its viewer at /docs/api (local environment).');
      } else {
        const app = stack?.apps.find((a) => a.framework === 'nestjs');
        if (!app) throw new Error('Not a NestJS site');
        const dir = join(p.path, app.dir);
        const mainFile = join(dir, 'src/main.ts');
        if (!existsSync(mainFile)) throw new Error('src/main.ts not found');
        const src = readFileSync(mainFile, 'utf8');
        const appVar = src.match(/(?:const|let)\s+(\w+)\s*=\s*await\s+NestFactory\.create/)?.[1];
        const listen = appVar ? src.search(new RegExp(`^[ \\t]*await\\s+${appVar}\\.listen\\(`, 'm')) : -1;
        if (!appVar || listen < 0) throw new Error('Could not find NestFactory.create and app.listen in src/main.ts: add SwaggerModule by hand (docs.nestjs.com/openapi/introduction)');
        const pm = detectPackageManager(dir, readJson<PackageJson>(join(dir, 'package.json')));
        const code = await stream(dir, `${pm === 'npm' ? 'npm install' : `${pm} add`} @nestjs/swagger`, log, this.runtimeEnv(p));
        if (code !== 0) throw new Error('Installing @nestjs/swagger failed; see Logs');
        if (!/SwaggerModule/.test(src)) {
          const indent = src.slice(listen).match(/^[ \t]*/)?.[0] ?? '  ';
          const block = [
            `${indent}// OpenAPI document at /docs-json and its viewer at /docs (added by DevCatz for DialCatz).`,
            `${indent}const { SwaggerModule, DocumentBuilder } = await import('@nestjs/swagger');`,
            `${indent}SwaggerModule.setup('docs', ${appVar}, SwaggerModule.createDocument(${appVar}, new DocumentBuilder().setTitle('API').build()));`,
            '',
          ].join('\n');
          writeFileSync(mainFile, src.slice(0, listen) + block + src.slice(listen));
          log(`src/main.ts: SwaggerModule set up before ${appVar}.listen (document at /docs-json).`);
        }
      }
      this.rescan();
    } finally {
      this.dbTasks.delete(id);
      this.changed();
    }
  }

  /** DevCatz/bridge.json: the sites, their apps and OpenAPI documents, for DialCatz (and the other Catzoid apps). */
  private publishBridge(): void {
    const sites: BridgeSite[] = this.projects.map((p) => {
      const stack = this.stacks.get(p.id);
      return {
        id: p.id,
        name: p.name,
        domain: p.domain,
        url: this.urlFor(p),
        path: p.path,
        ...(p.worktreeOf ? { worktreeOf: p.worktreeOf } : {}),
        running: this.processes.isActive(p.id),
        apps: (stack?.apps ?? []).map((a) => ({ dir: a.dir, name: a.name, framework: a.framework, kind: a.kind, domain: a.domain, url: a.domain ? this.urlFor(p, a.domain) : null, port: a.port })),
        openapi: [...(this.specFileCache.get(p.id) ?? []), ...(this.openapiUrls.get(p.id) ?? [])],
      };
    });
    writeBridge(sites);
  }

  /** A spec file DevCatz found for this site (Overview → API → Show in Finder only reveals those). */
  isSpecFile(id: string, file: string): boolean {
    return (this.specFileCache.get(id) ?? []).some((f) => f.file === file);
  }

  /** Spec files per site, found on rescan (a walk of three levels is too slow for every change). */
  private specFileCache = new Map<string, { app: string; file: string }[]>();

  // ------------------------------------------------------------ Build (header → Build ▾)

  /**
   * What Build runs: each app's own build — its package.json "build" script with the package manager of its
   * folder, a Go module's `go build` into bin/ — and, when there are several, "all" (the root build script when
   * the project has one, else every target in turn). PHP sites build their front-end assets (Vite / Mix).
   */
  buildTargets(id: string): BuildTarget[] {
    const p = this.project(id);
    const stack = this.stacks.get(id);
    if (!stack) return [];
    const targets: BuildTarget[] = [];
    const seen = new Set<string>();
    const jsBuild = (dir: string, label: string) => {
      const abs = join(p.path, dir);
      const pkg = readJson<PackageJson>(join(abs, 'package.json'));
      if (!pkg?.scripts?.build || seen.has(dir)) return;
      // A folder project's folders have their own package manager; a workspace's apps use the root one.
      const pm = stack.layout === 'folders' ? detectPackageManager(abs, pkg) : (stack.packageManager ?? detectPackageManager(abs, pkg));
      seen.add(dir);
      targets.push({ id: dir, label, command: runScriptCommand(pm, 'build'), cwd: dir });
    };
    for (const a of stack.apps) {
      if (a.framework === 'go') {
        if (seen.has(a.dir)) continue;
        const target = a.command?.match(/go run (\S+)/)?.[1] ?? '.';
        const bin = slugify(basename(a.dir === '.' ? p.path : a.dir));
        seen.add(a.dir);
        targets.push({ id: a.dir, label: a.dir === '.' ? `${a.name} (go build)` : a.dir, command: `go build -o bin/${bin} ${target}`, cwd: a.dir });
      } else if (a.framework === 'rust') {
        if (seen.has(a.dir)) continue;
        seen.add(a.dir);
        const cmd = a.command ?? '';
        const command = /(^|\s)anchor /.test(cmd)
          ? 'anchor build'
          : cmd.startsWith('cargo tauri')
            ? 'cargo tauri build'
            : cmd.startsWith('cargo leptos')
              ? 'cargo leptos build --release'
              : cmd.startsWith('trunk')
                ? 'trunk build --release'
                : cmd.startsWith('dx ')
                  ? 'dx bundle --release'
                  : 'cargo build --release';
        targets.push({ id: a.dir, label: a.dir === '.' ? `${a.name} (${command.split(' ').slice(0, 2).join(' ')})` : a.dir, command, cwd: a.dir });
      } else if (a.kind === 'assets' || isPhpFramework(a.framework)) jsBuild('.', a.kind === 'assets' ? 'Front-end assets' : a.name);
      else jsBuild(a.dir, a.dir === '.' ? a.name : a.dir);
    }
    if (stack.runtime === 'php') jsBuild('.', 'Front-end assets');
    for (const l of stack.libs.filter((x) => x.build)) jsBuild(l.dir, `${l.dir} (package)`);
    const rootPkg = readJson<PackageJson>(join(p.path, 'package.json'));
    const rootScript = stack.layout !== 'folders' && stack.monorepo && rootPkg?.scripts?.build && stack.packageManager;
    if (targets.length > 1 || rootScript) {
      targets.unshift({
        id: 'all',
        label: 'Build all',
        command: rootScript ? runScriptCommand(stack.packageManager!, 'build') : targets.map((t) => `(cd ${t.cwd} && ${t.command})`).join(' && '),
        cwd: '.',
      });
    }
    return targets;
  }

  async buildSite(id: string, targetId: string): Promise<void> {
    const p = this.project(id);
    const target = this.buildTargets(id).find((t) => t.id === targetId);
    if (!target) throw new Error('Nothing to build there');
    if (this.dbTasks.has(id)) throw new Error(`Busy: ${this.dbTasks.get(id)}`);
    this.dbTasks.set(id, `building ${target.id === 'all' ? p.name : target.label}`);
    this.changed();
    const tag = `[build${target.id === 'all' || target.id === '.' ? '' : ` ${basename(target.id)}`}] `;
    const started = Date.now();
    try {
      const code = await stream(join(p.path, target.cwd), target.command, (t) => this.processes.log(id, 'sys', t.replace(/^(?=.)/gm, tag)), this.runtimeEnv(p));
      if (code !== 0) throw new Error(`${target.command} failed (exit ${code}); see Logs`);
      this.processes.log(id, 'sys', `${tag}Done in ${((Date.now() - started) / 1000).toFixed(1)} s`);
    } finally {
      this.dbTasks.delete(id);
      this.changed();
    }
  }

  /** Restarts (or starts again, when it exited) one app of a site that runs one process per app. */
  async restartApp(id: string, dir: string): Promise<void> {
    if (!this.processes.childrenOf(id).some((c) => c.label === basename(dir))) throw new Error('That app does not run as its own process; restart the site');
    await this.processes.restartChild(id, basename(dir));
  }

  async stop(id: string): Promise<void> {
    this.hotWatchers.get(id)?.close();
    this.hotWatchers.delete(id);
    await this.processes.stop(id);
    this.removeHotFile(id);
    this.updateRoutes();
  }

  async restart(id: string): Promise<void> {
    await this.stop(id);
    // Give the OS a moment to release the ports before the port check.
    for (let i = 0; i < 10 && (await this.anyPortOpen(id)); i++) await new Promise((r) => setTimeout(r, 300));
    await this.start(id);
  }

  private async anyPortOpen(id: string): Promise<boolean> {
    for (const app of this.stacks.get(id)?.apps ?? []) if (app.port && (await isPortOpen(app.port))) return true;
    return false;
  }

  /** Starts every site that has a dev command; failures (port taken, no deps) go to each site's log. */
  startAll(): void {
    for (const p of this.projects) {
      const stack = this.stacks.get(p.id);
      if ((p.devCommand || stack?.devCommand) && !this.processes.isActive(p.id)) {
        this.start(p.id).catch((e) => console.warn(`start-all ${p.name}:`, e.message));
      }
    }
  }

  async stopAll(): Promise<void> {
    await this.processes.stopAll();
    this.updateRoutes();
  }

  async shutdown(): Promise<void> {
    for (const t of this.timers) clearInterval(t);
    for (const w of this.watchers) w.close();
    await this.processes.stopAll();
    this.monitor.stop();
    await this.storage.stopAll();
    await this.ws.stopAll();
    await this.search.stopAll();
    await this.dbs.stopAll();
    await this.expose.stopAll();
    await this.mail.close();
    await this.whatsapp.stopAll();
    await this.gateways.stopAll();
    await this.proxy.close();
    await this.dns.stop();
    for (const w of this.hotWatchers.values()) w.close();
    for (const id of [...this.hotWatchers.keys()]) this.removeHotFile(id);
    await this.fpm.stopAll();
  }

  private async pollPorts(): Promise<void> {
    let dirty = false;
    await Promise.all(
      this.projects.map(async (p) => {
        const ports = (this.stacks.get(p.id)?.apps ?? []).map((a) => a.port).filter((x): x is number => !!x);
        const open: number[] = [];
        for (const port of ports) if (await isPortOpen(port)) open.push(port);
        const prev = this.openPorts.get(p.id) ?? [];
        if (prev.join() !== open.join()) {
          this.openPorts.set(p.id, open);
          dirty = true;
        }
        // "running" once every app's port answers (or the first web app's, at least).
        if (this.processes.getStatus(p.id).status === 'starting' && ports.length && ports.every((x) => open.includes(x))) {
          this.processes.markRunning(p.id);
          this.processes.log(p.id, 'sys', `Ready → ${this.urlFor(p)}`);
          void this.screenshot(p.id);
        }
      }),
    );
    if (dirty) {
      this.updateRoutes();
      this.changed();
    }
  }

  private async pollDatabases(): Promise<void> {
    let dirty = false;
    await Promise.all(
      this.projects.map(async (p) => {
        const state = this.state(p);
        const [db, redis] = await Promise.all([dbStatus(state), this.redisStatusOf(p, state.stack)]);
        if (this.dbStates.get(p.id) !== db) {
          this.dbStates.set(p.id, db);
          dirty = true;
        }
        if (this.redisStates.get(p.id) !== redis) {
          this.redisStates.set(p.id, redis);
          dirty = true;
        }
      }),
    );
    if (dirty) this.changed();
  }

  /** Redis is up when its port answers (or, for an unpublished compose service, when the container runs). */
  private async redisStatusOf(p: ProjectConfig, stack: StackInfo): Promise<DbStatus> {
    const r = stack.redis;
    if (!r) return 'none';
    if (r.reachable) return (await isPortOpen(r.port)) ? 'running' : 'stopped';
    if (r.composeFile && r.service) {
      const { code, stdout } = await run('docker', ['compose', '-f', r.composeFile, 'ps', '--all', '--format', '{{.State}}', r.service], {
        cwd: p.path,
        timeout: 10_000,
      });
      if (code !== 0) return 'unknown';
      return stdout.trim().startsWith('running') ? 'running' : 'stopped';
    }
    return 'unknown';
  }

  /** Live INFO of the site's Redis (version, memory, keys); the password is read here only. */
  async redisInfo(id: string): Promise<RedisDetails | null> {
    const p = this.find(id);
    const stack = this.stacks.get(id);
    if (!p || !stack?.redis) return null;
    if (!stack.redis.reachable) {
      const known = this.redisStates.get(id);
      const status = known === 'running' || known === 'stopped' ? known : 'unknown';
      return { status, error: 'Not reachable from this Mac (Docker-internal host)' };
    }
    const dirs = stack.apps.map((a) => join(p.path, a.dir));
    return redisDetails(stack.redis, redisPassword(p.path, dirs));
  }

  /** `<pm> install` in the project root, streamed into its log. */
  async installDeps(id: string): Promise<void> {
    const p = this.find(id);
    if (p && this.stacks.get(id)?.layout === 'folders') return this.installFolderDeps(p, this.stacks.get(id)!);
    const pm = this.stacks.get(id)?.packageManager;
    if (p && this.stacks.get(id)?.runtime === 'php') return this.installPhpDeps(p);
    if (p && this.stacks.get(id)?.runtime === 'python') return this.installPythonDeps(p, this.stacks.get(id)!);
    if (p && this.stacks.get(id)?.runtime === 'rust') return this.installRustDeps(p);
    if (!p || !pm) return;
    if (this.dbTasks.has(id)) throw new Error(`Busy: ${this.dbTasks.get(id)}`);
    if (pm === 'bun' && !this.bunChoice(p).binDir) throw new Error('Bun is not installed. Install it on the Bun page (sidebar) first.');
    if (pm !== 'bun' && !this.nodeChoice(p).version) throw new Error(NO_NODE);
    this.dbTasks.set(id, `${pm} install`);
    this.changed();
    try {
      const code = await stream(p.path, `${pm} install`, (t) => this.processes.log(id, 'sys', t), this.runtimeEnv(p));
      if (code !== 0) throw new Error(`${pm} install failed (exit ${code}); see the log`);
    } finally {
      this.dbTasks.delete(id);
      this.rescan();
    }
  }

  /**
   * Folder layouts (frontend/ + backend/): each folder's own install — npm / pnpm / yarn / bun, composer, uv (or
   * poetry / pdm / pipenv), go mod download — one after the other, in the site's log with the folder as the tag.
   */
  private async installFolderDeps(p: ProjectConfig, stack: StackInfo): Promise<void> {
    if (this.dbTasks.has(p.id)) throw new Error(`Busy: ${this.dbTasks.get(p.id)}`);
    const q = (x: string) => `'${x.replace(/'/g, `'\\''`)}'`;
    const steps: { dir: string; command: string }[] = [];
    for (const app of stack.apps) {
      const dir = join(p.path, app.dir);
      const has = (f: string) => existsSync(join(dir, f));
      if (has('package.json')) {
        const pm = detectPackageManager(dir, readJson<PackageJson>(join(dir, 'package.json')));
        if (pm === 'bun' && !this.bunChoice(p).binDir) throw new Error('Bun is not installed. Install it on the Bun page (sidebar) first.');
        steps.push({ dir: app.dir, command: `${pm} install` });
      }
      if (has('composer.json')) steps.push({ dir: app.dir, command: 'composer install --no-interaction' });
      if (has('go.mod')) steps.push({ dir: app.dir, command: 'go mod download' });
      if (has('Cargo.toml')) {
        if (!this.rustupVer) throw new Error('Rust is not installed. Install it on the Rust page (sidebar) first.');
        steps.push({ dir: app.dir, command: 'cargo fetch' });
      }
      const req = ['requirements.txt', 'requirements/dev.txt', 'requirements/base.txt'].find((f) => has(f));
      const pyproject = has('pyproject.toml') ? readFileSync(join(dir, 'pyproject.toml'), 'utf8') : '';
      if (pyproject || req) {
        if (!pythons.uvPath()) await this.uvInstall();
        const uv = q(pythons.uvPath()!);
        if (/^\s*dependencies\s*=/m.test(pyproject)) steps.push({ dir: app.dir, command: `${uv} sync` });
        else if (/\[tool\.poetry\]/.test(pyproject)) steps.push({ dir: app.dir, command: 'POETRY_VIRTUALENVS_IN_PROJECT=true poetry install' });
        else if (req) steps.push({ dir: app.dir, command: `${uv} venv --allow-existing .venv && ${uv} pip install --python .venv/bin/python -r ${q(req)}` });
      }
    }
    if (!steps.length) return;
    this.dbTasks.set(p.id, 'installing dependencies');
    this.changed();
    try {
      for (const st of steps) {
        const tag = `[${basename(st.dir)}] `;
        this.processes.log(p.id, 'sys', `${tag}$ ${st.command}`);
        const code = await stream(join(p.path, st.dir), st.command, (t) => this.processes.log(p.id, 'sys', t.replace(/^(?=.)/gm, tag)), { ...this.runtimeEnv(p), ...pythons.uvEnv() });
        if (code !== 0) throw new Error(`${st.command} in ${st.dir} failed (exit ${code}); see the log`);
      }
    } finally {
      this.dbTasks.delete(p.id);
      this.rescan();
    }
  }

  /** Dependency commands from the manifests in the project root. */
  depCommands(id: string): DepCommand[] {
    const p = this.project(id);
    const stack = this.stacks.get(id);
    const has = (f: string) => existsSync(join(p.path, f));
    const out: DepCommand[] = [];
    if (has('composer.json')) {
      out.push(
        { id: 'composer-install', tool: 'composer', manifest: 'composer.json', label: 'install', command: 'composer install --no-interaction' },
        { id: 'composer-update', tool: 'composer', manifest: 'composer.json', label: 'update', command: 'composer update --no-interaction', danger: true },
        { id: 'composer-dump', tool: 'composer', manifest: 'composer.json', label: 'dump-autoload', command: 'composer dump-autoload' },
        { id: 'composer-outdated', tool: 'composer', manifest: 'composer.json', label: 'outdated', command: 'composer outdated --direct' },
      );
    }
    if (has('package.json')) {
      const pm = stack?.packageManager ?? 'npm';
      const update = pm === 'yarn' ? 'yarn upgrade' : `${pm} update`;
      out.push(
        { id: 'js-install', tool: pm, manifest: 'package.json', label: 'install', command: `${pm} install` },
        { id: 'js-update', tool: pm, manifest: 'package.json', label: 'update', command: update, danger: true },
        { id: 'js-outdated', tool: pm, manifest: 'package.json', label: 'outdated', command: `${pm} outdated` },
      );
    }
    const pyManifest = ['pyproject.toml', 'requirements.txt', 'Pipfile'].find((f) => has(f));
    if (pyManifest && stack?.python) {
      const tool = stack.python.tool;
      const pyproject = has('pyproject.toml') ? readFileSync(join(p.path, 'pyproject.toml'), 'utf8') : '';
      const pep621 = /^\s*dependencies\s*=/m.test(pyproject);
      const update =
        tool === 'poetry' && !pep621 ? 'poetry update' : tool === 'pdm' ? 'pdm update' : tool === 'pipenv' && !has('requirements.txt') ? 'pipenv update' : pep621 ? 'uv lock --upgrade && uv sync' : 'uv pip install -U -r requirements.txt';
      out.push(
        { id: 'py-install', tool, manifest: pyManifest, label: 'install', command: `${tool === 'poetry' || tool === 'pdm' || tool === 'pipenv' ? `${tool} install` : pep621 ? 'uv sync' : 'uv pip install -r requirements.txt'} (creates .venv)` },
        { id: 'py-update', tool, manifest: pyManifest, label: 'update', command: update, danger: true },
      );
    }
    if (has('go.mod')) {
      out.push(
        { id: 'go-download', tool: 'go', manifest: 'go.mod', label: 'mod download', command: 'go mod download' },
        { id: 'go-tidy', tool: 'go', manifest: 'go.mod', label: 'mod tidy', command: 'go mod tidy' },
        { id: 'go-update', tool: 'go', manifest: 'go.mod', label: 'update all', command: 'go get -u ./... && go mod tidy', danger: true },
      );
    }
    if (has('Cargo.toml')) {
      out.push(
        { id: 'cargo-fetch', tool: 'cargo', manifest: 'Cargo.toml', label: 'fetch', command: 'cargo fetch' },
        { id: 'cargo-check', tool: 'cargo', manifest: 'Cargo.toml', label: 'check', command: 'cargo check' },
        { id: 'cargo-update', tool: 'cargo', manifest: 'Cargo.toml', label: 'update', command: 'cargo update', danger: true },
      );
    }
    return out;
  }

  /** Runs one dependency command in the project root, streamed into the site's log. */
  async depRun(id: string, commandId: string): Promise<void> {
    const p = this.project(id);
    const cmd = this.depCommands(id).find((c) => c.id === commandId);
    if (!cmd) throw new Error('Unknown command');
    if (cmd.id === 'py-install') return this.installDeps(id);
    if (this.dbTasks.has(id)) throw new Error(`Busy: ${this.dbTasks.get(id)}`);
    // DevCatz's Composer, else one on the site's PATH (Laravel Herd's, Homebrew's).
    if (cmd.tool === 'composer' && !phps.composerInstalled() && !(await hasCommand('composer', this.runtimeEnv(p)))) {
      throw new Error('Composer is not installed: install it on the PHP page first.');
    }
    if (cmd.tool === 'bun' && !this.bunChoice(p).binDir) throw new Error('Bun is not installed. Install it on the Bun page first.');
    if (cmd.tool === 'go' && !this.goChoice(p).binDir) throw new Error('Go is not installed. Install it on the Go page first.');
    if (cmd.tool === 'cargo' && !this.rustupVer) throw new Error('Rust is not installed. Install it on the Rust page first.');
    let command = cmd.command;
    // Python tools run from the site's venv / uv (see runtimeEnv); pip-style updates need uv's binary.
    if (cmd.id === 'py-update' && command.startsWith('uv ')) {
      const uv = pythons.uvPath();
      if (!uv) throw new Error('uv is not installed: install it on the Python page first.');
      // uv finds the project's .venv in the working directory.
      command = command.replace(/(^|&& )uv /g, `$1'${uv.replace(/'/g, "'\\''")}' `);
    }
    const label = `${cmd.tool} ${cmd.label}`;
    this.dbTasks.set(id, label);
    this.changed();
    this.processes.log(id, 'sys', `$ ${command}`);
    try {
      const code = await stream(p.path, command, (t) => this.processes.log(id, 'sys', t), this.runtimeEnv(p));
      // `outdated` exits 1 when there are outdated packages: that is the answer, not a failure.
      if (code !== 0 && cmd.label !== 'outdated') throw new Error(`${label} failed (exit ${code}); see the log`);
    } finally {
      this.dbTasks.delete(id);
      this.rescan();
    }
  }

  /**
   * PHP sites moved from Laravel Herd/Valet keep `APP_URL=https://app.test`,
   * `APP_DOMAIN=app.test`, `SESSION_DOMAIN=.app.test` … in .env. For requests
   * and processes DevCatz runs, those values get this site's domain instead
   * (Route::domain('{sub}.'.config('app.domain')) then matches); .env itself
   * is untouched, so Herd keeps working. Off per site with envDomainOverride.
   */
  private domainOverrides(p: ProjectConfig, stack: StackInfo): Record<string, string> {
    if (stack.runtime !== 'php' || p.envDomainOverride === false) return {};
    const env = readEnvFiles(join(p.path, '.env'));
    const devHost = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.(test|localhost|local|internal|lan)$/;
    const fromUrl = (v?: string) => {
      try {
        return v ? new URL(v).hostname.toLowerCase() : '';
      } catch {
        return '';
      }
    };
    const candidates = [env.APP_DOMAIN?.trim().toLowerCase(), fromUrl(env.APP_URL)].filter((h): h is string => !!h && devHost.test(h));
    const old = candidates.find((h) => h !== p.domain && !h.endsWith(`.${p.domain}`));
    if (!old) return {};
    const re = new RegExp(`(^|[^a-z0-9-])${old.replace(/\./g, '\\.')}(?![a-z0-9-])`, 'gi');
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(env)) {
      const next = value.replace(re, `$1${p.domain}`);
      if (next !== value) out[key] = next;
    }
    // APP_URL follows the site's scheme too (Laravel builds absolute URLs from it).
    if (out.APP_URL) out.APP_URL = out.APP_URL.replace(/^https?:/, p.secure === false ? 'http:' : 'https:');
    return out;
  }

  /** .env files Redis settings are read from (root and app folders, .env then .env.local). */
  private redisEnvFiles(p: ProjectConfig, stack: StackInfo): string[] {
    return [p.path, ...stack.apps.map((a) => join(p.path, a.dir))].flatMap((d) => [join(d, '.env'), join(d, '.env.local')]);
  }

  /**
   * Several projects on one Redis (DBngin's, port 6379) all use db 0 unless
   * .env says otherwise, so a `cache:clear`/FLUSHDB in one wipes the others.
   * A per-site index is passed as REDIS_DB (and the path of REDIS_URL /
   * REDIS_URI / KV_URL) to the processes and PHP requests DevCatz runs; .env
   * values lose to real env vars in Laravel, dotenv and godotenv, so this wins.
   */
  private redisOverrides(p: ProjectConfig, stack: StackInfo, files = this.redisEnvFiles(p, stack)): Record<string, string> {
    const conns = stack.runtime === 'php' ? Object.entries(p.redisConnDbs ?? {}).filter(([k]) => stack.redis?.connections.some((c) => c.envKey === k)) : [];
    if (!stack.redis || (p.redisDb === undefined && p.redisCacheDb === undefined && !conns.length)) return {};
    const out: Record<string, string> = {};
    if (p.redisDb !== undefined) {
      out.REDIS_DB = String(p.redisDb);
      const env = readEnvFiles(...files);
      for (const key of ['REDIS_URL', 'REDIS_URI', 'KV_URL']) {
        const v = env[key];
        if (!v) continue;
        try {
          const u = new URL(v);
          if (!/^rediss?:$/.test(u.protocol)) continue;
          u.pathname = `/${p.redisDb}`;
          out[key] = u.toString();
        } catch {
          /* not a URL */
        }
      }
    }
    if (p.redisCacheDb !== undefined && stack.runtime === 'php') out.REDIS_CACHE_DB = String(p.redisCacheDb);
    // Custom Laravel connections (REDIS_VISIT_DB …).
    for (const [k, v] of conns) out[k] = String(v);
    return out;
  }

  /** Puts the chosen index(es) into the root .env (Laravel REDIS_DB / REDIS_CACHE_DB, else the keys .env already uses). */
  redisWriteEnv(id: string, apply: boolean) {
    const p = this.project(id);
    const stack = this.stacks.get(id);
    if (!stack?.redis) throw new Error('This site does not use Redis');
    const file = '.env';
    const abs = join(p.path, file);
    const own = readEnvFiles(abs);
    const all = this.redisOverrides(p, stack, [abs]);
    if (!Object.keys(all).length) throw new Error('Choose a database index first');
    const entries: Record<string, string> = {};
    for (const [k, v] of Object.entries(all)) {
      // Laravel: always REDIS_DB/REDIS_CACHE_DB; other stacks: only the keys this .env uses (REDIS_URL, or REDIS_DB next to REDIS_HOST).
      const custom = stack.redis.connections.some((c) => c.envKey === k);
      const keep = k in own || k === 'REDIS_CACHE_DB' || custom || (k === 'REDIS_DB' && (stack.runtime === 'php' || own.REDIS_HOST !== undefined || own.REDIS_PORT !== undefined));
      if (keep) entries[k] = v;
    }
    if (!Object.keys(entries).length) throw new Error(`No Redis setting in ${file} at the project root; set it in the app's .env (Env tab)`);
    const plan = this.envMerge(id, file, entries, 'Redis database (DevCatz)', apply);
    if (apply) this.update(id, { redisDb: -1, redisCacheDb: -1, redisConnDbs: {} });
    // Mask passwords of URLs in the preview.
    const mask = (v: string) => v.replace(/(\/\/[^:/@]*:)[^@]*@/, '$1•••@');
    return { file, ...plan, changed: plan.changed.map((c) => ({ key: c.key, from: mask(c.from), to: mask(c.to) })) };
  }

  /** .env URLs on local dev domains (.localhost/.test/…) that are not this site's domains. */
  private findEnvHints(p: ProjectConfig, stack: StackInfo): { key: string; value: string }[] {
    const own = new Set(stack.apps.map((a) => a.domain).concat(p.domain));
    const devTld = /^(localhost|test|internal|local|orb\.local|lan|home\.arpa)$/;
    const files = [p.path, ...stack.apps.map((a) => join(p.path, a.dir))].map((d) => join(d, '.env'));
    const out: { key: string; value: string }[] = [];
    for (const [key, value] of Object.entries(readEnvFiles(...files))) {
      // Bare hosts too (APP_DOMAIN=app.test, SESSION_DOMAIN=.app.test).
      const bare = value.trim().replace(/^\./, '');
      if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(bare)) {
        const parts = bare.toLowerCase().split('.');
        if (devTld.test(parts.at(-1)!) && !own.has(bare.toLowerCase()) && ![...own].some((d) => bare.toLowerCase().endsWith(`.${d}`))) {
          out.push({ key, value });
          continue;
        }
      }
      for (const m of value.matchAll(/\bhttps?:\/\/([a-z0-9.-]+)/gi)) {
        const host = m[1].toLowerCase();
        const parts = host.split('.');
        const suffix = parts.length > 2 && `${parts.at(-2)}.${parts.at(-1)}` === 'orb.local' ? 'orb.local' : parts.at(-1)!;
        if (parts.length > 1 && devTld.test(suffix) && !own.has(host)) {
          out.push({ key, value });
          break;
        }
      }
    }
    return out;
  }

  // ---------------------------------------------------------- default TLD

  /** Real TLDs a dev domain must not shadow, plus mDNS's `.local`. */
  private static readonly BLOCKED_TLDS = new Set(
    'local com net org edu gov mil int io dev app ai co me id info biz xyz site online tech store blog cloud page web site top shop live news'.split(' '),
  );

  /** A name under the TLD resolves to this Mac (always true for .localhost). */
  private async checkResolution(): Promise<void> {
    const t = tld();
    if (t === 'localhost') {
      this.resolves = true;
      return;
    }
    try {
      const addrs = await lookup(`mrcatz-herd-check.${t}`, { all: true });
      this.resolves = addrs.some((a) => a.address === '127.0.0.1' || a.address === '::1');
    } catch {
      this.resolves = false;
    }
  }

  /**
   * Changes the default TLD. Sites whose domain ends in the old TLD get the
   * new one (`shop.localhost` → `shop.test`); hand-picked domains with other
   * suffixes stay. `dryRun` only reports what would change.
   */
  async setTld(next: string, dryRun = false): Promise<TldChange> {
    const to = next.trim().toLowerCase().replace(/^\./, '');
    if (!/^[a-z][a-z0-9-]{0,30}$/.test(to)) throw new Error('Use a single label like "test" or "localhost".');
    if (Herd.BLOCKED_TLDS.has(to)) throw new Error(`.${to} is a real or mDNS top-level domain; pick a reserved one like .test, .localhost or .internal.`);
    const from = tld();
    const renamed = this.projects
      .filter((p) => p.domain.endsWith(`.${from}`))
      .map((p) => ({ name: p.name, from: p.domain, to: p.domain.slice(0, -from.length) + to }));
    if (dryRun || to === from) return { from, to, renamed };
    if (to !== 'localhost' && resolverStatus(to) === 'foreign') {
      throw new Error(`/etc/resolver/${to} belongs to another tool. Remove it there or pick another TLD.`);
    }
    // Linked sites carry their domain in the config; parked ones are re-derived on rescan.
    store.setProjects(store.projects.map((p) => (p.domain.endsWith(`.${from}`) ? { ...p, domain: p.domain.slice(0, -from.length) + to } : p)));
    store.updateSettings({ tld: to });
    await this.dns.start(to);
    this.rescan();
    await this.checkResolution();
    this.changed();
    return { from, to, renamed };
  }

  async installResolver(): Promise<boolean> {
    const r = await installResolver(tld(), DNS_PORT);
    if (!r.ok) throw new Error(r.message.includes('-128') ? 'Cancelled' : r.message);
    await new Promise((res) => setTimeout(res, 500));
    await this.checkResolution();
    this.changed();
    return this.resolves;
  }

  async uninstallResolver(): Promise<boolean> {
    const r = await uninstallResolver(tld());
    if (!r.ok) throw new Error(r.message.includes('-128') ? 'Cancelled' : r.message);
    await this.checkResolution();
    this.changed();
    return true;
  }

  // ------------------------------------------------------------ dev ports

  /**
   * Gives every app a stable port from DevCatz's pool (4100+), so sites
   * never collide however their .env files are set up (those keep the
   * production/Docker values). An app is only managed when it reads its port
   * from an env var nobody else in the project reads: one root dev command
   * starts all apps with the same environment, so a shared `PORT` cannot
   * tell them apart.
   */
  /** A site's own package manager choice replaces the lockfile's (dev command, install, Prisma); its app subdomains. */
  private applyOverrides(p: ProjectConfig, stack: StackInfo): StackInfo {
    this.applyAppDomains(p, stack);
    const pm = p.packageManager;
    if (!pm || stack.runtime !== 'node' || pm === stack.packageManager) return stack;
    const from = stack.packageManager;
    stack.packageManager = pm;
    if (stack.devCommand && from) stack.devCommand = stack.devCommand.replace(runScriptCommand(from, 'dev'), runScriptCommand(pm, 'dev'));
    return stack;
  }

  /**
   * Monorepos with managed ports run one process per app (in its folder,
   * with its own PORT) instead of the root dev command, because a single
   * environment cannot give two apps different values of a shared `PORT`.
   */
  private perAppMode(p: ProjectConfig, stack: StackInfo): boolean {
    // Sibling projects (frontend/ + backend/) only run app by app: there is no root command for them.
    if (stack.layout === 'folders') return !p.devCommand;
    const multi = stack.monorepo || stack.apps.some((a) => (a.framework === 'go' || a.framework === 'rust') && a.dir !== '.');
    return multi && !p.devCommand && p.managedPorts !== false && stack.packageManager !== null;
  }

  private assignPorts(p: ProjectConfig, stack: StackInfo): StackInfo {
    if (p.managedPorts === false) return stack;
    const readers = new Map<string, number>();
    for (const app of stack.apps) for (const v of app.portVars) readers.set(v, (readers.get(v) ?? 0) + 1);
    const taken = new Set(Object.entries(store.ports).filter(([k]) => !k.startsWith(`${p.id}:`)).map(([, v]) => v));
    const perApp = this.perAppMode(p, stack);
    for (const app of stack.apps) {
      const own = perApp ? app.portVars : app.portVars.filter((v) => readers.get(v) === 1);
      // Vite behind a Laravel site takes its port as a CLI flag, so it can always be managed.
      if (!own.length && !app.portFlag) continue;
      const key = `${p.id}:${app.dir}`;
      let port = store.ports[key];
      if (!port || taken.has(port)) {
        port = 4100;
        while (taken.has(port) || Object.values(store.ports).includes(port)) port++;
        store.setPort(key, port);
      }
      taken.add(port);
      app.port = port;
      app.managedPort = true;
    }
    // Shared .env ports no longer matter once every app has its own.
    if (stack.apps.every((a) => a.managedPort)) stack.warnings = stack.warnings.filter((w) => !w.includes('both use port'));
    return stack;
  }

  /**
   * Who uses a port the user wants for one of a site's apps (site Settings): another DevCatz site's app, or a
   * program listening on it; null when it is free (or already this app's).
   */
  async portUse(siteId: string, dir: string, port: number): Promise<string | null> {
    if (!Number.isInteger(port) || port < 1024 || port > 65535) return 'Use a port between 1024 and 65535';
    const mine = `${siteId}:${dir}`;
    if (store.ports[mine] === port) return null;
    for (const [key, v] of Object.entries(store.ports)) {
      if (v !== port || key === mine) continue;
      const at = key.indexOf(':');
      const other = this.find(key.slice(0, at));
      if (other) return `${other.name}${other.id === siteId ? ` (${key.slice(at + 1)})` : ''} already uses ${port}`;
    }
    for (const [id, stack] of this.stacks) {
      const app = stack.apps.find((a) => a.port === port && !(id === siteId && a.dir === dir));
      const other = app && this.find(id);
      if (other) return `${other.name}${stack.apps.length > 1 ? ` (${app.name})` : ''} already uses ${port}`;
    }
    if (await isPortOpen(port)) return `${(await portOwner(port).catch(() => null)) ?? 'Another program'} is listening on ${port}`;
    return null;
  }

  /** Puts one of a site's managed apps on a port of the user's choice; refused while the port is in use. */
  async setAppPort(siteId: string, dir: string, port: number, writeEnv = false): Promise<string[]> {
    const p = this.find(siteId);
    if (!p) throw new Error('This site is gone');
    const app = this.stacks.get(p.id)?.apps.find((a) => a.dir === dir);
    if (!app?.managedPort) throw new Error('DevCatz does not assign this app’s port: change it in the project’s .env');
    const use = await this.portUse(p.id, dir, port);
    if (use) throw new Error(use);
    const old = app.configuredPort;
    store.setPort(`${p.id}:${dir}`, port);
    const changed = writeEnv ? this.writePortToEnv(p, app, old, port) : [];
    this.processes.log(p.id, 'sys', `${app.name} moves to port ${port} (site settings)${changed.length ? `; .env: ${changed.join(', ')}` : ''}; restart the site to use it.`);
    this.rescan();
    return changed;
  }

  /** The .env files holding an app's port variables (Settings → Apps: "also write it to .env"). */
  appPortEnv(siteId: string, dir: string): { files: string[]; keys: string[]; locked: boolean } | null {
    const p = this.project(siteId);
    const app = this.stacks.get(siteId)?.apps.find((a) => a.dir === dir);
    if (!app?.portVars.length) return null;
    const files: string[] = [];
    const keys = new Set<string>();
    for (const rel of [...new Set([join(app.dir, '.env'), '.env'])]) {
      const text = readText(join(p.path, rel));
      if (!text) continue;
      const found = app.portVars.filter((v) => new RegExp(`^\\s*(export\\s+)?${v}\\s*=`, 'm').test(text));
      if (found.length) {
        files.push(rel);
        found.forEach((k) => keys.add(k));
      }
    }
    return files.length ? { files, keys: [...keys], locked: p.envLocked !== false } : null;
  }

  /**
   * Writes an app's new port into the .env files that hold its port variables (API_PORT=8080 → 4101), and moves the
   * localhost URLs that pointed at the old port with it (API_INTERNAL_URL=http://127.0.0.1:8080). Skipped while the
   * site's environment is locked (Env tab).
   */
  private writePortToEnv(p: ProjectConfig, app: AppInfo, old: number | null, port: number): string[] {
    const where = this.appPortEnv(p.id, app.dir);
    if (!where) return [];
    if (where.locked) throw new Error('The .env is locked (Env tab → Unlock) — the port is saved in DevCatz; unlock to write it to .env too');
    const changed: string[] = [];
    for (const rel of where.files) {
      const file = join(p.path, rel);
      const lines = readFileSync(file, 'utf8').split('\n');
      const next = lines.map((line) => {
        const m = line.match(/^(\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_]*)(\s*=\s*)(.*)$/);
        if (!m) return line;
        const [, pre, key, eq, value] = m;
        if (app.portVars.includes(key)) {
          const q = value.match(/^(["']?)\d+\1(\s*#.*)?$/);
          if (!q) return line;
          changed.push(key);
          return `${pre}${key}${eq}${q[1]}${port}${q[1]}${q[2] ?? ''}`;
        }
        if (old && old !== port) {
          const moved = value.replace(new RegExp(`(https?://(?:localhost|127\\.0\\.0\\.1|\\[::1\\]):)${old}\\b`, 'g'), `$1${port}`);
          if (moved !== value) {
            changed.push(key);
            return `${pre}${key}${eq}${moved}`;
          }
        }
        return line;
      });
      if (next.join('\n') !== lines.join('\n')) writeFileSync(file, next.join('\n'));
    }
    return [...new Set(changed)];
  }

  /** A free port for an app (Settings → Apps → Generate): not another site's, nothing listening. */
  async freePortFor(siteId: string, dir: string): Promise<number> {
    const mine = `${siteId}:${dir}`;
    const taken = new Set<number>([
      ...Object.entries(store.ports).filter(([k]) => k !== mine).map(([, v]) => v),
      ...[...this.stacks.entries()].flatMap(([id, s]) => s.apps.filter((a) => !(id === siteId && a.dir === dir)).map((a) => a.port ?? 0)),
    ]);
    for (let port = 4100; port < 4900; port++) if (!taken.has(port) && !(await isPortOpen(port))) return port;
    throw new Error('No free port between 4100 and 4900');
  }

  /**
   * Managed ports are only promised to DevCatz's own sites; if another
   * program listens on one (e.g. a second copy of the app), pick the next
   * free port from the pool. Returns true when something moved.
   */
  private async reassignBusyPorts(p: ProjectConfig, stack: StackInfo): Promise<boolean> {
    let moved = false;
    for (const app of stack.apps) {
      if (!app.managedPort || !app.port || !(await isPortOpen(app.port))) continue;
      const used = new Set(Object.values(store.ports));
      let port = 4100;
      while (used.has(port) || (await isPortOpen(port))) port++;
      this.processes.log(p.id, 'sys', `Port ${app.port} is taken by another program; ${app.name} moves to ${port}.`);
      store.setPort(`${p.id}:${app.dir}`, port);
      moved = true;
    }
    if (moved) this.rescan();
    return moved;
  }

  /**
   * Env for managed ports: `perApp[dir]` puts one app on its port (all the
   * vars it reads); `shared` holds .env values rewritten to the new ports
   * (e.g. NUXT_API_TARGET=http://localhost:3011 → the API's managed port).
   */
  private portEnv(p: ProjectConfig, stack: StackInfo, perApp: boolean) {
    const managed = stack.apps.filter((a) => a.managedPort && a.port);
    const readers = new Map<string, number>();
    for (const app of stack.apps) for (const v of app.portVars) readers.set(v, (readers.get(v) ?? 0) + 1);
    const apps = new Map<string, Record<string, string>>();
    const parts: string[] = [];
    for (const app of managed) {
      const vars = perApp ? app.portVars : app.portVars.filter((v) => readers.get(v) === 1);
      apps.set(app.dir, Object.fromEntries(vars.map((v) => [v, String(app.port)])));
      parts.push(`${app.name} → ${app.port} (${vars.length ? vars.join(', ') : app.flagCommand ? '--port' : 'config'})`);
    }
    const shared: Record<string, string> = {};
    if (!managed.length) return { shared, apps, summary: '' };

    const files = [p.path, ...stack.apps.map((a) => join(p.path, a.dir))].flatMap((d) => [join(d, '.env'), join(d, '.env.local')]);
    const values = readEnvFiles(...files);
    // Several apps may share one port in .env (each had its own container in
    // production): pick the API app for API-looking values, else the web app.
    const target = (key: string, value: string, port: number) => {
      const same = managed.filter((a) => a.configuredPort === port && a.configuredPort !== a.port);
      if (same.length < 2) return same[0];
      const wantsApi = /API|BACKEND/i.test(key) || /:\d+\/api\b/.test(value);
      return same.find((a) => a.kind === (wantsApi ? 'api' : 'web')) ?? same[0];
    };
    const injected = new Set(managed.flatMap((a) => Object.keys(apps.get(a.dir) ?? {})));
    const rewritten: string[] = [];
    for (const [key, value] of Object.entries(values)) {
      if (injected.has(key)) continue;
      const next = value.replace(/\b(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):(\d{2,5})\b/g, (whole, host: string, port: string) => {
        const app = target(key, value, Number(port));
        return app ? `${host}:${app.port}` : whole;
      });
      if (next !== value) {
        shared[key] = next;
        rewritten.push(key);
      }
    }
    const summary = `Ports (assigned by DevCatz): ${parts.join('; ')}${rewritten.length ? `. Rewritten: ${rewritten.join(', ')}` : ''}`;
    return { shared, apps, summary };
  }

  // ---------------------------------------------------------------- node.js

  private runtimesAt = 0;
  /**
   * Installed runtimes again, e.g. after Laravel Herd (whose PHP and nvm Node
   * DevCatz lists) was removed. At most every 30 s unless `force`.
   */
  async refreshRuntimes(force = false): Promise<void> {
    if (!force && Date.now() - this.runtimesAt < 30_000) return;
    this.runtimesAt = Date.now();
    this.refreshNodes();
    await this.refreshBuns();
    await this.refreshGos();
    await this.refreshRust();
    await this.refreshPythons();
    await this.refreshPhps();
    this.syncFpm();
    this.systemNode = await nodes.systemNode();
    this.changed();
  }

  refreshNodes(): void {
    this.installedNodes = nodes.listInstalled();
    const def = store.settings.nodeDefault;
    if (def && !this.installedNodes.some((n) => n.version === def)) store.updateSettings({ nodeDefault: null });
    nodes.writeShims(store.settings.nodeDefault);
  }

  /** Version a site runs with: its own pick, then .nvmrc/engines, then the default, then the shell's node. */
  /**
   * The version "Install" puts on this Mac for a runtime a project asks for (`spec`: .nvmrc / engines, composer.json's
   * require.php, go.mod, Bun's pin): the newest release that fits, else the newest (Node: the newest LTS).
   */
  async runtimePick(kind: RuntimeNeed['kind'], spec: string | null): Promise<string | null> {
    if (kind === 'node') {
      const remote = (await this.nodeRemote()).slice().sort((a, b) => nodes.compare(b.version, a.version));
      const asInstalled = remote.map((r) => ({ version: r.version, major: r.major, source: 'mrcatz' as const, binDir: '' }));
      const fit = nodes.resolveSpec(spec, asInstalled, LTS_NAMES)?.version;
      const major = spec?.match(/(\d+)/)?.[1];
      return fit ?? (major ? remote.find((r) => r.major === Number(major))?.version : undefined) ?? remote.find((r) => r.lts)?.version ?? remote[0]?.version ?? null;
    }
    if (kind === 'php') {
      const remote = (await this.phpRemote()).filter((r) => !r.via).sort((a, b) => nodes.compare(b.version, a.version));
      return (spec ? remote.find((r) => phps.satisfies(r.version, spec)) : remote[0])?.version ?? remote[0]?.version ?? null;
    }
    // go.mod's `go` line is a minimum and Bun pins are rare: the newest release.
    if (kind === 'go') return (await this.goRemote()).map((r) => r.version).sort((a, b) => nodes.compare(b, a))[0] ?? null;
    return (await this.bunRemote()).map((r) => r.version).sort((a, b) => nodes.compare(b, a))[0] ?? null;
  }

  /** Runtimes a site needs that are not on this Mac (or not in the version it asks for), with what Install would add. */
  async siteRuntimeNeeds(id: string): Promise<RuntimeNeed[]> {
    const p = this.find(id);
    const stack = this.stacks.get(id);
    if (!p || !stack) return [];
    const out: RuntimeNeed[] = [];
    const add = async (kind: RuntimeNeed['kind'], spec: string | null, current: string | null, from: string | null) =>
      out.push({ kind, spec, current, from, version: await this.runtimePick(kind, spec).catch(() => null) });
    if (stack.runtime === 'php') {
      const c = this.phpChoice(p);
      if (!c.version || c.missing) await add('php', c.spec, c.version, c.spec ? 'composer.json' : null);
    }
    if (stack.runtime === 'node' && stack.packageManager !== 'bun') {
      const c = this.nodeChoice(p);
      if (!c.version || c.missing) await add('node', c.spec, c.version, c.spec ? '.nvmrc / package.json engines' : null);
    }
    if (this.hasGo(p)) {
      const c = this.goChoice(p, stack);
      if (!c.binDir) await add('go', c.spec, null, c.spec ? 'go.mod' : null);
    }
    if (stack.packageManager === 'bun') {
      const c = this.bunChoice(p);
      if (!c.binDir) await add('bun', c.spec, null, c.spec ? 'the project' : null);
    }
    return out;
  }

  nodeChoice(p: ProjectConfig): NodeChoice {
    const spec = nodes.readNodeSpec(p.path);
    const installed = this.installedNodes;
    if (p.nodeVersion && installed.some((n) => n.version === p.nodeVersion)) {
      return { version: p.nodeVersion, reason: 'site', spec, missing: false };
    }
    const fromSpec = nodes.resolveSpec(spec, installed, LTS_NAMES);
    if (fromSpec) return { version: fromSpec.version, reason: 'nvmrc', spec, missing: false };
    const missing = Boolean(spec && /\d|lts|node/i.test(spec));
    const def = store.settings.nodeDefault;
    if (def && installed.some((n) => n.version === def)) return { version: def, reason: 'default', spec, missing };
    return { version: this.systemNode, reason: 'system', spec, missing };
  }

  /** PATH with the site's chosen Node and Bun first (nothing added for the shell's own). */
  private runtimeEnv(p: ProjectConfig): Record<string, string> {
    const dirs: string[] = [];
    const node = this.nodeChoice(p);
    if (node.reason !== 'system' && node.version) {
      const bin = this.installedNodes.find((n) => n.version === node.version)?.binDir;
      if (bin) dirs.push(bin);
    }
    if (this.stacks.get(p.id)?.packageManager === 'bun') {
      const bun = this.bunChoice(p);
      if (bun.binDir) dirs.push(bun.binDir);
    }
    if (this.hasGo(p)) {
      const go = this.goChoice(p);
      if (go.binDir) dirs.push(go.binDir);
    }
    // cargo / rustup's proxies (they pick the toolchain from rust-toolchain.toml), trunk, dx, Solana, anchor.
    if (this.hasRust(p)) dirs.push(...rusts.rustPathDirs());
    let phpEnv: Record<string, string> = {};
    const stackNow = this.stacks.get(p.id);
    if (stackNow?.runtime === 'php' || stackNow?.subRuntimes?.includes('php')) {
      const choice = this.phpChoice(p);
      const inst = this.installedPhps.find((i) => i.version === choice.version);
      // Wrapper folder first: `php`/`composer` = this site's version with DevCatz's php.ini.
      if (inst) {
        dirs.unshift(phps.siteBinDir(inst));
        phpEnv = phps.iniEnv(inst.version);
      }
      // Old dev domain → this site's (Vite/Wayfinder, queue, scheduler and artisan see the same app.domain as requests).
      if (stackNow?.runtime === 'php') phpEnv = { ...phpEnv, ...(this.envOverrides.get(p.id) ?? {}) };
    }
    // Python: the project's venv first (python, uvicorn, celery …), and output without buffering (live logs).
    let pyEnv: Record<string, string> = {};
    const py = this.stacks.get(p.id)?.python;
    if (stackNow?.subRuntimes?.includes('python')) dirs.push(join(pythons.pythonDir(), 'bin'));
    if (this.stacks.get(p.id)?.runtime === 'python') {
      if (py?.venv) {
        dirs.unshift(join(p.path, py.venv, isWin ? 'Scripts' : 'bin'));
        pyEnv = { VIRTUAL_ENV: join(p.path, py.venv) };
      }
      dirs.push(join(pythons.pythonDir(), 'bin'));
      pyEnv.PYTHONUNBUFFERED = '1';
    }
    // The site's Redis DB index (any stack).
    const extra = { ...phpEnv, ...pyEnv, ...(this.redisEnv.get(p.id) ?? {}) };
    if (!dirs.length) return extra;
    // `Path` with `;` on Windows, `PATH` with `:` on macOS.
    const key = pathKey(getShellEnv());
    return { ...extra, [key]: joinPath([...dirs, ...splitPath(getShellEnv()[key])]) };
  }

  async nodeInstall(version: string): Promise<void> {
    if (this.nodeInstalling && this.nodeInstalling.phase !== 'done' && this.nodeInstalling.phase !== 'error') {
      throw new Error(`Already installing ${this.nodeInstalling.version}`);
    }
    try {
      await nodes.install(version, (p) => {
        this.nodeInstalling = p;
        this.changed();
      });
      this.nodeInstalling = null;
      this.refreshNodes();
      // First managed version becomes the default.
      if (!store.settings.nodeDefault) {
        store.updateSettings({ nodeDefault: version });
        nodes.writeShims(version);
      }
    } catch (err) {
      this.nodeInstalling = { version, phase: 'error', received: 0, total: 0, error: (err as Error).message };
      throw err;
    } finally {
      this.changed();
    }
  }

  nodeUninstall(version: string): void {
    nodes.uninstall(version);
    this.refreshNodes();
    this.changed();
  }

  nodeSetDefault(version: string | null): void {
    store.updateSettings({ nodeDefault: version });
    nodes.writeShims(version);
    this.changed();
  }

  // -------------------------------------------------------------------- bun

  async refreshBuns(): Promise<void> {
    this.installedBuns = await buns.listInstalled();
    const def = store.settings.bunDefault;
    if (def && !this.installedBuns.some((b) => b.version === def)) store.updateSettings({ bunDefault: null });
    buns.writeShims(this.installedBuns.find((b) => b.version === store.settings.bunDefault)?.binDir ?? null);
  }

  bunChoice(p: ProjectConfig): BunChoice {
    return buns.chooseBun(buns.readBunSpec(p.path), this.installedBuns, store.settings.bunDefault);
  }

  async bunInstall(version: string): Promise<void> {
    if (this.bunInstalling && this.bunInstalling.phase !== 'done' && this.bunInstalling.phase !== 'error') {
      throw new Error(`Already installing Bun ${this.bunInstalling.version}`);
    }
    try {
      await buns.install(version, (prog) => {
        this.bunInstalling = prog;
        this.changed();
      });
      this.bunInstalling = null;
      // First managed version becomes the default.
      if (!store.settings.bunDefault) store.updateSettings({ bunDefault: version });
      await this.refreshBuns();
    } catch (err) {
      this.bunInstalling = { version, phase: 'error', received: 0, total: 0, error: (err as Error).message };
      throw err;
    } finally {
      this.changed();
    }
  }

  async bunUninstall(version: string): Promise<void> {
    buns.uninstall(version);
    await this.refreshBuns();
    this.changed();
  }

  async bunSetDefault(version: string | null): Promise<void> {
    store.updateSettings({ bunDefault: version });
    await this.refreshBuns();
    this.changed();
  }

  // --------------------------------------------------------------------- go

  private hasGo(p: ProjectConfig): boolean {
    return (this.stacks.get(p.id)?.apps ?? []).some((a) => a.framework === 'go');
  }

  async refreshGos(): Promise<void> {
    this.installedGos = await golang.listInstalled();
    const def = store.settings.goDefault;
    if (def && !this.installedGos.some((g) => g.version === def)) store.updateSettings({ goDefault: null });
    golang.writeShims(this.installedGos.find((g) => g.version === store.settings.goDefault)?.binDir ?? null);
  }

  goChoice(p: ProjectConfig, stack: StackInfo | undefined = this.stacks.get(p.id)): GoChoice {
    const goApp = (stack?.apps ?? []).find((a) => a.framework === 'go');
    const spec = goApp ? golang.readGoSpec(join(p.path, goApp.dir)) : null;
    const pinned = p.goVersion ? this.installedGos.find((g) => g.version === p.goVersion) : undefined;
    if (pinned) return { version: pinned.version, binDir: pinned.binDir, reason: 'site', spec, missing: false };
    return golang.chooseGo(spec, this.installedGos, store.settings.goDefault);
  }

  async goInstall(version: string): Promise<void> {
    if (this.goInstalling && this.goInstalling.phase !== 'done' && this.goInstalling.phase !== 'error') {
      throw new Error(`Already installing Go ${this.goInstalling.version}`);
    }
    try {
      await golang.install(version, (prog) => {
        this.goInstalling = prog;
        this.changed();
      });
      this.goInstalling = null;
      if (!store.settings.goDefault) store.updateSettings({ goDefault: version });
      await this.refreshGos();
    } catch (err) {
      this.goInstalling = { version, phase: 'error', received: 0, total: 0, error: (err as Error).message };
      throw err;
    } finally {
      this.changed();
    }
  }

  async goUninstall(version: string): Promise<void> {
    golang.uninstall(version);
    await this.refreshGos();
    this.changed();
  }

  async goSetDefault(version: string | null): Promise<void> {
    store.updateSettings({ goDefault: version });
    await this.refreshGos();
    this.changed();
  }

  // --------------------------------------------------------------------- rust

  /** Rust apps, or a Tauri app (its src-tauri crate builds with cargo). */
  private hasRust(p: ProjectConfig): boolean {
    return (this.stacks.get(p.id)?.apps ?? []).some((a) => a.framework === 'rust' || a.library === 'tauri');
  }

  async refreshRust(): Promise<void> {
    this.rustupVer = await rusts.rustupVersion();
    this.rustToolchains = rusts.sortInstalled(await rusts.listInstalled());
    this.rustTargets = await rusts.installedTargets();
    this.rustTools = await rusts.toolStates();
    this.rustLinkerMissing = this.rustupVer ? await rusts.linkerMissing() : false;
  }

  /** The toolchain (rust-toolchain.toml's, else rustup's default) and the CLIs / target the site's apps run with. */
  rustChoice(p: ProjectConfig, stack: StackInfo | undefined = this.stacks.get(p.id)): RustChoice {
    const apps = (stack?.apps ?? []).filter((a) => a.framework === 'rust' || a.library === 'tauri');
    const none: RustChoice = { version: null, toolchain: null, reason: 'none', spec: null, missing: true, needs: [] };
    if (!apps.length) return { ...none, missing: false };
    const spec = rusts.readToolchainSpec(p.path) ?? apps.map((a) => rusts.readToolchainSpec(join(p.path, a.dir))).find(Boolean) ?? null;
    const def = this.rustToolchains.find((t) => t.isDefault);
    const tc = spec ? this.rustToolchains.find((t) => t.channel === spec || t.version === spec || t.channel.startsWith(`${spec}-`)) : def;
    const needs = new Set<RustChoice['needs'][number]>();
    for (const a of apps) {
      const cmd = a.command ?? '';
      if (cmd.startsWith('trunk')) needs.add('trunk').add('wasm32');
      if (cmd.startsWith('dx ')) needs.add('dioxus-cli').add('wasm32');
      if (cmd.startsWith('cargo leptos')) needs.add('cargo-leptos').add('wasm32');
      if (cmd.startsWith('cargo tauri')) needs.add('tauri-cli');
      if (/(^|\s)anchor /.test(cmd)) needs.add('solana').add('anchor');
    }
    const installed = (n: RustChoice['needs'][number]) =>
      n === 'wasm32' ? this.rustTargets.includes(rusts.WASM_TARGET) : this.rustTools.some((t) => t.id === n && t.installed);
    return {
      version: tc?.version ?? null,
      toolchain: tc?.channel ?? spec,
      reason: spec ? 'project' : def ? 'default' : 'none',
      spec,
      // rustup installs a rust-toolchain.toml channel by itself on the first cargo run; only no Rust at all is missing.
      missing: !this.rustupVer,
      needs: this.rustupVer ? [...needs].filter((n) => !installed(n)) : [],
    };
  }

  /** One install at a time: rustup, a toolchain, the wasm32 target or a tool; progress lines in state.rust.installing. */
  private async rustTask(what: string, work: (detail: (line: string) => void) => Promise<void>): Promise<void> {
    if (this.rustInstalling && this.rustInstalling.phase !== 'done' && this.rustInstalling.phase !== 'error') {
      throw new Error(`Already installing ${this.rustInstalling.version}`);
    }
    this.rustInstalling = { version: what, phase: 'extract', received: 0, total: 0 };
    this.changed();
    let last = 0;
    try {
      await work((detail) => {
        this.rustInstalling = { version: what, phase: 'extract', received: 0, total: 0, detail };
        // Cargo prints hundreds of lines a second while compiling: the window hears about every fifth of a second.
        if (Date.now() - last > 200) {
          last = Date.now();
          this.changed();
        }
      });
      this.rustInstalling = null;
      await this.refreshRust();
    } catch (err) {
      this.rustInstalling = { version: what, phase: 'error', received: 0, total: 0, error: (err as Error).message };
      throw err;
    } finally {
      this.changed();
    }
  }

  rustInstall(): Promise<void> {
    return this.rustTask('Rust', (detail) =>
      rusts.installRustup((prog) => {
        if (prog.phase === 'download') {
          this.rustInstalling = { ...prog, version: 'Rust' };
          this.changed();
        } else if (prog.detail) detail(prog.detail);
      }),
    );
  }

  rustRemote(refresh = false): Promise<RemoteRust[]> {
    return rusts.listRemote(refresh);
  }

  rustToolchainInstall(name: string): Promise<void> {
    return this.rustTask(`Rust ${name}`, (detail) => rusts.installToolchain(name, detail));
  }

  async rustToolchainUninstall(name: string): Promise<void> {
    await rusts.uninstallToolchain(name);
    await this.refreshRust();
    this.changed();
  }

  async rustSetDefault(name: string): Promise<void> {
    await rusts.setDefault(name);
    await this.refreshRust();
    this.changed();
  }

  rustTargetAdd(target: string): Promise<void> {
    return this.rustTask(target, (detail) => rusts.addTarget(target, detail));
  }

  rustToolInstall(id: RustToolId): Promise<void> {
    const tool = rusts.RUST_TOOLS.find((t) => t.id === id);
    if (!tool) throw new Error(`Unknown tool ${id}`);
    return this.rustTask(tool.label, (detail) => rusts.installTool(id, detail));
  }

  /** `cargo fetch`, streamed into the site's log (cargo builds on Start anyway; this downloads the crates first). */
  private async installRustDeps(p: ProjectConfig): Promise<void> {
    if (this.dbTasks.has(p.id)) throw new Error(`Busy: ${this.dbTasks.get(p.id)}`);
    if (!this.rustupVer) throw new Error('Rust is not installed. Install it on the Rust page (sidebar) first.');
    this.dbTasks.set(p.id, 'cargo fetch');
    this.changed();
    try {
      const code = await stream(p.path, 'cargo fetch', (t) => this.processes.log(p.id, 'sys', t), this.runtimeEnv(p));
      if (code !== 0) throw new Error(`cargo fetch failed (exit ${code}); see the log`);
    } finally {
      this.dbTasks.delete(p.id);
      this.rescan();
    }
  }

  // ----------------------------------------------------------------- python

  async refreshPythons(): Promise<void> {
    this.uvVer = await pythons.uvVersion();
    this.installedPythons = await pythons.listInstalled().catch(() => []);
    const def = store.settings.pythonDefault;
    if (def && !this.installedPythons.some((i) => i.version === def)) store.updateSettings({ pythonDefault: null });
  }

  /** The venv's Python when there is one; else what a new venv would be created with. */
  pythonChoice(p: ProjectConfig, stack: StackInfo | undefined = this.stacks.get(p.id)): PythonChoice {
    const py = stack?.python;
    if (py?.venv && py.venvVersion && !p.pythonVersion) return { version: py.venvVersion, reason: 'venv', spec: py.spec, missing: false };
    return pythons.choosePython(py?.spec ?? null, p.pythonVersion, this.installedPythons, store.settings.pythonDefault);
  }

  private trackInstall<T>(set: (p: RuntimeInstallProgress | null) => void, label: string, work: (report: (p: RuntimeInstallProgress) => void) => Promise<T>): Promise<T> {
    const report = (prog: RuntimeInstallProgress) => {
      set(prog);
      this.changed();
    };
    return work(report)
      .then((r) => {
        set(null);
        return r;
      })
      .catch((err) => {
        set({ version: label, phase: 'error', received: 0, total: 0, error: (err as Error).message });
        throw err;
      })
      .finally(() => this.changed());
  }

  async uvInstall(): Promise<void> {
    await this.trackInstall((x) => (this.pythonInstalling = x), 'uv', (report) => pythons.installUv(report));
    await this.refreshPythons();
    this.changed();
  }

  async pythonRemote() {
    if (!pythons.uvPath()) await this.uvInstall();
    return pythons.listRemote();
  }

  async pythonInstall(version: string): Promise<void> {
    if (this.pythonInstalling && this.pythonInstalling.phase !== 'done' && this.pythonInstalling.phase !== 'error') {
      throw new Error(`Already installing ${this.pythonInstalling.version}`);
    }
    if (!pythons.uvPath()) await this.uvInstall();
    await this.trackInstall((x) => (this.pythonInstalling = x), version, (report) => pythons.install(version, report));
    if (!store.settings.pythonDefault) store.updateSettings({ pythonDefault: version });
    await this.refreshPythons();
    this.rescan();
  }

  async pythonUninstall(version: string): Promise<void> {
    const inst = this.installedPythons.find((i) => i.version === version);
    if (!inst || inst.source !== 'mrcatz') throw new Error(`Python ${version} is not managed by DevCatz`);
    await pythons.uninstall(version);
    await this.refreshPythons();
    this.changed();
  }

  async pythonSetDefault(version: string | null): Promise<void> {
    store.updateSettings({ pythonDefault: version });
    await this.refreshPythons();
    this.changed();
  }

  /**
   * Creates `.venv` and installs the project's dependencies: uv for PEP 621 /
   * requirements / Pipfile projects (and uv projects), the project's own
   * Poetry / PDM / Pipenv when its lockfile says so (with the venv kept in the
   * project), so Start finds `.venv/bin`.
   */
  private async installPythonDeps(p: ProjectConfig, stack: StackInfo): Promise<void> {
    const py = stack.python!;
    if (!pythons.uvPath()) await this.uvInstall();
    const choice = this.pythonChoice(p, stack);
    let version = choice.version;
    if (!version || choice.missing) {
      // Nothing installed that fits: let uv fetch what the project asks for (or the newest).
      version = choice.spec && /^\d+(\.\d+){0,2}$/.test(choice.spec) ? choice.spec : (choice.spec ?? '3.13');
    }
    const uvBin = pythons.uvPath()!;
    const req = ['requirements.txt', 'requirements/dev.txt', 'requirements/local.txt', 'requirements/base.txt'].find((f) => existsSync(join(p.path, f)));
    const pyproject = existsSync(join(p.path, 'pyproject.toml')) ? readFileSync(join(p.path, 'pyproject.toml'), 'utf8') : '';
    const pep621 = /^\s*dependencies\s*=/m.test(pyproject);
    const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
    let command: string;
    if (py.tool === 'poetry' && !pep621) command = `POETRY_VIRTUALENVS_IN_PROJECT=true poetry env use ${q(version)} && POETRY_VIRTUALENVS_IN_PROJECT=true poetry install`;
    else if (py.tool === 'pdm') command = `pdm venv create --force ${q(version)} >/dev/null 2>&1; pdm install`;
    else if (py.tool === 'pipenv' && !req) command = `PIPENV_VENV_IN_PROJECT=1 pipenv install --dev --python ${q(version)}`;
    else if (pep621) command = `${q(uvBin)} sync --python ${q(version)}`;
    else if (req) command = `${q(uvBin)} venv --allow-existing --python ${q(version)} .venv && ${q(uvBin)} pip install --python .venv/bin/python -r ${q(req)}`;
    else command = `${q(uvBin)} venv --allow-existing --python ${q(version)} .venv`;
    if (this.dbTasks.has(p.id)) throw new Error(`Busy: ${this.dbTasks.get(p.id)}`);
    this.dbTasks.set(p.id, 'installing Python dependencies');
    this.changed();
    try {
      const code = await stream(p.path, command, (t) => this.processes.log(p.id, 'sys', t), { ...this.runtimeEnv(p), ...pythons.uvEnv() });
      if (code !== 0) throw new Error(`Installing dependencies failed (exit ${code}); see the log`);
    } finally {
      this.dbTasks.delete(p.id);
      await this.refreshPythons();
      this.rescan();
    }
  }

  // -------------------------------------------------------------------- php

  async refreshPhps(): Promise<void> {
    this.installedPhps = await phps.listInstalled();
    // Windows: php.ini written before extensions moved to conf.d/20-<name>.ini still loads them itself: rewrite it once.
    for (const p of this.installedPhps) {
      if (isWin && p.source === 'mrcatz' && phps.iniNeedsUpgrade(p.version)) {
        await phps.writeIni(p.php, p.version, phps.readIni(p.version)).catch((e) => console.error(`php.ini ${p.version}:`, e));
        this.fpm.reload(p.version);
      }
    }
    const def = store.settings.phpDefault;
    if (def && !this.installedPhps.some((i) => i.version === def)) store.updateSettings({ phpDefault: null });
    const defInst = this.installedPhps.find((i) => i.version === store.settings.phpDefault) ?? this.installedPhps.find((i) => i.source === 'mrcatz') ?? null;
    phps.writeShims(defInst);
    // The shared Reverb: the default PHP when it is 8.2+, else the newest installed 8.2+.
    const fit = [defInst, ...[...this.installedPhps].sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }))].find(
      (i): i is InstalledPhp => !!i && phps.satisfies(i.version, '>=8.2'),
    );
    setPhpRuntime(() =>
      fit
        ? {
            php: fit.php,
            // siteBinDir has a composer wrapper when DevCatz's Composer is installed; else Herd's / Homebrew's composer on PATH.
            composer: 'composer',
            env: { ...phps.iniEnv(fit.version), [pathKey(getShellEnv())]: joinPath([phps.siteBinDir(fit), ...splitPath(getShellEnv()[pathKey(getShellEnv())])]) },
          }
        : null,
    );
  }

  phpChoice(p: ProjectConfig): PhpChoice {
    return phps.choosePhp(phps.readPhpSpec(p.path), this.installedPhps, store.settings.phpDefault, p.phpVersion);
  }

  /** One FPM pool per PHP version in use; pools of unused versions stop. */
  syncFpm(): void {
    const wanted = new Map<string, { php: InstalledPhp; sites: string[] }>();
    for (const p of this.projects) {
      if (this.stacks.get(p.id)?.runtime !== 'php') continue;
      const v = this.phpChoice(p).version;
      const inst = this.installedPhps.find((i) => i.version === v);
      if (!inst) continue;
      // First use of a version: write its php.ini (defaults like Laravel Herd's).
      if (!existsSync(join(phps.etcDir(inst.version), 'conf.d/99-mrcatz.ini'))) {
        void phps.writeIni(inst.php, inst.version, phps.readIni(inst.version)).then(() => this.fpm.reload(inst.version));
      }
      const w = wanted.get(inst.version) ?? { php: inst, sites: [] };
      w.sites.push(p.name);
      wanted.set(inst.version, w);
    }
    this.fpm.sync(wanted);
    // PHP sites are always on: take their preview once the pool is up (no Start needed).
    for (const p of this.projects) {
      if (this.stacks.get(p.id)?.runtime !== 'php' || screenshotTime(p.id) || this.previewQueued.has(p.id)) continue;
      const v = this.phpChoice(p).version;
      if (!v || !this.installedPhps.some((i) => i.version === v)) continue;
      this.previewQueued.add(p.id);
      setTimeout(() => void this.screenshot(p.id), 4000);
    }
  }

  /** "Start" for PHP sites: Vite (laravel-vite-plugin) + optional queue worker / scheduler. Serving needs nothing. */
  private async launchPhp(p: ProjectConfig, stack: StackInfo): Promise<void> {
    const id = p.id;
    const php = this.phpChoice(p);
    if (!php.version) {
      const msg = 'PHP is not installed. Install it on the PHP page (sidebar).';
      this.processes.log(id, 'sys', msg);
      throw new Error(msg);
    }
    this.processes.log(id, 'sys', `Using PHP ${php.version} (${php.reason}${php.source === 'herd' ? ', Laravel Herd build' : ''}); served by ${words.phpServer}, always on`);
    if (stack.depsMissing) {
      const msg = 'vendor/ is missing: use "Install dependencies" (composer install) first.';
      this.processes.log(id, 'sys', msg);
      throw new Error(msg);
    }
    const base = this.runtimeEnv(p);
    const specs: { label: string; cwd: string; command: string; env: Record<string, string> }[] = [];
    const vite = stack.apps.find((a) => a.kind === 'assets' && a.framework === 'vite');
    const mix = stack.apps.find((a) => a.framework === 'mix');
    if (mix && !stack.jsDepsMissing) specs.push({ label: 'mix', cwd: p.path, command: mix.command ?? 'npx mix watch', env: base });
    else if (mix) this.processes.log(id, 'sys', 'node_modules is missing, so Laravel Mix is not started (the built public/ assets are used).');
    if (vite && !stack.jsDepsMissing) {
      if (await this.reassignBusyPorts(p, stack)) return this.launchPhp(p, this.stacks.get(id)!);
      const pm = stack.packageManager ?? 'npm';
      const run = runScriptCommand(pm, 'dev');
      const sep = pm === 'npm' ? ' --' : '';
      // --host 127.0.0.1: laravel-vite-plugin binds to <folder>.test when it finds a Herd/Valet certificate, which fails
      // (ENOTFOUND) whenever Herd's DNS is not running; DevCatz's proxy reaches Vite on 127.0.0.1 either way.
      specs.push({ label: 'vite', cwd: p.path, command: `${run}${sep} --port ${vite.port} --strictPort --host 127.0.0.1`, env: base });
      this.watchHotFile(p);
    } else if (vite) {
      this.processes.log(id, 'sys', 'node_modules is missing, so Vite is not started (assets from public/build are used).');
    }
    const laravel = stack.apps.some((a) => a.framework === 'laravel');
    if (laravel && p.queueWorker) specs.push({ label: 'queue', cwd: p.path, command: 'php artisan queue:work --tries=1', env: base });
    if (laravel && p.scheduler) specs.push({ label: 'schedule', cwd: p.path, command: 'php artisan schedule:work', env: base });
    if (laravel && p.reverb) {
      if (!detectRealtime(p.path).reverb) this.processes.log(id, 'sys', 'Reverb is on, but laravel/reverb is not in composer.json (composer require laravel/reverb).');
      else specs.push({ label: 'reverb', cwd: p.path, command: `php artisan reverb:start --host=127.0.0.1 --port=${this.reverbPort(p)}`, env: base });
    }
    if (!specs.length) {
      this.processes.log(id, 'sys', `Nothing to start: the site is served by ${words.phpServer} all the time. (Enable the queue worker or scheduler in Settings.)`);
      return;
    }
    this.processes.startMany(id, specs);
    // Without a dev server port to wait for (queue/scheduler only) the site is up right away.
    if (!vite || stack.jsDepsMissing) this.processes.markRunning(id);
    this.updateRoutes();
  }

  /**
   * laravel-vite-plugin writes public/hot as http://[::1]:<port>; point it at
   * the site's own origin instead, so @vite tags load same-origin over HTTPS
   * and the proxy forwards those requests (and the HMR socket) to Vite.
   */
  private watchHotFile(p: ProjectConfig): void {
    this.hotWatchers.get(p.id)?.close();
    const app = this.stacks.get(p.id)?.apps.find((a) => a.docroot !== undefined);
    if (!app) return;
    const dir = join(p.path, app.docroot ?? 'public');
    const hot = join(dir, 'hot');
    const fix = () => {
      try {
        const want = this.urlFor(p);
        const current = existsSync(hot) ? readFileSync(hot, 'utf8').trim() : null;
        if (current && current !== want) {
          // What Vite really listens on (https when laravel-vite-plugin found a Herd/Valet cert).
          this.viteTls.set(p.id, current.startsWith('https:'));
          this.viteOrigin.set(p.id, current.replace(/\/$/, ''));
          writeFileSync(hot, want);
        }
      } catch {
        /* file vanished */
      }
      this.updateRoutes();
    };
    try {
      const w = watch(dir, (_e, name) => {
        if (name === 'hot') setTimeout(fix, 50);
      });
      this.hotWatchers.set(p.id, w);
    } catch {
      /* no public dir */
    }
    fix();
  }

  /**
   * laravel-vite-plugin does not always delete public/hot when its process is
   * signalled; a stale one would make every other server of the app (Laravel
   * Herd's *.test too) look for a Vite that is gone. Remove ours.
   */
  private removeHotFile(id: string): void {
    const p = this.find(id);
    const app = this.stacks.get(id)?.apps.find((a) => a.docroot !== undefined);
    if (!p || !app) return;
    const hot = join(p.path, app.docroot ?? 'public', 'hot');
    try {
      if (existsSync(hot) && readFileSync(hot, 'utf8').trim() === this.urlFor(p)) rmSync(hot, { force: true });
    } catch {
      /* gone */
    }
    this.viteTls.delete(id);
    this.viteOrigin.delete(id);
  }

  /** composer install (vendor/) and, if there is a package.json, the JS install. */
  private async installPhpDeps(p: ProjectConfig): Promise<void> {
    const id = p.id;
    const stack = this.stacks.get(id)!;
    if (this.dbTasks.has(id)) throw new Error(`Busy: ${this.dbTasks.get(id)}`);
    if (!phps.composerInstalled()) throw new Error('Composer is not installed: install it on the PHP page first.');
    this.dbTasks.set(id, 'composer install');
    this.changed();
    try {
      const env = this.runtimeEnv(p);
      if (stack.depsMissing) {
        const code = await stream(p.path, 'composer install --no-interaction', (t) => this.processes.log(id, 'sys', t), env);
        if (code !== 0) throw new Error(`composer install failed (exit ${code}); see the log`);
      }
      if (stack.jsDepsMissing && stack.packageManager) {
        this.dbTasks.set(id, `${stack.packageManager} install`);
        this.changed();
        const code = await stream(p.path, `${stack.packageManager} install`, (t) => this.processes.log(id, 'sys', t), env);
        if (code !== 0) throw new Error(`${stack.packageManager} install failed (exit ${code}); see the log`);
      }
    } finally {
      this.dbTasks.delete(id);
      this.rescan();
    }
  }

  async phpInstall(version: string): Promise<void> {
    if (this.phpInstalling && this.phpInstalling.phase !== 'done' && this.phpInstalling.phase !== 'error') {
      throw new Error(`Already installing PHP ${this.phpInstalling.version}`);
    }
    try {
      // A legacy minor ("7.4") resolves to the exact version Homebrew installed.
      version = await phps.install(version, (prog) => {
        this.phpInstalling = prog;
        this.changed();
      });
      this.phpInstalling = null;
      if (!store.settings.phpDefault) store.updateSettings({ phpDefault: version });
      await this.refreshPhps();
      const inst = this.installedPhps.find((i) => i.version === version);
      if (inst) await phps.writeIni(inst.php, version, phps.readIni(version));
      // Extensions built for an older patch of the same minor load into this one too.
      const minor = version.split('.').slice(0, 2).join('.');
      const prev = this.installedPhps.filter((i) => i.source === 'mrcatz' && i.version !== version && i.version.startsWith(`${minor}.`)).sort((a, b) => nodes.compare(b.version, a.version))[0];
      if (inst?.source === 'mrcatz' && prev && !phpext.listInstalled(version).length) phpext.carryOver(prev.version, version);
      if (!phps.composerInstalled()) await phps.installComposer(() => undefined).catch(() => undefined);
      await this.refreshPhps();
      this.syncFpm();
    } catch (err) {
      this.phpInstalling = { version, phase: 'error', received: 0, total: 0, error: (err as Error).message };
      throw err;
    } finally {
      this.changed();
    }
  }

  async phpUninstall(version: string): Promise<void> {
    this.fpm.stop(version);
    phps.uninstall(version);
    phpext.pruneIni(version);
    await this.refreshPhps();
    this.syncFpm();
    this.changed();
  }

  async phpSetDefault(version: string | null): Promise<void> {
    store.updateSettings({ phpDefault: version });
    await this.refreshPhps();
    this.syncFpm();
    this.changed();
  }

  async phpGetIni(version: string): Promise<{ settings: PhpIniSettings; effective: Record<string, string> }> {
    const inst = this.installedPhps.find((i) => i.version === version);
    if (!inst) throw new Error(`PHP ${version} is not installed`);
    const settings = phps.readIni(version);
    const keys = Object.keys(settings).filter((k) => k !== 'extra');
    return { settings, effective: await phps.effectiveIni(inst.php, version, keys) };
  }

  async phpSetIni(version: string, settings: PhpIniSettings): Promise<void> {
    const inst = this.installedPhps.find((i) => i.version === version);
    if (!inst) throw new Error(`PHP ${version} is not installed`);
    await phps.writeIni(inst.php, version, settings);
    this.fpm.reload(version);
  }

  // ---------------------------------------------------------------- PHP extensions

  private phpExtTask: PhpExtTask | null = null;
  private builtinCache = new Map<string, string[]>();

  async phpExtensions(version: string): Promise<PhpExtensions> {
    const inst = this.installedPhps.find((i) => i.version === version);
    if (!inst) throw new Error(`PHP ${version} is not installed`);
    // macOS builds PECL with phpize against static-php.dev's 8.x; Windows takes php.net's ready-made DLLs (7.4 too).
    const supported = inst.source === 'mrcatz' && (isWin || (!version.startsWith('7.') && !version.startsWith('5.')));
    if (!this.builtinCache.has(version)) this.builtinCache.set(version, await phpext.builtin(inst.php));
    return {
      version,
      supported,
      builtin: this.builtinCache.get(version)!,
      installed: supported ? phpext.listInstalled(version) : [],
      bundled: supported ? phpext.listBundled(version) : [],
      catalog: phpext.CATALOG,
      toolkit: isWin || phpext.hasToolkit(version),
      problem: supported ? await phpext.buildProblem() : null,
    };
  }

  async phpExtInstall(version: string, pkg: string): Promise<void> {
    if (this.phpExtTask && this.phpExtTask.phase !== 'done' && this.phpExtTask.phase !== 'error') {
      throw new Error(`Already building ${this.phpExtTask.pkg} for PHP ${this.phpExtTask.version}`);
    }
    const inst = this.installedPhps.find((i) => i.version === version);
    if (!inst || inst.source !== 'mrcatz') throw new Error(`PHP ${version} is not one of DevCatz's builds`);
    const t: PhpExtTask = { version, pkg, phase: 'download', detail: 'Starting', log: [] };
    this.phpExtTask = t;
    this.changed();
    let last = 0;
    const tick = () => {
      if (Date.now() - last > 250) {
        last = Date.now();
        this.changed();
      }
    };
    try {
      await phpext.install(
        version,
        inst.php,
        pkg,
        (patch) => {
          Object.assign(t, patch);
          this.changed();
        },
        (line) => {
          t.log.push(line);
          if (t.log.length > 200) t.log.splice(0, t.log.length - 200);
          tick();
        },
      );
      t.phase = 'done';
      t.detail = `${pkg} installed for PHP ${version}`;
      this.fpm.reload(version);
    } catch (err) {
      t.phase = 'error';
      t.error = (err as Error).message;
      throw err;
    } finally {
      this.changed();
    }
  }

  phpExtSetEnabled(version: string, module: string, on: boolean): void {
    phpext.setEnabled(version, module, on);
    this.fpm.reload(version);
  }

  phpExtRemove(version: string, module: string): void {
    phpext.remove(version, module);
    this.fpm.reload(version);
  }

  async shimPathSet(on: boolean): Promise<void> {
    await setUserPath(nodes.shimDir(), on);
    this.changed();
  }

  phpExtDismiss(): void {
    if (this.phpExtTask?.phase === 'done' || this.phpExtTask?.phase === 'error') this.phpExtTask = null;
    this.changed();
  }

  async composerInstall(): Promise<void> {
    await phps.installComposer((prog) => {
      this.phpInstalling = prog.phase === 'done' ? null : prog;
      this.changed();
    });
    await this.refreshPhps();
    this.changed();
  }

  laravelLog(id: string, lines = 400): { file: string | null; text: string } {
    const p = this.find(id);
    if (!p) return { file: null, text: '' };
    const dir = join(p.path, 'storage/logs');
    let files: string[] = [];
    try {
      files = readdirSync(dir).filter((f) => /^laravel.*\.log$/.test(f));
    } catch {
      return { file: null, text: '' };
    }
    const newest = files.map((f) => ({ f, t: statSync(join(dir, f)).mtimeMs })).sort((a, b) => b.t - a.t)[0]?.f;
    if (!newest) return { file: null, text: '' };
    const file = join(dir, newest);
    // Read only the tail of big logs.
    const size = statSync(file).size;
    const buf = readFileSync(file);
    const text = buf.subarray(Math.max(0, size - 400_000)).toString('utf8');
    return { file, text: text.split('\n').slice(-lines).join('\n') };
  }

  /** Sites Laravel Herd serves: symlinks in its Sites folder + projects inside its parked folders. */
  herdSites(): HerdSite[] {
    const base = join(homedir(), 'Library/Application Support/Herd/config/valet');
    const out: HerdSite[] = [];
    const seen = new Set<string>();
    const linkedPaths = new Set(this.projects.map((p) => p.path));
    const add = (name: string, path: string, via: HerdSite['via']) => {
      if (seen.has(path) || !isProjectDir(path)) return;
      seen.add(path);
      out.push({ name, path, via, linked: linkedPaths.has(path) });
    };
    const sitesDir = join(base, 'Sites');
    try {
      for (const name of readdirSync(sitesDir)) {
        try {
          add(name, realpathSync(join(sitesDir, name)), 'link');
        } catch {
          /* dangling link */
        }
      }
    } catch {
      /* no Herd */
    }
    try {
      const cfg = JSON.parse(readFileSync(join(base, 'config.json'), 'utf8')) as { paths?: string[] };
      for (const parked of cfg.paths ?? []) {
        if (parked.replace(/\/$/, '') === sitesDir) continue;
        try {
          for (const name of readdirSync(parked)) add(name, join(parked, name), 'park');
        } catch {
          /* folder gone */
        }
      }
    } catch {
      /* no config */
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Menu bar "Restart services": proxy, DNS and every PHP-FPM pool. */
  async restartServices(): Promise<void> {
    await this.proxy.listen(store.settings.httpsPort, store.settings.httpPort);
    await this.dns.start(tld());
    await this.fpm.restartAll();
    this.updateRoutes();
    this.changed();
  }

  // ------------------------------------------------------------ screenshots

  /** Takes the site preview through the proxy's HTTP port (no certificate prompts). */
  async screenshot(id: string): Promise<boolean> {
    const p = this.find(id);
    if (!p) return false;
    this.capturing.add(id);
    this.changed();
    try {
      return await captureScreenshot(id, `${this.urlFor(p)}/`);
    } finally {
      this.capturing.delete(id);
      this.changed();
    }
  }

  // --------------------------------------------------------------- database

  async db(id: string, action: DbAction, arg?: string): Promise<void> {
    const p = this.find(id);
    if (!p) return;
    if (this.dbTasks.has(id)) throw new Error(`Busy: ${this.dbTasks.get(id)}`);
    this.dbTasks.set(id, DB_TASK_LABELS[action]);
    this.changed();
    try {
      const code = await runDbAction(this.state(p), action, arg, (t) => this.processes.log(id, 'db', t), this.runtimeEnv(p));
      if (code !== 0) throw new Error(`${DB_TASK_LABELS[action]} failed (exit ${code}); see the log`);
    } finally {
      this.dbTasks.delete(id);
      await this.pollDatabases();
      this.changed();
    }
  }

  // ---------------------------------------------------------- object storage

  /** S3 credentials of a running service. */
  s3Target(kind: StorageKind): s3.S3Target {
    const c = this.storage.config(kind);
    if (!c) throw new Error('Not installed');
    if (this.storage.processes.getStatus(`storage:${kind}`).status !== 'running') throw new Error(`Start ${ENGINES[kind].name} first`);
    return { port: c.apiPort, accessKey: c.accessKey, secretKey: c.secretKey, region: s3Region(c) };
  }

  async s3Buckets(kind: StorageKind): Promise<S3Bucket[]> {
    const list = await s3.listBuckets(this.s3Target(kind));
    // SeaweedFS before bucket policies: public = anonymous read in its identity file.
    if (kind === 'seaweedfs') {
      const pub = new Set(seaweedPublic());
      for (const b of list) b.public ||= pub.has(b.name);
    }
    return list;
  }

  /**
   * Public read = a bucket policy allowing s3:GetObject to everyone, applied
   * live (SeaweedFS 4.x included). Older SeaweedFS builds without bucket
   * policies fall back to an anonymous identity in s3.json, which needs a restart.
   */
  async s3SetPublic(kind: StorageKind, bucket: string, on: boolean): Promise<void> {
    try {
      await s3.setPublic(this.s3Target(kind), bucket, on);
    } catch (err) {
      if (kind !== 'seaweedfs') throw err;
      setSeaweedPublic(bucket, on);
      await this.storage.action(kind, 'restart');
      return;
    }
    // A bucket made public the old way keeps anonymous read through s3.json until it is dropped from there.
    if (kind === 'seaweedfs' && !on && seaweedPublic().includes(bucket)) {
      setSeaweedPublic(bucket, false);
      await this.storage.action(kind, 'restart');
    }
  }

  // -------------------------------------------------------------------- env

  private envDirs(id: string): string[] {
    return [...new Set((this.stacks.get(id)?.apps ?? []).map((a) => a.dir))];
  }

  envFiles(id: string): EnvFileInfo[] {
    return envfiles.listEnvFiles(this.project(id).path, this.envDirs(id));
  }

  envRead(id: string, path: string) {
    return envfiles.readEnv(envfiles.envPath(this.project(id).path, path, this.envDirs(id)));
  }

  envWrite(id: string, path: string, content: string, mtime: number | null): number {
    const p = this.project(id);
    if (p.envLocked !== false) throw new Error('The environment is locked; unlock it to edit');
    const at = envfiles.writeEnv(envfiles.envPath(p.path, path, this.envDirs(id)), content, mtime);
    this.processes.log(id, 'sys', `Saved ${path}${this.processes.isActive(id) ? ' (restart the site to apply)' : ''}`);
    // Ports, database and Redis are read from .env.
    this.rescan();
    return at;
  }

  /** Explicit write from another page (Storage → Connection) after a preview; allowed while the Env tab is locked. */
  envMerge(id: string, path: string, entries: Record<string, string>, comment: string, apply: boolean) {
    const p = this.project(id);
    const abs = envfiles.envPath(p.path, path, this.envDirs(id));
    const { content } = envfiles.readEnv(abs);
    const plan = envfiles.planMerge(content, entries);
    if (apply && (plan.added.length || plan.changed.length)) {
      envfiles.writeEnv(abs, envfiles.applyMerge(content, entries, comment), null);
      this.processes.log(id, 'sys', `${path}: set ${[...plan.added, ...plan.changed.map((c) => c.key)].join(', ')}${this.processes.isActive(id) ? ' (restart the site to apply)' : ''}`);
      this.rescan();
    }
    return plan;
  }

  async envCreate(id: string, path: string): Promise<void> {
    const p = this.project(id);
    const dirs = this.envDirs(id);
    const abs = envfiles.envPath(p.path, path, dirs);
    const info = this.envFiles(id).find((f) => f.path === path);
    envfiles.createEnv(abs, info?.example ? envfiles.envPath(p.path, info.example, dirs) : null);
    this.processes.log(id, 'sys', `Created ${path}${info?.example ? ` from ${info.example}` : ''}`);
    const laravel = this.stacks.get(id)?.apps.some((a) => a.framework === 'laravel');
    if (laravel && path === '.env' && existsSync(join(p.path, 'vendor/autoload.php'))) await this.envKeyGenerate(id).catch(() => undefined);
    this.rescan();
  }

  /** Laravel: `php artisan key:generate` (a new APP_KEY in .env) with the site's own PHP; output in Logs. */
  async envKeyGenerate(id: string): Promise<void> {
    const p = this.project(id);
    if (!this.stacks.get(id)?.apps.some((a) => a.framework === 'laravel')) throw new Error('Not a Laravel site');
    if (!existsSync(join(p.path, '.env'))) throw new Error('Create .env first');
    if (!existsSync(join(p.path, 'vendor/autoload.php'))) throw new Error('vendor/ is missing: use "Install dependencies" (composer install) first');
    if (!this.phpChoice(p).version) throw new Error('PHP is not installed: install it from the site\'s Overview first');
    const code = await stream(p.path, 'php artisan key:generate --force --no-interaction', (t) => this.processes.log(id, 'sys', t), this.runtimeEnv(p));
    if (code !== 0) {
      this.processes.log(id, 'sys', 'key:generate failed; set APP_KEY yourself');
      throw new Error('php artisan key:generate failed: see Logs');
    }
    this.rescan();
  }

  goDbInfo(id: string): GoDbInfo[] {
    const p = this.project(id);
    const apps = (this.stacks.get(id)?.apps ?? []).filter((a) => a.framework === 'go');
    return apps.map((a) => gorm.goDbInfo(p.path, a.dir, a.name)).filter((x): x is GoDbInfo => !!x);
  }

  async goDbTask(id: string, dir: string, taskId: string, name?: string): Promise<void> {
    const p = this.project(id);
    const task = this.goDbInfo(id).find((i) => i.dir === dir)?.tasks.find((t) => t.id === taskId);
    if (!task) throw new Error('Unknown task');
    let command = task.command;
    if (task.needsName) {
      if (!name || !/^[A-Za-z0-9_]+$/.test(name)) throw new Error('Name: letters, digits and _ only');
      command = command.replace('{name}', name);
    }
    if (task.needsBin && !(await hasCommand(task.needsBin))) {
      throw new Error(task.needsBin === 'atlas' ? 'Atlas CLI is not installed: brew install ariga/tap/atlas' : `${task.needsBin} is not installed`);
    }
    if (this.dbTasks.has(id)) throw new Error(`Busy: ${this.dbTasks.get(id)}`);
    const label = `${task.tool} ${task.label.replace('…', '')}`;
    this.dbTasks.set(id, label);
    this.changed();
    try {
      const code = await stream(join(p.path, task.cwd), command, (t) => this.processes.log(id, 'db', t), this.runtimeEnv(p));
      if (code !== 0) throw new Error(`${label} failed (exit ${code}); see the log`);
    } finally {
      this.dbTasks.delete(id);
      await this.pollDatabases();
      this.changed();
    }
  }

  /** A framework command of the site (CodeIgniter spark, Yii, Symfony console, CakePHP, WP-CLI, Django, Alembic …). */
  async stackTask(id: string, taskId: string, name?: string): Promise<void> {
    const p = this.project(id);
    const task = this.stacks.get(id)?.tasks?.find((t) => t.id === taskId);
    if (!task) throw new Error('Unknown task');
    let command = task.command;
    if (task.needsName) {
      if (!name || !/^[A-Za-z0-9_][A-Za-z0-9_ -]{0,80}$/.test(name)) throw new Error('Name: letters, digits, spaces, _ and -');
      // Quoted: Alembic / Django names may have spaces.
      command = command.replace('{name}', `'${name.replace(/'/g, '')}'`);
    }
    if (task.needsBin && !(await hasCommand(task.needsBin, this.runtimeEnv(p)))) {
      const rust = rusts.RUST_TOOLS.find((x) => x.bin === task.needsBin);
      throw new Error(task.needsBin === 'wp' ? 'WP-CLI is not installed: brew install wp-cli' : rust ? `${rust.label} is not installed: install it on the Rust page → Tools` : `${task.needsBin} is not installed`);
    }
    if (this.dbTasks.has(id)) throw new Error(`Busy: ${this.dbTasks.get(id)}`);
    const label = `${task.tool} ${task.label.replace('…', '')}`;
    this.dbTasks.set(id, label);
    this.changed();
    try {
      const code = await stream(join(p.path, task.cwd), command, (t) => this.processes.log(id, 'db', t), this.runtimeEnv(p));
      if (code !== 0) throw new Error(`${label} failed (exit ${code}); see the log`);
    } finally {
      this.dbTasks.delete(id);
      await this.pollDatabases();
      this.changed();
    }
  }

  // ---------------------------------------------------------- proxy & certs

  private updateRoutes(): void {
    const routes = this.projects.flatMap((p) => {
      const stack = this.stacks.get(p.id);
      const apps = (stack?.apps ?? []).filter((a) => a.kind !== 'assets' && a.domain);
      return apps.map((app) => {
        const route: Route = {
          domain: app.domain,
          port: app.port,
          projectName: p.name,
          running: this.processes.isActive(p.id) || (this.openPorts.get(p.id) ?? []).includes(app.port ?? -1),
          secure: p.secure !== false,
        };
        if (app.docroot !== undefined) {
          const version = this.phpChoice(p).version;
          const vite = stack!.apps.find((a) => a.kind === 'assets' && a.framework === 'vite');
          const viteUp = Boolean(vite?.port && this.processes.isActive(p.id) && (this.openPorts.get(p.id) ?? []).includes(vite.port));
          route.running = Boolean(version && this.fpm.isRunning(version));
          route.php = {
            docroot: join(p.path, app.docroot),
            socket: version ? this.fpm.socketFor(version) : '',
            vitePort: viteUp ? vite!.port : null,
            viteTls: this.viteTls.get(p.id) ?? false,
            viteOrigin: this.viteOrigin.get(p.id) ?? null,
            env: { ...(this.envOverrides.get(p.id) ?? {}), ...(this.redisEnv.get(p.id) ?? {}) },
          };
        }
        return route;
      });
    });
    // Laravel Reverb of sites that run it: reverb.<site domain>.
    const reverb: Route[] = this.projects
      .filter((p) => p.reverb && this.stacks.get(p.id)?.apps.some((a) => a.framework === 'laravel'))
      .map((p) => ({ domain: this.reverbDomain(p), port: this.reverbPort(p), projectName: `${p.name} Reverb`, running: this.processes.isActive(p.id), secure: true }));
    // Object storage domains (minio.localhost, console.minio.localhost …) and WebSocket servers (ws.localhost …).
    this.proxy.setRoutes([...routes, ...reverb, ...this.storage.routes(), ...this.ws.routes(), ...this.search.routes(), ...this.mail.routes(), ...this.whatsapp.routes(), ...this.gateways.routes()]);
  }

  /**
   * Who already answers on a domain (null = free): another site — its own domain, its apps' and worktrees'
   * subdomains, its Reverb — or a DevCatz service (object storage, WebSocket, search, mail, WhatsApp, gateways, the
   * DB domain). `site` is the one being changed: its own domains do not count.
   */
  domainOwner(domain: string, site?: string): string | null {
    const d = domain.trim().toLowerCase();
    for (const p of this.projects) {
      if (p.id === site) continue;
      if (p.domain === d) return `the site ${p.name}`;
      const app = this.stacks.get(p.id)?.apps.find((a) => a.domain === d);
      if (app) return `${app.name}, an app of ${p.name}`;
      if (p.reverb && this.reverbDomain(p) === d) return `${p.name}'s Reverb`;
    }
    const services = [...this.storage.routes(), ...this.ws.routes(), ...this.search.routes(), ...this.mail.routes(), ...this.whatsapp.routes(), ...this.gateways.routes()];
    const svc = services.find((r) => r.domain === d);
    if (svc) return `the DevCatz service ${svc.projectName}`;
    if (store.settings.dbDomain && `${store.settings.dbDomain}.${tld()}` === d) return 'the DB domain (Settings → Database)';
    return null;
  }

  /** `:8443` while clean URLs are off, empty once [::1]:443 is redirected. */
  portSuffix(secure = true): string {
    if (secure) return this.cleanUrls ? '' : `:${store.settings.httpsPort}`;
    return this.cleanHttp ? '' : `:${store.settings.httpPort}`;
  }

  /** The URL a browser should open for one of the site's domains, in its scheme. */
  urlFor(p: ProjectConfig, domain = p.domain): string {
    const secure = p.secure !== false;
    return `${secure ? 'https' : 'http'}://${domain}${this.portSuffix(secure)}`;
  }

  async updateSettings(patch: Partial<Settings>): Promise<void> {
    if (patch.mailDomain !== undefined) {
      const label = patch.mailDomain.trim().toLowerCase().replace(new RegExp(`\\.${tld().replace(/\./g, '\\.')}$`), '') || 'mail';
      if (!DB_DOMAIN_LABEL.test(label)) throw new Error(`Mail domain "${label}": lowercase letters, digits, hyphens and dots`);
      const host = `${label}.${tld()}`;
      const taken = [
        ...this.projects.flatMap((p) => [p.domain, ...(this.stacks.get(p.id)?.apps.map((a) => a.domain) ?? [])]),
        ...this.storage.routes().map((r) => r.domain),
        ...this.ws.routes().map((r) => r.domain),
        ...this.search.routes().map((r) => r.domain),
      ];
      if (taken.includes(host)) throw new Error(`${host} is already a site or service domain`);
      patch.mailDomain = label;
    }
    if (patch.mailPort !== undefined && (!Number.isInteger(patch.mailPort) || patch.mailPort < 1024 || patch.mailPort > 65535)) throw new Error('Mail port: 1024–65535');
    const mailRestart = (patch.mailPort !== undefined && patch.mailPort !== store.settings.mailPort) || (patch.mailDomain !== undefined && patch.mailDomain !== store.settings.mailDomain);
    if (patch.dbDomain !== undefined) {
      // A label; a pasted full host loses the Default domain suffix.
      const label = patch.dbDomain.trim().toLowerCase().replace(new RegExp(`\\.${tld().replace(/\./g, '\\.')}$`), '');
      if (label && !DB_DOMAIN_LABEL.test(label)) throw new Error(`DB domain "${label}": lowercase letters, digits, hyphens and dots`);
      const host = `${label}.${tld()}`;
      const taken = [...this.projects.flatMap((p) => [p.domain, ...(this.stacks.get(p.id)?.apps.map((a) => a.domain) ?? [])]), ...this.storage.routes().map((r) => r.domain)];
      if (label && taken.includes(host)) throw new Error(`${host} is already a site or storage domain`);
      patch.dbDomain = label;
    }
    if (patch.browser !== undefined && !validBrowser(patch.browser)) throw new Error('That browser is no longer installed');
    const portsChanged =
      (patch.httpsPort && patch.httpsPort !== store.settings.httpsPort) ||
      (patch.httpPort && patch.httpPort !== store.settings.httpPort);
    store.updateSettings(patch);
    if (mailRestart) {
      this.updateRoutes();
      if (this.mail.state().running) await this.mail.restart();
      else this.changed();
    }
    // Sampling turned back on, or a new rate: the monitor picks it up now.
    if (patch.monitorBackground !== undefined || patch.monitorLiveInterval !== undefined) this.monitor.start();
    if (portsChanged) await this.proxy.listen(store.settings.httpsPort, store.settings.httpPort);
    this.cleanUrls = await cleanUrlsWorking();
    this.cleanHttp = await cleanHttpWorking();
    this.changed();
  }

  // ------------------------------------------------------------------ docker

  private project(id: string): ProjectConfig {
    const p = this.projects.find((x) => x.id === id);
    if (!p) throw new Error('Unknown site');
    return p;
  }

  dockerFiles(id: string): DockerComposeFile[] {
    const p = this.project(id);
    return docker.composeFiles(p.path).map((c) => ({ ...c, project: c.generated ? docker.projectName(p, c.file) : null }));
  }

  private composeTarget(id: string, file: string): { p: ProjectConfig; project: string | null } {
    const p = this.project(id);
    const c = this.dockerFiles(id).find((x) => x.file === file);
    if (!c) throw new Error(`${file} not found`);
    return { p, project: c.project };
  }

  // ---------------------------------------------------------- WebSocket

  reverbDomain(p: ProjectConfig): string {
    return `reverb.${p.domain}`;
  }

  /** Stable port for a site's Reverb (pool 8090+). */
  reverbPort(p: ProjectConfig): number {
    const key = `${p.id}:reverb`;
    if (store.ports[key]) return store.ports[key];
    const used = new Set(Object.values(store.ports));
    let port = 8090;
    while (used.has(port)) port++;
    store.setPort(key, port);
    return port;
  }

  /** GET https://<site>/broadcasting/auth through the proxy: 405/419/403 = registered, 404 = missing. */
  private probeBroadcastAuth(p: ProjectConfig): Promise<number | null> {
    return new Promise((resolve) => {
      const req = httpsRequest(
        { host: '127.0.0.1', port: store.settings.httpsPort, path: '/broadcasting/auth', method: 'GET', servername: p.domain, headers: { host: p.domain, accept: 'application/json' }, rejectUnauthorized: false, timeout: 8000 },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? null);
        },
      );
      req.on('error', () => resolve(null));
      req.on('timeout', () => {
        req.destroy();
        resolve(null);
      });
      req.end();
    });
  }

  async laravelBroadcast(siteId: string): Promise<LaravelBroadcastInfo> {
    const p = this.project(siteId);
    const env = readEnvFiles(join(p.path, '.env'));
    const connection = env.BROADCAST_CONNECTION || env.BROADCAST_DRIVER || null;
    const checks = bcast.staticChecks(p.path, env, Boolean(p.reverb));
    // The route answers without a session: 404 means routes/channels.php is not loaded.
    if (this.isServed(p)) {
      const code = await this.probeBroadcastAuth(p);
      checks.push({
        id: 'auth',
        label: 'Auth endpoint /broadcasting/auth',
        ok: code === null ? null : code !== 404 && code < 500,
        detail: code === null ? 'No answer from the site' : code === 404 ? '404: not registered (see Channel routes)' : `Answers (${code} without a signed-in user, as expected)`,
      });
    }
    let listen: LaravelBroadcastInfo['listen'] = null;
    if (connection === 'reverb' && p.reverb) {
      const port = this.reverbPort(p);
      checks.push({ id: 'server', label: 'Reverb running', ok: await isPortOpen(port), detail: `127.0.0.1:${port} (starts with the site)` });
      if (env.REVERB_APP_KEY) listen = { key: env.REVERB_APP_KEY, ws: `ws://127.0.0.1:${port}` };
    } else if (connection === 'pusher') {
      const sock = this.ws.config('sockudo');
      const usesSockudo = sock && (env.PUSHER_APP_KEY === sock.key || env.PUSHER_PORT === String(sock.port));
      checks.push({
        id: 'server',
        label: 'Pusher server',
        ok: usesSockudo ? this.ws.isActive('sockudo') : null,
        detail: usesSockudo ? `DevCatz Sockudo (${this.ws.isActive('sockudo') ? 'running' : 'stopped'})` : `PUSHER_HOST=${env.PUSHER_HOST ?? '(Pusher cloud)'}`,
      });
      if (usesSockudo && sock) listen = { key: sock.key, ws: `ws://127.0.0.1:${sock.port}` };
    } else if (connection === 'reverb' && !p.reverb && this.ws.config('reverb') && env.REVERB_APP_KEY === this.ws.config('reverb')!.key) {
      // DevCatz's shared Reverb (WebSocket page).
      const rv = this.ws.config('reverb')!;
      checks.push({ id: 'server', label: 'Reverb running', ok: this.ws.isActive('reverb'), detail: `DevCatz Laravel Reverb, 127.0.0.1:${rv.port} (${this.ws.isActive('reverb') ? 'running' : 'stopped'})` });
      listen = { key: rv.key, ws: `ws://127.0.0.1:${rv.port}` };
    } else if (connection === 'reverb' && !p.reverb) {
      checks.push({ id: 'server', label: 'Reverb running', ok: false, detail: 'Turn on “Run with the site” (Reverb card), use DevCatz’s shared Reverb (WebSocket page), or run php artisan reverb:start yourself' });
    }
    const events = bcast.scanEvents(p.path);
    return {
      connection,
      events,
      channels: bcast.channelRoutes(p.path),
      checks,
      listen,
      queueHint: events.some((e) => !e.now) && !p.queueWorker,
    };
  }

  /** Boots the app (no tinker needed) and sends an anonymous broadcast through its own broadcaster. */
  async laravelTestBroadcast(siteId: string, type: 'public' | 'private' | 'presence', channel: string, event: string, payload: string): Promise<string> {
    const p = this.project(siteId);
    if (!/^[\w.\-=@{}:]+$/.test(channel)) throw new Error('Channel: letters, digits and . - _ = @ :');
    if (!/^[\w.\-\\:]+$/.test(event)) throw new Error('Event name: letters, digits and . - _ \\ :');
    try {
      JSON.parse(payload || '{}');
    } catch {
      throw new Error('Payload must be JSON, e.g. {"message": "hi"}');
    }
    const fn = type === 'private' ? 'private' : type === 'presence' ? 'presence' : 'on';
    const code = [
      "require 'vendor/autoload.php';",
      "$app = require 'bootstrap/app.php';",
      '$app->make(Illuminate\\Contracts\\Console\\Kernel::class)->bootstrap();',
      "$data = json_decode(getenv('DEVCATZ_PAYLOAD') ?: '{}', true) ?? [];",
      `Illuminate\\Support\\Facades\\Broadcast::${fn}(getenv('DEVCATZ_CHANNEL'))->as(getenv('DEVCATZ_EVENT'))->with($data)->sendNow();`,
      "echo 'sent via ', config('broadcasting.default'), PHP_EOL;",
    ].join(' ');
    const r = await run(...shellCommand(`php -r "eval(getenv('DEVCATZ_CODE'));"`), {
      cwd: p.path,
      timeout: 30_000,
      env: { ...this.runtimeEnv(p), DEVCATZ_CODE: code, DEVCATZ_CHANNEL: channel, DEVCATZ_EVENT: event, DEVCATZ_PAYLOAD: payload || '{}' },
    });
    const out = `${r.stdout}${r.stderr}`.trim();
    this.processes.log(p.id, 'sys', `Test broadcast ${type} ${channel} → ${event}: ${out.split('\n').slice(-1)[0] ?? ''}`);
    if (r.code !== 0 || !/sent via/.test(out)) {
      const msg = out.match(/(?:PHP Fatal error|Error|Exception)[^\n]*/)?.[0] ?? out.split('\n').slice(-3).join(' ');
      throw new Error(/Call to undefined method .*(on|private|presence)\(/.test(out) ? 'Anonymous broadcasts need Laravel 11 or newer' : msg || `exit ${r.code}`);
    }
    return out.split('\n').slice(-1)[0];
  }

  /** S3 use of a site, with the DevCatz service its endpoint points at. */
  private s3Info(p: ProjectConfig): S3Info {
    const info = detectS3(p.path);
    const service =
      this.storage.state().find((s) => s.config && endpointMatches(info.endpoint, `${s.config.apiDomain}.${tld()}`, s.config.apiPort))?.kind ?? null;
    return { ...info, service };
  }

  /** Backends talk to 127.0.0.1 (no TLS, any PHP works); public file URLs use the https:// API domain. */
  storageEnv(kind: StorageKind, siteId: string, bucket: string): Record<string, string> {
    const p = this.project(siteId);
    const c = this.storage.config(kind);
    if (!c) throw new Error('This storage service is not installed');
    if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) throw new Error('Choose a bucket (3–63 lowercase letters, digits, . and -)');
    const local = `http://127.0.0.1:${c.apiPort}`;
    const pub = `https://${c.apiDomain}.${tld()}${this.cleanUrls ? '' : `:${store.settings.httpsPort}`}`;
    const region = c.region || store.settings.s3Region || 'us-east-1';
    const runtime = this.stacks.get(p.id)?.runtime ?? 'node';
    if (runtime === 'php') {
      return {
        FILESYSTEM_DISK: 's3',
        AWS_ACCESS_KEY_ID: c.accessKey,
        AWS_SECRET_ACCESS_KEY: c.secretKey,
        AWS_DEFAULT_REGION: region,
        AWS_BUCKET: bucket,
        AWS_ENDPOINT: local,
        AWS_URL: `${pub}/${bucket}`,
        AWS_USE_PATH_STYLE_ENDPOINT: 'true',
      };
    }
    return {
      S3_ENDPOINT: local,
      S3_REGION: region,
      S3_BUCKET: bucket,
      S3_ACCESS_KEY: c.accessKey,
      S3_SECRET_KEY: c.secretKey,
      S3_FORCE_PATH_STYLE: 'true',
      S3_PUBLIC_URL: `${pub}/${bucket}`,
      // AWS SDKs (v3, boto3, Go v2) read these by themselves.
      AWS_ACCESS_KEY_ID: c.accessKey,
      AWS_SECRET_ACCESS_KEY: c.secretKey,
      AWS_REGION: region,
      AWS_ENDPOINT_URL_S3: local,
      ...(runtime === 'python' ? { AWS_STORAGE_BUCKET_NAME: bucket, AWS_S3_ENDPOINT_URL: local, AWS_S3_ADDRESSING_STYLE: 'path' } : {}),
    };
  }

  searchEnv(kind: SearchKind, siteId: string): Promise<Record<string, string>> {
    const p = this.project(siteId);
    return this.search.env(kind, this.stacks.get(p.id)?.runtime ?? 'node', this.cleanUrls ? 443 : store.settings.httpsPort);
  }

  /** Laravel Scout commands with the site's PHP; output also in the site's log. */
  async scoutCommand(siteId: string, command: 'import' | 'flush' | 'sync', model: string | null): Promise<string> {
    const p = this.project(siteId);
    if (command !== 'sync' && (!model || !/^[\w\\]+$/.test(model))) throw new Error('Choose a Searchable model');
    const args = command === 'sync' ? 'scout:sync-index-settings' : `scout:${command} "${model}"`;
    this.processes.log(p.id, 'sys', `$ php artisan ${args}`);
    const r = await run(...shellCommand(`php artisan ${args}`), { cwd: p.path, timeout: 600_000, env: this.runtimeEnv(p) });
    const out = `${r.stdout}${r.stderr}`.trim();
    for (const line of out.split('\n')) if (line.trim()) this.processes.log(p.id, 'sys', line);
    if (r.code !== 0) throw new Error(out.split('\n').slice(-3).join(' ') || `exit ${r.code}`);
    return out.split('\n').filter((l) => l.trim()).slice(-1)[0] ?? 'Done';
  }

  wsEnv(kind: WsKind, siteId: string): Record<string, string> {
    const p = this.project(siteId);
    return this.ws.env(kind, this.stacks.get(p.id)?.runtime ?? 'node', this.cleanUrls ? 443 : store.settings.httpsPort);
  }

  /**
   * REVERB_* for the site's own Reverb. PHP publishes straight to 127.0.0.1 (no TLS, so any PHP build works,
   * Herd's included); browsers (VITE_REVERB_*) connect to wss://reverb.<site domain> through the proxy.
   */
  reverbEnv(siteId: string): Record<string, string> {
    const p = this.project(siteId);
    const env = readEnvFiles(join(p.path, '.env'));
    const rnd = () => randomBytes(10).toString('hex');
    return {
      BROADCAST_CONNECTION: 'reverb',
      REVERB_APP_ID: env.REVERB_APP_ID || String(100000 + Math.floor(Math.random() * 900000)),
      REVERB_APP_KEY: env.REVERB_APP_KEY || rnd(),
      REVERB_APP_SECRET: env.REVERB_APP_SECRET || rnd(),
      REVERB_HOST: '127.0.0.1',
      REVERB_PORT: String(this.reverbPort(p)),
      REVERB_SCHEME: 'http',
      REVERB_SERVER_HOST: '127.0.0.1',
      REVERB_SERVER_PORT: String(this.reverbPort(p)),
      VITE_REVERB_APP_KEY: '${REVERB_APP_KEY}',
      VITE_REVERB_HOST: this.reverbDomain(p),
      VITE_REVERB_PORT: this.cleanUrls ? '443' : String(store.settings.httpsPort),
      VITE_REVERB_SCHEME: 'https',
    };
  }

  /** Stable host port per container (pool 4800+, apart from the dev ports). */
  private dockerHostPort(id: string, svc: string): number {
    const key = `${id}:docker:${svc}`;
    if (store.ports[key]) return store.ports[key];
    const used = new Set(Object.values(store.ports));
    let port = 4800;
    while (used.has(port)) port++;
    store.setPort(key, port);
    return port;
  }

  dockerServices(id: string, file: string): Promise<DockerService[]> {
    const { p, project } = this.composeTarget(id, file);
    return docker.services(p.path, file, project);
  }

  dockerGenerate(id: string, options: Partial<DockerGenOptions> = {}) {
    const p = this.project(id);
    const st = this.state(p);
    const opts = { ...docker.defaultOptions(p, st.stack, options.target), ...options };
    return docker.generate({
      hostPort: (svc) => this.dockerHostPort(p.id, svc),
      p,
      stack: st.stack,
      phpVersion: st.php.version,
      goVersion: st.go.version,
      pythonVersion: st.python.version,
      nodeVersion: st.node.version ?? this.systemNode,
    }, opts);
  }

  /** Regenerates here (the renderer only picks paths), so what is written is exactly what was previewed. */
  /** Docker files a user may adjust with AI: Dockerfile*, *compose*.y(a)ml, .dockerignore, in the site's folder (one level of app folders too). */
  dockerListFiles(id: string): string[] {
    const p = this.project(id);
    const dirs = ['.', ...(this.stacks.get(id)?.apps.map((a) => a.dir) ?? [])].filter((d, i, all) => all.indexOf(d) === i);
    const out: string[] = [];
    for (const d of dirs)
      for (const f of (() => {
        try {
          return readdirSync(join(p.path, d));
        } catch {
          return [];
        }
      })())
        if (DOCKER_FILE.test(f)) out.push(d === '.' ? f : join(d, f));
    return out.sort();
  }

  private dockerFilePath(id: string, file: string): string {
    if (!this.dockerListFiles(id).includes(file) && !(DOCKER_FILE.test(basename(file)) && !file.includes('..'))) throw new Error('Only Docker files of the site');
    const p = this.project(id);
    const full = resolve(p.path, file);
    if (relative(p.path, full).startsWith('..')) throw new Error('Only Docker files of the site');
    return full;
  }

  dockerReadFile(id: string, file: string): string {
    return readFileSync(this.dockerFilePath(id, file), 'utf8');
  }

  dockerSaveFile(id: string, file: string, content: string): void {
    writeFileSync(this.dockerFilePath(id, file), content);
    this.processes.log(id, 'sys', `${file} saved (adjusted with AI)`);
  }

  dockerWrite(id: string, options: DockerGenOptions, paths: string[], overwrite: string[], edited: Record<string, string> = {}): string[] {
    const p = this.project(id);
    // Edited content replaces only files the generator makes (never an arbitrary path from the window).
    const files = this.dockerGenerate(id, options)
      .files.filter((f) => paths.includes(f.path))
      .map((f) => (typeof edited[f.path] === 'string' ? { ...f, content: edited[f.path] } : f));
    const written = docker.writeFiles(p.path, files, overwrite);
    this.processes.log(id, 'sys', `Docker: wrote ${written.join(', ') || 'nothing'}`);
    return written;
  }

  async dockerCompose(id: string, file: string, action: DockerAction, service?: string): Promise<void> {
    const { p, project } = this.composeTarget(id, file);
    const args: Record<DockerAction, string[]> = {
      up: ['up', '-d', '--build', '--remove-orphans'],
      down: ['down'],
      restart: ['restart'],
      build: ['build'],
      logs: ['logs', '--tail', '200', '--no-color', '--timestamps'],
    };
    const cmd = [...args[action], ...(service ? [service] : [])];
    this.processes.log(id, 'sys', `$ docker compose -f ${file}${project ? ` -p ${project}` : ''} ${cmd.join(' ')}`);
    const code = await docker.compose(p.path, file, project, cmd, (stream, text) => this.processes.log(id, stream, text));
    this.processes.log(id, 'sys', code === 0 ? `Docker: ${action} done` : `Docker: ${action} failed (exit ${code})`);
    if (code !== 0) throw new Error(`docker compose ${action} failed (exit ${code}); see Logs`);
  }

  // ------------------------------------------------------- sidebar organisation

  /** Site URL and folder for the sidebar's context menu. */
  siteInfo(id: string): { url: string; path: string } | null {
    const p = this.projects.find((x) => x.id === id);
    return p ? { url: this.urlFor(p), path: p.path } : null;
  }

  setFavorite(id: string, on: boolean): void {
    const favs = store.settings.favorites.filter((f) => f !== id);
    store.updateSettings({ favorites: on ? [...favs, id] : favs });
    this.changed();
  }

  setSiteGroup(id: string, group: string | null): void {
    const name = group?.trim().slice(0, 40) || null;
    const groups = store.settings.siteGroups.map((g) => ({ ...g, sites: g.sites.filter((s) => s !== id) }));
    if (name) {
      const g = groups.find((x) => x.name.toLowerCase() === name.toLowerCase());
      if (g) g.sites.push(id);
      else groups.push({ name, sites: [id] });
    }
    store.updateSettings({ siteGroups: groups });
    this.changed();
  }

  renameGroup(from: string, to: string): void {
    const name = to.trim().slice(0, 40);
    if (!name) throw new Error('Group name is empty');
    const groups = store.settings.siteGroups;
    if (groups.some((g) => g.name !== from && g.name.toLowerCase() === name.toLowerCase())) throw new Error(`A group "${name}" already exists`);
    store.updateSettings({ siteGroups: groups.map((g) => (g.name === from ? { ...g, name } : g)) });
    this.changed();
  }

  /** The sites stay; they just become ungrouped. */
  deleteGroup(name: string): void {
    store.updateSettings({ siteGroups: store.settings.siteGroups.filter((g) => g.name !== name) });
    this.changed();
  }

  toggleGroup(name: string): void {
    store.updateSettings({ siteGroups: store.settings.siteGroups.map((g) => (g.name === name ? { ...g, collapsed: !g.collapsed } : g)) });
    this.changed();
  }

  moveGroup(name: string, delta: number): void {
    const groups = [...store.settings.siteGroups];
    const i = groups.findIndex((g) => g.name === name);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= groups.length) return;
    [groups[i], groups[j]] = [groups[j], groups[i]];
    store.updateSettings({ siteGroups: groups });
    this.changed();
  }

  setSiteOrder(order: string[]): void {
    const known = new Set(this.projects.map((p) => p.id));
    store.updateSettings({ siteOrder: [...new Set(order)].filter((id) => known.has(id)) });
    this.changed();
  }

  // ---- the Database page's list: favorites, groups and order, kept in their own settings keys.

  dbSetFavorite(id: string, on: boolean): void {
    const favs = store.settings.dbFavorites.filter((f) => f !== id);
    store.updateSettings({ dbFavorites: on ? [...favs, id] : favs });
    this.changed();
  }

  dbSetGroup(id: string, group: string | null): void {
    const name = group?.trim().slice(0, 40) || null;
    const groups = store.settings.dbGroups.map((g) => ({ ...g, sites: g.sites.filter((s) => s !== id) }));
    if (name) {
      const g = groups.find((x) => x.name.toLowerCase() === name.toLowerCase());
      if (g) g.sites.push(id);
      else groups.push({ name, sites: [id] });
    }
    store.updateSettings({ dbGroups: groups });
    this.changed();
  }

  dbGroupAction(name: string, action: 'rename' | 'delete' | 'toggle' | 'up' | 'down', value?: string): void {
    const groups = [...store.settings.dbGroups];
    const i = groups.findIndex((g) => g.name === name);
    if (action === 'rename') {
      const to = (value ?? '').trim().slice(0, 40);
      if (!to) throw new Error('Group name is empty');
      if (groups.some((g) => g.name !== name && g.name.toLowerCase() === to.toLowerCase())) throw new Error(`A group "${to}" already exists`);
      store.updateSettings({ dbGroups: groups.map((g) => (g.name === name ? { ...g, name: to } : g)) });
    } else if (action === 'delete') store.updateSettings({ dbGroups: groups.filter((g) => g.name !== name) });
    else if (action === 'toggle') store.updateSettings({ dbGroups: groups.map((g) => (g.name === name ? { ...g, collapsed: !g.collapsed } : g)) });
    else {
      const j = i + (action === 'up' ? -1 : 1);
      if (i < 0 || j < 0 || j >= groups.length) return;
      [groups[i], groups[j]] = [groups[j], groups[i]];
      store.updateSettings({ dbGroups: groups });
    }
    this.changed();
  }

  dbSetOrder(order: string[]): void {
    const known = new Set(this.dbs.state().map((d) => d.id));
    store.updateSettings({ dbOrder: [...new Set(order)].filter((id) => known.has(id)) });
    this.changed();
  }

  async trustCa(): Promise<boolean> {
    const r = await this.certs.trust();
    this.refreshNodes();
    await this.refreshBuns();
    this.systemNode = await nodes.systemNode();
    this.caTrusted = await this.certs.isTrusted();
    this.changed();
    if (!r.ok && !this.caTrusted) throw new Error(r.message || (isWin ? 'Windows did not add the certificate' : 'Keychain refused the certificate'));
    return this.caTrusted;
  }

  async untrustCa(): Promise<boolean> {
    await this.certs.untrust();
    this.refreshNodes();
    await this.refreshBuns();
    this.systemNode = await nodes.systemNode();
    this.caTrusted = await this.certs.isTrusted();
    this.changed();
    return !this.caTrusted;
  }

  async installCleanUrls(): Promise<boolean> {
    // Only take 127.0.0.1:80/443 when nothing else (Laravel Herd's nginx) listens there.
    const ours = cleanUrlsCoverIpv4();
    const ipv4 = {
      https: ours || !(await isListening('127.0.0.1', 443)),
      http: ours || !(await isListening('127.0.0.1', 80)),
    };
    const r = await installCleanUrls(store.settings.httpsPort, store.settings.httpPort, ipv4);
    if (!r.ok) throw new Error(r.message.includes('-128') ? 'Cancelled' : r.message);
    this.cleanUrls = await cleanUrlsWorking();
    this.cleanHttp = await cleanHttpWorking();
    this.changed();
    return this.cleanUrls;
  }

  async uninstallCleanUrls(): Promise<boolean> {
    const r = await uninstallCleanUrls();
    if (!r.ok) throw new Error(r.message.includes('-128') ? 'Cancelled' : r.message);
    this.cleanUrls = await cleanUrlsWorking();
    this.cleanHttp = await cleanHttpWorking();
    this.changed();
    return !this.cleanUrls;
  }

  // ------------------------------------------------------------------ monitoring

  /**
   * What the monitor measures: each site's dev processes, PHP-FPM pools (shared
   * by PHP sites), database and storage services. Future WebSocket / search
   * services add their process managers here.
   */
  private monitorTargets(): MonitorTarget[] {
    const out: MonitorTarget[] = [];
    for (const p of this.projects) {
      const pids = this.processes.pidsOf(p.id);
      const stack = this.stacks.get(p.id);
      out.push({
        id: `site:${p.id}`,
        kind: 'site',
        name: p.name,
        detail: [p.domain, stack?.apps.map((a) => a.framework).filter((f, i, all) => all.indexOf(f) === i).join(', ')].filter(Boolean).join(' · '),
        active: pids.length > 0,
        pids,
        dataDirs: [],
        path: p.path,
        link: { section: 'projects', id: p.id },
      });
    }
    for (const f of this.fpm.pids()) {
      const names = f.sites.map((id) => this.find(id)?.name ?? id);
      out.push({ id: `php:${f.version}`, kind: 'php', name: `${words.phpServer} ${f.version}`, detail: names.join(', ') || 'no sites', active: true, pids: [f.pid], dataDirs: [], link: null });
    }
    for (const d of this.dbs.state()) {
      if (d.pending) continue;
      out.push({
        id: `db:${d.id}`,
        kind: 'database',
        name: d.name,
        detail: `${d.engineName} ${d.version}${d.engine === 'sqlite' ? '' : ` · :${d.port}`}`,
        active: d.engine !== 'sqlite' && this.dbs.isActive(d.id),
        pids: this.dbs.processes.pidsOf(dbProcessId(d.id)),
        dataDirs: [d.resolvedDataDir],
        binDirs: (() => {
          const b = this.dbs.binaryOf(d);
          return b && b.source !== 'system' ? [b.root] : [];
        })(),
        link: { section: 'database', id: d.id },
      });
    }
    for (const s of this.storage.state()) {
      if (!s.installed || !s.config) continue;
      out.push({
        id: `storage:${s.kind}`,
        kind: 'storage',
        name: s.name,
        detail: `${s.config.version ?? ''} · :${s.config.apiPort}`,
        active: this.storage.isActive(s.kind),
        pids: this.storage.processes.pidsOf(`storage:${s.kind}`),
        dataDirs: [s.config.dataDir],
        binDirs: [storageBinaryDirOf(s.config)],
        link: { section: 'storage', id: s.kind },
      });
    }
    for (const s of this.search.state()) {
      if (!s.installed || !s.config) continue;
      const counts = this.search.lastCounts.get(s.kind);
      out.push({
        id: `search:${s.kind}`,
        kind: 'search',
        name: s.name,
        detail: [`${s.config.version ?? ''} · :${s.config.port}`, counts && this.search.isActive(s.kind) ? `${counts.indexes} index${counts.indexes === 1 ? '' : 'es'} · ${counts.docs} docs` : '']
          .filter(Boolean)
          .join(' · '),
        active: this.search.isActive(s.kind),
        pids: this.search.processes.pidsOf(searchId(s.kind)),
        dataDirs: [s.config.dataDir],
        binDirs: [searchBinaryDirOf(s.config)],
        link: { section: 'search', id: s.kind },
      });
    }
    for (const w of this.ws.state()) {
      if (!w.installed || !w.config) continue;
      const clients = this.ws.lastClients.get(w.kind);
      out.push({
        id: `ws:${w.kind}`,
        kind: 'websocket',
        name: w.name,
        detail: [`${w.config.version ?? ''} · :${w.config.port}`, clients !== undefined && this.ws.isActive(w.kind) ? `${clients} client${clients === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · '),
        active: this.ws.isActive(w.kind),
        pids: this.ws.processes.pidsOf(wsId(w.kind)),
        dataDirs: [w.config.dataDir],
        binDirs: [wsBinaryDirOf(w.config)],
        link: { section: 'websocket', id: w.kind },
      });
    }
    for (const w of this.whatsapp.state()) {
      if (!w.installed || !w.config) continue;
      const linked = w.sessions.filter((x) => x.status === 'connected').length;
      out.push({
        id: `wa:${w.engine}`,
        kind: 'whatsapp',
        name: w.name,
        detail: [`${w.config.version} · :${w.config.port}`, this.whatsapp.isActive(w.engine) ? `${linked} linked` : ''].filter(Boolean).join(' · '),
        active: this.whatsapp.isActive(w.engine),
        pids: this.whatsapp.processes.pidsOf(`wa:${w.engine}`),
        dataDirs: [w.config.dataDir],
        binDirs: w.engine === 'gowa' ? [this.whatsapp.binDir('gowa')] : [],
        link: { section: 'whatsapp', id: w.engine },
      });
    }
    for (const g of this.gateways.state()) {
      if (!g.installed || !g.config) continue;
      out.push({
        id: `gw:${g.kind}`,
        kind: 'gateway',
        name: g.name,
        detail: `${g.config.version} · :${g.config.port}${g.docker ? ' · Docker' : ''}`,
        active: this.gateways.isActive(g.kind),
        pids: this.gateways.processes.pidsOf(`gw:${g.kind}`),
        dataDirs: [g.config.dataDir],
        binDirs: g.docker ? [] : [this.gateways.binDir(g.kind)],
        link: { section: 'whatsapp', id: g.kind },
      });
    }
    return out;
  }

  // ------------------------------------------------------------------ state

  /** PHP sites are up whenever their PHP-FPM pool runs (Start only adds Vite/Mix, queue, scheduler). */
  private isServed(p: ProjectConfig): boolean {
    if (this.stacks.get(p.id)?.runtime !== 'php') return false;
    const v = this.phpChoice(p).version;
    return Boolean(v && this.fpm.isRunning(v));
  }

  /** Sites running now (an update restart starts them again). */
  runningSites(): string[] {
    return this.projects.filter((p) => ['running', 'starting'].includes(this.processes.getStatus(p.id).status)).map((p) => p.id);
  }

  state(p: ProjectConfig): ProjectState {
    const { status, exitCode } = this.processes.getStatus(p.id);
    return {
      ...p,
      stack: this.stacks.get(p.id) ?? this.assignPorts(p, this.applyOverrides(p, detectStack(p.path, p.domain))),
      status,
      exitCode,
      openPorts: this.openPorts.get(p.id) ?? [],
      dbStatus: this.dbStates.get(p.id) ?? (this.stacks.get(p.id)?.database ? 'unknown' : 'none'),
      dbTask: this.dbTasks.get(p.id) ?? null,
      redisStatus: this.redisStates.get(p.id) ?? (this.stacks.get(p.id)?.redis ? 'unknown' : 'none'),
      screenshotAt: screenshotTime(p.id),
      capturing: this.capturing.has(p.id),
      node: this.nodeChoice(p),
      bun: this.bunChoice(p),
      go: this.goChoice(p),
      rust: this.rustChoice(p),
      launch: this.launchState.get(p.id) ?? null,
      python: this.pythonChoice(p),
      php: this.phpChoice(p),
      realtime: detectRealtime(p.path),
      search: detectSearch(p.path),
      s3: this.s3Info(p),
      reverbEndpoint: p.reverb ? { port: this.reverbPort(p), domain: this.reverbDomain(p) } : null,
      envHints: this.envHints.get(p.id) ?? [],
      envOverrides: this.envOverrides.get(p.id) ?? {},
      served: this.isServed(p),
      git: this.git.summaries.get(p.id) ?? null,
      mailInfo: this.mailInfo(p),
      waInfo: this.whatsapp.siteInfo(p),
      gwInfo: this.gateways.siteInfo(p),
    };
  }

  /** Mailer keys in .env and whether they target the catcher (127.0.0.1 / mail.<tld> on its port). */
  private mailInfo(p: ProjectConfig): ProjectState['mailInfo'] {
    const env = readEnvFiles(join(p.path, '.env'));
    const keys = Object.keys(env).filter((k) => /^(MAIL_(HOST|PORT|MAILER|SCHEME)|SMTP_(HOST|PORT)|EMAIL_(HOST|PORT|BACKEND)|MAIL_SERVER)$/.test(k));
    if (!keys.length) return null;
    const host = (env.MAIL_HOST ?? env.SMTP_HOST ?? env.EMAIL_HOST ?? env.MAIL_SERVER ?? '').toLowerCase();
    const port = env.MAIL_PORT ?? env.SMTP_PORT ?? env.EMAIL_PORT ?? '';
    const local = ['127.0.0.1', 'localhost', '::1', this.mail.domain()].includes(host);
    return { keys, catcher: local && port === String(store.settings.mailPort) };
  }

  /**
   * Called once at launch: starts every site (or only those flagged
   * `autoStart` when "Start all sites on launch" is off). A site whose port is
   * taken is skipped; the reason lands in its log.
   */
  autoStart(): void {
    const all = store.settings.startAllOnLaunch;
    // Sites that ran before an update restart (Catzoid #54) come back too, once.
    const resume = new Set(store.settings.resumeSites);
    if (resume.size) store.updateSettings({ resumeSites: [] });
    for (const p of this.projects) {
      const stack = this.stacks.get(p.id);
      if (!(all || p.autoStart || resume.has(p.id)) || !(p.devCommand || stack?.devCommand)) continue;
      this.start(p.id).catch((e) => console.warn(`auto-start ${p.name}:`, e.message));
    }
  }

  snapshot(editors: string[], login: { launchAtLogin: boolean; packaged: boolean }): AppState {
    return {
      projects: this.projects.map((p) => this.state(p)),
      settings: store.settings,
      ai: aiSettings(),
      cert: { caExists: this.certs.caExists(), caTrusted: this.caTrusted, caPath: this.certs.caPath },
      cleanUrls: {
        installed: this.cleanUrls,
        configured: cleanUrlsInstalled(),
        ipv4: cleanUrlsCoverIpv4(),
        ipv4Available: this.ipv4Free,
      },
      domain: {
        tld: tld(),
        needsResolver: tld() !== 'localhost',
        dnsRunning: this.dns.running,
        dnsError: this.dns.error,
        resolver: tld() === 'localhost' ? 'none' : resolverStatus(tld()),
        resolves: this.resolves,
      },
      proxy: { https: this.proxy.httpsUp, http: this.proxy.httpUp, error: this.proxy.error },
      editors,
      browsers: browsersState(),
      editorIcons: editorIcons(),
      ...login,
      urlSuffix: this.portSuffix(true),
      httpUrlSuffix: this.portSuffix(false),
      node: {
        installed: this.installedNodes,
        defaultVersion: store.settings.nodeDefault,
        system: this.systemNode,
        shimDir: nodes.shimDir(),
        shimOnPath: nodes.shimOnPath(),
        installing: this.nodeInstalling,
      },
      bun: {
        installed: this.installedBuns,
        defaultVersion: store.settings.bunDefault,
        installing: this.bunInstalling,
      },
      go: {
        installed: this.installedGos,
        defaultVersion: store.settings.goDefault,
        installing: this.goInstalling,
      },
      rust: {
        rustup: this.rustupVer,
        toolchains: this.rustToolchains,
        targets: this.rustTargets,
        tools: this.rustTools,
        installing: this.rustInstalling,
        linkerMissing: this.rustLinkerMissing,
      },
      python: {
        uv: this.uvVer,
        installed: this.installedPythons,
        defaultVersion: store.settings.pythonDefault,
        installing: this.pythonInstalling,
      },
      php: {
        installed: this.installedPhps,
        defaultVersion: store.settings.phpDefault,
        installing: this.phpInstalling,
        extTask: this.phpExtTask,
        composer: phps.composerInstalled(),
        fpm: this.fpm.status(),
      },
      updates: { ...this.updates, list: this.computeUpdates() },
      storage: this.storage.state(),
      websockets: this.ws.state(),
      searchEngines: this.search.state(),
      databases: this.dbs.state(),
      dbcatz: this.dbcatz.state(),
      dialcatz: this.dialcatz.state(),
      appUpdate: this.updater.state(),
      reports: this.reports.state(),
      uninstall: this.uninstallTask,
      git: this.git.state(),
      mail: this.mail.state(),
      expose: this.expose.state(),
      whatsapp: this.whatsapp.state(),
      gateways: this.gateways.state(),
      services: {
        proxy: this.proxy.httpsUp,
        dns: tld() === 'localhost' ? 'not-needed' : this.dns.running ? 'running' : 'down',
      },
    };
  }

  private changed(): void {
    if (this.changeTimer) return;
    this.changeTimer = setTimeout(() => {
      this.changeTimer = null;
      this.dbcatz.publish(this.dbs.state());
      this.publishBridge();
      this.emit('change');
    }, 50);
  }
}

/** A starting .gitignore for a stack (Git tab → Add .gitignore): the usual build output, dependencies and secrets. */
function gitignoreFor(stack: StackInfo | undefined): string {
  const runtimes = new Set<string>([stack?.runtime ?? 'node', ...(stack?.subRuntimes ?? [])]);
  const laravel = stack?.apps.some((a) => a.framework === 'laravel');
  const blocks: string[] = ['# Secrets\n.env\n.env.*\n!.env.example', '# macOS and editors\n.DS_Store\n.idea/\n.vscode/\n*.swp'];
  if (runtimes.has('node') || stack?.packageManager) blocks.push('# Node\nnode_modules/\ndist/\nbuild/\n.astro/\n.nuxt/\n.output/\n.next/\n.svelte-kit/\n.turbo/\ncoverage/\n*.log\nnpm-debug.log*\nyarn-error.log*');
  if (runtimes.has('php')) blocks.push(laravel ? '# Laravel\n/vendor/\n/public/hot\n/public/storage\n/storage/*.key\n/storage/pail\n.phpunit.result.cache\nHomestead.json\nHomestead.yaml' : '# PHP\n/vendor/\n.phpunit.result.cache');
  if (runtimes.has('python')) blocks.push('# Python\n.venv/\nvenv/\n__pycache__/\n*.py[cod]\n.pytest_cache/\n.mypy_cache/\n.ruff_cache/\n*.egg-info/\ninstance/\ndb.sqlite3');
  if (runtimes.has('go')) blocks.push('# Go\nbin/\ntmp/\n*.exe\n*.test\n*.out');
  if (runtimes.has('rust')) blocks.push('# Rust\n/target/\n**/*.rs.bk\n.anchor/\ntest-ledger/\ndist/');
  return `${blocks.join('\n\n')}\n`;
}

/** Minimal YAML for plain JSON data (objects, arrays, strings, numbers, booleans): enough for a starter OpenAPI file. */
function toYaml(value: unknown, indent = ''): string {
  const scalar = (v: unknown) =>
    typeof v === 'string' ? (/^[\w./ -]*$/.test(v) && !/^(true|false|null|yes|no|on|off|~|-?\d[\d.]*)$/i.test(v) && v.trim() === v && v !== '' ? v : JSON.stringify(v)) : String(v);
  const lines: string[] = [];
  if (Array.isArray(value)) {
    for (const item of value) {
      if (item && typeof item === 'object') lines.push(`${indent}-${toYaml(item, `${indent}  `).replace(/^\s*/, ' ')}`);
      else lines.push(`${indent}- ${scalar(item)}\n`);
    }
    return lines.join('');
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const key = /^[\w./-]+$/.test(k) && !/^\d+$/.test(k) ? k : JSON.stringify(k);
    if (v && typeof v === 'object') {
      const empty = Array.isArray(v) ? !v.length : !Object.keys(v).length;
      lines.push(empty ? `${indent}${key}: ${Array.isArray(v) ? '[]' : '{}'}\n` : `${indent}${key}:\n${toYaml(v, `${indent}  `)}`);
    } else lines.push(`${indent}${key}: ${scalar(v)}\n`);
  }
  return lines.join('');
}
