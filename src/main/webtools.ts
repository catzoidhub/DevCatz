import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { delimiter, join } from 'node:path';
import type { DbEngine, DbOpenTool, DbServiceState, TaskProgress, WebToolConfig, WebToolId, WebToolRun, WebToolState } from '@shared/types';
import type { Route } from './proxy';
import type { MonitorTarget } from './monitor';
import { downloadVerified } from './download';
import { getShellEnv, run } from './env';
import { githubJson } from './github';
import { unzipLinux } from './linuxapps';
import { isLinux, isWin, killTree, TAR } from './platform';
import { dataDir, store, tld } from './store';

/**
 * Web database tools (TODO §48): phpMyAdmin (MySQL, MariaDB), Adminer (MySQL, MariaDB, PostgreSQL, SQLite) and pgweb
 * (PostgreSQL), next to DBCatz, which stays first. Each answers at its own name under the default domain
 * (`adminer.<tld>`), HTTPS through DevCatz's proxy, and listens on 127.0.0.1 only.
 * - Redis Commander (Redis, Valkey) runs on an installed Node.js, every Redis / Valkey service as a connection, read
 *   from a config file next to it (never on the command line).
 * - phpMyAdmin and Adminer are PHP apps served by `php -S` with DevCatz's default PHP; they sign in to the service
 *   they are opened from by themselves. The users and passwords are written to servers.json next to the served
 *   folder (never served), readable by you only; links name a service, never a password.
 * - pgweb runs once per PostgreSQL service (`<service>.pgweb.<tld>`, and `pgweb.<tld>` when there is only one), its
 *   connection string in the environment, never on the command line (visible in ps). Started when opened, stopped
 *   with its service.
 */

/** An installed runtime a tool runs on: PHP (php binary + its ini environment) or Node.js (node, npm in binDir). */
export interface RuntimeInfo {
  version: string;
  bin: string;
  binDir: string;
  env: Record<string, string>;
}
export type ToolRuntime = 'php' | 'node';
const RUNTIME_NAME: Record<ToolRuntime, string> = { php: 'PHP', node: 'Node.js' };

interface ToolDef {
  name: string;
  description: string;
  engines: DbEngine[];
  runtime: ToolRuntime | null;
  port: number;
  sourceUrl: string;
  latest(): Promise<string>;
  /** Downloads the release into `into` (verified against the publisher's SHA-256). */
  fetch(version: string, into: string, tmp: string, progress: (received: number, total: number) => void, rt: RuntimeInfo | null): Promise<void>;
}

interface GhRelease {
  tag_name: string;
  assets: { name: string; browser_download_url: string; digest?: string | null }[];
}

async function ghAsset(repo: string, tag: string | null, name: string): Promise<{ url: string; sha: string }> {
  const r = await githubJson<GhRelease>(`/repos/${repo}/releases/${tag ? `tags/${tag}` : 'latest'}`);
  const a = r.assets.find((x) => x.name === name);
  if (!a) throw new Error(`${name} is not in ${repo}'s release ${r.tag_name}`);
  const sha = a.digest?.startsWith('sha256:') ? a.digest.slice(7) : '';
  if (!sha) throw new Error(`${repo} gives no SHA-256 for ${name}`);
  return { url: a.browser_download_url, sha };
}

async function unpack(archive: string, into: string): Promise<void> {
  mkdirSync(into, { recursive: true });
  const r = isWin
    ? await run(TAR, ['-xf', archive, '-C', into], { timeout: 300_000 })
    : isLinux
      ? await unzipLinux(archive, into)
      : await run('ditto', ['-x', '-k', archive, into], { timeout: 300_000 });
  if (r.code !== 0) throw new Error(`Unpacking failed: ${r.stderr.trim()}`);
}

const pgwebAsset = (): string => {
  const os = isWin ? 'windows' : isLinux ? 'linux' : 'darwin';
  // No Windows ARM build: the x64 one runs emulated there.
  const arch = process.arch === 'arm64' && !isWin ? 'arm64' : 'amd64';
  return `pgweb_${os}_${arch}.zip`;
};

