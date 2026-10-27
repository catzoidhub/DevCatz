import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { readFileSync, writeFileSync } from 'node:fs';
import { getShellEnv, run } from './env';
import { isWin, killTree, shellCommand } from './platform';
import { dataDir } from './store';
import type { LogLine, ProcessStatus } from '@shared/types';

const MAX_LINES = 5000;
const STOP_GRACE_MS = 5000;

/** One command of a site: the whole dev command, or one app of a monorepo. */
export interface ProcessSpec {
  /** Prefix for log lines when a site runs several processes (e.g. `web`). */
  label: string;
  cwd: string;
  command: string;
  env: Record<string, string>;
  /** Signal for a graceful stop (PostgreSQL: SIGINT = fast shutdown). Default SIGTERM. */
  stopSignal?: NodeJS.Signals;
  /**
   * Signal only the main process, not its group or children: database servers
   * shut their workers down themselves (signalling a PostgreSQL worker directly
   * makes the postmaster assume a crash).
   */
  leaderOnly?: boolean;
}

interface Child {
  label: string;
  spec: ProcessSpec;
  child: ChildProcess;
  exited: boolean;
  code: number | null;
  /** Being restarted on its own (restartChild): its exit is expected. */
  restarting?: boolean;
}

interface Managed {
  children: Child[];
  stopping: Promise<void> | null;
}

/**
 * Runs each site's dev command(s) in their own process groups (detached), so
 * a whole tree — `bun run --filter` → nuxt → vite workers — can be signalled
 * at once. A site may run several processes (one per monorepo app, each with
 * its own PORT). Output is kept in a per-site ring buffer and streamed as events.
 */
export class ProcessManager extends EventEmitter {
  private procs = new Map<string, Managed>();
  private logs = new Map<string, LogLine[]>();
  private status = new Map<string, { status: ProcessStatus; exitCode: number | null }>();
  private pidFile: string;

  private graceMs: number;

  /** `pidName`: each manager (sites, storage services) keeps its own orphan list. `graceMs`: wait before SIGKILL on stop. */
  constructor(pidName = 'pids.json', graceMs = STOP_GRACE_MS) {
    super();
    this.pidFile = dataDir(pidName);
    this.graceMs = graceMs;
  }

  getStatus(id: string): { status: ProcessStatus; exitCode: number | null } {
    return this.status.get(id) ?? { status: 'stopped', exitCode: null };
  }

  getLogs(id: string): LogLine[] {
    return this.logs.get(id) ?? [];
  }

  clearLogs(id: string): void {
    this.logs.set(id, []);
  }

  log(projectId: string, stream: LogLine['stream'], text: string): void {
    const buf = this.logs.get(projectId) ?? [];
    const lines = text.replace(/\r\n/g, '\n').split('\n');
    if (lines.at(-1) === '') lines.pop();
    const out: LogLine[] = [];
    for (const line of lines) {
      // Progress bars redraw with \r; keep only the final frame.
      const l = { projectId, stream, text: line.split('\r').filter(Boolean).at(-1) ?? '', time: Date.now() };
      buf.push(l);
      out.push(l);
    }
    if (buf.length > MAX_LINES) buf.splice(0, buf.length - MAX_LINES);
    this.logs.set(projectId, buf);
    this.emit('log', out);
  }

  private setStatus(id: string, status: ProcessStatus, exitCode: number | null = null): void {
    this.status.set(id, { status, exitCode });
    this.emit('status', id);
  }

  /** Main pids of `id`'s live processes (their trees are walked by the monitor). */
  pidsOf(id: string): number[] {
    return (this.procs.get(id)?.children ?? []).filter((c) => !c.exited && c.child.pid).map((c) => c.child.pid!);
  }

  markRunning(id: string): void {
    if (this.getStatus(id).status === 'starting') this.setStatus(id, 'running');
  }

  isActive(id: string): boolean {
    const s = this.getStatus(id).status;
    return s === 'starting' || s === 'running';
  }

