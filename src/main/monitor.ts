import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, statfsSync, writeFileSync } from 'node:fs';
import { cpus, loadavg, totalmem } from 'node:os';
import { join } from 'node:path';
import type { MonitorEntity, MonitorKind, MonitorPoint, MonitorRange, MonitorSnapshot, MonitorSystem, MonitorUpdate } from '@shared/types';
import { run } from './env';
import { dataDir, store } from './store';

/**
 * Resource use of everything DevCatz runs. Each sample takes one `ps` of the
 * whole Mac, walks every site's / service's process tree from its main pids
 * (the first tree to reach a pid owns it; what is left under DevCatz's own pid
 * is DevCatz itself), and turns cumulative counters into rates:
 *  - CPU: cpu-time delta / wall time (`ps -o time`),
 *  - memory: phys_footprint (Activity Monitor's "Memory"), RSS as fallback,
 *  - disk I/O: proc_pid_rusage via a tiny helper compiled once with clang,
 *  - network: `nettop -P -L 1` bytes in/out per process,
 *  - containers: `docker stats` when Docker runs.
 * An hour of points stays in memory; the page pushes updates while it is open.
 */

/** A site or service: its main pids and the folders whose size is shown. */
export interface MonitorTarget {
  id: string;
  kind: MonitorKind;
  name: string;
  detail: string;
  active: boolean;
  pids: number[];
  dataDirs: string[];
  /** The installed build (binaries), measured like dataDirs. */
  binDirs?: string[];
  /** Sites: the project folder (matches compose containers to their site; its size is not measured). */
  path?: string;
  link: MonitorEntity['link'];
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const BACKGROUND_S = 15;
const HISTORY_FILE = () => dataDir('monitor', 'history.json');

// proc_pid_rusage for every pid this user can see: pid, disk bytes read/written, physical footprint.
const HELPER_SOURCE = `#include <libproc.h>
#include <stdio.h>
#include <stdlib.h>
int main(void) {
  int n = proc_listallpids(NULL, 0);
  pid_t *pids = malloc(sizeof(pid_t) * (n + 256));
  n = proc_listallpids(pids, sizeof(pid_t) * (n + 256));
  for (int i = 0; i < n; i++) {
    struct rusage_info_v2 ri;
    if (proc_pid_rusage(pids[i], RUSAGE_INFO_V2, (rusage_info_t *)&ri) == 0)
      printf("%d %llu %llu %llu\\n", pids[i], ri.ri_diskio_bytesread, ri.ri_diskio_byteswritten, ri.ri_phys_footprint);
  }
  return 0;
}
`;

interface Proc {
  ppid: number;
  rss: number;
  cpuSec: number;
}

/** `ps -o time`: [[dd-]hh:]mm:ss.cc → seconds. */
function cpuSeconds(t: string): number {
  let days = 0;
  let rest = t;
  if (rest.includes('-')) {
    const [d, r] = rest.split('-');
    days = Number(d);
    rest = r;
  }
  const parts = rest.split(':').map(Number);
  let s = 0;
  for (const p of parts) s = s * 60 + p;
  return days * 86400 + s;
}

/** "12.3MiB" / "1.2kB" / "4GB" → bytes (docker stats). */
function dockerBytes(v: string): number {
  const m = v.trim().match(/^([\d.]+)\s*([kKMGT]?i?B)?$/);
  if (!m) return 0;
  const unit = (m[2] ?? 'B').replace('i', '').toUpperCase();
  const pow = { B: 0, KB: 1, MB: 2, GB: 3, TB: 4 }[unit] ?? 0;
  return Number(m[1]) * (m[2]?.includes('i') ? 1024 : 1000) ** pow;
}

export class Monitor {
  private timer: NodeJS.Timeout | null = null;
  private live = false;
  private running = false;
  private lastAt = 0;
  private prevCpu = new Map<number, number>();
  private prevDisk = new Map<number, [number, number]>();
  private prevNet = new Map<number, [number, number]>();
  private prevContainers = new Map<string, [number, number, number, number]>();
  private prevSysCpu: { idle: number; total: number } | null = null;
  private history = new Map<string, MonitorPoint[]>();
  private latest: MonitorUpdate | null = null;
  private helper: string | null | undefined;
  private helperHint: string | null = null;
  private diskSizes = new Map<string, { at: number; bytes: number }>();
  private sizing = new Set<string>();
  private dockerOk = false;
  private dockerCheckedAt = 0;
  private lastContainersAt = 0;
  private containers: MonitorEntity[] = [];
  private alerted = new Map<string, number>();
  /** Per-minute averages for 24 h (saved to disk), plus the minute being collected. */
  private long = new Map<string, MonitorPoint[]>();
  private minute = new Map<string, { t: number; sum: Omit<MonitorPoint, 't'>; n: number }>();
  private names = new Map<string, { name: string; kind: MonitorKind }>();
  private savedAt = 0;
  private sockets = new Map<number, { ports: Set<number>; conns: number }>();

