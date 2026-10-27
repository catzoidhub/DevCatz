import { randomBytes } from 'node:crypto';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { extname, isAbsolute, join } from 'node:path';
import type {
  DbBinary,
  DbImportCandidate,
  DbImportSource,
  DbEngine,
  DbEngineInfo,
  DbnginInstall,
  DbServiceConfig,
  DbServiceInput,
  DbServiceState,
  DbVersionOption,
  ExternalDbService,
  LogLine,
  StorageAction,
  TaskProgress,
} from '@shared/types';
import { binOf, Cancelled, client, DB_ENGINE_ORDER, DB_ENGINES, mysqlClient, mysqlClientArgs, psqlArgs, SQLITE_ROOT, type RemoteBuild } from './dbengines';
import { isPortOpen, pipeCommands, portOwner, run } from './env';
import { isWin } from './platform';
import { ProcessManager } from './processes';
import { dataDir, store, tld } from './store';

/**
 * Database services like DBngin: any number of MySQL, MariaDB, PostgreSQL,
 * Redis, MongoDB and Elasticsearch instances (each with its own version, port
 * and data folder), plus SQLite folders. Builds are shared per version; the
 * servers run as managed processes on 127.0.0.1 with their own process
 * manager, a long stop grace (no SIGKILL mid-checkpoint) and an orphan list.
 */
export const dbProcessId = (id: string) => `db:${id}`;
const ID = /^[a-z]+-[a-z0-9]{6}$/;
const DB_NAME = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/;
export const DB_DOMAIN_LABEL = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

interface Pending {
  config: DbServiceConfig;
  task: TaskProgress | null;
  abort: AbortController;
}

export class DbServiceManager {
  readonly processes = new ProcessManager('db-pids.json', 30_000);
  private pending = new Map<string, Pending>();
  /** Tasks of saved instances (version change installs). */
  private tasks = new Map<string, TaskProgress>();
  private errors = new Map<string, string>();
  private booting = new Set<string>();
  onChange: () => void = () => undefined;
  /** Sites linked to an instance (project ids), from Herd. */
  linkedSites: (id: string) => string[] = () => [];
  /** Clears `dbService` on sites when an instance is removed. */
  unlinkSites: (id: string) => void = () => undefined;

  constructor() {
    this.processes.on('status', () => this.onChange());
    this.processes.on('log', (lines: LogLine[]) => {
      for (const l of lines) {
        try {
          appendFileSync(join(dataDir('logs'), `db-${l.projectId.replace(/^db:/, '')}.log`), `${new Date(l.time).toISOString()} ${l.stream} ${l.text}\n`);
        } catch {
          /* best effort */
        }
      }
    });
    setInterval(() => void this.poll(), 1500);
  }

  // ------------------------------------------------------------- lookups

  list(): DbServiceConfig[] {
    return store.dbServices;
  }

  config(id: string): DbServiceConfig | null {
    return store.dbServices.find((c) => c.id === id) ?? null;
  }

  private get(id: string): DbServiceConfig {
    const c = this.config(id);
    if (!c) throw new Error('No such database service');
    return c;
  }

  // Not <userData>/databases: Chromium owns that folder (WebSQL) and deletes it at every launch.
  dataDirOf(c: Pick<DbServiceConfig, 'id' | 'dataDir'>): string {
    return c.dataDir || join(store.settings.dbDataRoot || dataDir('db-services', 'data'), c.id);
  }

  private binDir(engine: DbEngine, version: string): string {
    return join(store.settings.dbBinRoot || dataDir('db-services', 'bin'), engine, version);
  }

  /** Root folder of the build an instance runs, when it is on disk. */
  binaryOf(c: Pick<DbServiceConfig, 'engine' | 'version'>): DbBinary | null {
    if (c.engine === 'sqlite') return { engine: 'sqlite', version: c.version, root: SQLITE_ROOT, source: 'system' };
    const b = store.dbBinaries.find((x) => x.engine === c.engine && x.version === c.version);
    return b && existsSync(b.root) ? b : null;
  }

  socketOf(c: Pick<DbServiceConfig, 'engine' | 'socket' | 'port'>): string | null {
    // Windows: TCP only.
    if (isWin) return null;
    if (c.engine === 'mysql' || c.engine === 'mariadb') return c.socket || `/tmp/devcatz-${c.engine}-${c.port}.sock`;
    if (c.engine === 'postgresql') return `/tmp/.s.PGSQL.${c.port}`;
    return null;
  }

  /** Settings → Database → DB domain (`db` → db.localhost), shared by every service; null when unset. */
  host(): string | null {
    return store.settings.dbDomain ? `${store.settings.dbDomain}.${tld()}` : null;
  }

  isActive(id: string): boolean {
    return this.processes.isActive(dbProcessId(id));
  }

  // ------------------------------------------------------------- engines & versions

  async engines(): Promise<DbEngineInfo[]> {
    return Promise.all(
      DB_ENGINE_ORDER.map(async (engine) => {
        const e = DB_ENGINES[engine];
        return {
          engine,
          name: e.name,
          description: e.description,
          defaultPort: e.defaultPort,
          sourceNote: e.sourceNote,
          requirement: e.requirement ? await e.requirement() : null,
          installed: engine === 'sqlite' ? [this.binaryOf({ engine, version: (await e.version(SQLITE_ROOT)) ?? 'system' })!] : store.dbBinaries.filter((b) => b.engine === engine && existsSync(b.root)),
        };
      }),
    );
  }