  start(id: string, cwd: string, command: string, extraEnv: Record<string, string> = {}): void {
    this.startMany(id, [{ label: '', cwd, command, env: extraEnv }]);
  }

  startMany(id: string, specs: ProcessSpec[]): void {
    if (this.procs.has(id) || !specs.length) return;
    const managed: Managed = { children: [], stopping: null };
    this.procs.set(id, managed);
    this.setStatus(id, 'starting');
    for (const spec of specs) this.spawnChild(id, managed, spec);
    this.savePids();
  }

  /** One process of a site, in its own group; its exit settles the site's status once every process is gone. */
  private spawnChild(id: string, managed: Managed, spec: ProcessSpec): void {
    const prefix = spec.label ? `[${spec.label}] ` : '';
    const tag = (text: string) => (prefix ? text.replace(/^(?=.)/gm, prefix) : text);
    this.log(id, 'sys', `${prefix}$ ${spec.command}${spec.label ? `  (in ${spec.cwd})` : ''}`);
    const [file, args] = shellCommand(spec.command, { exec: true });
    const child = spawn(file, args, {
      cwd: spec.cwd,
      // macOS: its own process group, stopped as a whole; Windows: taskkill /T follows the tree instead.
      detached: !isWin,
      windowsHide: true,
      windowsVerbatimArguments: isWin,
      env: { ...getShellEnv(), FORCE_COLOR: '1', BROWSER: 'none', ...spec.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const entry: Child = { label: spec.label, spec, child, exited: false, code: null };
    managed.children.push(entry);
    child.stdout?.on('data', (d: Buffer) => this.log(id, 'out', tag(d.toString())));
    child.stderr?.on('data', (d: Buffer) => this.log(id, 'err', tag(d.toString())));
    child.on('error', (err) => this.log(id, 'sys', `${prefix}Failed to start: ${err.message}`));
    child.on('exit', (code, signal) => {
      entry.exited = true;
      entry.code = code;
      this.savePids();
      this.log(id, 'sys', `${prefix}Process exited (${signal ?? `code ${code}`})`);
      // Children that ignored the group signal or re-parented themselves.
      if (child.pid) killGroup(child.pid, 'SIGKILL');
      if (managed.children.every((c) => c.exited)) {
        this.procs.delete(id);
        const expected = managed.stopping !== null;
        const failed = managed.children.find((c) => c.code !== 0 && c.code !== null);
        this.setStatus(id, expected || !failed ? 'stopped' : 'crashed', failed?.code ?? code);
      } else if (managed.stopping === null && code !== 0 && !entry.restarting) {
        this.log(id, 'sys', `${prefix}stopped while the rest of the site keeps running; restart it from Overview → Apps (or restart the site).`);
      }
    });
  }

  /** Labels of a site's processes (one per app when it runs several), with whether each is still up. */
  childrenOf(id: string): { label: string; running: boolean }[] {
    return (this.procs.get(id)?.children ?? []).filter((c) => c.label).map((c) => ({ label: c.label, running: !c.exited }));
  }

  /**
   * Restarts one process of a running site (one app of a monorepo / folder project): stops its group, waits, starts
   * the same command again; the other apps keep running.
   */
  async restartChild(id: string, label: string): Promise<void> {
    const managed = this.procs.get(id);
    if (!managed || managed.stopping) throw new Error('The site is not running');
    const i = managed.children.findIndex((c) => c.label === label);
    if (i < 0) throw new Error(`No process ${label}`);
    const old = managed.children[i];
    if (!old.exited && old.child.pid) {
      this.log(id, 'sys', `[${label}] Restarting…`);
      old.restarting = true;
      // Taken out first, so its exit does not end the site.
      managed.children.splice(i, 1);
      const tree = await descendants(old.child.pid);
      killGroup(old.child.pid, old.spec.stopSignal ?? 'SIGTERM');
      for (const p of tree) safeKill(p, 'SIGTERM');
      if (!(await waitForExit(old.child, this.graceMs))) killGroup(old.child.pid, 'SIGKILL');
      for (const p of tree) safeKill(p, 'SIGKILL');
    } else managed.children.splice(i, 1);
    this.spawnChild(id, managed, old.spec);
    this.savePids();
    this.emit('status', id);
  }

  stop(id: string): Promise<void> {
    const managed = this.procs.get(id);
    if (!managed) return Promise.resolve();
    if (managed.stopping) return managed.stopping;
    this.setStatus(id, 'stopping');
    this.log(id, 'sys', 'Stopping…');
    managed.stopping = (async () => {
      const alive = managed.children.filter((c) => !c.exited && c.child.pid);
      const trees = await Promise.all(alive.map((c) => descendants(c.child.pid!)));
      alive.forEach((c, i) => {
        const sig = c.spec.stopSignal ?? 'SIGTERM';
        if (c.spec.leaderOnly) return safeKill(c.child.pid!, sig);
        killGroup(c.child.pid!, sig);
        for (const p of trees[i]) safeKill(p, 'SIGTERM');
      });
      const exited = await Promise.all(alive.map((c) => waitForExit(c.child, this.graceMs)));
      alive.forEach((c, i) => {
        if (!exited[i]) {
          this.log(id, 'sys', `${c.label ? `[${c.label}] ` : ''}Still running after ${Math.round(this.graceMs / 1000)}s, sending SIGKILL`);
          killGroup(c.child.pid!, 'SIGKILL');
        }
        // Make sure no stragglers survive.
        for (const p of trees[i]) safeKill(p, 'SIGKILL');
      });
      await Promise.all(alive.map((c) => waitForExit(c.child, 2000)));
    })();
    return managed.stopping;
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.procs.keys()].map((id) => this.stop(id)));
  }

  /** Records process-group ids so a crash of DevCatz does not leave orphans forever. */
  private savePids(): void {
    const pids = [...this.procs.values()].flatMap((m) => m.children.filter((c) => !c.exited).map((c) => c.child.pid)).filter(Boolean);
    try {
      writeFileSync(this.pidFile, JSON.stringify(pids));
    } catch {
      /* not fatal */
    }
  }

  /** Kills process groups left over by a previous run that did not shut down cleanly. */
  async reapOrphans(): Promise<number> {
    let pids: number[] = [];
    try {
      pids = JSON.parse(readFileSync(this.pidFile, 'utf8'));
    } catch {
      return 0;
    }
    let killed = 0;
    const live = new Set<number>();
    if (isWin) {
      for (const pid of pids) {
        try {
          process.kill(pid, 0);
          live.add(pid);
        } catch {
          /* gone */
        }
      }
    } else {
      const { stdout } = await run('ps', ['-A', '-o', 'pgid=']);
      for (const l of stdout.split('\n')) live.add(Number(l.trim()));
    }
    for (const pgid of pids) {
      if (live.has(pgid)) {
        killGroup(pgid, 'SIGTERM');
        killed++;
      }
    }
    this.savePids();
    return killed;
  }
}

function safeKill(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch {
    /* already gone */
  }
}

function killGroup(pgid: number, signal: NodeJS.Signals): void {
  if (isWin) killTree(pgid, signal);
  else safeKill(-pgid, signal);
}

/** All descendants of pid (some tools start children in a new process group). */
async function descendants(pid: number): Promise<number[]> {
  // Windows: taskkill /T already ends the whole tree.
  if (isWin) return [];
  const { stdout } = await run('ps', ['-A', '-o', 'pid=,ppid=']);
  const children = new Map<number, number[]>();
  for (const line of stdout.split('\n')) {
    const [p, pp] = line.trim().split(/\s+/).map(Number);
    if (!p) continue;
    if (!children.has(pp)) children.set(pp, []);
    children.get(pp)!.push(p);
  }
  const out: number[] = [];
  const queue = [pid];
  while (queue.length) {
    const next = queue.shift()!;
    for (const c of children.get(next) ?? []) {
      out.push(c);
      queue.push(c);
    }
  }
  return out;
}

function waitForExit(child: ChildProcess, ms: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}