  /** Updates go to the window while the page is open, and to the menu bar line. */
  onSample: (u: MonitorUpdate, live: boolean) => void = () => undefined;
  /** macOS notification (alerts). */
  notify: (title: string, body: string) => void = () => undefined;

  constructor(private targets: () => MonitorTarget[]) {}

  start(): void {
    if (!this.long.size) this.loadLong();
    this.schedule(1000);
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.saveLong();
  }

  // ------------------------------------------------------------------ 24 h history

  private loadLong(): void {
    try {
      const d = JSON.parse(readFileSync(HISTORY_FILE(), 'utf8')) as { names: Record<string, { name: string; kind: MonitorKind }>; long: Record<string, MonitorPoint[]> };
      const from = Date.now() - DAY;
      for (const [id, pts] of Object.entries(d.long ?? {})) {
        const keep = pts.filter((p) => p.t >= from);
        if (keep.length) this.long.set(id, keep);
      }
      for (const [id, n] of Object.entries(d.names ?? {})) this.names.set(id, n);
    } catch {
      /* first run */
    }
  }

  private saveLong(): void {
    try {
      mkdirSync(dataDir('monitor'), { recursive: true });
      const tmp = `${HISTORY_FILE()}.tmp`;
      writeFileSync(tmp, JSON.stringify({ v: 1, names: Object.fromEntries(this.names), long: Object.fromEntries(this.long) }));
      renameSync(tmp, HISTORY_FILE());
      this.savedAt = Date.now();
    } catch (err) {
      console.error('monitor history:', (err as Error).message);
    }
  }

  /** Adds a sample to its minute; a finished minute becomes one averaged point (24 h kept). */
  private addToMinute(id: string, p: MonitorPoint): void {
    const m = Math.floor(p.t / 60_000) * 60_000;
    const cur = this.minute.get(id);
    if (cur && cur.t !== m) {
      const n = cur.n;
      const pts = this.long.get(id) ?? [];
      pts.push({ t: cur.t, cpu: cur.sum.cpu / n, mem: cur.sum.mem / n, netIn: cur.sum.netIn / n, netOut: cur.sum.netOut / n, diskRead: cur.sum.diskRead / n, diskWrite: cur.sum.diskWrite / n });
      while (pts.length && pts[0].t < p.t - DAY) pts.shift();
      this.long.set(id, pts);
      this.minute.delete(id);
    }
    const next = this.minute.get(id) ?? { t: m, sum: { cpu: 0, mem: 0, netIn: 0, netOut: 0, diskRead: 0, diskWrite: 0 }, n: 0 };
    next.sum.cpu += p.cpu;
    next.sum.mem += p.mem;
    next.sum.netIn += p.netIn;
    next.sum.netOut += p.netOut;
    next.sum.diskRead += p.diskRead;
    next.sum.diskWrite += p.diskWrite;
    next.n++;
    this.minute.set(id, next);
  }

  /** 1 h: every sample; 6 h / 24 h: per-minute averages. */
  rangeHistory(range: MonitorRange): Record<string, MonitorPoint[]> {
    const out: Record<string, MonitorPoint[]> = {};
    if (range === '1h') {
      for (const [k, v] of this.history) out[k] = v;
      return out;
    }
    const from = Date.now() - (range === '6h' ? 6 : 24) * HOUR;
    for (const [k, v] of this.long) {
      const pts = v.filter((p) => p.t >= from);
      if (pts.length) out[k] = pts;
    }
    return out;
  }