  async versions(engine: DbEngine): Promise<DbVersionOption[]> {
    const installed = store.dbBinaries.filter((b) => b.engine === engine && existsSync(b.root));
    let remote: RemoteBuild[] = [];
    let error: string | null = null;
    try {
      remote = await DB_ENGINES[engine].builds();
    } catch (err) {
      error = (err as Error).message;
    }
    const out: DbVersionOption[] = remote.map((b) => ({
      version: b.version,
      label: b.label,
      installed: installed.some((i) => i.version === b.version),
      source: b.source,
      note: b.note,
    }));
    // Installed builds that are no longer the newest of their line stay selectable.
    for (const i of installed) if (!out.some((o) => o.version === i.version)) out.push({ version: i.version, label: i.version, installed: true, source: i.source });
    if (!out.length && error) throw new Error(error);
    return out;
  }

  async defaults(engine: DbEngine, version: string): Promise<DbServiceInput> {
    const e = DB_ENGINES[engine];
    const line = version.split('.')[0];
    let name = engine === 'sqlite' ? 'SQLite' : `${e.name} ${line}`;
    const names = new Set(store.dbServices.map((c) => c.name));
    for (let i = 2; names.has(name); i++) name = `${engine === 'sqlite' ? 'SQLite' : `${e.name} ${line}`} (${i})`;
    // First free port from the default up.
    const used = new Set(store.dbServices.flatMap((c) => (c.engine === 'elasticsearch' ? [c.port, c.port + 100] : [c.port])));
    let port = e.defaultPort;
    if (engine !== 'sqlite') while (used.has(port) || (engine === 'elasticsearch' && used.has(port + 100))) port++;
    return {
      engine,
      version,
      name,
      port,
      socket: '',
      dataDir: '',
      configFile: '',
      disableBinLog: engine === 'mysql' || engine === 'mariadb',
      autoStart: false,
      user: engine === 'redis' || engine === 'valkey' || engine === 'mongodb' || engine === 'elasticsearch' || engine === 'sqlite' ? '' : 'root',
      password: '',
    };
  }

  // ------------------------------------------------------------- validation

  private validate(c: DbServiceConfig, selfId: string | null): void {
    if (!DB_ENGINES[c.engine]) throw new Error('Unknown engine');
    if (!c.name.trim()) throw new Error('Name is required');
    const others = [...store.dbServices, ...[...this.pending.values()].map((p) => p.config)].filter((o) => o.id !== selfId);
    if (others.some((o) => o.name.trim().toLowerCase() === c.name.trim().toLowerCase())) throw new Error(`The name "${c.name}" is already used`);
    if (c.engine !== 'sqlite') {
      if (!Number.isInteger(c.port) || c.port < 1 || c.port > 65535) throw new Error('Port: 1–65535');
      const mine = c.engine === 'elasticsearch' ? [c.port, c.port + 100] : [c.port];
      for (const o of others) {
        if (o.engine === 'sqlite') continue;
        const theirs = o.engine === 'elasticsearch' ? [o.port, o.port + 100] : [o.port];
        const clash = mine.find((p) => theirs.includes(p));
        if (clash) throw new Error(`Port ${clash} is used by ${o.name}`);
      }
    }
    // Windows: no sockets (the field is ignored there).
    if (!isWin && c.socket && !c.socket.startsWith('/')) throw new Error('Socket path must be absolute');
    if (!isWin && c.socket && Buffer.byteLength(c.socket) > 103) throw new Error('Socket path is too long (macOS allows 103 bytes)');
    if (c.dataDir && !(isWin ? isAbsolute(c.dataDir) : c.dataDir.startsWith('/'))) throw new Error('Data folder must be an absolute path');
    if (c.configFile && !existsSync(c.configFile)) throw new Error(`${c.configFile} does not exist`);
    const data = this.dataDirOf(c);
    const sameData = others.find((o) => this.dataDirOf(o) === data);
    if (sameData) throw new Error(`${data} is ${sameData.name}'s data folder`);
  }

  // ------------------------------------------------------------- tasks

  private stepper(steps: string[], set: (t: TaskProgress | null) => void, init: Omit<TaskProgress, 'steps' | 'step'>) {
    let cur: TaskProgress = { ...init, steps, step: 0 };
    set(cur);
    return {
      step: (name: string, p: Partial<TaskProgress> = {}) => {
        const i = steps.indexOf(name);
        cur = { ...cur, ...p, ...(i >= 0 ? { step: i } : {}) };
        set(cur);
        this.onChange();
      },
      report: (p: Partial<TaskProgress>) => {
        cur = { ...cur, ...p };
        set(cur);
        this.onChange();
      },
      finish: () => {
        cur = { ...cur, step: steps.length, done: true, detail: undefined, received: undefined, total: undefined };
        set(cur);
        this.onChange();
      },
    };
  }