const TOOLS: Record<WebToolId, ToolDef> = {
  phpmyadmin: {
    name: 'phpMyAdmin',
    description: 'The classic web interface for MySQL and MariaDB.',
    engines: ['mysql', 'mariadb'],
    runtime: 'php',
    port: 8090,
    sourceUrl: 'https://www.phpmyadmin.net',
    async latest() {
      const res = await fetch('https://www.phpmyadmin.net/home_page/version.json', { cache: 'no-store' });
      if (!res.ok) throw new Error(`phpmyadmin.net: HTTP ${res.status}`);
      const v = ((await res.json()) as { version?: string }).version;
      if (!v) throw new Error('phpmyadmin.net gave no version');
      return v;
    },
    async fetch(v, into, tmp, progress) {
      const file = `phpMyAdmin-${v}-all-languages.zip`;
      const base = `https://files.phpmyadmin.net/phpMyAdmin/${v}/${file}`;
      const sums = await fetch(`${base}.sha256`, { cache: 'no-store' });
      if (!sums.ok) throw new Error(`phpMyAdmin's checksum: HTTP ${sums.status}`);
      const sha = (await sums.text()).trim().split(/\s+/)[0]?.toLowerCase();
      if (!sha || !/^[0-9a-f]{64}$/.test(sha)) throw new Error("phpMyAdmin's checksum file is not readable");
      const zip = join(tmp, file);
      await downloadVerified(base, zip, sha, progress);
      await unpack(zip, join(tmp, 'x'));
      renameSync(join(tmp, 'x', `phpMyAdmin-${v}-all-languages`), into);
    },
  },
  adminer: {
    name: 'Adminer',
    description: 'One PHP file for MySQL, MariaDB, PostgreSQL and SQLite.',
    engines: ['mysql', 'mariadb', 'postgresql', 'sqlite'],
    runtime: 'php',
    port: 8091,
    sourceUrl: 'https://www.adminer.org',
    async latest() {
      return (await githubJson<GhRelease>('/repos/vrana/adminer/releases/latest')).tag_name.replace(/^v/, '');
    },
    async fetch(v, into, _tmp, progress) {
      const a = await ghAsset('vrana/adminer', `v${v}`, `adminer-${v}.php`);
      mkdirSync(into, { recursive: true });
      await downloadVerified(a.url, join(into, 'adminer.php'), a.sha, progress);
    },
  },
  pgweb: {
    name: 'pgweb',
    description: 'A small, fast web viewer for PostgreSQL, one per service.',
    engines: ['postgresql'],
    runtime: null,
    port: 8092,
    sourceUrl: 'https://github.com/sosedoff/pgweb',
    async latest() {
      return (await githubJson<GhRelease>('/repos/sosedoff/pgweb/releases/latest')).tag_name.replace(/^v/, '');
    },
    async fetch(v, into, tmp, progress) {
      const name = pgwebAsset();
      const a = await ghAsset('sosedoff/pgweb', `v${v}`, name);
      const zip = join(tmp, name);
      await downloadVerified(a.url, zip, a.sha, progress);
      await unpack(zip, join(tmp, 'x'));
      const bin = readdirSync(join(tmp, 'x')).find((f) => f.startsWith('pgweb'));
      if (!bin) throw new Error('No pgweb program in the download');
      mkdirSync(into, { recursive: true });
      renameSync(join(tmp, 'x', bin), join(into, isWin ? 'pgweb.exe' : 'pgweb'));
      if (!isWin) chmodSync(join(into, 'pgweb'), 0o755);
    },
  },
  rediscommander: {
    name: 'Redis Commander',
    description: 'A web viewer for Redis and Valkey: keys, values, TTLs and a command line.',
    engines: ['redis', 'valkey'],
    runtime: 'node',
    port: 8093,
    sourceUrl: 'https://github.com/joeferner/redis-commander',
    async latest() {
      const res = await fetch('https://registry.npmjs.org/redis-commander/latest', { cache: 'no-store' });
      if (!res.ok) throw new Error(`npm: HTTP ${res.status}`);
      const v = ((await res.json()) as { version?: string }).version;
      if (!v) throw new Error('npm gave no version');
      return v;
    },
    async fetch(v, into, _tmp, _progress, rt) {
      if (!rt) throw new Error('Needs Node.js');
      // npm checks every package against its sha512 in the registry; no install scripts run.
      mkdirSync(into, { recursive: true });
      writeFileSync(join(into, 'package.json'), JSON.stringify({ name: 'devcatz-redis-commander', private: true }));
      const npm = join(rt.binDir, isWin ? 'npm.cmd' : 'npm');
      const args = ['install', '--prefix', into, '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund', '--no-update-notifier', `redis-commander@${v}`];
      const env = rt.env; // run() adds the shell environment
      const r = isWin ? await run(process.env.ComSpec ?? 'cmd.exe', ['/d', '/c', npm, ...args], { env, timeout: 600_000 }) : await run(npm, args, { env, timeout: 600_000 });
      if (r.code !== 0) throw new Error(`npm install: ${(r.stderr || r.stdout).trim().split('\n').slice(-3).join(' ')}`);
      if (!existsSync(join(into, 'node_modules', 'redis-commander', 'bin', 'redis-commander.js'))) throw new Error('Redis Commander is not in the download');
    },
  },
};

export const WEB_TOOL_IDS = Object.keys(TOOLS) as WebToolId[];
export const webToolName = (id: WebToolId): string => TOOLS[id].name;

const NAME_RE = /^[a-z0-9]([a-z0-9-]{0,48}[a-z0-9])?$/;

/** True when nothing listens on 127.0.0.1:port. */
function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once('error', () => resolve(false));
    srv.listen({ host: '127.0.0.1', port, exclusive: true }, () => srv.close(() => resolve(true)));
  });
}

const slug = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'db';