  /** CSV of a range: one row per point and item. */
  csv(range: MonitorRange): string {
    const h = this.rangeHistory(range);
    const label = (id: string) => (id === 'system' ? { name: 'This Mac', kind: 'system' } : id === 'total' ? { name: 'All of DevCatz', kind: 'total' } : (this.names.get(id) ?? { name: id, kind: '' }));
    const q = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
    const rows = ['time,id,name,kind,cpu_percent,memory_bytes,net_in_bytes_per_s,net_out_bytes_per_s,disk_read_bytes_per_s,disk_write_bytes_per_s'];
    for (const [id, pts] of Object.entries(h)) {
      const l = label(id);
      for (const p of pts) {
        rows.push(
          [new Date(p.t).toISOString(), q(id), q(l.name), l.kind, p.cpu.toFixed(2), Math.round(p.mem), Math.round(p.netIn), Math.round(p.netOut), Math.round(p.diskRead), Math.round(p.diskWrite)].join(','),
        );
      }
    }
    return rows.join('\n') + '\n';
  }

  setLive(on: boolean): void {
    if (this.live === on) return;
    this.live = on;
    // Opening the page: a fresh sample right away.
    if (on) this.schedule(0);
  }

  private interval(): number {
    return this.live ? Math.max(1, Math.min(10, store.settings.monitorLiveInterval || 2)) : BACKGROUND_S;
  }

  private schedule(ms: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.tick(), ms);
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    // Closed page and no background sampling: idle until the page opens.
    if (!this.live && !store.settings.monitorBackground) {
      this.timer = null;
      return;
    }
    this.running = true;
    try {
      const u = await this.sample();
      this.latest = u;
      this.onSample(u, this.live);
      this.checkAlerts(u);
    } catch (err) {
      console.error('monitor:', (err as Error).message);
    } finally {
      this.running = false;
      this.schedule(this.interval() * 1000);
    }
  }

  async snapshot(): Promise<MonitorSnapshot> {
    if (!this.latest) this.latest = await this.sample();
    const history: Record<string, MonitorPoint[]> = {};
    for (const [k, v] of this.history) history[k] = v;
    return { ...this.latest, history };
  }

  // ------------------------------------------------------------------ helpers

  /** The disk I/O helper: compiled once into DevCatz's data folder (needs clang from the Command Line Tools). */
  private async ensureHelper(): Promise<string | null> {
    if (this.helper !== undefined) return this.helper;
    const hash = createHash('sha256').update(HELPER_SOURCE).digest('hex').slice(0, 12);
    const dir = dataDir('bin');
    const bin = join(dir, `devcatz-procstat-${hash}`);
    if (!existsSync(bin)) {
      mkdirSync(dir, { recursive: true });
      const src = join(dir, `devcatz-procstat-${hash}.c`);
      writeFileSync(src, HELPER_SOURCE);
      const r = await run('clang', ['-O2', '-o', bin, src], { timeout: 60_000 });
      if (r.code !== 0 || !existsSync(bin)) {
        this.helperHint = 'Disk I/O needs the Xcode Command Line Tools (clang) to build a small helper: run `xcode-select --install`.';
        this.helper = null;
        return null;
      }
    }
    this.helper = bin;
    return bin;
  }

  private async rusage(): Promise<Map<number, [number, number, number]>> {
    const out = new Map<number, [number, number, number]>();
    const bin = await this.ensureHelper();
    if (!bin) return out;
    const r = await run(bin, [], { timeout: 10_000 });
    for (const line of r.stdout.split('\n')) {
      const [pid, rd, wr, fp] = line.split(' ').map(Number);
      if (pid) out.set(pid, [rd, wr, fp]);
    }
    return out;
  }

  private async net(): Promise<Map<number, [number, number]>> {
    const out = new Map<number, [number, number]>();
    const r = await run('nettop', ['-P', '-L', '1', '-n', '-x', '-J', 'bytes_in,bytes_out'], { timeout: 10_000 });
    for (const line of r.stdout.split('\n')) {
      const m = line.match(/\.(\d+),(\d+),(\d+),?$/);
      if (m) out.set(Number(m[1]), [Number(m[2]), Number(m[3])]);
    }
    return out;
  }

