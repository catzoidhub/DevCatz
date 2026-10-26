import { createHash } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FpmStatus, InstalledPhp } from '@shared/types';
import { getShellEnv } from './env';
import { etcDir, iniEnv } from './php';
import { compare } from './node';
import { dataDir } from './store';

interface Pool {
  php: InstalledPhp;
  child: ChildProcess | null;
  socket: string;
  sites: string[];
  error: string | null;
  stopping: boolean;
}

/**
 * One PHP-FPM master per PHP version that a linked site uses (Laravel
 * Herd's "FPM" service). Sites are always on: the proxy talks FastCGI to the
 * pool's unix socket; there is no per-site process to start.
 */
export class FpmManager {
  private pools = new Map<string, Pool>();
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

  socketFor(version: string): string {
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
        if (!pool.child && !pool.stopping) this.start(pool);
      } else {
        const p: Pool = { php: w.php, child: null, socket: this.socketFor(version), sites: w.sites, error: null, stopping: false };
        this.pools.set(version, p);
        this.start(p);
      }
    }
  }

  private start(pool: Pool): void {
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
        pool.error = `PHP-FPM ${v} exited (${signal ?? `code ${code}`}); see logs/php-fpm-${v}.log`;
        // Crash loop guard: retry once after a pause.
        setTimeout(() => {
          if (!pool.child && !pool.stopping && this.pools.get(v) === pool) this.start(pool);
        }, 3000);
      }
      this.onChange();
    });
    this.onChange();
  }

  /** Graceful reload (php.ini changed). */
  reload(version: string): void {
    this.pools.get(version)?.child?.kill('SIGUSR2');
  }

  stop(version: string): void {
    const pool = this.pools.get(version);
    if (!pool?.child) return;
    pool.stopping = true;
    pool.child.kill('SIGQUIT');
    const child = pool.child;
    setTimeout(() => child.exitCode === null && child.kill('SIGKILL'), 3000);
  }

  async stopAll(): Promise<void> {
    const children = [...this.pools.values()].map((p) => p.child).filter((c): c is ChildProcess => !!c);
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
    return [...this.pools.values()].filter((p) => p.child?.pid).map((p) => ({ version: p.php.version, pid: p.child!.pid!, sites: p.sites }));
  }

  isRunning(version: string): boolean {
    return Boolean(this.pools.get(version)?.child) && existsSync(this.socketFor(version));
  }

  status(): FpmStatus[] {
    return [...this.pools.values()].map((p) => ({
      version: p.php.version,
      running: Boolean(p.child) && existsSync(p.socket),
      sites: p.sites,
      error: p.error,
    }));
  }
}
