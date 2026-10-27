import { createHash } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import type { FpmStatus, InstalledPhp } from '@shared/types';
import { getShellEnv } from './env';
import { etcDir, iniEnv } from './php';
import { compare } from './node';
import { isWin, killTree } from './platform';
import { dataDir } from './store';
import { words } from '@shared/platform';

/** Windows: one `php-cgi -b` per port; each serves one request at a time. */
interface Worker {
  port: number;
  child: ChildProcess | null;
  /** Killed on purpose (php.ini reload): start it again right away. */
  restart: boolean;
}

interface Pool {
  php: InstalledPhp;
  child: ChildProcess | null;
  socket: string;
  sites: string[];
  error: string | null;
  stopping: boolean;
  /** Windows only (no php-fpm): the php-cgi workers on consecutive ports. */
  workers: Worker[];
  starting: boolean;
}

/**
 * Windows: no php-fpm and php-cgi cannot fork children (PHP_FCGI_CHILDREN is not supported there), so each version
 * gets WIN_WORKERS php-cgi processes on consecutive ports from 9100 (clear of DevCatz's dev ports, 4100+). The
 * "socket" is then `tcp://127.0.0.1:9100-9103`; fastcgi.ts sends each request to the least busy port.
 */
const WIN_WORKERS = 4;
const WIN_PORT_BASE = 9100;

/** True when nothing listens on 127.0.0.1:port. */
function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once('error', () => resolve(false));
    srv.listen({ host: '127.0.0.1', port, exclusive: true }, () => srv.close(() => resolve(true)));
  });
}

/**
 * One PHP-FPM master per PHP version that a linked site uses (Laravel
 * Herd's "FPM" service). Sites are always on: the proxy talks FastCGI to the
 * pool's unix socket; there is no per-site process to start.
 */
export class FpmManager {
  private pools = new Map<string, Pool>();
  /** Windows: first worker port per version (kept for the session so routes stay put). */
  private winPorts = new Map<string, number>();
  onChange: () => void = () => undefined;

  private runDir() {
    const d = dataDir('run');
    if (!existsSync(d)) mkdirSync(d, { recursive: true });
    return d;
  }

  private logFile(version: string) {
    const d = dataDir('logs');
    if (!existsSync(d)) mkdirSync(d, { recursive: true });
    return join(d, `php-fpm-${version}.log`);
  }

  /** Windows: the version's port block, the next unused one on first use. */
  private winBase(version: string): number {
    let base = this.winPorts.get(version);
    if (base === undefined) {
      const used = new Set(this.winPorts.values());
      base = WIN_PORT_BASE;
      while (used.has(base)) base += WIN_WORKERS;
      this.winPorts.set(version, base);
    }
    return base;
  }

  socketFor(version: string): string {
    if (isWin) {
      const base = this.winBase(version);
      return `tcp://127.0.0.1:${base}-${base + WIN_WORKERS - 1}`;
    }
    const sock = join(this.runDir(), `php-${version}.sock`);
    // Unix socket paths are limited to 104 bytes on macOS (a long home folder or data folder overflows it):
    // fall back to a short per-folder directory under /tmp.
    if (Buffer.byteLength(sock) <= 100) return sock;
    const dir = join('/tmp', `devcatz-${createHash('sha1').update(this.runDir()).digest('hex').slice(0, 8)}`);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return join(dir, `php-${version}.sock`);
  }

  /** Starts pools for versions in use, stops the rest. */
  sync(wanted: Map<string, { php: InstalledPhp; sites: string[] }>): void {
    for (const [version, pool] of this.pools) {
      if (!wanted.has(version)) {
        this.stop(version);
        this.pools.delete(version);
      }
    }
    for (const [version, w] of wanted) {
      const pool = this.pools.get(version);
      if (pool) {
        pool.sites = w.sites;
        if (!this.alive(pool) && !pool.stopping && !pool.starting) this.start(pool);
      } else {
        const p: Pool = { php: w.php, child: null, socket: this.socketFor(version), sites: w.sites, error: null, stopping: false, workers: [], starting: false };
        this.pools.set(version, p);
        this.start(p);
      }
    }
  }