  private async readSockets(): Promise<void> {
    const r = await run('lsof', ['-nP', '-iTCP', '-FpTn'], { timeout: 10_000 });
    const out = new Map<number, { ports: Set<number>; conns: number }>();
    let pid = 0;
    let name = '';
    for (const line of r.stdout.split('\n')) {
      if (line.startsWith('p')) {
        pid = Number(line.slice(1));
        if (!out.has(pid)) out.set(pid, { ports: new Set(), conns: 0 });
      } else if (line.startsWith('n')) name = line.slice(1);
      else if (line.startsWith('TST=')) {
        const s = out.get(pid);
        if (!s) continue;
        if (line === 'TST=LISTEN') {
          const port = Number(name.match(/:(\d+)$/)?.[1]);
          if (port) s.ports.add(port);
        } else if (line === 'TST=ESTABLISHED') s.conns++;
      }
    }
    this.sockets = out;
  }

  /** Data folder sizes, refreshed every 5 minutes in the background (du can take a while). */
  private sizeOf(dirs: string[]): number | null {
    if (!dirs.length) return null;
    let total = 0;
    let known = false;
    for (const d of dirs) {
      const hit = this.diskSizes.get(d);
      if (hit) {
        total += hit.bytes;
        known = true;
      }
      if ((!hit || Date.now() - hit.at > 300_000) && !this.sizing.has(d) && existsSync(d)) {
        this.sizing.add(d);
        void run('du', ['-sk', d], { timeout: 120_000 })
          .then((r) => {
            const kb = Number(r.stdout.trim().split(/\s+/)[0]);
            if (Number.isFinite(kb)) this.diskSizes.set(d, { at: Date.now(), bytes: kb * 1024 });
          })
          .finally(() => this.sizing.delete(d));
      }
    }
    return known ? total : null;
  }

  private async system(netIn: number, netOut: number): Promise<MonitorSystem> {
    const c = cpus();
    const idle = c.reduce((n, x) => n + x.times.idle, 0);
    const total = c.reduce((n, x) => n + x.times.idle + x.times.user + x.times.sys + x.times.nice + x.times.irq, 0);
    let cpu = 0;
    if (this.prevSysCpu && total > this.prevSysCpu.total) cpu = (1 - (idle - this.prevSysCpu.idle) / (total - this.prevSysCpu.total)) * 100;
    this.prevSysCpu = { idle, total };
    // Memory Used = app (anonymous) + wired + compressed, from vm_stat.
    const vm = (await run('vm_stat', [])).stdout;
    const page = Number(vm.match(/page size of (\d+)/)?.[1] ?? 16384);
    const pages = (label: string) => Number(vm.match(new RegExp(`${label}:\\s+(\\d+)`))?.[1] ?? 0);
    const memUsed = (pages('Anonymous pages') - pages('Pages purgeable') + pages('Pages wired down') + pages('Pages occupied by compressor')) * page;
    const sys = (await run('sysctl', ['-n', 'kern.memorystatus_vm_pressure_level', 'vm.swapusage'])).stdout.split('\n');
    const level = Number(sys[0]);
    const swapUsed = Number(sys[1]?.match(/used = ([\d.]+)M/)?.[1] ?? 0) * 1048576;
    let diskTotal = 0;
    let diskFree = 0;
    try {
      const fs = statfsSync('/System/Volumes/Data');
      diskTotal = fs.blocks * fs.bsize;
      diskFree = fs.bavail * fs.bsize;
    } catch {
      /* not on macOS 10.15+ layout */
    }
    const l = loadavg();
    return {
      cpu: Math.max(0, Math.min(100, cpu)),
      cores: c.length,
      load: [l[0], l[1], l[2]],
      memTotal: totalmem(),
      memUsed: Math.max(0, memUsed),
      memPressure: level === 1 ? 'normal' : level === 2 ? 'warn' : level === 4 ? 'critical' : null,
      swapUsed,
      diskTotal,
      diskFree,
      netIn,
      netOut,
    };
  }