  /** Downloads/builds/brews the version when it is not on disk yet; records it. */
  private async ensureBinary(c: DbServiceConfig, step: (name: string, p?: Partial<TaskProgress>) => void, signal: AbortSignal): Promise<DbBinary> {
    const have = this.binaryOf(c);
    if (have) return have;
    const e = DB_ENGINES[c.engine];
    const req = e.requirement ? await e.requirement() : null;
    if (req) throw new Error(req);
    const build = (await e.builds()).find((b) => b.version === c.version);
    if (!build) throw new Error(`${e.name} ${c.version} is not available for download`);
    const dest = this.binDir(c.engine, c.version);
    mkdirSync(join(dest, '..'), { recursive: true });
    let root: string;
    try {
      root = await e.install(build, dest, step, signal);
      step('Checking the version', { detail: root, received: undefined, total: undefined });
      const v = await e.version(root);
      if (!v)
        throw new Error(
          `${e.name} in ${root} does not run ${
            // Windows: the MSVC builds (MySQL, PostgreSQL, MongoDB) need the Visual C++ runtime.
            isWin ? '(the Microsoft Visual C++ Redistributable x64 may be missing: https://aka.ms/vs/17/release/vc_redist.x64.exe)' : '(wrong architecture?)'
          }`,
        );
    } catch (err) {
      // Nothing half-installed stays behind (Homebrew cleans up after itself).
      if (build.source !== 'homebrew') await rm(dest, { recursive: true, force: true }).catch(() => undefined);
      throw err;
    }
    const bin: DbBinary = { engine: c.engine, version: c.version, root, source: build.source };
    store.setDbBinaries([...store.dbBinaries.filter((b) => !(b.engine === c.engine && b.version === c.version)), bin]);
    return bin;
  }

  private async installSteps(c: DbServiceConfig): Promise<string[]> {
    if (this.binaryOf(c)) return [];
    const e = DB_ENGINES[c.engine];
    const build = (await e.builds()).find((b) => b.version === c.version);
    if (!build) throw new Error(`${e.name} ${c.version} is not available for download`);
    return e.installSteps(build);
  }

  // ------------------------------------------------------------- create / update / remove

  async create(input: DbServiceInput): Promise<string> {
    const id = `${input.engine}-${randomBytes(4).toString('hex').slice(0, 6)}`;
    const c: DbServiceConfig = { ...input, id, name: input.name.trim(), bootstrapped: false };
    // An empty data path = the default location now; pinned, so a later change of the default does not move it.
    c.dataDir = this.dataDirOf(c);
    this.validate(c, null);
    const e = DB_ENGINES[c.engine];
    const steps = [...(await this.installSteps(c)), 'Preparing the data folder', 'Saving settings', ...(c.engine === 'sqlite' ? [] : ['Starting'])];
    const abort = new AbortController();
    const p: Pending = { config: c, task: null, abort };
    this.pending.set(id, p);
    const t = this.stepper(steps, (task) => (p.task = task), { kind: 'install', title: `Creating ${c.name}` });
    const data = this.dataDirOf(c);
    const dataExisted = existsSync(data);
    try {
      const bin = await this.ensureBinary(c, t.step, abort.signal);
      if (abort.signal.aborted) throw new Cancelled();
      t.step('Preparing the data folder', { detail: data, received: undefined, total: undefined });
      await e.init?.(c, bin.root, data);
      if (abort.signal.aborted) throw new Cancelled();
      t.step('Saving settings', { detail: `${c.name} · ${c.engine === 'sqlite' ? data : `127.0.0.1:${c.port}`}` });
      store.setDbServices([...store.dbServices, c]);
      this.pending.delete(id);
      this.onChange();
      if (c.engine !== 'sqlite') {
        // The instance exists either way; a busy port only shows up as its error.
        await this.action(id, 'start').catch(() => undefined);
      }
      return id;
    } catch (err) {
      if (err instanceof Cancelled || abort.signal.aborted) {
        this.pending.delete(id);
        if (!dataExisted) await rm(data, { recursive: true, force: true }).catch(() => undefined);
        this.onChange();
        throw new Error('Cancelled; nothing was kept');
      }
      t.report({ error: (err as Error).message });
      throw err;
    }
  }

  cancelCreate(id: string): void {
    this.pending.get(id)?.abort.abort();
  }

  dismiss(id: string): void {
    const p = this.pending.get(id);
    if (p && (p.task?.error || p.task?.done)) {
      this.pending.delete(id);
      this.onChange();
    }
    if (this.tasks.get(id)?.error) {
      this.tasks.delete(id);
      this.onChange();
    }
  }

  async update(id: string, input: DbServiceInput): Promise<void> {
    const old = this.get(id);
    const c: DbServiceConfig = { ...old, ...input, id, engine: old.engine, name: input.name.trim() };
    c.dataDir = this.dataDirOf(c);
    this.validate(c, id);
    const e = DB_ENGINES[c.engine];
    const wasActive = this.isActive(id);
    // A new version that is not on disk yet: install it first (shown as the instance's task).
    if (!this.binaryOf(c)) {
      const steps = await this.installSteps(c);
      const abort = new AbortController();
      const t = this.stepper(steps, (task) => (task ? this.tasks.set(id, task) : this.tasks.delete(id)), { kind: 'install', title: `Installing ${e.name} ${c.version}` });
      try {
        await this.ensureBinary(c, t.step, abort.signal);
        t.finish();
        setTimeout(() => {
          this.tasks.delete(id);
          this.onChange();
        }, 4000);
      } catch (err) {
        t.report({ error: (err as Error).message });
        throw err;
      }
    }
    // Passwords live in the server: change them there first (it has to run).
    if (c.password !== old.password && (c.engine === 'mysql' || c.engine === 'mariadb' || c.engine === 'postgresql')) {
      if (!wasActive) throw new Error(`Start ${old.name} to change its password`);
      await this.setPassword(old, c.password);
    }
    store.setDbServices(store.dbServices.map((x) => (x.id === id ? c : x)));
    this.onChange();
    // Redis takes its password on the command line; the SQL engines changed it in place above.
    const runtime: (keyof DbServiceConfig)[] = ['version', 'port', 'socket', 'dataDir', 'configFile', 'disableBinLog', ...(c.engine === 'redis' || c.engine === 'valkey' ? (['password'] as const) : [])];
    if (wasActive && runtime.some((k) => c[k] !== old[k])) await this.action(id, 'restart');
  }