/** Adminer's sign-in for DevCatz's services (servers.json → its login, without the form). */
const ADMINER_INDEX = `<?php
// Written by DevCatz. Opens DevCatz's own database services without the login form. Their users and passwords stay
// in servers.json next to this folder (never served), readable by you only; a link names a service, never a password.
function devcatz_servers(): array {
  static $all = null;
  return $all ??= (json_decode((string) @file_get_contents(dirname(__DIR__) . '/servers.json'), true) ?: []);
}
if (isset($_GET['devcatz']) && ($s = devcatz_servers()[$_GET['devcatz']] ?? null)) {
  $_POST['auth'] = ['driver' => $s['driver'], 'server' => $s['server'], 'username' => $s['username'], 'password' => $s['password'], 'db' => $_GET['db'] ?? '', 'permanent' => 1];
  define('DEVCATZ_SIGN_IN', true);
  // Adminer goes on to this address after signing in: without the marker, or it would sign in again and again.
  $_SERVER['REQUEST_URI'] = preg_replace('~([?&])devcatz=[^&]*&?~', '$1', $_SERVER['REQUEST_URI']);
  unset($_GET['devcatz']);
}
function adminer_object() {
  class DevCatzAdminer extends \\Adminer\\Adminer {
    function name() { return 'Adminer · DevCatz'; }
    // DevCatz's services may have no password (SQLite never has one).
    function login($login, $password) { return true; }
    // The sign-in above has no form, so there is no form token to check.
    function verifyLoginToken() { return !defined('DEVCATZ_SIGN_IN'); }
  }
  return new DevCatzAdminer;
}
include __DIR__ . '/adminer.php';
`;

/** phpMyAdmin's config: every MySQL / MariaDB service of DevCatz is a server, signed in with its own user. */
const pmaConfig = (secret: string): string => `<?php
// Written by DevCatz. Every DevCatz MySQL / MariaDB service is a server here, signed in with its own user; the
// passwords stay in servers.json next to this folder (never served), readable by you only.
declare(strict_types=1);
$cfg['blowfish_secret'] = '${secret}';
$cfg['VersionCheck'] = false;
$cfg['SendErrorReports'] = 'never';
$cfg['TempDir'] = dirname(__DIR__) . '/tmp';
$cfg['ServerDefault'] = 1;
$i = 0;
foreach ((json_decode((string) @file_get_contents(dirname(__DIR__) . '/servers.json'), true) ?: []) as $s) {
    $i++;
    $cfg['Servers'][$i] = [
        'verbose' => $s['name'], 'host' => $s['host'], 'port' => (string) $s['port'], 'connect_type' => 'tcp',
        'auth_type' => 'config', 'user' => $s['user'], 'password' => $s['password'], 'AllowNoPassword' => true,
    ];
}
`;

interface Running {
  key: string;
  id: WebToolId;
  serviceId: string | null;
  port: number;
  child: ChildProcess;
  /** pgweb: the database it was started on. */
  db?: string;
  /** Last request through DevCatz's proxy (or its start), for pgweb's idle stop. */
  usedAt: number;
}

/** pgweb stops after this many minutes without a request unless set otherwise (it starts again on the next Open, in about a second). */
export const PGWEB_IDLE_MINUTES = 30;

export interface WebToolsDeps {
  services(): DbServiceState[];
  isActive(serviceId: string): boolean;
  /** An installed PHP / Node.js (the version asked for, else the default); null when none is installed. */
  runtime(kind: ToolRuntime, version?: string | null): RuntimeInfo | null;
  /** The site that owns this host already, or null. */
  domainOwner(host: string): string | null;
  /** https://<host> with the proxy's port when it is not 443. */
  urlOf(host: string): string;
}

export class WebTools {
  private tasks = new Map<WebToolId, TaskProgress>();
  private aborts = new Map<WebToolId, AbortController>();
  private updates = new Map<WebToolId, string>();
  private runs = new Map<string, Running>();
  onChange: () => void = () => undefined;

  constructor(private deps: WebToolsDeps) {}

  private dir(id: WebToolId, ...p: string[]): string {
    return dataDir('webtools', id, ...p);
  }
  private config(id: WebToolId): WebToolConfig | null {
    const c = store.settings.webTools?.[id];
    return c && existsSync(this.dir(id, 'app')) ? c : null;
  }
  private save(id: WebToolId, c: WebToolConfig | null): void {
    const all = { ...(store.settings.webTools ?? {}) };
    if (c) all[id] = c;
    else delete all[id];
    store.updateSettings({ webTools: all });
  }
  private host(id: WebToolId): string {
    return `${this.config(id)?.domain ?? id}.${tld()}`;
  }

  private pgServices(): DbServiceState[] {
    return this.deps.services().filter((s) => s.engine === 'postgresql' && !s.pending);
  }