  /** Containers of the sites (OrbStack / Docker), every ~10 s while the page is open. */
  private async dockerEntities(dt: number): Promise<MonitorEntity[]> {
    if (!this.live) return [];
    if (Date.now() - this.dockerCheckedAt > 60_000) {
      this.dockerCheckedAt = Date.now();
      this.dockerOk = (await run('docker', ['info', '--format', '{{.ServerVersion}}'], { timeout: 5000 })).code === 0;
    }
    if (!this.dockerOk) return [];
    if (Date.now() - this.lastContainersAt < 9000) return this.containers;
    const since = this.lastContainersAt ? (Date.now() - this.lastContainersAt) / 1000 : dt;
    this.lastContainersAt = Date.now();
    const [stats, ps] = await Promise.all([
      run('docker', ['stats', '--no-stream', '--format', '{{json .}}'], { timeout: 15_000 }),
      run('docker', ['ps', '--format', '{{.Names}}\t{{.Label "com.docker.compose.project"}}\t{{.Label "com.docker.compose.project.working_dir"}}'], { timeout: 10_000 }),
    ]);
    const project = new Map(ps.stdout.split('\n').filter(Boolean).map((l) => l.split('\t')).map(([n, p, dir]) => [n, { p, dir }]));
    const sites = this.targets().filter((t) => t.kind === 'site');
    const out: MonitorEntity[] = [];
    for (const line of stats.stdout.split('\n').filter(Boolean)) {
      try {
        const s = JSON.parse(line) as { Name: string; CPUPerc: string; MemUsage: string; NetIO: string; BlockIO: string };
        const [ni, no] = s.NetIO.split('/').map(dockerBytes);
        const [br, bw] = s.BlockIO.split('/').map(dockerBytes);
        const prev = this.prevContainers.get(s.Name);
        this.prevContainers.set(s.Name, [ni, no, br, bw]);
        const rate = (i: number, v: number) => (prev ? Math.max(0, (v - prev[i]) / since) : 0);
        const info = project.get(s.Name);
        const site = info?.dir ? sites.find((t) => t.path && (info.dir === t.path || info.dir.startsWith(`${t.path}/`))) : undefined;
        out.push({
          id: `container:${s.Name}`,
          kind: 'container',
          name: s.Name,
          detail: [info?.p ? `compose ${info.p}` : null, site ? site.name : null].filter(Boolean).join(' · '),
          active: true,
          processes: 1,
          cpu: Number(s.CPUPerc.replace('%', '')) || 0,
          mem: dockerBytes(s.MemUsage.split('/')[0]),
          netIn: rate(0, ni),
          netOut: rate(1, no),
          diskRead: rate(2, br),
          diskWrite: rate(3, bw),
          disk: null,
          binaries: null,
          ports: [],
          connections: 0,
          link: site?.link ?? null,
        });
      } catch {
        /* not JSON */
      }
    }
    this.containers = out;
    return out;
  }

  // ------------------------------------------------------------------ sample

