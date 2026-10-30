import { spawn } from 'node:child_process';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { createServer, request as httpRequest, type IncomingMessage, type Server } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { basename, extname, join } from 'node:path';
import type { ProcessStatus, ProjectConfig, StorageAction, TaskProgress, WaConfig, WaContact, WaDelivery, WaEngine, WaHook, WaMessage, WaSendInput, WaSendResult, WaSession, WaState } from '@shared/types';
import { readEnvFiles } from './detect';
import { dockerBin, dockerStatus } from './docker';
import { getShellEnv, run } from './env';
import { ProcessManager } from './processes';
import type { Route } from './proxy';
import { Cancelled, check, githubAsset, installFrom, INSTALL_STEPS } from './storage';
import { dataDir, store, tld } from './store';
import { githubLatest, isNewer, UPDATE_TAIL, upgradeBinaries } from './svcupdate';

/**
 * WhatsApp gateways for local development: GOWA (go-whatsapp-web-multidevice,
 * a Go binary from GitHub releases) and WAHA (WhatsApp HTTP API, its Docker
 * image). One instance each on 127.0.0.1:<port>, also reachable on
 * https://<label>.<tld> through the proxy. Sessions are linked with a QR
 * code; the engines post their events to DevCatz's webhook receiver, which
 * keeps them for the inspector and forwards them to sites (with Replay).
 *
 * Both talk the WhatsApp Web protocol, which WhatsApp does not sanction: the
 * UI says to use a test number.
 */

interface Hooks {
  projects(): ProjectConfig[];
  runtime(siteId: string): 'node' | 'go' | 'php' | 'python' | 'rust' | null;
  framework(siteId: string): string | null;
  takenDomains(): string[];
  changed(): void;
  notify(title: string, body: string): void;
}

interface EngineDef {
  name: string;
  description: string;
  docker: boolean;
  port: number;
  label: string;
  dashboardPath: string;
  defaultSession: string;
}

/** DevCatz's page on the WAHA domain that points the dashboard at the right key (see wahaBootstrap). */
const WAHA_BOOTSTRAP = '/devcatz-dashboard';

const ENGINES: Record<WaEngine, EngineDef> = {
  gowa: {
    name: 'GOWA',
    description: 'go-whatsapp-web-multidevice: one Go binary with a REST API, webhooks and a web UI; several devices.',
    docker: false,
    port: 3010,
    label: 'gowa',
    dashboardPath: '/',
    defaultSession: 'default',
  },
  waha: {
    name: 'WAHA',
    description: 'WhatsApp HTTP API (Core): a Docker image with a REST API, dashboard, Swagger docs and webhooks.',
    docker: true,
    port: 3020,
    label: 'waha',
    dashboardPath: WAHA_BOOTSTRAP,
    defaultSession: 'default',
  },
};
const KINDS: WaEngine[] = ['gowa', 'waha'];
const GOWA_REPO = 'aldinokemal/go-whatsapp-web-multidevice';
const WAHA_IMAGE = 'devlikeapro/waha';
const BODY_LIMIT = 64 * 1024;
const DELIVERIES_KEPT = 500;
const MIME: Record<string, string> = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp', '.pdf': 'application/pdf', '.txt': 'text/plain', '.csv': 'text/csv', '.zip': 'application/zip', '.mp4': 'video/mp4', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };

type Report = (p: Partial<TaskProgress>) => void;
const id = () => `${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;
const secret = (n = 24) => randomBytes(n).toString('base64url');
const host = (label: string) => `${label}.${tld()}`;
const q = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
const waId = (engine: WaEngine) => `wa:${engine}`;
/** Configs saved before the user became editable have none. */
const userOf = (c: WaConfig) => c.apiUser || 'devcatz';

interface Stored {
  configs: Partial<Record<WaEngine, WaConfig>>;
  hooks: WaHook[];
}

/**
 * WAHA publishes per-architecture tags: `latest-YYYY.M.N` (amd64) and
 * `arm-YYYY.M.N` (arm64); DevCatz keeps the bare version and picks the tag here.
 */
const wahaTag = (version: string) => (version === 'latest' ? (process.arch === 'arm64' ? 'arm' : 'latest') : `${process.arch === 'arm64' ? 'arm' : 'latest'}-${version}`);

/** Newest WAHA version on Docker Hub (YYYY.M.N) with a build for this Mac, or `latest`. */
async function wahaLatest(): Promise<string> {
  const res = await fetch(`https://hub.docker.com/v2/repositories/${WAHA_IMAGE}/tags?page_size=100&ordering=last_updated`);
  if (!res.ok) throw new Error(`Docker Hub: HTTP ${res.status}`);
  const prefix = process.arch === 'arm64' ? 'arm-' : 'latest-';
  const names = ((await res.json()) as { results: { name: string }[] }).results
    .map((t) => t.name)
    .filter((n) => n.startsWith(prefix) && /^\d{4}\.\d{1,2}\.\d+$/.test(n.slice(prefix.length)))
    .map((n) => n.slice(prefix.length));
  return names.sort((a, b) => (isNewer(a, b) ? -1 : 1))[0] ?? 'latest';
}