  /** The pool has a live process: php-fpm's master, or on Windows at least one php-cgi worker. */
  private alive(pool: Pool): boolean {
    return isWin ? pool.workers.some((w) => w.child) : Boolean(pool.child);
  }

  private start(pool: Pool): void {
    if (isWin) {
      void this.startWin(pool);
      return;
    }
    const v = pool.php.version;
    const etc = etcDir(v);
    const conf = join(etc, 'php-fpm.conf');
    rmSync(pool.socket, { force: true });
    writeFileSync(
      conf,
      [
        '; Managed by DevCatz',
        '[global]',
        `error_log = ${this.logFile(v)}`,
        'daemonize = no',
        '',
        '[mrcatz]',
        `listen = ${pool.socket}`,
        'listen.mode = 0600',
        'pm = dynamic',
        'pm.max_children = 16',
        'pm.start_servers = 2',
        'pm.min_spare_servers = 1',
        'pm.max_spare_servers = 4',
        'pm.max_requests = 500',
        'catch_workers_output = yes',
        // Added in PHP 7.3; older php-fpm refuses unknown directives.
        ...(compare(v, '7.3.0') >= 0 ? ['decorate_workers_output = no'] : []),
        // Laravel reads its own .env; keep the shell PATH etc. for exec() calls.
        'clear_env = no',
        'request_terminate_timeout = 0',
        '',
      ].join('\n'),
    );
    const child = spawn(pool.php.fpm, ['--nodaemonize', '--fpm-config', conf, '-c', join(etc, 'php.ini')], {
      env: { ...getShellEnv(), ...iniEnv(v) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    pool.child = child;
    pool.error = null;
    const log = (d: Buffer) => {
      try {
        appendFileSync(this.logFile(v), d);
      } catch {
        /* best effort */
      }
    };
    child.stdout?.on('data', log);
    child.stderr?.on('data', log);
    child.on('error', (e) => {
      pool.error = e.message;
      this.onChange();
    });
    child.on('exit', (code, signal) => {
      pool.child = null;
      if (!pool.stopping) {
        pool.error = `${words.phpServer} ${v} exited (${signal ?? `code ${code}`}); see logs/php-fpm-${v}.log`;
        // Crash loop guard: retry once after a pause.
        setTimeout(() => {
          if (!pool.child && !pool.stopping && this.pools.get(v) === pool) this.start(pool);
        }, 3000);
      }
      this.onChange();
    });
    this.onChange();
  }

  /** Windows: frees the port block (another app may hold a port: move on to the next block), then starts the workers. */
  private async startWin(pool: Pool): Promise<void> {
    const v = pool.php.version;
    pool.starting = true;
    try {
      let base = this.winBase(v);
      for (let tries = 0; tries < 50; tries++) {
        const free = await Promise.all(Array.from({ length: WIN_WORKERS }, (_, i) => portFree(base + i)));
        if (free.every(Boolean)) break;
        const used = new Set(this.winPorts.values());
        do base += WIN_WORKERS;
        while (used.has(base));
        this.winPorts.set(v, base);
      }
      pool.socket = this.socketFor(v);
      if (pool.stopping || this.pools.get(v) !== pool) return;
      pool.error = null;
      pool.workers = Array.from({ length: WIN_WORKERS }, (_, i) => ({ port: base + i, child: null, restart: false }));
      for (const w of pool.workers) this.spawnWorker(pool, w);
    } finally {
      pool.starting = false;
      this.onChange();
    }
  }

  /** Windows: one php-cgi FastCGI server; PHP_FCGI_MAX_REQUESTS=0 so it never exits after N requests. */
  private spawnWorker(pool: Pool, w: Worker): void {
    const v = pool.php.version;
    const child = spawn(pool.php.fpm, ['-b', `127.0.0.1:${w.port}`, '-c', join(etcDir(v), 'php.ini')], {
      env: { ...getShellEnv(), ...iniEnv(v), PHP_FCGI_MAX_REQUESTS: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    w.child = child;
    const log = (d: Buffer) => {
      try {
        appendFileSync(this.logFile(v), d);
      } catch {
        /* best effort */
      }
    };
    child.stdout?.on('data', log);
    child.stderr?.on('data', log);
    child.on('error', (e) => {
      pool.error = e.message;
      // Never started (php-cgi.exe missing): no exit event follows.
      if (!child.pid && w.child === child) w.child = null;
      this.onChange();
    });
    child.on('exit', (code, signal) => {
      if (w.child !== child) return;
      w.child = null;
      if (w.restart) {
        w.restart = false;
        if (!pool.stopping && this.pools.get(v) === pool) this.spawnWorker(pool, w);
      } else if (!pool.stopping) {
        pool.error = `PHP ${v} (php-cgi on port ${w.port}) exited (${signal ?? `code ${code}`}); see logs/php-fpm-${v}.log`;
        // Crash loop guard: retry after a pause.
        setTimeout(() => {
          if (!w.child && !pool.stopping && this.pools.get(v) === pool && pool.workers.includes(w)) this.spawnWorker(pool, w);
        }, 3000);
      }
      this.onChange();
    });
  }

  /** Graceful reload (php.ini changed). */
  reload(version: string): void {
    if (isWin) {
      // php-cgi has no reload signal: restart each worker.
      for (const w of this.pools.get(version)?.workers ?? []) {
        if (!w.child?.pid) continue;
        w.restart = true;
        killTree(w.child.pid);
      }
      return;
    }
    this.pools.get(version)?.child?.kill('SIGUSR2');
  }

  stop(version: string): void {
    const pool = this.pools.get(version);
    if (isWin) {
      if (!pool) return;
      pool.stopping = true;
      for (const w of pool.workers) {
        w.restart = false;
        if (w.child?.pid) killTree(w.child.pid);
      }
      return;
    }
    if (!pool?.child) return;
    pool.stopping = true;
    pool.child.kill('SIGQUIT');
    const child = pool.child;
    setTimeout(() => child.exitCode === null && child.kill('SIGKILL'), 3000);
  }

  async stopAll(): Promise<void> {
    const children = [...this.pools.values()].flatMap((p) => (isWin ? p.workers.map((w) => w.child) : [p.child])).filter((c): c is ChildProcess => !!c);
    for (const v of this.pools.keys()) this.stop(v);
    await Promise.all(
      children.map((c) => (c.exitCode !== null ? Promise.resolve() : new Promise<void>((r) => c.once('exit', () => r())))),
    );
  }

  /** Restart every pool (menu bar "Restart services"). */
  async restartAll(): Promise<void> {
    const pools = [...this.pools.values()];
    await this.stopAll();
    for (const p of pools) {
      p.stopping = false;
      this.start(p);
    }
  }

  /** Master pid per running pool (workers are its children), for the monitor. */
  pids(): { version: string; pid: number; sites: string[] }[] {
    if (isWin) {
      // No master on Windows: the first live worker stands for the version.
      return [...this.pools.values()].flatMap((p) => {
        const pid = p.workers.find((w) => w.child?.pid)?.child?.pid;
        return pid ? [{ version: p.php.version, pid, sites: p.sites }] : [];
      });
    }
    return [...this.pools.values()].filter((p) => p.child?.pid).map((p) => ({ version: p.php.version, pid: p.child!.pid!, sites: p.sites }));
  }

  isRunning(version: string): boolean {
    if (isWin) {
      const pool = this.pools.get(version);
      return Boolean(pool && this.alive(pool));
    }
    return Boolean(this.pools.get(version)?.child) && existsSync(this.socketFor(version));
  }

  status(): FpmStatus[] {
    return [...this.pools.values()].map((p) => ({
      version: p.php.version,
      running: isWin ? this.alive(p) : Boolean(p.child) && existsSync(p.socket),
      sites: p.sites,
      error: p.error,
    }));
  }
}