  private async sample(): Promise<MonitorUpdate> {
    const now = Date.now();
    const dt = this.lastAt ? Math.max(0.2, (now - this.lastAt) / 1000) : 0;
    this.lastAt = now;
    const [ps, ru, net] = await Promise.all([
      run('ps', ['-A', '-o', 'pid=,ppid=,rss=,time='], { timeout: 10_000 }),
      this.rusage(),
      this.net().catch(() => new Map<number, [number, number]>()),
      // Listening ports and open connections per pid: only while the page shows them.
      this.live ? this.readSockets().catch(() => undefined) : Promise.resolve(),
    ]);
    const procs = new Map<number, Proc>();
    const children = new Map<number, number[]>();
    for (const line of ps.stdout.split('\n')) {
      const [pid, ppid, rss, time] = line.trim().split(/\s+/);
      if (!pid || !time) continue;
      const p = Number(pid);
      procs.set(p, { ppid: Number(ppid), rss: Number(rss) * 1024, cpuSec: cpuSeconds(time) });
      if (!children.has(Number(ppid))) children.set(Number(ppid), []);
      children.get(Number(ppid))!.push(p);
    }

    // Per-pid rates.
    const rate = new Map<number, Omit<MonitorPoint, 't'>>();
    for (const [pid, p] of procs) {
      const prevCpu = this.prevCpu.get(pid);
      const d = ru.get(pid);
      const prevDisk = this.prevDisk.get(pid);
      const n = net.get(pid);
      const prevNet = this.prevNet.get(pid);
      rate.set(pid, {
        cpu: dt && prevCpu !== undefined ? Math.max(0, ((p.cpuSec - prevCpu) / dt) * 100) : 0,
        mem: d?.[2] || p.rss,
        diskRead: dt && d && prevDisk ? Math.max(0, (d[0] - prevDisk[0]) / dt) : 0,
        diskWrite: dt && d && prevDisk ? Math.max(0, (d[1] - prevDisk[1]) / dt) : 0,
        netIn: dt && n && prevNet ? Math.max(0, (n[0] - prevNet[0]) / dt) : 0,
        netOut: dt && n && prevNet ? Math.max(0, (n[1] - prevNet[1]) / dt) : 0,
      });
    }
    this.prevCpu = new Map([...procs].map(([pid, p]) => [pid, p.cpuSec]));
    this.prevDisk = new Map([...ru].map(([pid, d]) => [pid, [d[0], d[1]]]));
    this.prevNet = net;

    // Trees: the first target to reach a pid owns it.
    const owner = new Map<number, string>();
    const claim = (root: number, id: string) => {
      const stack = [root];
      while (stack.length) {
        const pid = stack.pop()!;
        if (owner.has(pid) || !procs.has(pid)) continue;
        owner.set(pid, id);
        stack.push(...(children.get(pid) ?? []));
      }
    };
    const targets = this.targets();
    for (const t of targets) for (const pid of t.pids) claim(pid, t.id);
    claim(process.pid, 'devcatz');

    const sums = new Map<string, Omit<MonitorPoint, 't'> & { processes: number }>();
    const sock = new Map<string, { ports: Set<number>; conns: number }>();
    for (const [pid, id] of owner) {
      const so = this.sockets.get(pid);
      if (so) {
        const acc = sock.get(id) ?? { ports: new Set<number>(), conns: 0 };
        for (const p of so.ports) acc.ports.add(p);
        acc.conns += so.conns;
        sock.set(id, acc);
      }
      const r = rate.get(pid)!;
      const s = sums.get(id) ?? { cpu: 0, mem: 0, netIn: 0, netOut: 0, diskRead: 0, diskWrite: 0, processes: 0 };
      s.cpu += r.cpu;
      s.mem += r.mem;
      s.netIn += r.netIn;
      s.netOut += r.netOut;
      s.diskRead += r.diskRead;
      s.diskWrite += r.diskWrite;
      s.processes++;
      sums.set(id, s);
    }
    const zero = { cpu: 0, mem: 0, netIn: 0, netOut: 0, diskRead: 0, diskWrite: 0, processes: 0 };
    const entities: MonitorEntity[] = targets.map((t) => ({
      id: t.id,
      kind: t.kind,
      name: t.name,
      detail: t.detail,
      active: t.active || Boolean(sums.get(t.id)?.processes),
      ...(sums.get(t.id) ?? zero),
      disk: this.sizeOf(t.dataDirs),
      binaries: t.binDirs?.length ? this.sizeOf(t.binDirs) : null,
      ports: [...(sock.get(t.id)?.ports ?? [])].sort((a, b) => a - b),
      connections: sock.get(t.id)?.conns ?? 0,
      link: t.link,
    }));
    entities.push({
      id: 'devcatz',
      kind: 'devcatz',
      name: 'DevCatz',
      detail: 'App, proxy and DNS',
      active: true,
      ...(sums.get('devcatz') ?? zero),
      disk: this.sizeOf([dataDir()]),
      binaries: null,
      ports: [...(sock.get('devcatz')?.ports ?? [])].sort((a, b) => a - b),
      connections: sock.get('devcatz')?.conns ?? 0,
      link: null,
    });
    entities.push(...(await this.dockerEntities(dt || BACKGROUND_S).catch(() => [])));

    let netIn = 0;
    let netOut = 0;
    for (const [pid] of net) {
      const r = rate.get(pid);
      if (r) {
        netIn += r.netIn;
        netOut += r.netOut;
      }
    }
    const system = await this.system(netIn, netOut);
    const total: MonitorPoint = { t: now, cpu: 0, mem: 0, netIn: 0, netOut: 0, diskRead: 0, diskWrite: 0 };
    for (const e of entities) {
      total.cpu += e.cpu;
      total.mem += e.mem;
      total.netIn += e.netIn;
      total.netOut += e.netOut;
      total.diskRead += e.diskRead;
      total.diskWrite += e.diskWrite;
    }

    // History (an hour), skipping the very first sample (no rates yet).
    if (dt) {
      const push = (id: string, p: MonitorPoint) => {
        const h = this.history.get(id) ?? [];
        h.push(p);
        while (h.length && h[0].t < now - HOUR) h.shift();
        this.history.set(id, h);
      };
      for (const e of entities) {
        const pt = { t: now, cpu: e.cpu, mem: e.mem, netIn: e.netIn, netOut: e.netOut, diskRead: e.diskRead, diskWrite: e.diskWrite };
        push(e.id, pt);
        // Stopped items would only add zeros to the 24 h file.
        if (!e.active) continue;
        this.addToMinute(e.id, pt);
        this.names.set(e.id, { name: e.name, kind: e.kind });
      }
      const sysPt = { t: now, cpu: system.cpu, mem: system.memUsed, netIn: system.netIn, netOut: system.netOut, diskRead: 0, diskWrite: 0 };
      push('total', total);
      push('system', sysPt);
      this.addToMinute('total', total);
      this.addToMinute('system', sysPt);
      // The 24 h file every 5 minutes (and when DevCatz quits).
      if (now - this.savedAt > 300_000) this.saveLong();
      // Ids that disappeared long ago.
      for (const [id, h] of this.history) if (!h.length || h.at(-1)!.t < now - HOUR) this.history.delete(id);
    }

    return {
      at: now,
      interval: this.interval(),
      system,
      total,
      entities,
      capabilities: { blockIo: Boolean(this.helper), net: net.size > 0, docker: this.dockerOk, blockIoHint: this.helperHint },
    };
  }