  private async setPassword(c: DbServiceConfig, next: string): Promise<void> {
    const bin = this.binaryOf(c);
    if (!bin) throw new Error('The server build is missing');
    if (c.engine === 'postgresql') {
      await client(binOf(bin.root, 'psql'), [...psqlArgs(c), '-c', `ALTER ROLE "${c.user || 'root'}" PASSWORD ${next ? `'${next.replace(/'/g, "''")}'` : 'NULL'}`], { PGPASSWORD: c.password });
      return;
    }
    const p = next.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const user = c.user || 'root';
    const env = { MYSQL_PWD: c.password };
    // Every host of the user: MariaDB's install also creates root@127.0.0.1, root@::1 and root@<hostname>.
    const hosts = (await client(mysqlClient(bin.root), [...mysqlClientArgs(c), '-N', '-e', `SELECT host FROM mysql.user WHERE user = '${user}'`], env))
      .split('\n')
      .map((h) => h.trim())
      .filter(Boolean);
    const sql = hosts.map((h) => `ALTER USER '${user}'@'${h.replace(/'/g, "\\'")}' IDENTIFIED BY '${p}';`).join(' ');
    await client(mysqlClient(bin.root), [...mysqlClientArgs(c), '-e', `${sql} FLUSH PRIVILEGES;`], env);
  }

  async remove(id: string, deleteData: boolean): Promise<void> {
    const c = this.get(id);
    await this.stopServer(c);
    if (deleteData) await rm(this.dataDirOf(c), { recursive: true, force: true });
    // Elasticsearch's per-instance config folder.
    await rm(dataDir('db-services', 'config', id), { recursive: true, force: true });
    store.setDbServices(store.dbServices.filter((x) => x.id !== id));
    this.unlinkSites(id);
    this.processes.clearLogs(dbProcessId(id));
    this.errors.delete(id);
    this.onChange();
  }

  // ------------------------------------------------------------- run

  async action(id: string, action: StorageAction): Promise<void> {
    const c = this.get(id);
    if (c.engine === 'sqlite') return;
    const pid = dbProcessId(id);
    if (action === 'stop' || action === 'restart') await this.stopServer(c);
    if (action === 'stop') return;
    const e = DB_ENGINES[c.engine];
    const fail = (msg: string): never => {
      this.processes.log(pid, 'sys', msg);
      this.errors.set(id, msg);
      this.onChange();
      throw new Error(msg);
    };
    for (let i = 0; i < 10 && (await isPortOpen(c.port)); i++) await new Promise((r) => setTimeout(r, 300));
    for (const port of c.engine === 'elasticsearch' ? [c.port, c.port + 100] : [c.port]) {
      if (await isPortOpen(port)) {
        const owner = await portOwner(port);
        fail(`Port ${port} is already in use${owner ? ` by ${owner}` : ''}; change ${c.name}'s port or stop the other server.`);
      }
    }
    const bin = this.binaryOf(c);
    if (!bin) fail(`${e.name} ${c.version} is not installed; pick the version again in ${c.name}'s settings to install it.`);
    const data = this.dataDirOf(c);
    this.errors.delete(id);
    try {
      await e.init?.(c, bin!.root, data);
    } catch (err) {
      fail((err as Error).message);
    }
    const spec = e.spec!(c, bin!.root, data, this.socketOf(c));
    // Windows: the server runs under cmd.exe, so a forced stop has to end the tree (taskkill /T), not just the leader.
    this.processes.startMany(pid, [{ label: '', cwd: data, command: spec.command, env: spec.env, stopSignal: spec.stopSignal, leaderOnly: !isWin }]);
    this.onChange();
  }

  /**
   * Stops an instance's server. Windows has no SIGTERM / SIGINT for console programs (the process manager's stop is
   * taskkill /F): the engine's own shutdown first (SHUTDOWN, pg_ctl stop, redis-cli shutdown), then whatever is left.
   */
  private async stopServer(c: DbServiceConfig): Promise<void> {
    const pid = dbProcessId(c.id);
    const e = DB_ENGINES[c.engine];
    const bin = this.binaryOf(c);
    if (isWin && e.shutdown && bin && this.processes.getStatus(pid).status === 'running') {
      this.processes.log(pid, 'sys', 'Shutting down…');
      await e.shutdown(c, bin.root, this.dataDirOf(c)).catch((err: Error) => this.processes.log(pid, 'sys', `Shutdown request failed: ${err.message}`));
      for (let i = 0; i < 60 && this.isActive(c.id); i++) await new Promise((r) => setTimeout(r, 500));
    }
    await this.processes.stop(pid);
  }