  state(): WebToolState[] {
    return WEB_TOOL_IDS.map((id) => {
      const t = TOOLS[id];
      const c = this.config(id);
      const host = this.host(id);
      const used = new Set(WEB_TOOL_IDS.filter((o) => o !== id).map((o) => this.config(o)?.port));
      let port = t.port;
      while (used.has(port)) port++;
      return {
        id,
        name: t.name,
        description: t.description,
        engines: t.engines,
        installed: !!c,
        version: c?.version ?? null,
        update: c ? (this.updates.get(id) ?? null) : null,
        domain: c?.domain ?? id,
        host,
        url: this.deps.urlOf(host),
        port: c?.port ?? port,
        defaults: { domain: id, port },
        runtime: t.runtime,
        runtimeVersion: t.runtime ? (c?.runtime ?? this.deps.runtime(t.runtime)?.version ?? null) : null,
        autoStop: id === 'pgweb' ? c?.autoStop !== false : null,
        autoStopMinutes: c?.autoStopMinutes ?? PGWEB_IDLE_MINUTES,
        blocked: t.runtime && !this.deps.runtime(t.runtime) ? `Needs ${RUNTIME_NAME[t.runtime]}` : null,
        running: [...this.runs.values()].filter((r) => r.id === id).map((r) => this.runInfo(r)),
        task: this.tasks.get(id) ?? null,
        sourceUrl: t.sourceUrl,
      };
    });
  }

  private runHost(r: Running): string {
    if (r.id !== 'pgweb' || !r.serviceId) return this.host(r.id);
    const s = this.pgServices().find((x) => x.id === r.serviceId);
    return `${slug(s?.name ?? r.serviceId)}.${this.host('pgweb')}`;
  }
  private runInfo(r: Running): WebToolRun {
    const s = r.serviceId ? this.deps.services().find((x) => x.id === r.serviceId) : null;
    return { serviceId: r.serviceId, name: s ? `${TOOLS[r.id].name} · ${s.name}` : TOOLS[r.id].name, port: r.port, url: this.deps.urlOf(this.runHost(r)), pid: r.child.pid ?? null };
  }

  // ---------------------------------------------------------------- form checks

  async check(id: WebToolId, o: { domain: string; port: number }): Promise<{ domain: string | null; port: string | null }> {
    const name = String(o.domain ?? '').trim().toLowerCase();
    let domain: string | null = null;
    if (!NAME_RE.test(name)) domain = 'Lowercase letters, digits and hyphens';
    else {
      const host = `${name}.${tld()}`;
      const owner = this.deps.domainOwner(host);
      const other = WEB_TOOL_IDS.find((x) => x !== id && (this.config(x)?.domain ?? x) === name);
      if (owner) domain = `${host} is the site ${owner}'s address`;
      else if (other) domain = `${host} is ${TOOLS[other].name}'s address`;
    }
    const port = Number(o.port);
    let portMsg: string | null = null;
    if (!Number.isInteger(port) || port < 1024 || port > 65535) portMsg = 'A port from 1024 to 65535';
    else {
      const other = WEB_TOOL_IDS.find((x) => x !== id && (this.config(x)?.port === port || Object.values(this.config(x)?.ports ?? {}).includes(port)));
      const ours = [...this.runs.values()].some((r) => r.id === id && r.port === port);
      const svc = this.deps.services().find((s) => s.port === port);
      if (other) portMsg = `${TOOLS[other].name} uses ${port}`;
      else if (svc) portMsg = `${svc.name} uses ${port}`;
      else if (!ours && !(await portFree(port))) portMsg = `Something already listens on ${port}`;
    }
    return { domain, port: portMsg };
  }

  private async assertForm(id: WebToolId, o: { domain: string; port: number }): Promise<{ domain: string; port: number }> {
    const c = await this.check(id, o);
    if (c.domain || c.port) throw new Error([c.domain, c.port].filter(Boolean).join('. '));
    return { domain: o.domain.trim().toLowerCase(), port: Number(o.port) };
  }

  // ---------------------------------------------------------------- install / update / uninstall

  private task(id: WebToolId, init: TaskProgress) {
    this.tasks.set(id, init);
    this.onChange();
    const report = (p: Partial<TaskProgress>) => {
      const cur = this.tasks.get(id);
      if (!cur) return;
      this.tasks.set(id, { ...cur, ...p });
      this.onChange();
    };
    return {
      report,
      finish: () => {
        report({ step: this.tasks.get(id)?.steps.length ?? 0, done: true, detail: undefined, received: undefined, total: undefined });
        setTimeout(() => {
          if (this.tasks.get(id)?.done) {
            this.tasks.delete(id);
            this.onChange();
          }
        }, 4000);
      },
    };
  }

  dismiss(id: WebToolId): void {
    if (this.aborts.has(id)) return;
    this.tasks.delete(id);
    this.onChange();
  }

  cancel(id: WebToolId): void {
    this.aborts.get(id)?.abort();
  }