  // ------------------------------------------------------------------ alerts

  /** Sustained high CPU / memory over the last N minutes, and a low disk; each alert at most once an hour. */
  private checkAlerts(u: MonitorUpdate): void {
    const s = store.settings;
    if (!s.monitorAlerts) return;
    const span = Math.max(1, s.monitorAlertMinutes) * 60_000;
    const once = (key: string, every: number, title: string, body: string) => {
      const last = this.alerted.get(key) ?? 0;
      if (Date.now() - last < every) return;
      this.alerted.set(key, Date.now());
      this.notify(title, body);
    };
    for (const e of u.entities) {
      const h = this.history.get(e.id) ?? [];
      const recent = h.filter((p) => p.t >= u.at - span);
      // Enough points to cover the span (allowing for the first gap).
      if (!recent.length || recent[0].t > u.at - span + u.interval * 2000) continue;
      if (recent.every((p) => p.cpu >= s.monitorCpuAlert))
        once(`cpu:${e.id}`, HOUR, `${e.name} is busy`, `Above ${s.monitorCpuAlert}% CPU for ${s.monitorAlertMinutes} min (now ${Math.round(e.cpu)}%).`);
      if (recent.every((p) => p.mem >= s.monitorMemAlertMb * 1048576))
        once(`mem:${e.id}`, HOUR, `${e.name} uses a lot of memory`, `Above ${s.monitorMemAlertMb} MB for ${s.monitorAlertMinutes} min (now ${Math.round(e.mem / 1048576)} MB).`);
    }
    if (u.system.diskTotal && u.system.diskFree < s.monitorDiskAlertGb * 1073741824)
      once('disk', 6 * HOUR, 'Disk almost full', `${(u.system.diskFree / 1073741824).toFixed(1)} GB free on this Mac.`);
  }
}