  /** "running" once the port answers; then the one-time bootstrap. */
  private async poll(): Promise<void> {
    for (const c of store.dbServices) {
      const pid = dbProcessId(c.id);
      if (this.processes.getStatus(pid).status !== 'starting') continue;
      if (!(await isPortOpen(c.port))) continue;
      this.processes.markRunning(pid);
      this.processes.log(pid, 'sys', `Ready on 127.0.0.1:${c.port}`);
      if (!c.bootstrapped && !this.booting.has(c.id)) void this.bootstrap(c);
    }
  }

  private async bootstrap(c: DbServiceConfig): Promise<void> {
    const e = DB_ENGINES[c.engine];
    const bin = this.binaryOf(c);
    this.booting.add(c.id);
    try {
      if (e.bootstrap && bin) {
        // MySQL accepts TCP a moment before it accepts logins.
        for (let i = 0; ; i++) {
          try {
            await e.bootstrap(c, bin.root);
            break;
          } catch (err) {
            if (i >= 5) throw err;
            await new Promise((r) => setTimeout(r, 1000));
          }
        }
        this.processes.log(dbProcessId(c.id), 'sys', 'First start: users set up');
      }
      store.setDbServices(store.dbServices.map((x) => (x.id === c.id ? { ...x, bootstrapped: true } : x)));
    } catch (err) {
      this.processes.log(dbProcessId(c.id), 'sys', `First-start setup failed: ${(err as Error).message}`);
    } finally {
      this.booting.delete(c.id);
    }
  }

  /** Fills the version cache in the background, so the create form opens with its lists. */
  async prefetchVersions(): Promise<void> {
    for (const engine of DB_ENGINE_ORDER) await DB_ENGINES[engine].builds().catch(() => undefined);
  }

  autoStart(): void {
    for (const c of store.dbServices) if (c.autoStart && c.engine !== 'sqlite') this.action(c.id, 'start').catch((e) => console.error(`${c.name}:`, e.message));
  }

  async stopAll(): Promise<void> {
    if (isWin) await Promise.all(store.dbServices.filter((c) => this.isActive(c.id)).map((c) => this.stopServer(c)));
    return this.processes.stopAll();
  }

  // ------------------------------------------------------------- databases in an instance

  async databases(id: string): Promise<string[]> {
    const c = this.get(id);
    const bin = this.binaryOf(c);
    if (c.engine === 'sqlite') {
      const dir = this.dataDirOf(c);
      return existsSync(dir) ? readdirSync(dir).filter((f) => /\.(sqlite3?|db)$/i.test(f) && statSync(join(dir, f)).isFile()).sort() : [];
    }
    if (!bin || !this.isActive(id)) return [];
    if (c.engine === 'mysql' || c.engine === 'mariadb') {
      const out = await client(mysqlClient(bin.root), [...mysqlClientArgs(c), '-N', '-e', 'SHOW DATABASES'], { MYSQL_PWD: c.password });
      return out.split('\n').map((s) => s.trim()).filter((s) => s && !['information_schema', 'performance_schema', 'mysql', 'sys'].includes(s));
    }
    if (c.engine === 'postgresql') {
      const out = await client(binOf(bin.root, 'psql'), [...psqlArgs(c), '-tAc', 'SELECT datname FROM pg_database WHERE NOT datistemplate ORDER BY 1'], { PGPASSWORD: c.password });
      return out.split('\n').map((s) => s.trim()).filter(Boolean);
    }
    return [];
  }

  async createDatabase(id: string, name: string): Promise<void> {
    const c = this.get(id);
    if (!DB_NAME.test(name)) throw new Error('Database names: letters, digits, _ and -, up to 64 characters');
    if (c.engine === 'sqlite') {
      const dir = this.dataDirOf(c);
      mkdirSync(dir, { recursive: true });
      const file = join(dir, /\.(sqlite3?|db)$/i.test(name) ? name : `${name}.sqlite`);
      if (existsSync(file)) throw new Error(`${file} already exists`);
      // Opening creates the file; a pragma makes it a real (non-empty) database.
      const db = new DatabaseSync(file);
      db.exec('PRAGMA journal_mode = WAL;');
      db.close();
      return;
    }
    const bin = this.binaryOf(c);
    if (!bin || !this.isActive(id)) throw new Error(`Start ${c.name} first`);
    if (c.engine === 'mysql' || c.engine === 'mariadb') {
      await client(mysqlClient(bin.root), [...mysqlClientArgs(c), '-e', `CREATE DATABASE IF NOT EXISTS \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`], { MYSQL_PWD: c.password });
    } else if (c.engine === 'postgresql') {
      await client(binOf(bin.root, 'psql'), [...psqlArgs(c), '-c', `CREATE DATABASE "${name}"`], { PGPASSWORD: c.password });
    } else {
      throw new Error(`${DB_ENGINES[c.engine].name} creates databases on first use`);
    }
  }