  /** Downloads the release into <tool>/app (replacing an older one); returns its version. */
  private async download(id: WebToolId, report: (p: Partial<TaskProgress>) => void, version?: string, rt: RuntimeInfo | null = null): Promise<string> {
    const t = TOOLS[id];
    const abort = new AbortController();
    this.aborts.set(id, abort);
    const tmp = this.dir(id, `tmp-${Date.now()}`);
    try {
      report({ step: 0, detail: t.sourceUrl });
      const v = version ?? (await t.latest());
      report({ step: 1, detail: `${t.name} ${v}` });
      mkdirSync(tmp, { recursive: true });
      const into = join(tmp, 'app');
      await t.fetch(v, into, tmp, (received, total) => report({ received, total }), rt);
      if (abort.signal.aborted) throw new Error('Cancelled');
      report({ step: 2, detail: undefined, received: undefined, total: undefined });
      this.stopTool(id);
      rmSync(this.dir(id, 'app'), { recursive: true, force: true });
      renameSync(into, this.dir(id, 'app'));
      this.writeFiles(id);
      return v;
    } finally {
      this.aborts.delete(id);
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  /** The files DevCatz adds to a tool: Adminer's sign-in, phpMyAdmin's config and temp folder. */
  private writeFiles(id: WebToolId): void {
    if (id === 'adminer') writeFileSync(this.dir(id, 'app', 'index.php'), ADMINER_INDEX);
    if (id === 'phpmyadmin') {
      mkdirSync(this.dir(id, 'tmp'), { recursive: true });
      const secret = randomBytes(24).toString('base64').replace(/[^A-Za-z0-9]/g, '').padEnd(32, 'x').slice(0, 32);
      writeFileSync(this.dir(id, 'app', 'config.inc.php'), pmaConfig(secret), { mode: 0o600 });
    }
  }

  async install(id: WebToolId, o: { domain: string; port: number; runtime?: string | null }): Promise<void> {
    if (this.aborts.has(id)) throw new Error(`${TOOLS[id].name} is busy`);
    const kind = TOOLS[id].runtime;
    const rt = kind ? this.deps.runtime(kind, o.runtime) : null;
    if (kind && !rt) throw new Error(`Needs ${RUNTIME_NAME[kind]}: install it first`);
    const form = await this.assertForm(id, o);
    const t = this.task(id, { kind: 'install', title: `Installing ${TOOLS[id].name}`, steps: ['Looking up the latest release', 'Downloading (SHA-256 checked)', 'Setting up'], step: 0 });
    try {
      const version = await this.download(id, t.report, undefined, rt);
      this.save(id, { version, domain: form.domain, port: form.port, ...(rt ? { runtime: rt.version } : {}) });
      this.updates.delete(id);
      // Its address answers right away (pgweb starts per service, when one is opened).
      if (kind) await this.startShared(id).catch(() => undefined);
      t.finish();
    } catch (err) {
      t.report({ error: (err as Error).message, cancelled: (err as Error).message === 'Cancelled' || undefined });
      throw err;
    } finally {
      this.onChange();
    }
  }

  async update(id: WebToolId): Promise<void> {
    const c = this.config(id);
    if (!c) throw new Error(`${TOOLS[id].name} is not installed`);
    if (this.aborts.has(id)) throw new Error(`${TOOLS[id].name} is busy`);
    const t = this.task(id, { kind: 'update', title: `Updating ${TOOLS[id].name}`, steps: ['Looking up the latest release', 'Downloading (SHA-256 checked)', 'Setting up'], step: 0 });
    try {
      const kind = TOOLS[id].runtime;
      const version = await this.download(id, t.report, this.updates.get(id), kind ? this.deps.runtime(kind, c.runtime) : null);
      this.save(id, { ...c, version });
      this.updates.delete(id);
      if (kind) await this.startShared(id).catch(() => undefined);
      t.finish();
    } catch (err) {
      t.report({ error: (err as Error).message });
      throw err;
    } finally {
      this.onChange();
    }
  }

  uninstall(id: WebToolId): void {
    if (this.aborts.has(id)) throw new Error(`${TOOLS[id].name} is busy`);
    this.stopTool(id);
    rmSync(this.dir(id), { recursive: true, force: true });
    this.save(id, null);
    this.updates.delete(id);
    // Open goes back to DBCatz where this tool was the choice.
    const w = { ...(store.settings.dbOpenWith ?? {}) };
    for (const [k, v] of Object.entries(w)) if (v === id) delete w[k];
    store.updateSettings({ dbOpenWith: w });
    this.onChange();
  }

  async configure(id: WebToolId, o: { domain: string; port: number; runtime?: string | null }): Promise<void> {
    const c = this.config(id);
    if (!c) throw new Error(`${TOOLS[id].name} is not installed`);
    const form = await this.assertForm(id, o);
    const kind = TOOLS[id].runtime;
    const rt = kind && o.runtime ? this.deps.runtime(kind, o.runtime) : null;
    if (kind && o.runtime && rt?.version !== o.runtime) throw new Error(`${RUNTIME_NAME[kind]} ${o.runtime} is not installed`);
    const portChanged = form.port !== c.port;
    const rtChanged = !!rt && rt.version !== c.runtime;
    this.save(id, { ...c, domain: form.domain, port: form.port, ports: portChanged ? {} : c.ports, ...(rt ? { runtime: rt.version } : {}) });
    if (portChanged || rtChanged) {
      const wasUp = [...this.runs.values()].some((r) => r.id === id);
      this.stopTool(id);
      if (wasUp && kind) await this.startShared(id).catch(() => undefined);
    }
    this.onChange();
  }

  async checkUpdates(): Promise<string[]> {
    const failed: string[] = [];
    await Promise.all(
      WEB_TOOL_IDS.map(async (id) => {
        const c = this.config(id);
        if (!c) return void this.updates.delete(id);
        const v = await TOOLS[id].latest().catch(() => null);
        if (!v) failed.push(TOOLS[id].name);
        else if (newer(v, c.version)) this.updates.set(id, v);
        else this.updates.delete(id);
      }),
    );
    this.onChange();
    return failed;
  }

  /** Updates found and not yet told (for the notification). */
  pendingUpdates(): { id: WebToolId; name: string; from: string; to: string }[] {
    return [...this.updates].flatMap(([id, to]) => {
      const c = this.config(id);
      return c ? [{ id, name: TOOLS[id].name, from: c.version, to }] : [];
    });
  }

  // ---------------------------------------------------------------- running

  private writeServers(id: WebToolId): void {
    const svcs = this.deps.services().filter((s) => !s.pending && TOOLS[id].engines.includes(s.engine));
    let data: unknown;
    if (id === 'rediscommander') {
      mkdirSync(this.dir(id, 'conf'), { recursive: true });
      const list = svcs.map((s) => ({ label: s.name, host: '127.0.0.1', port: s.port, dbIndex: 0, ...(s.user ? { username: s.user } : {}), ...(s.password ? { password: s.password } : {}) }));
      writeFileSync(this.dir(id, 'conf', 'local.json'), JSON.stringify({ connections: list }), { mode: 0o600 });
      if (!isWin) chmodSync(this.dir(id, 'conf', 'local.json'), 0o600);
      return;
    }
    if (id === 'phpmyadmin') data = svcs.map((s) => ({ key: s.id, name: s.name, host: '127.0.0.1', port: s.port, user: s.user || 'root', password: s.password }));
    else
      data = Object.fromEntries(
        svcs.map((s) => [
          s.id,
          s.engine === 'sqlite'
            ? { driver: 'sqlite', server: '', username: '', password: '' }
            : { driver: s.engine === 'postgresql' ? 'pgsql' : 'server', server: `127.0.0.1:${s.port}`, username: s.user || (s.engine === 'postgresql' ? 'postgres' : 'root'), password: s.password },
        ]),
      );
    writeFileSync(this.dir(id, 'servers.json'), JSON.stringify(data), { mode: 0o600 });
    if (!isWin) chmodSync(this.dir(id, 'servers.json'), 0o600);
  }

  private spawnTracked(key: string, id: WebToolId, serviceId: string | null, port: number, cmd: string, args: string[], env: NodeJS.ProcessEnv, db?: string): Running {
    const child = spawn(cmd, args, { env, stdio: 'ignore', windowsHide: true });
    const r: Running = { key, id, serviceId, port, child, db, usedAt: Date.now() };
    this.runs.set(key, r);
    child.on('exit', () => {
      if (this.runs.get(key) === r) {
        this.runs.delete(key);
        this.onChange();
      }
    });
    child.on('error', () => undefined);
    this.onChange();
    return r;
  }

  private async waitUp(port: number, child: ChildProcess, name: string): Promise<void> {
    for (let i = 0; i < 50; i++) {
      if (child.exitCode !== null) throw new Error(`${name} stopped right after starting`);
      if (!(await portFree(port))) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`${name} did not start on port ${port}`);
  }

  /** phpMyAdmin / Adminer (php -S) and Redis Commander (node): one process serving every service of its engines. */
  private async startShared(id: WebToolId): Promise<Running> {
    const have = this.runs.get(id);
    if (have) return have;
    const c = this.config(id);
    if (!c) throw new Error(`${TOOLS[id].name} is not installed`);
    const kind = TOOLS[id].runtime!;
    const rt = this.deps.runtime(kind, c.runtime);
    if (!rt) throw new Error(`Needs ${RUNTIME_NAME[kind]}: install it first`);
    if (!(await portFree(c.port))) throw new Error(`Port ${c.port} is taken: pick another one in ${TOOLS[id].name}'s settings`);
    this.writeServers(id);
    if (kind === 'node') {
      // Its own defaults, then DevCatz's connections (conf/local.json); nothing it saves goes back into them.
      const pkg = this.dir(id, 'app', 'node_modules', 'redis-commander');
      const env = { ...getShellEnv(), ...rt.env, NODE_ENV: 'production', NODE_CONFIG_DIR: [join(pkg, 'config'), this.dir(id, 'conf')].join(delimiter), NODE_CONFIG_STRICT_MODE: '0' };
      const r = this.spawnTracked(id, id, null, c.port, rt.bin, [join(pkg, 'bin', 'redis-commander.js'), '--address', '127.0.0.1', '--port', String(c.port), '--nosave'], env);
      await this.waitUp(c.port, r.child, TOOLS[id].name);
      return r;
    }
    const php = rt;
    const env = { ...getShellEnv(), ...php.env, ...(isWin ? {} : { PHP_CLI_SERVER_WORKERS: '4' }) };
    // phpMyAdmin 5.2 still raises deprecation notices on PHP 8.4+: they stay out of its pages.
    const args = ['-d', 'display_errors=0', '-d', 'log_errors=0', '-d', 'error_reporting=24575', '-d', 'memory_limit=512M', '-d', 'upload_max_filesize=512M', '-d', 'post_max_size=512M', '-d', 'max_execution_time=600', '-S', `127.0.0.1:${c.port}`, '-t', this.dir(id, 'app')];
    const r = this.spawnTracked(id, id, null, c.port, php.bin, args, env);
    await this.waitUp(c.port, r.child, TOOLS[id].name);
    return r;
  }

  private async pgwebPort(serviceId: string): Promise<number> {
    const c = this.config('pgweb')!;
    const ports = { ...(c.ports ?? {}) };
    if (ports[serviceId] && (await portFree(ports[serviceId]))) return ports[serviceId];
    const taken = new Set([...Object.values(ports), ...WEB_TOOL_IDS.filter((x) => x !== 'pgweb').map((x) => this.config(x)?.port), ...this.deps.services().map((s) => s.port)]);
    let p = c.port;
    while (taken.has(p) || !(await portFree(p))) p++;
    ports[serviceId] = p;
    this.save('pgweb', { ...c, ports });
    return p;
  }

  private async startPgweb(s: DbServiceState, db: string): Promise<Running> {
    const key = `pgweb:${s.id}`;
    const have = this.runs.get(key);
    if (have && have.db === db) {
      have.usedAt = Date.now();
      return have;
    }
    if (have) {
      // pgweb starts on one database; another one is a restart (seconds), the UI lists the others too.
      this.stop(key);
      await new Promise((r) => setTimeout(r, 300));
    }
    const port = await this.pgwebPort(s.id);
    const user = encodeURIComponent(s.user || 'postgres');
    const pass = s.password ? `:${encodeURIComponent(s.password)}` : '';
    const env = { ...getShellEnv(), PGWEB_DATABASE_URL: `postgres://${user}${pass}@127.0.0.1:${s.port}/${encodeURIComponent(db)}?sslmode=disable` };
    const r = this.spawnTracked(key, 'pgweb', s.id, port, this.dir('pgweb', 'app', isWin ? 'pgweb.exe' : 'pgweb'), ['--bind=127.0.0.1', `--listen=${port}`, '--skip-open'], env, db);
    await this.waitUp(port, r.child, 'pgweb');
    return r;
  }

  /** Starts what is needed and returns the address that opens this service (at a database when given). */
  async open(id: WebToolId, serviceId: string, database?: string): Promise<string> {
    const s = this.deps.services().find((x) => x.id === serviceId);
    if (!s) throw new Error('No such database service');
    if (!TOOLS[id].engines.includes(s.engine)) throw new Error(`${TOOLS[id].name} does not open ${s.engineName}`);
    if (!this.config(id)) throw new Error(`${TOOLS[id].name} is not installed`);
    if (s.engine !== 'sqlite' && !this.deps.isActive(s.id)) throw new Error(`${s.name} is not running: start it first`);
    const q = (o: Record<string, string>) => new URLSearchParams(o).toString();
    if (id === 'pgweb') {
      const r = await this.startPgweb(s, database || 'postgres');
      return this.deps.urlOf(this.runHost(r)) + '/';
    }
    this.writeServers(id);
    // A service created since it started: Redis Commander reads its connections once, so it starts again.
    if (id === 'rediscommander' && this.runs.has(id) && !(await this.knows(id, s))) this.stopTool(id);
    await this.startShared(id);
    const base = this.deps.urlOf(this.host(id));
    if (id === 'rediscommander') return `${base}/`;
    if (id === 'phpmyadmin') {
      const n = this.deps.services().filter((x) => !x.pending && TOOLS.phpmyadmin.engines.includes(x.engine)).findIndex((x) => x.id === s.id) + 1;
      return `${base}/index.php?${q(database ? { route: '/database/structure', server: String(n), db: database } : { server: String(n) })}`;
    }
    if (s.engine === 'sqlite') {
      const file = sqliteFile(s.resolvedDataDir, database);
      if (!file) throw new Error(`${s.name} has no database file yet (${s.resolvedDataDir})`);
      return `${base}/?${q({ devcatz: s.id, sqlite: '', username: '', db: file })}`;
    }
    const driver = s.engine === 'postgresql' ? 'pgsql' : 'server';
    return `${base}/?${q({ devcatz: s.id, [driver]: `127.0.0.1:${s.port}`, username: s.user || (s.engine === 'postgresql' ? 'postgres' : 'root'), ...(database ? { db: database } : {}) })}`;
  }

  /** Start: phpMyAdmin / Adminer serve every service; pgweb starts for one PostgreSQL service (on the database it had). */
  async start(id: WebToolId, serviceId?: string): Promise<void> {
    if (!this.config(id)) throw new Error(`${TOOLS[id].name} is not installed`);
    if (TOOLS[id].runtime) {
      this.writeServers(id);
      await this.startShared(id);
      return;
    }
    const s = this.pgServices().find((x) => x.id === serviceId);
    if (!s) throw new Error('Name the PostgreSQL service to start pgweb for');
    if (!this.deps.isActive(s.id)) throw new Error(`${s.name} is not running: start it first`);
    await this.startPgweb(s, this.runs.get(`pgweb:${s.id}`)?.db ?? 'postgres');
  }

  setAutoStop(id: WebToolId, on: boolean, minutes?: number): void {
    const c = this.config(id);
    if (!c) throw new Error(`${TOOLS[id].name} is not installed`);
    if (id !== 'pgweb') throw new Error(`${TOOLS[id].name} has no auto-stop: it is light and serves every service`);
    // Counting starts again from now when it is turned back on.
    if (on) for (const r of this.runs.values()) if (r.id === id) r.usedAt = Date.now();
    const m = minutes === undefined ? c.autoStopMinutes : Math.round(minutes);
    if (m !== undefined && !(m >= 5 && m <= 1440)) throw new Error('Between 5 minutes and 24 hours (1440)');
    this.save(id, { ...c, autoStop: on, ...(m !== undefined ? { autoStopMinutes: m } : {}) });
    this.onChange();
  }

  /** Stop: the tool, or pgweb of one service (every pgweb without one). Open starts it again. */
  stopRunning(id: WebToolId, serviceId?: string): void {
    if (id === 'pgweb' && serviceId) this.stop(`pgweb:${serviceId}`);
    else this.stopTool(id);
  }

  /** Redis Commander lists this service already (asked through its own API on 127.0.0.1). */
  private async knows(id: WebToolId, s: DbServiceState): Promise<boolean> {
    const r = this.runs.get(id);
    if (!r) return false;
    try {
      const res = await fetch(`http://127.0.0.1:${r.port}/apiv2/server/info`, { signal: AbortSignal.timeout(2000) });
      const body = (await res.json()) as { data?: { port?: number }[] };
      return !!body.data?.some((c) => c.port === s.port);
    } catch {
      return false;
    }
  }

  /** phpMyAdmin, Adminer and Redis Commander start with DevCatz once installed, so their address answers without a click. */
  async startInstalled(): Promise<void> {
    for (const id of WEB_TOOL_IDS) if (TOOLS[id].runtime && this.config(id)) await this.startShared(id).catch(() => undefined);
  }

  /** Stops pgweb of services that stopped or are gone, and pgweb nobody used for its auto-stop minutes. */
  prune(): void {
    for (const r of [...this.runs.values()]) {
      if (r.id === 'pgweb' && r.serviceId) {
        const s = this.pgServices().find((x) => x.id === r.serviceId);
        const c = this.config('pgweb');
        const idle = c?.autoStop !== false && Date.now() - r.usedAt > (c?.autoStopMinutes ?? PGWEB_IDLE_MINUTES) * 60_000;
        if (!s || !this.deps.isActive(s.id) || idle) this.stop(r.key);
      }
    }
  }

  private stop(key: string): void {
    const r = this.runs.get(key);
    if (!r) return;
    this.runs.delete(key);
    if (r.child.pid) killTree(r.child.pid);
    this.onChange();
  }
  private stopTool(id: WebToolId): void {
    for (const r of [...this.runs.values()]) if (r.id === id) this.stop(r.key);
  }
  stopAll(): void {
    for (const k of [...this.runs.keys()]) this.stop(k);
  }

  routes(): Route[] {
    const out: Route[] = [];
    for (const id of WEB_TOOL_IDS) {
      if (!this.config(id) || id === 'pgweb') continue;
      const r = this.runs.get(id);
      out.push({ domain: this.host(id), port: r?.port ?? this.config(id)!.port, projectName: TOOLS[id].name, running: !!r, secure: true, keepHost: true });
    }
    const pg = [...this.runs.values()].filter((r) => r.id === 'pgweb');
    const used = (r: Running) => () => void (r.usedAt = Date.now());
    for (const r of pg) out.push({ domain: this.runHost(r), port: r.port, projectName: this.runInfo(r).name, running: true, secure: true, used: used(r) });
    if (this.config('pgweb') && this.pgServices().length === 1 && pg[0]) out.push({ domain: this.host('pgweb'), port: pg[0].port, projectName: 'pgweb', running: true, secure: true, used: used(pg[0]) });
    return out;
  }

  monitorTargets(): MonitorTarget[] {
    return [...this.runs.values()].map((r) => {
      const info = this.runInfo(r);
      return {
        id: `webtool:${r.key}`,
        kind: 'webtool' as const,
        name: info.name,
        detail: `${this.runHost(r)} · :${r.port}`,
        active: true,
        pids: info.pid ? [info.pid] : [],
        dataDirs: [],
        binDirs: [this.dir(r.id, 'app')],
        link: r.serviceId ? { section: 'database' as const, id: r.serviceId } : null,
      };
    });
  }
}

/** A newer x.y.z. */
function newer(a: string, b: string): boolean {
  const pa = a.split(/[.-]/).map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split(/[.-]/).map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  return false;
}

/** A SQLite service's database file: the one named, else the first one in its folder. */
function sqliteFile(dir: string, name?: string): string | null {
  if (name) {
    const p = name.includes('/') || name.includes('\\') ? name : join(dir, name);
    if (existsSync(p)) return p;
  }
  try {
    const f = readdirSync(dir).find((x) => /\.(sqlite3?|db)$/i.test(x) && statSync(join(dir, x)).isFile());
    return f ? join(dir, f) : null;
  } catch {
    return null;
  }
}

export type { DbOpenTool };