export class WaManager {
  readonly processes = new ProcessManager('wa-pids.json');
  private tasks = new Map<WaEngine, TaskProgress>();
  private aborts = new Map<WaEngine, AbortController>();
  private errors = new Map<WaEngine, string>();
  private updates = new Map<WaEngine, string>();
  private sessions = new Map<WaEngine, WaSession[]>();
  private sessionKey = new Map<WaEngine, string>();
  private messages: WaMessage[] = [];
  private deliveries: WaDelivery[] = [];
  private receiver: Server;
  private receiverPort = 0;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private h: Hooks) {
    mkdirSync(this.dir, { recursive: true });
    this.load();
    this.receiver = createServer((req, res) => void this.receive(req, res));
    this.receiver.listen(0, '127.0.0.1', () => {
      this.receiverPort = (this.receiver.address() as { port: number }).port;
    });
    this.processes.on('status', () => this.h.changed());
    setInterval(() => void this.pollSessions(), 5000);
    setTimeout(() => void this.checkUpdates(), 45_000);
    setInterval(() => void this.checkUpdates(), 6 * 3600_000);
  }

  private get dir() {
    return dataDir('whatsapp');
  }
  binDir(engine: WaEngine) {
    return join(this.dir, engine, 'bin');
  }
  private stored(): Stored {
    return store.extra<Stored>('whatsapp') ?? { configs: {}, hooks: [] };
  }
  private save(patch: Partial<Stored>) {
    store.setExtra('whatsapp', { ...this.stored(), ...patch });
  }
  config(engine: WaEngine): WaConfig | null {
    return this.stored().configs[engine] ?? null;
  }

  private load() {
    try {
      this.messages = JSON.parse(readFileSync(join(this.dir, 'messages.json'), 'utf8')) as WaMessage[];
    } catch {
      this.messages = [];
    }
    try {
      this.deliveries = JSON.parse(readFileSync(join(this.dir, 'deliveries.json'), 'utf8')) as WaDelivery[];
    } catch {
      this.deliveries = [];
    }
  }
  private persist() {
    this.saveTimer ??= setTimeout(() => {
      this.saveTimer = null;
      writeFileSync(join(this.dir, 'messages.json'), JSON.stringify(this.messages));
      writeFileSync(join(this.dir, 'deliveries.json'), JSON.stringify(this.deliveries));
    }, 500);
  }

  // ---------------------------------------------------------------- state

  defaults(engine: WaEngine): WaConfig {
    const e = ENGINES[engine];
    return { engine, port: e.port, domain: e.label, apiUser: 'devcatz', apiKey: secret(18), version: '', autoStart: false, dataDir: join(this.dir, engine, 'data') };
  }

  state(): WaState[] {
    return KINDS.map((engine) => {
      const e = ENGINES[engine];
      const c = this.config(engine);
      const status: ProcessStatus = c ? this.processes.getStatus(waId(engine)).status : 'stopped';
      return {
        engine,
        name: e.name,
        description: e.description,
        docker: e.docker,
        installed: Boolean(c),
        config: c,
        defaults: this.defaults(engine),
        status,
        error: this.errors.get(engine) ?? null,
        task: this.tasks.get(engine) ?? null,
        url: c ? `https://${host(c.domain)}` : null,
        apiLocal: c ? `http://127.0.0.1:${c.port}` : null,
        update: c ? (this.updates.get(engine) ?? null) : null,
        sessions: this.sessions.get(engine) ?? [],
        dashboardPath: e.dashboardPath,
      };
    });
  }

  routes(): Route[] {
    return KINDS.flatMap((engine) => {
      const c = this.config(engine);
      if (!c) return [];
      const route: Route = { domain: host(c.domain), port: c.port, projectName: ENGINES[engine].name, running: this.processes.isActive(waId(engine)), secure: true };
      if (engine === 'waha') route.pages = { [WAHA_BOOTSTRAP]: (req, res) => this.wahaBootstrap(c, req, res) };
      return [route];
    });
  }

  /**
   * WAHA's dashboard keeps its servers in localStorage and, when there are
   * none, tries this origin with the key "admin", which never matches the key
   * DevCatz generated ("not connected"). This page (behind the dashboard's
   * basic auth) writes the right key for this origin, then opens the dashboard.
   */
  private wahaBootstrap(c: WaConfig, req: IncomingMessage, res: import('node:http').ServerResponse): void {
    const auth = req.headers.authorization ?? '';
    const ok = auth.startsWith('Basic ') && Buffer.from(auth.slice(6), 'base64').toString('utf8') === `${userOf(c)}:${c.apiKey}`;
    if (!ok) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="WAHA (DevCatz)"', 'Content-Type': 'text/plain' });
      res.end('Authentication required');
      return;
    }
    const key = JSON.stringify(c.apiKey);
    const html = `<!doctype html><meta charset="utf-8"><title>WAHA</title><script>
(() => {
  const origin = location.origin;
  let list = [];
  try { list = JSON.parse(localStorage.getItem('servers') || '[]'); } catch {}
  if (!Array.isArray(list)) list = [];
  const mine = list.find((s) => s && s.connection && s.connection.url === origin);
  if (mine) mine.connection.key = ${key};
  else list.unshift({ id: 'waha_devcatz', name: 'WAHA (DevCatz)', connection: { url: origin, key: ${key} } });
  localStorage.setItem('servers', JSON.stringify(list));
  location.replace('/dashboard/');
})();
</script>`;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(html);
  }

  domains(): string[] {
    return KINDS.map((k) => this.config(k)).filter((c): c is WaConfig => Boolean(c)).map((c) => host(c.domain));
  }

  isActive(engine: WaEngine) {
    return this.processes.isActive(waId(engine));
  }

  // ---------------------------------------------------------------- tasks

  /** Hides a task that ended (done, failed or cancelled). */
  dismissTask(engine: WaEngine): void {
    const t = this.tasks.get(engine);
    if (t && (t.done || t.error)) {
      this.tasks.delete(engine);
      this.h.changed();
    }
  }

  private task(engine: WaEngine, t: TaskProgress) {
    this.tasks.set(engine, t);
    this.h.changed();
    const report: Report = (p) => {
      this.tasks.set(engine, { ...this.tasks.get(engine)!, ...p });
      this.h.changed();
    };
    return {
      report,
      finish: () => {
        report({ step: this.tasks.get(engine)!.steps.length, done: true });
        setTimeout(() => {
          if (this.tasks.get(engine)?.done) {
            this.tasks.delete(engine);
            this.h.changed();
          }
        }, 4000);
      },
      fail: (err: unknown) => {
        const e = err as Error;
        report({ error: e.message, cancelled: e instanceof Cancelled });
        throw e;
      },
    };
  }

  private validate(c: WaConfig, current: WaConfig | null) {
    if (!Number.isInteger(c.port) || c.port < 1024 || c.port > 65535) throw new Error('Port: 1024–65535');
    if (!/^[a-z0-9-]+$/.test(c.domain)) throw new Error('Domain label: letters, digits and dashes (e.g. gowa)');
    if (!/^[A-Za-z0-9_.-]{1,40}$/.test(c.apiUser)) throw new Error('Basic auth user: letters, digits, . _ -');
    if (c.apiKey.length < 8) throw new Error('API key: at least 8 characters');
    const others = KINDS.filter((k) => k !== c.engine).map((k) => this.config(k)).filter((x): x is WaConfig => Boolean(x));
    if (others.some((o) => o.port === c.port)) throw new Error(`Port ${c.port} is used by the other WhatsApp engine`);
    if (current?.domain !== c.domain && [...this.h.takenDomains(), ...others.map((o) => host(o.domain))].includes(host(c.domain))) throw new Error(`${host(c.domain)} is already used`);
  }

  // ---------------------------------------------------------------- install

  /** GOWA: the darwin build of the newest release; placed as `gowa` in `dir`. Resolves with the release tag. */
  private async fetchGowa(dir: string, report: Report, signal: AbortSignal): Promise<string> {
    report({ step: 0, detail: `github.com/${GOWA_REPO} releases` });
    const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';
    const a = await githubAsset(GOWA_REPO, new RegExp(`^whatsapp_[\\d.]+_darwin_${arch}\\.zip$`));
    check(signal);
    mkdirSync(dir, { recursive: true });
    await installFrom(a.url, a.sha256, dir, `darwin-${arch}`, `GOWA ${a.tag}`, report, signal);
    renameSync(join(dir, `darwin-${arch}`), join(dir, 'gowa'));
    return a.tag.replace(/^v/, '');
  }

  /** WAHA: `docker pull` of a tag, with the layer lines as progress. */
  private async pullWaha(tag: string, report: Report, signal: AbortSignal): Promise<void> {
    const ds = await dockerStatus();
    if (!ds.daemon) throw new Error(ds.error ?? 'No container engine is running (Docker / OrbStack)');
    report({ step: 1, detail: `${WAHA_IMAGE}:${wahaTag(tag)}` });
    await new Promise<void>((resolve, reject) => {
      const proc = spawn(dockerBin(), ['pull', `${WAHA_IMAGE}:${wahaTag(tag)}`], { env: getShellEnv() as NodeJS.ProcessEnv, stdio: ['ignore', 'pipe', 'pipe'] });
      let last = '';
      const feed = (d: Buffer) => {
        const line = d.toString().trim().split('\n').pop() ?? '';
        if (line) {
          last = line;
          report({ step: 1, detail: line.slice(0, 120) });
        }
      };
      proc.stdout?.on('data', feed);
      proc.stderr?.on('data', feed);
      const onAbort = () => proc.kill('SIGTERM');
      signal.addEventListener('abort', onAbort, { once: true });
      proc.on('exit', (code) => {
        signal.removeEventListener('abort', onAbort);
        if (signal.aborted) reject(new Cancelled());
        else if (code === 0) resolve();
        else reject(new Error(`docker pull failed: ${last}`));
      });
      proc.on('error', reject);
    });
  }

  async install(engine: WaEngine, input: WaConfig): Promise<void> {
    if (this.config(engine)) throw new Error(`${ENGINES[engine].name} is already installed`);
    if (this.aborts.has(engine)) throw new Error(`${ENGINES[engine].name} is busy`);
    const c: WaConfig = { ...this.defaults(engine), ...input, engine, domain: input.domain.trim().toLowerCase(), apiUser: (input.apiUser || 'devcatz').trim(), apiKey: input.apiKey.trim() };
    this.validate(c, null);
    const steps = engine === 'gowa' ? [...INSTALL_STEPS.slice(0, 5), 'Preparing the data folder'] : ['Checking the container engine', 'Pulling the image', 'Preparing the data folder'];
    const t = this.task(engine, { kind: 'install', title: `Installing ${ENGINES[engine].name}`, steps, step: 0 });
    const abort = new AbortController();
    this.aborts.set(engine, abort);
    try {
      if (engine === 'gowa') c.version = await this.fetchGowa(this.binDir('gowa'), t.report, abort.signal);
      else {
        t.report({ step: 0 });
        c.version = c.version || (await wahaLatest().catch(() => 'latest'));
        await this.pullWaha(c.version, t.report, abort.signal);
      }
      check(abort.signal);
      t.report({ step: steps.length - 1, detail: c.dataDir, received: undefined, total: undefined });
      mkdirSync(c.dataDir, { recursive: true });
      this.save({ configs: { ...this.stored().configs, [engine]: c } });
      t.report({ title: `Installed ${ENGINES[engine].name} ${c.version}` });
      t.finish();
      this.h.changed();
    } catch (err) {
      if (abort.signal.aborted || err instanceof Cancelled) {
        await rm(this.binDir(engine), { recursive: true, force: true }).catch(() => undefined);
        t.fail(new Cancelled());
      }
      t.fail(err);
    } finally {
      this.aborts.delete(engine);
    }
  }

  cancelInstall(engine: WaEngine) {
    this.aborts.get(engine)?.abort();
  }

  /** Port / domain / key / autostart of an installed engine; restarts it when running. */
  async update(engine: WaEngine, input: WaConfig): Promise<void> {
    const current = this.config(engine);
    if (!current) throw new Error(`${ENGINES[engine].name} is not installed`);
    const c: WaConfig = { ...current, port: input.port, domain: input.domain.trim().toLowerCase(), apiUser: (input.apiUser || 'devcatz').trim(), apiKey: input.apiKey.trim(), autoStart: input.autoStart };
    this.validate(c, current);
    this.save({ configs: { ...this.stored().configs, [engine]: c } });
    if (this.isActive(engine)) {
      await this.stop(engine);
      await this.start(engine);
    }
    this.h.changed();
  }

  async uninstall(engine: WaEngine, deleteData: boolean, confirmHost: string): Promise<void> {
    const c = this.config(engine);
    if (!c) return;
    if (confirmHost.trim().toLowerCase() !== host(c.domain)) throw new Error(`Type ${host(c.domain)} to confirm`);
    const steps = ['Stopping', engine === 'waha' ? 'Removing the image' : 'Removing the binary', ...(deleteData ? ['Deleting the data folder'] : [])];
    const t = this.task(engine, { kind: 'uninstall', title: `Removing ${ENGINES[engine].name}`, steps, step: 0 });
    try {
      await this.stop(engine);
      t.report({ step: 1 });
      if (engine === 'waha') await run(dockerBin(), ['rmi', `${WAHA_IMAGE}:${wahaTag(c.version)}`], { timeout: 60_000 });
      else rmSync(join(this.dir, engine), { recursive: true, force: true });
      if (deleteData) {
        t.report({ step: 2, detail: c.dataDir });
        rmSync(c.dataDir, { recursive: true, force: true });
      }
      const { [engine]: _gone, ...rest } = this.stored().configs;
      this.save({ configs: rest });
      this.sessions.delete(engine);
      this.updates.delete(engine);
      t.finish();
      this.h.changed();
    } catch (err) {
      t.fail(err);
    }
  }

  // ---------------------------------------------------------------- updates

  async checkUpdates(): Promise<string[]> {
    const failed: string[] = [];
    await Promise.all(
      KINDS.map(async (engine) => {
        const c = this.config(engine);
        if (!c) return void this.updates.delete(engine);
        const v = await (engine === 'gowa' ? githubLatest(GOWA_REPO) : wahaLatest()).catch(() => null);
        if (!v) failed.push(ENGINES[engine].name);
        else if (isNewer(v, c.version)) this.updates.set(engine, v);
        else this.updates.delete(engine);
      }),
    );
    this.h.changed();
    return failed;
  }

  async upgrade(engine: WaEngine): Promise<void> {
    const c = this.config(engine);
    if (!c) throw new Error(`${ENGINES[engine].name} is not installed`);
    if (this.aborts.has(engine)) throw new Error(`${ENGINES[engine].name} is busy`);
    const head = engine === 'gowa' ? INSTALL_STEPS.slice(0, 5) : ['Checking the container engine', 'Pulling the image'];
    const t = this.task(engine, { kind: 'update', title: `Updating ${ENGINES[engine].name}`, steps: [...head, ...UPDATE_TAIL], step: 0 });
    const abort = new AbortController();
    this.aborts.set(engine, abort);
    const wasActive = this.isActive(engine);
    try {
      let v: string;
      if (engine === 'gowa') {
        let tag = '';
        v = await upgradeBinaries({
          binDir: this.binDir('gowa'),
          install: async (d, r, s) => void (tag = await this.fetchGowa(d, r, s)),
          stop: () => this.stop(engine),
          start: () => this.start(engine),
          wasActive,
          version: async () => ((await run(join(this.binDir('gowa'), 'gowa'), ['--help'], { timeout: 15_000 })).code === 0 ? tag : null),
          report: t.report,
          signal: abort.signal,
          tailAt: head.length,
        });
      } else {
        t.report({ step: 0 });
        v = this.updates.get('waha') ?? (await wahaLatest());
        await this.pullWaha(v, t.report, abort.signal);
        t.report({ step: head.length, received: undefined, total: undefined, detail: undefined });
        if (wasActive) await this.stop(engine);
        t.report({ step: head.length + 1 });
        const old = c.version;
        this.save({ configs: { ...this.stored().configs, waha: { ...c, version: v } } });
        if (old !== v) await run(dockerBin(), ['rmi', `${WAHA_IMAGE}:${wahaTag(old)}`], { timeout: 60_000 });
        if (wasActive) {
          t.report({ step: head.length + 3 });
          await this.start(engine);
        }
      }
      if (engine === 'gowa') this.save({ configs: { ...this.stored().configs, gowa: { ...this.config('gowa')!, version: v } } });
      this.updates.delete(engine);
      this.processes.log(waId(engine), 'sys', `Updated ${c.version} → ${v}`);
      t.report({ title: `Updated ${ENGINES[engine].name} to ${v}` });
      t.finish();
    } catch (err) {
      t.fail(abort.signal.aborted ? new Error('Update cancelled; the current version was kept') : err);
    } finally {
      this.aborts.delete(engine);
      this.h.changed();
    }
  }

  // ---------------------------------------------------------------- run

  async start(engine: WaEngine): Promise<void> {
    const c = this.config(engine);
    if (!c) throw new Error(`${ENGINES[engine].name} is not installed`);
    if (this.isActive(engine)) return;
    this.errors.delete(engine);
    mkdirSync(c.dataDir, { recursive: true });
    const hook = `/${engine}`;
    if (engine === 'gowa') {
      const bin = join(this.binDir('gowa'), 'gowa');
      if (!existsSync(bin)) throw new Error('The GOWA binary is missing: remove and install again');
      const args = [
        'rest',
        `--port=${c.port}`,
        '--host=127.0.0.1',
        `--basic-auth=${userOf(c)}:${c.apiKey}`,
        `--db-uri=file:${join(c.dataDir, 'whatsapp.db')}?_foreign_keys=on`,
        `--webhook=http://127.0.0.1:${this.receiverPort}${hook}`,
        `--webhook-secret=${c.apiKey}`,
        '--os=DevCatz',
      ];
      this.processes.startMany(waId(engine), [{ label: '', cwd: c.dataDir, command: `${q(bin)} ${args.map(q).join(' ')}`, env: {} }]);
    } else {
      const ds = await dockerStatus();
      if (!ds.daemon) {
        this.errors.set(engine, ds.error ?? 'No container engine is running');
        this.h.changed();
        throw new Error(this.errors.get(engine));
      }
      await run(dockerBin(), ['rm', '-f', 'devcatz-waha'], { timeout: 20_000 });
      const sessions = join(c.dataDir, 'sessions');
      const media = join(c.dataDir, 'media');
      mkdirSync(sessions, { recursive: true });
      mkdirSync(media, { recursive: true });
      const env: Record<string, string> = {
        WHATSAPP_API_KEY: c.apiKey,
        WHATSAPP_HOOK_URL: `http://host.docker.internal:${this.receiverPort}${hook}`,
        WHATSAPP_HOOK_EVENTS: 'message.any,message.ack,message.reaction,session.status,group.join,group.leave',
        WHATSAPP_RESTART_ALL_SESSIONS: 'True',
        WHATSAPP_SESSIONS_PATH: '/app/.sessions',
        WHATSAPP_FILES_FOLDER: '/app/.media',
        WHATSAPP_API_HOSTNAME: `127.0.0.1:${c.port}`,
        WAHA_DASHBOARD_USERNAME: userOf(c),
        WAHA_DASHBOARD_PASSWORD: c.apiKey,
        WHATSAPP_SWAGGER_USERNAME: userOf(c),
        WHATSAPP_SWAGGER_PASSWORD: c.apiKey,
        WAHA_PRINT_QR: 'False',
      };
      const args = ['run', '--rm', '--name', 'devcatz-waha', '-p', `127.0.0.1:${c.port}:3000`, '--add-host=host.docker.internal:host-gateway', '-v', `${sessions}:/app/.sessions`, '-v', `${media}:/app/.media`, ...Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]), `${WAHA_IMAGE}:${wahaTag(c.version)}`];
      this.processes.startMany(waId(engine), [{ label: '', cwd: c.dataDir, command: `${q(dockerBin())} ${args.map(q).join(' ')}`, env: {} }]);
    }
    this.h.changed();
    // Mark running once the API answers (up to 60 s: WAHA's image boots slowly the first time).
    for (let i = 0; i < 120 && this.processes.getStatus(waId(engine)).status === 'starting'; i++) {
      await new Promise((r) => setTimeout(r, 500));
      if (await this.api(engine, 'GET', engine === 'gowa' ? '/devices' : '/api/sessions?all=true').then((r) => r.status < 500 && r.status !== 0, () => false)) {
        this.processes.markRunning(waId(engine));
        void this.pollSessions();
        break;
      }
    }
  }

  async stop(engine: WaEngine): Promise<void> {
    await this.processes.stop(waId(engine));
    if (engine === 'waha') await run(dockerBin(), ['rm', '-f', 'devcatz-waha'], { timeout: 20_000 }).catch(() => undefined);
    this.sessions.delete(engine);
    this.h.changed();
  }

  async action(engine: WaEngine, action: StorageAction): Promise<void> {
    if (action === 'stop') return this.stop(engine);
    if (action === 'restart') await this.stop(engine);
    await this.start(engine);
  }

  autoStart(): void {
    for (const k of KINDS) if (this.config(k)?.autoStart) void this.start(k).catch((e) => this.processes.log(waId(k), 'sys', `Autostart failed: ${(e as Error).message}`));
  }

  async stopAll(): Promise<void> {
    await Promise.all(KINDS.map((k) => this.stop(k)));
    this.receiver.close();
  }

  openData(engine: WaEngine): string {
    return this.config(engine)?.dataDir ?? this.dir;
  }

  // ---------------------------------------------------------------- engine API

  private async api(engine: WaEngine, method: string, path: string, body?: unknown, session?: string, form?: FormData): Promise<{ status: number; text: string; json: unknown }> {
    const c = this.config(engine);
    if (!c) throw new Error(`${ENGINES[engine].name} is not installed`);
    const headers: Record<string, string> = engine === 'gowa' ? { Authorization: `Basic ${Buffer.from(`${userOf(c)}:${c.apiKey}`).toString('base64')}` } : { 'X-Api-Key': c.apiKey };
    if (session && engine === 'gowa') headers['X-Device-Id'] = session;
    let payload: BodyInit | undefined;
    if (form) payload = form;
    else if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const res = await fetch(`http://127.0.0.1:${c.port}${path}`, { method, headers, body: payload, signal: AbortSignal.timeout(30_000) });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    return { status: res.status, text, json };
  }

  private need(r: { status: number; text: string; json: unknown }, what: string) {
    if (r.status >= 200 && r.status < 300) return;
    const j = r.json as { message?: string; error?: string; code?: string } | null;
    throw new Error(`${what}: ${j?.message ?? j?.error ?? r.text.slice(0, 200) ?? `HTTP ${r.status}`}`);
  }

  // ---------------------------------------------------------------- sessions

  private async readSessions(engine: WaEngine): Promise<WaSession[]> {
    if (engine === 'gowa') {
      const r = await this.api(engine, 'GET', '/devices');
      const list = ((r.json as { results?: { device_id?: string; id?: string; jid?: string; state?: string; status?: string }[] })?.results ?? []).map((d) => ({ name: d.device_id ?? d.id ?? '', jid: d.jid ?? null, state: d.state ?? d.status ?? '' }));
      const out: WaSession[] = [];
      for (const d of list) {
        if (!d.name) continue;
        const s = await this.api(engine, 'GET', '/app/status', undefined, d.name).catch(() => null);
        const st = (s?.json as { results?: { is_connected?: boolean; is_logged_in?: boolean; jid?: string } } | null)?.results;
        const loggedIn = Boolean(st?.is_logged_in);
        out.push({
          name: d.name,
          status: loggedIn && st?.is_connected ? 'connected' : loggedIn ? 'starting' : /scan|qr/i.test(d.state) ? 'scanning' : 'disconnected',
          jid: (st?.jid ?? d.jid)?.replace(/:\d+/, '') || null,
          pushName: null,
        });
      }
      return out;
    }
    const r = await this.api(engine, 'GET', '/api/sessions?all=true');
    const list = (r.json as { name: string; status: string; me?: { id?: string; pushName?: string } | null }[] | null) ?? [];
    return list.map((s) => ({
      name: s.name,
      status: s.status === 'WORKING' ? 'connected' : s.status === 'SCAN_QR_CODE' ? 'scanning' : s.status === 'STARTING' ? 'starting' : s.status === 'FAILED' ? 'failed' : 'disconnected',
      jid: s.me?.id ?? null,
      pushName: s.me?.pushName ?? null,
    }));
  }

  private async pollSessions(): Promise<void> {
    for (const engine of KINDS) {
      if (!this.isActive(engine)) continue;
      const list = await this.readSessions(engine).catch(() => null);
      if (!list) continue;
      const key = JSON.stringify(list);
      if (key === this.sessionKey.get(engine)) continue;
      this.sessionKey.set(engine, key);
      this.sessions.set(engine, list);
      this.h.changed();
    }
  }

  async sessionStart(engine: WaEngine, name: string): Promise<void> {
    name = name.trim() || ENGINES[engine].defaultSession;
    if (!/^[a-z0-9_-]+$/i.test(name)) throw new Error('Session name: letters, digits, - and _');
    if (!this.isActive(engine)) throw new Error(`${ENGINES[engine].name} is not running`);
    const known = (this.sessions.get(engine) ?? []).some((s) => s.name === name);
    if (engine === 'gowa') {
      if (!known) this.need(await this.api(engine, 'POST', '/devices', { device_id: name }), 'Create device');
    } else if (!known) this.need(await this.api(engine, 'POST', '/api/sessions', { name, start: true }), 'Create session');
    else this.need(await this.api(engine, 'POST', `/api/sessions/${name}/start`), 'Start session');
    this.sessionKey.delete(engine);
    await this.pollSessions();
  }

  /** PNG data URL of the QR to scan, or '' when the session is not waiting for one. */
  async sessionQr(engine: WaEngine, name: string): Promise<string> {
    const c = this.config(engine);
    if (!c || !this.isActive(engine)) return '';
    if (engine === 'gowa') {
      const r = await this.api(engine, 'GET', `/devices/${name}/login`, undefined, name);
      const link = (r.json as { results?: { qr_link?: string } })?.results?.qr_link;
      if (!link) return '';
      const png = await fetch(link.replace(/^https?:\/\/[^/]+/, `http://127.0.0.1:${c.port}`), { headers: { Authorization: `Basic ${Buffer.from(`${userOf(c)}:${c.apiKey}`).toString('base64')}` } });
      if (!png.ok) return '';
      return `data:image/png;base64,${Buffer.from(await png.arrayBuffer()).toString('base64')}`;
    }
    const res = await fetch(`http://127.0.0.1:${c.port}/api/${name}/auth/qr?format=image`, { headers: { 'X-Api-Key': c.apiKey, Accept: 'image/png' } });
    if (!res.ok) return '';
    return `data:image/png;base64,${Buffer.from(await res.arrayBuffer()).toString('base64')}`;
  }

  async sessionLogout(engine: WaEngine, name: string): Promise<void> {
    if (engine === 'gowa') this.need(await this.api(engine, 'GET', '/app/logout', undefined, name), 'Logout');
    else this.need(await this.api(engine, 'POST', `/api/sessions/${name}/logout`), 'Logout');
    this.sessionKey.delete(engine);
    await this.pollSessions();
  }

  async sessionRemove(engine: WaEngine, name: string): Promise<void> {
    if (engine === 'gowa') {
      await this.api(engine, 'GET', '/app/logout', undefined, name).catch(() => undefined);
      this.need(await this.api(engine, 'DELETE', `/devices/${name}`, undefined, name), 'Remove device');
    } else this.need(await this.api(engine, 'DELETE', `/api/sessions/${name}`), 'Remove session');
    this.sessionKey.delete(engine);
    await this.pollSessions();
  }

  // ---------------------------------------------------------------- sending, contacts

  private chatId(engine: WaEngine, to: string): string {
    const t = to.trim();
    if (t.includes('@')) return t;
    const digits = t.replace(/\D/g, '');
    if (digits.length < 8) throw new Error('Number: country code and number, e.g. 6281234567890');
    return engine === 'gowa' ? `${digits}@s.whatsapp.net` : `${digits}@c.us`;
  }

  async send(engine: WaEngine, input: WaSendInput): Promise<WaSendResult> {
    const c = this.config(engine);
    if (!c) throw new Error(`${ENGINES[engine].name} is not installed`);
    if (!this.isActive(engine)) throw new Error(`${ENGINES[engine].name} is not running`);
    const session = input.session || ENGINES[engine].defaultSession;
    const to = this.chatId(engine, input.to);
    let method = 'POST';
    let path: string;
    let shown: string;
    let r: { status: number; text: string; json: unknown };
    if (input.kind !== 'text') {
      if (!input.file || !existsSync(input.file)) throw new Error('Choose a file to send');
      const buf = readFileSync(input.file);
      const mime = MIME[extname(input.file).toLowerCase()] ?? 'application/octet-stream';
      if (engine === 'gowa') {
        path = input.kind === 'image' ? '/send/image' : '/send/file';
        const form = new FormData();
        form.set('phone', to);
        form.set('caption', input.text);
        form.set(input.kind === 'image' ? 'image' : 'file', new Blob([buf], { type: mime }), basename(input.file));
        shown = `multipart/form-data: phone=${to} caption=${JSON.stringify(input.text)} ${input.kind}=@${basename(input.file)} (${mime}, ${buf.length} bytes)`;
        r = await this.api(engine, method, path, undefined, session, form);
      } else {
        path = input.kind === 'image' ? '/api/sendImage' : '/api/sendFile';
        const body = { session, chatId: to, caption: input.text, file: { mimetype: mime, filename: basename(input.file), data: buf.toString('base64') } };
        shown = JSON.stringify({ ...body, file: { ...body.file, data: `<base64, ${buf.length} bytes>` } }, null, 2);
        r = await this.api(engine, method, path, body);
      }
    } else {
      if (!input.text.trim()) throw new Error('Type a message');
      if (engine === 'gowa') {
        path = '/send/message';
        const body = { phone: to, message: input.text };
        shown = JSON.stringify(body, null, 2);
        r = await this.api(engine, method, path, body, session);
      } else {
        path = '/api/sendText';
        const body = { session, chatId: to, text: input.text };
        shown = JSON.stringify(body, null, 2);
        r = await this.api(engine, method, path, body);
      }
    }
    if (r.status >= 200 && r.status < 300) {
      this.record({
        engine,
        session,
        direction: 'out',
        event: 'send',
        from: null,
        fromName: 'DevCatz test sender',
        to,
        body: input.kind === 'text' ? input.text : `${input.kind}: ${basename(input.file ?? '')}${input.text ? ` — ${input.text}` : ''}`,
        kind: input.kind,
        raw: r.text.slice(0, BODY_LIMIT),
      });
    }
    return { request: { method, url: `http://127.0.0.1:${c.port}${path}`, body: shown }, status: r.status, response: r.text.slice(0, BODY_LIMIT) };
  }

  async contacts(engine: WaEngine, session: string): Promise<WaContact[]> {
    session ||= ENGINES[engine].defaultSession;
    if (engine === 'gowa') {
      const r = await this.api(engine, 'GET', '/user/my/contacts', undefined, session);
      this.need(r, 'Contacts');
      const data = ((r.json as { results?: { data?: { jid: string; name?: string }[] } })?.results?.data ?? []) as { jid: string; name?: string }[];
      return data.map((x) => ({ id: x.jid, name: x.name || x.jid.split('@')[0] }));
    }
    const r = await this.api(engine, 'GET', `/api/contacts/all?session=${session}`);
    this.need(r, 'Contacts');
    return ((r.json as { id: string; name?: string; pushname?: string }[]) ?? []).map((x) => ({ id: x.id, name: x.name || x.pushname || x.id.split('@')[0] }));
  }

  async groups(engine: WaEngine, session: string): Promise<WaContact[]> {
    session ||= ENGINES[engine].defaultSession;
    if (engine === 'gowa') {
      const r = await this.api(engine, 'GET', '/user/my/groups', undefined, session);
      this.need(r, 'Groups');
      const data = ((r.json as { results?: { data?: { JID: string; Name?: string; Participants?: unknown[] }[] } })?.results?.data ?? []) as { JID: string; Name?: string; Participants?: unknown[] }[];
      return data.map((g) => ({ id: g.JID, name: g.Name || g.JID, members: g.Participants?.length }));
    }
    const r = await this.api(engine, 'GET', `/api/${session}/groups`);
    this.need(r, 'Groups');
    const list = (r.json as { id: string | { _serialized?: string }; name?: string; subject?: string; participants?: unknown[]; groupMetadata?: { subject?: string; participants?: unknown[] } }[]) ?? [];
    return list.map((g) => {
      const gid = typeof g.id === 'string' ? g.id : (g.id?._serialized ?? '');
      return { id: gid, name: g.name ?? g.subject ?? g.groupMetadata?.subject ?? gid, members: (g.participants ?? g.groupMetadata?.participants)?.length };
    });
  }

  // ---------------------------------------------------------------- inspector

  private record(m: Omit<WaMessage, 'id' | 'at'>): WaMessage {
    const entry: WaMessage = { id: id(), at: new Date().toISOString(), ...m };
    this.messages.unshift(entry);
    const keep = Math.max(50, store.settings.waKeep || 500);
    if (this.messages.length > keep) this.messages.length = keep;
    this.persist();
    this.h.changed();
    return entry;
  }

  list(limit: number): WaMessage[] {
    return this.messages.slice(0, limit);
  }

  clear(): void {
    this.messages = [];
    this.persist();
    this.h.changed();
  }

  /** Counts for the sidebar / tray: messages seen today. */
  countToday(): number {
    const day = new Date().toISOString().slice(0, 10);
    return this.messages.filter((m) => m.at.startsWith(day)).length;
  }

  /** The engines' webhook: verified, kept for the inspector, forwarded to the sites. */
  private async receive(req: IncomingMessage, res: import('node:http').ServerResponse): Promise<void> {
    const engine = req.url?.startsWith('/gowa') ? 'gowa' : req.url?.startsWith('/waha') ? 'waha' : null;
    const c = engine && this.config(engine);
    if (!engine || !c || req.method !== 'POST') {
      res.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const d of req) chunks.push(d as Buffer);
    const raw = Buffer.concat(chunks);
    res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true}');
    // GOWA signs with the webhook secret; WAHA has no signature on a plain hook URL (it is local only).
    const sig = req.headers['x-hub-signature-256'];
    if (engine === 'gowa' && typeof sig === 'string') {
      const mine = `sha256=${createHmac('sha256', c.apiKey).update(raw).digest('hex')}`;
      if (mine.length !== sig.length || !timingSafeEqual(Buffer.from(mine), Buffer.from(sig))) return;
    }
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
    } catch {
      return;
    }
    const m = this.normalize(engine, body, raw.toString('utf8').slice(0, BODY_LIMIT));
    if (m) {
      const entry = this.record(m);
      if (entry.direction === 'in' && entry.event.startsWith('message') && store.settings.waNotify) this.h.notify(`${ENGINES[engine].name}: ${entry.fromName ?? entry.from ?? 'message'}`, entry.body.slice(0, 120) || entry.kind);
    }
    if (/session|status/.test(String(body.event ?? ''))) this.sessionKey.delete(engine);
    void this.forward(engine, String(body.event ?? 'event'), raw);
  }

  private normalize(engine: WaEngine, b: Record<string, unknown>, raw: string): Omit<WaMessage, 'id' | 'at'> | null {
    const event = String(b.event ?? 'event');
    const p = (b.payload ?? {}) as Record<string, unknown>;
    const session = String(b.device_id ?? b.session ?? b.session_id ?? ENGINES[engine].defaultSession);
    const media = ['image', 'video', 'audio', 'document', 'sticker', 'location', 'contact', 'reaction', 'poll'].find((k) => p[k] !== undefined && p[k] !== null);
    if (engine === 'gowa') {
      if (!event.startsWith('message') && !event.startsWith('group')) return null;
      const fromMe = Boolean(p.is_from_me);
      const from = String(p.from ?? p.chat_id ?? '') || null;
      const text = String(p.body ?? p.message ?? p.caption ?? p.text ?? '');
      return { engine, session, direction: fromMe ? 'out' : 'in', event, from, fromName: (p.from_name ?? p.sender_display_name ?? p.pushname ?? null) as string | null, to: fromMe ? ((p.chat_id as string) ?? null) : null, body: text || (media ? `(${media})` : `(${event})`), kind: media ?? (event === 'message' ? 'text' : event), raw };
    }
    if (event === 'session.status') return { engine, session, direction: 'in', event, from: null, fromName: null, to: null, body: `session ${session}: ${String(p.status ?? '')}`, kind: 'status', raw };
    if (!event.startsWith('message') && !event.startsWith('group')) return null;
    const fromMe = Boolean(p.fromMe);
    const data = (p._data ?? {}) as Record<string, unknown>;
    const mime = ((p.media as { mimetype?: string } | null)?.mimetype ?? '').split('/')[0];
    const kind = p.hasMedia ? mime || 'media' : event.includes('reaction') ? 'reaction' : event.includes('ack') ? 'ack' : 'text';
    const text = String(p.body ?? p.caption ?? (p.reaction as { text?: string } | undefined)?.text ?? '');
    return { engine, session, direction: fromMe ? 'out' : 'in', event, from: (p.from as string) ?? null, fromName: (data.notifyName ?? data.pushName ?? p.pushName ?? null) as string | null, to: (p.to as string) ?? null, body: text || `(${kind})`, kind, raw };
  }

  // ---------------------------------------------------------------- site webhooks

  hooks(): WaHook[] {
    const known = new Set(this.h.projects().map((p) => p.id));
    return this.stored().hooks.filter((h) => known.has(h.siteId));
  }

  hooksOf(siteId: string): WaHook[] {
    return this.hooks().filter((h) => h.siteId === siteId);
  }

  setHook(input: { id?: string; siteId: string; url: string; events: string[]; enabled: boolean }): WaHook {
    const p = this.h.projects().find((x) => x.id === input.siteId);
    if (!p) throw new Error('Unknown site');
    const url = input.url.trim();
    if (!/^https?:\/\/\S+$/.test(url)) throw new Error('URL: https://site.localhost/webhooks/whatsapp');
    const hooks = this.stored().hooks;
    const existing = input.id ? hooks.find((h) => h.id === input.id) : undefined;
    const hook: WaHook = existing
      ? { ...existing, siteName: p.name, url, events: input.events.map((e) => e.trim()).filter(Boolean), enabled: input.enabled }
      : { id: id(), siteId: p.id, siteName: p.name, url, events: input.events.map((e) => e.trim()).filter(Boolean), enabled: input.enabled, secret: secret(), deliveries: 0, lastStatus: null, lastAt: null };
    this.save({ hooks: existing ? hooks.map((h) => (h.id === hook.id ? hook : h)) : [...hooks, hook] });
    this.h.changed();
    return hook;
  }

  removeHook(hookId: string): void {
    this.save({ hooks: this.stored().hooks.filter((h) => h.id !== hookId) });
    this.deliveries = this.deliveries.filter((d) => d.hookId !== hookId);
    this.persist();
    this.h.changed();
  }

  deliveriesOf(hookId: string, limit: number): WaDelivery[] {
    return this.deliveries.filter((d) => d.hookId === hookId).slice(0, limit);
  }

  private async forward(engine: WaEngine, event: string, raw: Buffer): Promise<void> {
    for (const hook of this.hooks()) {
      if (!hook.enabled) continue;
      if (hook.events.length && !hook.events.some((e) => event === e || event.startsWith(`${e}.`))) continue;
      await this.deliver(hook, engine, event, raw, false);
    }
  }

  private deliver(hook: WaHook, engine: WaEngine, event: string, raw: Buffer, replay: boolean): Promise<WaDelivery> {
    return new Promise((resolve) => {
      const t0 = Date.now();
      const deliveryId = id();
      const done = (status: number | null, error: string | null, response: string | null) => {
        const d: WaDelivery = { id: deliveryId, hookId: hook.id, at: new Date().toISOString(), engine, event, status, ms: Date.now() - t0, error, body: raw.toString('utf8').slice(0, BODY_LIMIT), response, replay };
        this.deliveries.unshift(d);
        if (this.deliveries.length > DELIVERIES_KEPT) this.deliveries.length = DELIVERIES_KEPT;
        const hooks = this.stored().hooks.map((h) => (h.id === hook.id ? { ...h, deliveries: h.deliveries + 1, lastStatus: status, lastAt: d.at } : h));
        this.save({ hooks });
        this.persist();
        this.h.changed();
        resolve(d);
      };
      let u: URL;
      try {
        u = new URL(hook.url);
      } catch {
        return done(null, 'Invalid URL', null);
      }
      const headers = {
        'Content-Type': 'application/json',
        'Content-Length': String(raw.length),
        'User-Agent': 'DevCatz-WhatsApp/1',
        'X-DevCatz-Engine': engine,
        'X-DevCatz-Event': event,
        'X-DevCatz-Delivery': deliveryId,
        'X-DevCatz-Signature': `sha256=${createHmac('sha256', hook.secret).update(raw).digest('hex')}`,
      };
      const req = (u.protocol === 'https:' ? httpsRequest : httpRequest)({ host: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80), path: `${u.pathname}${u.search}`, method: 'POST', headers, rejectUnauthorized: false, servername: u.hostname, timeout: 15_000 }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (d: Buffer) => chunks.length < 64 && chunks.push(d));
        res.on('end', () => done(res.statusCode ?? null, null, Buffer.concat(chunks).toString('utf8').slice(0, 4096)));
      });
      req.on('timeout', () => req.destroy(new Error('No answer in 15 s')));
      req.on('error', (e) => done(null, e.message, null));
      req.end(raw);
    });
  }

  async replay(deliveryId: string): Promise<WaDelivery> {
    const d = this.deliveries.find((x) => x.id === deliveryId);
    if (!d) throw new Error('Delivery not found');
    const hook = this.stored().hooks.find((h) => h.id === d.hookId);
    if (!hook) throw new Error('The webhook was removed');
    return this.deliver(hook, d.engine, d.event, Buffer.from(d.body, 'utf8'), true);
  }

  // ---------------------------------------------------------------- sites

  /** .env lines for a site: the engine's API on 127.0.0.1, its key, the default session and the site's webhook secret. */
  env(engine: WaEngine, siteId: string): Record<string, string> {
    const c = this.config(engine);
    if (!c) throw new Error(`${ENGINES[engine].name} is not installed`);
    const p = this.h.projects().find((x) => x.id === siteId);
    if (!p) throw new Error('Unknown site');
    const hook = this.hooksOf(siteId)[0];
    const out: Record<string, string> = { WHATSAPP_ENGINE: engine, WHATSAPP_API_URL: `http://127.0.0.1:${c.port}`, WHATSAPP_API_KEY: c.apiKey };
    if (engine === 'gowa') {
      out.WHATSAPP_API_USER = userOf(c);
      out.WHATSAPP_API_PASS = c.apiKey;
    }
    out.WHATSAPP_SESSION = ENGINES[engine].defaultSession;
    out.WHATSAPP_WEBHOOK_SECRET = hook?.secret ?? '';
    return out;
  }

  /** WhatsApp keys / client libraries in a site, and the DevCatz engine its API URL points at. */
  siteInfo(p: ProjectConfig): { keys: string[]; libraries: string[]; engine: WaEngine | null } | null {
    const env = readEnvFiles(join(p.path, '.env'));
    const keys = Object.keys(env).filter((k) => /^(WHATSAPP_|WAHA_|GOWA_|WA_API|WA_GATEWAY)/.test(k));
    const libraries: string[] = [];
    for (const [file, names] of [
      ['package.json', ['whatsapp-web.js', '@whiskeysockets/baileys', 'baileys', 'venom-bot', '@open-wa/wa-automate', 'wppconnect', '@wppconnect-team/wppconnect', 'waha', '@devlikeapro/waha']],
      ['composer.json', ['netflie/whatsapp-cloud-api', 'aldinokemal/go-whatsapp-web-multidevice', 'marcelodeveloper/whatsapp', 'missaelanda/whatsapp']],
      ['go.mod', ['go.mau.fi/whatsmeow']],
      ['requirements.txt', ['pywa', 'whatsapp-api-client-python', 'yowsup']],
      ['pyproject.toml', ['pywa']],
    ] as const) {
      const text = (() => {
        try {
          return readFileSync(join(p.path, file), 'utf8');
        } catch {
          return '';
        }
      })();
      for (const n of names) if (text.includes(`"${n}"`) || text.includes(`${n} `) || text.includes(`${n}==`) || text.includes(`\n${n}`)) libraries.push(n);
    }
    if (!keys.length && !libraries.length) return null;
    const url = (env.WHATSAPP_API_URL ?? env.WAHA_URL ?? env.WAHA_API_URL ?? env.GOWA_URL ?? env.GOWA_API_URL ?? env.WA_API_URL ?? '').toLowerCase();
    const declared = (env.WHATSAPP_ENGINE ?? '').toLowerCase();
    let engine: WaEngine | null = null;
    for (const k of KINDS) {
      const c = this.config(k);
      if (!c) continue;
      if (declared === k || url.includes(`127.0.0.1:${c.port}`) || url.includes(`localhost:${c.port}`) || url.includes(host(c.domain))) engine = k;
    }
    return { keys, libraries: [...new Set(libraries)], engine };
  }

  /** Sites whose .env points at an engine (the sidebar's "Sites using WhatsApp"). */
  sitesUsing(): { id: string; name: string; engine: WaEngine | null }[] {
    return this.h
      .projects()
      .map((p) => ({ p, info: this.siteInfo(p) }))
      .filter((x) => x.info)
      .map(({ p, info }) => ({ id: p.id, name: p.name, engine: info!.engine }));
  }
}