  /**
   * Copies a database on this service into a new one (a worktree's own database): MySQL / MariaDB with
   * mysqldump | mysql, PostgreSQL with pg_dump | psql, SQLite by copying the file. The target must not exist.
   */
  async copyDatabase(id: string, from: string, to: string): Promise<void> {
    const c = this.get(id);
    if (!DB_NAME.test(to)) throw new Error('Database names: letters, digits, _ and -, up to 64 characters');
    if (c.engine === 'sqlite') {
      const dir = this.dataDirOf(c);
      const src = join(dir, from);
      const dest = join(dir, /\.(sqlite3?|db)$/i.test(to) ? to : `${to}${extname(from) || '.sqlite'}`);
      if (!existsSync(src)) throw new Error(`${src} not found`);
      if (existsSync(dest)) throw new Error(`${dest} already exists`);
      copyFileSync(src, dest);
      return;
    }
    const bin = this.binaryOf(c);
    if (!bin || !this.isActive(id)) throw new Error(`Start ${c.name} first`);
    if ((await this.databases(id)).includes(to)) throw new Error(`${to} already exists on ${c.name}`);
    await this.createDatabase(id, to);
    try {
      if (c.engine === 'mysql' || c.engine === 'mariadb') {
        const dump = [binOf(bin.root, 'mariadb-dump'), binOf(bin.root, 'mysqldump')].find((f) => existsSync(f));
        if (!dump) throw new Error(`No mysqldump in ${bin.root}`);
        await pipeCommands(
          [dump, [...mysqlClientArgs(c), '--single-transaction', '--routines', '--triggers', '--events', from]],
          [mysqlClient(bin.root), [...mysqlClientArgs(c), to]],
          { MYSQL_PWD: c.password },
        );
      } else if (c.engine === 'postgresql') {
        const dump = binOf(bin.root, 'pg_dump');
        if (!existsSync(dump)) throw new Error(`No pg_dump in ${bin.root}`);
        await pipeCommands(
          [dump, ['-h', '127.0.0.1', '-p', String(c.port), '-U', c.user || 'root', '--no-owner', '--no-privileges', from]],
          [binOf(bin.root, 'psql'), [...psqlArgs(c, to), '-q']],
          { PGPASSWORD: c.password },
        );
      } else {
        throw new Error(`${DB_ENGINES[c.engine].name} databases cannot be copied`);
      }
    } catch (e) {
      await this.dropDatabase(id, to).catch(() => undefined);
      throw e;
    }
  }

  // ------------------------------------------------------------- import from another app

  /**
   * A server outside DevCatz (DBngin, Laravel Herd, Postgres.app, Homebrew, Docker …) seen through the target
   * service's own client tools: the same engine family (MySQL ↔ MariaDB, PostgreSQL), on 127.0.0.1 and the source's
   * port, with the credentials the user gave. Only read: nothing on the source changes.
   */
  private importTarget(targetId: string, src: DbImportSource): { c: DbServiceConfig; s: DbServiceConfig; root: string } {
    const c = this.get(targetId);
    const family = (e: string) => (e === 'mariadb' ? 'mysql' : e);
    if (family(c.engine) !== family(src.engine)) throw new Error(`${c.name} is ${DB_ENGINES[c.engine].name}; pick a ${DB_ENGINES[src.engine].name} service to import into`);
    if (!Number.isInteger(src.port) || src.port < 1 || src.port > 65535) throw new Error('Invalid port');
    if (store.dbServices.some((x) => x.port === src.port)) throw new Error(`Port ${src.port} is a DevCatz service`);
    const bin = this.binaryOf(c);
    if (!bin || !this.isActive(targetId)) throw new Error(`Start ${c.name} first`);
    return { c, s: { ...c, port: src.port, user: src.user.trim(), password: src.password }, root: bin.root };
  }

  async importList(targetId: string, src: DbImportSource): Promise<DbImportCandidate[]> {
    const { c, s, root } = this.importTarget(targetId, src);
    const have = new Set(await this.databases(targetId));
    let rows: [string, number | null][] = [];
    if (c.engine === 'mysql' || c.engine === 'mariadb') {
      const out = await client(mysqlClient(root), [...mysqlClientArgs(s), '-N', '-e', 'SELECT s.schema_name, SUM(t.data_length + t.index_length) FROM information_schema.schemata s LEFT JOIN information_schema.tables t ON t.table_schema = s.schema_name GROUP BY s.schema_name'], { MYSQL_PWD: s.password });
      rows = out.split('\n').filter(Boolean).map((l) => l.split('\t')).map(([n, b]) => [n, b && b !== 'NULL' ? Number(b) : null]);
      rows = rows.filter(([n]) => !['information_schema', 'performance_schema', 'mysql', 'sys'].includes(n));
    } else {
      const out = await client(binOf(root, 'psql'), [...psqlArgs(s), '-tAF', '\t', '-c', 'SELECT datname, pg_database_size(datname) FROM pg_database WHERE NOT datistemplate ORDER BY 1'], { PGPASSWORD: s.password });
      rows = out.split('\n').filter(Boolean).map((l) => l.split('\t')).map(([n, b]) => [n, Number(b) || null]);
      rows = rows.filter(([n]) => n !== 'postgres');
    }
    return rows.map(([name, bytes]) => ({ name, bytes, exists: have.has(name) })).sort((a, b) => a.name.localeCompare(b.name));
  }

  async importOne(targetId: string, src: DbImportSource, name: string): Promise<void> {
    const { c, s, root } = this.importTarget(targetId, src);
    if (!DB_NAME.test(name)) throw new Error(`${name}: DevCatz takes database names of letters, digits, _ and -`);
    if ((await this.databases(targetId)).includes(name)) throw new Error(`${name} already exists on ${c.name}`);
    await this.createDatabase(targetId, name);
    try {
      if (c.engine === 'mysql' || c.engine === 'mariadb') {
        const dump = [binOf(root, 'mariadb-dump'), binOf(root, 'mysqldump')].find((f) => existsSync(f));
        if (!dump) throw new Error(`No mysqldump in ${root}`);
        const mysqldump = /mysqldump(\.exe)?$/.test(dump);
        const opts = ['--single-transaction', '--routines', '--triggers', '--events', '--no-tablespaces', ...(mysqldump ? ['--set-gtid-purged=OFF', ...(src.engine === 'mariadb' ? ['--column-statistics=0'] : [])] : [])];
        await pipeCommands([dump, [...mysqlClientArgs(s), ...opts, name]], [mysqlClient(root), [...mysqlClientArgs(c), name]], { MYSQL_PWD: s.password }, 2 * 60 * 60_000);
      } else {
        const dump = binOf(root, 'pg_dump');
        if (!existsSync(dump)) throw new Error(`No pg_dump in ${root}`);
        await pipeCommands(
          [dump, ['-h', '127.0.0.1', '-p', String(s.port), '-U', s.user || 'postgres', '--no-owner', '--no-privileges', name]],
          [binOf(root, 'psql'), [...psqlArgs(c, name), '-q']],
          { PGPASSWORD: s.password },
          2 * 60 * 60_000,
        );
      }
    } catch (e) {
      await this.dropDatabase(targetId, name).catch(() => undefined);
      throw e;
    }
  }

  /** Drops a database (a worktree's copy when the worktree is removed). */
  async dropDatabase(id: string, name: string): Promise<void> {
    const c = this.get(id);
    if (!DB_NAME.test(name)) throw new Error('Invalid database name');
    if (c.engine === 'sqlite') {
      const file = join(this.dataDirOf(c), name);
      if (existsSync(file)) await rm(file);
      return;
    }
    const bin = this.binaryOf(c);
    if (!bin || !this.isActive(id)) throw new Error(`Start ${c.name} first`);
    if (c.engine === 'mysql' || c.engine === 'mariadb') {
      await client(mysqlClient(bin.root), [...mysqlClientArgs(c), '-e', `DROP DATABASE IF EXISTS \`${name}\``], { MYSQL_PWD: c.password });
    } else if (c.engine === 'postgresql') {
      await client(binOf(bin.root, 'psql'), [...psqlArgs(c), '-c', `DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`], { PGPASSWORD: c.password });
    }
  }

  // ------------------------------------------------------------- builds

  /** Shows a build in Finder, or removes it (downloads and source builds only; Homebrew's stay with Homebrew). */
  async buildAction(engine: DbEngine, version: string, action: 'reveal' | 'remove'): Promise<string | null> {
    const b = store.dbBinaries.find((x) => x.engine === engine && x.version === version);
    if (!b) throw new Error('Unknown build');
    if (action === 'reveal') return b.root;
    const users = store.dbServices.filter((c) => c.engine === engine && c.version === version);
    if (users.length) throw new Error(`Used by ${users.map((u) => u.name).join(', ')}`);
    if (b.source === 'download' || b.source === 'source') await rm(b.root, { recursive: true, force: true });
    store.setDbBinaries(store.dbBinaries.filter((x) => x !== b));
    this.onChange();
    return null;
  }

  // ------------------------------------------------------------- detection

  /** Database servers listening here that DevCatz does not run (DBngin, Herd, Docker, Homebrew …). */
  async detect(): Promise<{ running: ExternalDbService[]; dbngin: DbnginInstall[] }> {
    const ours = new Set(store.dbServices.filter((c) => this.isActive(c.id)).map((c) => c.port));
    if (isWin) return { running: await this.detectWindows(ours), dbngin: [] };
    const { stdout } = await run('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpcn'], { timeout: 10_000 });
    const byPid = new Map<number, { command: string; ports: Set<number> }>();
    let pid = 0;
    for (const line of stdout.split('\n')) {
      if (line.startsWith('p')) {
        pid = Number(line.slice(1));
        if (!byPid.has(pid)) byPid.set(pid, { command: '', ports: new Set() });
      } else if (line.startsWith('c')) byPid.get(pid)!.command = line.slice(1);
      else if (line.startsWith('n')) {
        const port = Number(line.match(/:(\d+)$/)?.[1]);
        if (port) byPid.get(pid)?.ports.add(port);
      }
    }
    const WELL_KNOWN: Record<number, DbEngine> = { 3306: 'mysql', 3307: 'mysql', 5432: 'postgresql', 5433: 'postgresql', 6379: 'redis', 6380: 'redis', 27017: 'mongodb', 9200: 'elasticsearch' };
    const byName = (cmd: string, path: string): DbEngine | null => {
      if (/mariadbd|mariadb/i.test(path)) return 'mariadb';
      if (/mysqld/.test(cmd)) return 'mysql';
      if (/^postgres/.test(cmd)) return 'postgresql';
      if (/valkey-server/.test(cmd)) return 'valkey';
      if (/redis-server/.test(cmd)) return 'redis';
      if (/^mongod$/.test(cmd)) return 'mongodb';
      if (/elasticsearch|opensearch/i.test(path)) return 'elasticsearch';
      return null;
    };
    const out: ExternalDbService[] = [];
    for (const [p, info] of byPid) {
      const path = (await run('ps', ['-o', 'comm=', '-p', String(p)])).stdout.trim();
      const isContainer = /com\.docker|docker|OrbStack|vpnkit|colima|limactl|podman|gvproxy|rancher/i.test(`${info.command} ${path}`);
      let engine = byName(info.command, path);
      const ports = [...info.ports].filter((x) => !ours.has(x)).sort((a, b) => a - b);
      if (!engine && isContainer) {
        // Containers: one entry per well-known database port they publish.
        for (const port of ports) {
          const e = WELL_KNOWN[port];
          if (e) out.push({ engine: e, port, pid: p, process: info.command, source: /orbstack/i.test(path) ? 'OrbStack' : 'Docker', path });
        }
        continue;
      }
      if (!engine || !ports.length) continue;
      // mysqld also listens on 33060 (X protocol): show the classic port.
      const port = ports.find((x) => WELL_KNOWN[x] === engine || (engine === 'mariadb' && WELL_KNOWN[x] === 'mysql')) ?? ports.find((x) => x !== 33060) ?? ports[0];
      const source: ExternalDbService['source'] = /DBngin/i.test(path)
        ? 'DBngin'
        : /Herd/.test(path)
          ? 'Laravel Herd'
          : /Postgres\.app/.test(path)
            ? 'Postgres.app'
            : /homebrew|\/usr\/local\/(Cellar|opt)/i.test(path)
              ? 'Homebrew'
              : isContainer
                ? 'Docker'
                : 'Other';
      if (path.includes(dataDir())) continue; // ours, already listed
      out.push({ engine, port, pid: p, process: info.command, source, path });
    }
    const dbngin: DbnginInstall[] = [];
    const root = '/Users/Shared/DBngin';
    for (const [dir, engine] of [
      ['mysql', 'mysql'],
      ['mariadb', 'mariadb'],
      ['postgresql', 'postgresql'],
      ['redis', 'redis'],
    ] as const) {
      try {
        for (const v of readdirSync(join(root, dir))) if (!v.startsWith('.')) dbngin.push({ engine, version: v.replace(/_arm$/, '') });
      } catch {
        /* not installed */
      }
    }
    return { running: out.sort((a, b) => a.port - b.port), dbngin };
  }

  /**
   * Windows: no lsof, DBngin, Herd databases or Homebrew; the well-known database ports that answer, named by the
   * process netstat sees on them (Docker Desktop / WSL publish through their relay processes).
   */
  private async detectWindows(ours: Set<number>): Promise<ExternalDbService[]> {
    const WELL_KNOWN: [number, DbEngine][] = [
      [3306, 'mysql'],
      [3307, 'mysql'],
      [5432, 'postgresql'],
      [5433, 'postgresql'],
      [6379, 'redis'],
      [6380, 'redis'],
      [27017, 'mongodb'],
      [9200, 'elasticsearch'],
    ];
    const out: ExternalDbService[] = [];
    for (const [port, guess] of WELL_KNOWN) {
      if (ours.has(port) || !(await isPortOpen(port))) continue;
      // "mysqld.exe (pid 123)"
      const owner = await portOwner(port);
      const m = owner?.match(/^(.*) \(pid (\d+)\)$/);
      const name = (m?.[1] ?? '').replace(/\.exe$/i, '');
      const engine: DbEngine = /mariadbd/i.test(name)
        ? 'mariadb'
        : /mysqld/i.test(name)
          ? 'mysql'
          : /^postgres/i.test(name)
            ? 'postgresql'
            : /valkey-server/i.test(name)
              ? 'valkey'
              : /redis-server/i.test(name)
                ? 'redis'
                : /^mongod$/i.test(name)
                  ? 'mongodb'
                  : guess;
      const docker = /docker|wslrelay|vpnkit|com\.docker/i.test(name);
      out.push({ engine, port, pid: m ? Number(m[2]) : null, process: name || 'unknown', source: docker ? 'Docker' : 'Other', path: null });
    }
    return out;
  }

  // ------------------------------------------------------------- state

  state(): DbServiceState[] {
    const one = (c: DbServiceConfig, pending: Pending | null): DbServiceState => {
      const bin = this.binaryOf(c);
      const status = c.engine === 'sqlite' ? 'running' : this.processes.getStatus(dbProcessId(c.id)).status;
      return {
        ...c,
        host: c.engine === 'sqlite' ? null : this.host(),
        engineName: DB_ENGINES[c.engine].name,
        status: pending ? 'stopped' : status,
        error: pending ? (pending.task?.error ?? null) : (this.errors.get(c.id) ?? null),
        task: pending ? pending.task : (this.tasks.get(c.id) ?? null),
        pending: Boolean(pending),
        resolvedDataDir: this.dataDirOf(c),
        resolvedSocket: this.socketOf(c),
        binaryRoot: bin?.root ?? null,
        linkedSites: pending ? [] : this.linkedSites(c.id),
      };
    };
    return [...store.dbServices.map((c) => one(c, null)), ...[...this.pending.values()].map((p) => one(p.config, p))];
  }

  /** Ids are generated here; anything else from the window is refused. */
  static validId(id: string): boolean {
    return ID.test(id);
  }
}
