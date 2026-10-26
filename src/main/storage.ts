import { rm } from 'node:fs/promises';
import { brewLatest, isNewer, UPDATE_TAIL, upgradeBinaries } from './svcupdate';
import { appendFileSync, chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { release } from 'node:os';
import { dirname, join } from 'node:path';
import type { LogLine, StorageAction, StorageConfig, StorageKind, StorageState, TaskProgress } from '@shared/types';
import { downloadVerified } from './download';
import { isPortOpen, portOwner, run } from './env';
import { ProcessManager } from './processes';
import type { Route } from './proxy';
import { dataDir, store, tld } from './store';

/**
 * Local S3-compatible object storage, one instance per kind: RustFS, MinIO and
 * SeaweedFS. Official builds are downloaded and checksum-verified into
 * <userData>/storage/<kind>/bin, run as managed processes (own process
 * manager, so "Stop All" for sites leaves them alone) and served on HTTPS
 * domains through the proxy (Host kept: S3 signatures include it).
 */
export const STORAGE_KINDS: StorageKind[] = ['rustfs', 'minio', 'seaweedfs'];

interface Engine {
  name: string;
  exe: string;
  /** Console page below the console port's root, if any. */
  consolePath?: string;
  description: string;
  defaults: Omit<StorageConfig, 'kind' | 'dataDir' | 'binaryPath' | 'binaryDir' | 'autoStart' | 'region'>;
  /** Downloads the binary into the folder `dir` (as `dir/<exe>`); throws on checksum/version problems. */
  install(dir: string, progress: Report, signal: AbortSignal): Promise<void>;
  /** Newest release, from the installer's source (update check). */
  latest(): Promise<string>;
  /** Process specs to run (SeaweedFS needs two). */
  specs(c: StorageConfig, bin: string): { label: string; command: string; env: Record<string, string> }[];
}

/** Updates the running task (merged into the current TaskProgress). */
type Report = (p: Partial<TaskProgress>) => void;

/** Install steps; indexes are used by installFrom and StorageManager.install. */
export const INSTALL_STEPS = [
  'Finding the latest release',
  'Downloading',
  'Verifying the checksum',
  'Unpacking',
  'Installing the binary',
  'Checking the version',
  'Preparing the data folder',
  'Saving settings',
];
const S = { find: 0, download: 1, verify: 2, unpack: 3, place: 4, version: 5, data: 6, save: 7 } as const;

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const host = (label: string) => `${label}.${tld()}`;

/** GitHub release asset with its published SHA-256 digest. */
export async function githubAsset(repo: string, match: RegExp): Promise<{ url: string; sha256: string; tag: string }> {
  const res = await fetch(`https://api.github.com/repos/${repo}/releases?per_page=10`, { headers: { Accept: 'application/vnd.github+json' } });
  if (!res.ok) throw new Error(`GitHub: HTTP ${res.status}${res.status === 403 ? ' (rate limit, try again later)' : ''}`);
  const releases = (await res.json()) as { tag_name: string; prerelease: boolean; draft: boolean; assets: { name: string; browser_download_url: string; digest?: string }[] }[];
  for (const r of releases) {
    if (r.prerelease || r.draft) continue;
    const a = r.assets.find((x) => match.test(x.name));
    if (a?.digest?.startsWith('sha256:')) return { url: a.browser_download_url, sha256: a.digest.slice(7), tag: r.tag_name };
  }
  throw new Error(`No macOS build with a checksum found in ${repo} releases`);
}

async function unpack(archive: string, into: string): Promise<void> {
  mkdirSync(into, { recursive: true });
  const r = archive.endsWith('.zip')
    ? await run('ditto', ['-x', '-k', archive, into], { timeout: 300_000 })
    : await run('tar', ['-xf', archive, '-C', into], { timeout: 300_000 }); // bsdtar detects gzip / xz by content
  if (r.code !== 0) throw new Error(`Unpacking failed: ${r.stderr.trim()}`);
}

/** Finds `exe` anywhere below `dir` (archives nest it differently). */
function findExe(dir: string, exe: string): string | null {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    const st = statSync(p);
    if (st.isFile() && e === exe) return p;
    if (st.isDirectory()) {
      const f = findExe(p, exe);
      if (f) return f;
    }
  }
  return null;
}

/** Thrown between steps once the user cancelled. */
export class Cancelled extends Error {
  constructor() {
    super('Cancelled');
  }
}
export const check = (signal: AbortSignal) => {
  if (signal.aborted) throw new Cancelled();
};

export async function installFrom(
  url: string,
  sha256: string,
  dir: string,
  exe: string,
  label: string,
  progress: Report,
  signal: AbortSignal,
  headers?: Record<string, string>,
) {
  progress({ title: `Installing ${label}` });
  // Unpack next to DevCatz's data (the target folder may be on another volume).
  const tmp = join(dataDir('storage'), `.tmp-${exe}-${Date.now()}`);
  mkdirSync(tmp, { recursive: true });
  try {
    const archive = join(tmp, url.endsWith('.zip') ? 'pkg.zip' : 'pkg.tar.gz');
    const file = decodeURIComponent(url.split('/').pop() ?? '').replace(/^sha256:/, 'sha256:');
    progress({ step: S.download, received: 0, total: 0, detail: url.includes('ghcr.io') ? `Homebrew bottle (${label})` : file });
    // The hash is computed while downloading; the comparison happens at the end (Verifying).
    const digest = await downloadVerified(url, archive, '', (received, total) => progress({ step: S.download, received, total }), headers, signal).catch((e) => {
      throw signal.aborted ? new Cancelled() : e;
    });
    check(signal);
    progress({ step: S.verify, received: undefined, total: undefined, detail: `SHA-256 ${digest.slice(0, 16)}…` });
    if (digest !== sha256) throw new Error(`Checksum mismatch (expected ${sha256.slice(0, 12)}…, got ${digest.slice(0, 12)}…); download discarded`);
    progress({ step: S.unpack, detail: url.endsWith('.zip') ? 'zip archive' : 'tar.gz archive' });
    await unpack(archive, join(tmp, 'x'));
    check(signal);
    const found = findExe(join(tmp, 'x'), exe);
    if (!found) throw new Error(`${exe} not found in the download`);
    chmodSync(found, 0o755);
    // Downloaded with fetch, so no quarantine flag; clear it anyway in case.
    await run('xattr', ['-dr', 'com.apple.quarantine', found]);
    const dest = join(dir, exe);
    check(signal);
    progress({ step: S.place, detail: dest });
    mkdirSync(dir, { recursive: true });
    try {
      renameSync(found, dest);
    } catch {
      copyFileSync(found, dest);
      chmodSync(dest, 0o755);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** Homebrew bottle tag for this macOS (MinIO only ships through Homebrew now). */
function bottleTag(files: Record<string, unknown>): string {
  const major = Number(release().split('.')[0]); // Darwin 25 = macOS 26
  const byDarwin: Record<number, string> = { 25: 'tahoe', 24: 'sequoia', 23: 'sonoma', 26: 'golden_gate' };
  const arch = process.arch === 'arm64' ? 'arm64_' : '';
  const want = `${arch}${byDarwin[major] ?? 'tahoe'}`;
  if (want in files) return want;
  const any = Object.keys(files).find((k) => (process.arch === 'arm64' ? k.startsWith('arm64_') : !k.includes('_')) && !k.includes('linux'));
  if (!any) throw new Error('No MinIO build for this Mac');
  return any;
}

export const ENGINES: Record<StorageKind, Engine> = {
  rustfs: {
    name: 'RustFS',
    exe: 'rustfs',
    consolePath: '/rustfs/console/',
    description: 'Fast S3-compatible storage written in Rust; Apache 2.0, built-in web console.',
    defaults: { apiPort: 9000, consolePort: 9001, apiDomain: 'rustfs', consoleDomain: 'console.rustfs', accessKey: 'rustfsadmin', secretKey: 'rustfsadmin' },
    latest: async () => (await githubAsset('rustfs/rustfs', process.arch === 'arm64' ? /^rustfs-macos-aarch64-v[\d.]+\.zip$/ : /^rustfs-macos-x86_64-v[\d.]+\.zip$/)).tag.replace(/^v/, ''),
    async install(dir, progress, signal) {
      progress({ step: S.find, detail: 'github.com/rustfs/rustfs releases' });
      const a = await githubAsset('rustfs/rustfs', process.arch === 'arm64' ? /^rustfs-macos-aarch64-v[\d.]+\.zip$/ : /^rustfs-macos-x86_64-v[\d.]+\.zip$/);
      check(signal);
      await installFrom(a.url, a.sha256, dir, 'rustfs', `RustFS ${a.tag}`, progress, signal);
    },
    specs: (c, bin) => [
      {
        label: '',
        command: `${q(bin)} server --address 127.0.0.1:${c.apiPort} --console-enable --console-address 127.0.0.1:${c.consolePort} --server-domains ${q(host(c.apiDomain))} ${rustfsVolume(c.dataDir)}`,
        env: { RUSTFS_ACCESS_KEY: c.accessKey, RUSTFS_SECRET_KEY: c.secretKey, RUSTFS_REGION: s3Region(c) },
      },
    ],
  },
  minio: {
    name: 'MinIO',
    exe: 'minio',
    description: 'The classic S3 server. Last community release (2025-10, upstream archived), from Homebrew’s build.',
    defaults: { apiPort: 9010, consolePort: 9011, apiDomain: 'minio', consoleDomain: 'console.minio', accessKey: 'minioadmin', secretKey: 'minioadmin' },
    latest: () => brewLatest('minio'),
    async install(dir, progress, signal) {
      // MinIO stopped publishing binaries (dl.min.io answers 410); the last community release ships as a Homebrew bottle.
      progress({ step: S.find, detail: 'formulae.brew.sh (Homebrew’s MinIO bottle)' });
      const res = await fetch('https://formulae.brew.sh/api/formula/minio.json');
      if (!res.ok) throw new Error(`formulae.brew.sh: HTTP ${res.status}`);
      const f = (await res.json()) as { versions: { stable: string }; bottle: { stable: { files: Record<string, { url: string; sha256: string }> } } };
      const files = f.bottle.stable.files;
      const file = files[bottleTag(files)];
      // ghcr.io serves Homebrew's public bottles with this anonymous token.
      check(signal);
      await installFrom(file.url, file.sha256, dir, 'minio', `MinIO ${f.versions.stable}`, progress, signal, { Authorization: 'Bearer QQ==' });
    },
    specs: (c, bin) => [
      {
        label: '',
        command: `${q(bin)} server ${q(c.dataDir)} --address 127.0.0.1:${c.apiPort} --console-address 127.0.0.1:${c.consolePort}`,
        env: {
          MINIO_ROOT_USER: c.accessKey,
          MINIO_ROOT_PASSWORD: c.secretKey,
          // bucket.minio.localhost (virtual-hosted style) and console links through the proxy.
          MINIO_DOMAIN: host(c.apiDomain),
          MINIO_BROWSER_REDIRECT_URL: `https://${host(c.consoleDomain)}`,
          MINIO_UPDATE: 'off',
          MINIO_REGION: s3Region(c),
        },
      },
    ],
  },
  seaweedfs: {
    name: 'SeaweedFS',
    exe: 'weed',
    description: 'Distributed file system with an S3 gateway and an admin UI; master, volume and filer in one process.',
    defaults: { apiPort: 8333, consolePort: 23646, apiDomain: 'seaweedfs', consoleDomain: 'console.seaweedfs', accessKey: 'devcatz', secretKey: 'devcatz-secret' },
    latest: async () => (await githubAsset('seaweedfs/seaweedfs', process.arch === 'arm64' ? /^darwin_arm64\.tar\.gz$/ : /^darwin_amd64\.tar\.gz$/)).tag.replace(/^v/, ''),
    async install(dir, progress, signal) {
      progress({ step: S.find, detail: 'github.com/seaweedfs/seaweedfs releases' });
      const a = await githubAsset('seaweedfs/seaweedfs', process.arch === 'arm64' ? /^darwin_arm64\.tar\.gz$/ : /^darwin_amd64\.tar\.gz$/);
      check(signal);
      await installFrom(a.url, a.sha256, dir, 'weed', `SeaweedFS ${a.tag}`, progress, signal);
    },
    specs: (c, bin) => {
      const p = seaweedPorts(c);
      return [
        {
          label: 'server',
          command:
            `${q(bin)} server -dir=${q(c.dataDir)} -ip=127.0.0.1 -ip.bind=127.0.0.1 -master.port=${p.master} -volume.port=${p.volume} ` +
            `-filer -filer.port=${p.filer} -s3 -s3.port=${c.apiPort} -s3.config=${q(seaweedConfig(c))}`,
          env: {},
        },
        {
          label: 'admin',
          command: `${q(bin)} admin -port=${c.consolePort} -ip=127.0.0.1 -masters=127.0.0.1:${p.master} -adminUser=${q(c.accessKey)} -adminPassword=${q(c.secretKey)} -dataDir=${q(join(c.dataDir, '.admin'))}`,
          env: {},
        },
      ];
    },
  },
};

/**
 * RustFS (1.0.x) cannot open a volume whose path contains whitespace (VolumeNotFound),
 * and DevCatz's default lives in "Application Support". The process runs with
 * cwd = the data folder, so `.` names the same folder without the space.
 */
const rustfsVolume = (dir: string) => (/\s/.test(dir) ? '.' : q(dir));

/** SeaweedFS's master / volume / filer ports, derived from the S3 port (gRPC = +10000). */
export function seaweedPorts(c: StorageConfig): Record<string, number> {
  return { master: c.apiPort + 1000, volume: c.apiPort + 2, filer: c.apiPort + 3 };
}

/** Identity file for SeaweedFS's S3 gateway: the admin keys, plus anonymous read on public buckets. */
function seaweedConfig(c: StorageConfig): string {
  const file = join(dataDir('storage', 'seaweedfs'), 's3.json');
  const publics = store.storage.seaweedfs ? seaweedPublic() : [];
  const identities: unknown[] = [{ name: 'devcatz', credentials: [{ accessKey: c.accessKey, secretKey: c.secretKey }], actions: ['Admin', 'Read', 'List', 'Tagging', 'Write'] }];
  if (publics.length) identities.push({ name: 'anonymous', actions: publics.map((b) => `Read:${b}`) });
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ identities }, null, 2));
  return file;
}

const SEAWEED_PUBLIC = () => join(dataDir('storage', 'seaweedfs'), 'public-buckets.json');
export function seaweedPublic(): string[] {
  try {
    return JSON.parse(readFileSync(SEAWEED_PUBLIC(), 'utf8')) as string[];
  } catch {
    return [];
  }
}
export function setSeaweedPublic(bucket: string, on: boolean): void {
  const list = new Set(seaweedPublic());
  if (on) list.add(bucket);
  else list.delete(bucket);
  mkdirSync(dirname(SEAWEED_PUBLIC()), { recursive: true });
  writeFileSync(SEAWEED_PUBLIC(), JSON.stringify([...list]));
}

export const storageId = (kind: StorageKind) => `storage:${kind}`;
const managedDir = (kind: StorageKind) => dataDir('storage', kind);
/** Folder the managed binary is downloaded into. */
export const binaryDirOf = (c: Pick<StorageConfig, 'kind' | 'binaryDir'>) => c.binaryDir || join(managedDir(c.kind), 'bin');
export const binaryOf = (c: StorageConfig) => c.binaryPath || join(binaryDirOf(c), ENGINES[c.kind].exe);

export function defaultsFor(kind: StorageKind): StorageConfig {
  const root = store.settings.storageRoot;
  const binRoot = store.settings.storageBinRoot;
  return {
    kind,
    ...ENGINES[kind].defaults,
    dataDir: root ? join(root, kind) : join(managedDir(kind), 'data'),
    binaryPath: '',
    binaryDir: binRoot ? join(binRoot, kind) : join(managedDir(kind), 'bin'),
    autoStart: false,
    region: s3Region(),
  };
}

/** Region from Settings → Object Storage (servers run in it, clients sign for it). */
export const s3Region = (c?: Pick<StorageConfig, 'region'>) => c?.region || store.settings.s3Region || 'us-east-1';

const LABEL = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

export class StorageManager {
  readonly processes = new ProcessManager('storage-pids.json');
  private tasks = new Map<StorageKind, TaskProgress>();
  private aborts = new Map<StorageKind, AbortController>();

  /** Returns the names of the services that could not be checked (offline, GitHub rate limit …). */
  async checkUpdates(): Promise<string[]> {
    const failed: string[] = [];
    await Promise.all(
      STORAGE_KINDS.map(async (kind) => {
        const c = this.config(kind);
        if (!c || c.binaryPath) return void this.updates.delete(kind);
        const v = await ENGINES[kind].latest().catch(() => null);
        if (!v) failed.push(ENGINES[kind].name);
        else if (isNewer(v, c.version)) this.updates.set(kind, v);
        else this.updates.delete(kind);
      }),
    );
    this.onChange();
    return failed;
  }

  /** Newer release in place of the current binary (data folder and settings stay). */
  async upgrade(kind: StorageKind): Promise<void> {
    const c = this.config(kind);
    if (!c) throw new Error(`${ENGINES[kind].name} is not installed`);
    if (c.binaryPath) throw new Error(`${ENGINES[kind].name} runs your own binary (${c.binaryPath}); update that file yourself`);
    if (this.aborts.has(kind)) throw new Error(`${ENGINES[kind].name} is busy`);
    const steps = [...INSTALL_STEPS.slice(0, 5), ...UPDATE_TAIL];
    const t = this.task(kind, { kind: 'update', title: `Updating ${ENGINES[kind].name}`, steps, step: 0 });
    const abort = new AbortController();
    this.aborts.set(kind, abort);
    try {
      const v = await upgradeBinaries({
        binDir: binaryDirOf(c),
        install: (d, report, signal) => ENGINES[kind].install(d, report, signal),
        inPlace: false,
        stop: () => this.processes.stop(storageId(kind)),
        start: () => this.action(kind, 'start'),
        wasActive: this.isActive(kind),
        version: () => this.version(c),
        report: t.report,
        signal: abort.signal,
        tailAt: 5,
      });
      store.setStorage(kind, { ...this.config(kind)!, version: v });
      this.updates.delete(kind);
      this.processes.log(storageId(kind), 'sys', `Updated ${c.version ?? ''} → ${v}`);
      t.report({ title: `Updated ${ENGINES[kind].name} to ${v}` });
      t.finish();
    } catch (err) {
      t.fail(abort.signal.aborted ? new Error('Update cancelled; the current version was kept') : err);
    } finally {
      this.aborts.delete(kind);
      this.onChange();
    }
  }

  cancelInstall(kind: StorageKind): void {
    this.aborts.get(kind)?.abort();
  }

  /** Starts a task; returns its reporter. Finished tasks fade out, failed ones stay until the next one. */
  /** Hides a task that ended (done, failed or cancelled). */
  dismissTask(kind: StorageKind): void {
    const t = this.tasks.get(kind);
    if (t && (t.done || t.error)) {
      this.tasks.delete(kind);
      this.onChange();
    }
  }

  private task(kind: StorageKind, init: TaskProgress): { report: Report; fail: (err: unknown) => never; finish: () => void } {
    this.tasks.set(kind, init);
    this.onChange();
    const report: Report = (p) => {
      const cur = this.tasks.get(kind);
      if (!cur) return;
      this.tasks.set(kind, { ...cur, ...p });
      this.onChange();
    };
    return {
      report,
      fail: (err) => {
        report({ error: (err as Error).message });
        throw err;
      },
      finish: () => {
        const cur = this.tasks.get(kind);
        report({ step: cur?.steps.length ?? 0, done: true, detail: undefined, received: undefined, total: undefined });
        setTimeout(() => {
          if (this.tasks.get(kind)?.done) {
            this.tasks.delete(kind);
            this.onChange();
          }
        }, 4000);
      },
    };
  }
  private errors = new Map<StorageKind, string>();
  /** Newer releases found by checkUpdates (kind → version). */
  private updates = new Map<StorageKind, string>();
  onChange: () => void = () => undefined;
  /** Site domains, to refuse clashing storage domains. */
  siteDomains: () => string[] = () => [];

  constructor() {
    this.processes.on('status', () => this.onChange());
    // Mirror each service's output into logs/storage-<kind>.log as well.
    this.processes.on('log', (lines: LogLine[]) => {
      for (const l of lines) {
        const kind = l.projectId.replace(/^storage:/, '');
        try {
          appendFileSync(join(dataDir('logs'), `storage-${kind}.log`), `${new Date(l.time).toISOString()} ${l.stream} ${l.text}\n`);
        } catch {
          /* best effort */
        }
      }
    });
    setInterval(() => void this.poll(), 1500);
    // Update check shortly after launch, then every 6 hours.
    setTimeout(() => void this.checkUpdates(), 40_000);
    setInterval(() => void this.checkUpdates(), 6 * 3600_000);
  }

  /** "Starts with DevCatz" only: saved without restarting a running service. */
  setAutoStart(kind: StorageKind, on: boolean): void {
    const c = this.config(kind);
    if (!c) throw new Error('Not installed');
    store.setStorage(kind, { ...c, autoStart: on });
    this.onChange();
  }

  config(kind: StorageKind): StorageConfig | null {
    const c = store.storage[kind];
    // Older installs: no binaryDir / region yet.
    return c ? { ...c, binaryDir: c.binaryDir ?? '', region: c.region || s3Region() } : null;
  }

  /** "running" once the S3 port answers. */
  private async poll(): Promise<void> {
    for (const kind of STORAGE_KINDS) {
      const c = this.config(kind);
      if (!c || this.processes.getStatus(storageId(kind)).status !== 'starting') continue;
      if (await isPortOpen(c.apiPort)) {
        this.processes.markRunning(storageId(kind));
        this.processes.log(storageId(kind), 'sys', `Ready → https://${host(c.apiDomain)} (console https://${host(c.consoleDomain)})`);
      }
    }
  }

  /** Ports and domains must be free and unique (across services and sites). */
  validate(c: StorageConfig): void {
    for (const [what, port] of [['API port', c.apiPort], ['Console port', c.consolePort]] as const) {
      if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error(`${what}: 1024–65535`);
    }
    if (c.apiPort === c.consolePort) throw new Error('API and console ports must differ');
    for (const label of [c.apiDomain, c.consoleDomain]) {
      if (!LABEL.test(label)) throw new Error(`Domain "${label}": lowercase letters, digits, hyphens and dots`);
    }
    if (c.apiDomain === c.consoleDomain) throw new Error('API and console domains must differ');
    const sites = new Set(this.siteDomains());
    for (const label of [c.apiDomain, c.consoleDomain]) if (sites.has(host(label))) throw new Error(`${host(label)} is already a site`);
    const used = c.kind === 'seaweedfs' ? [c.apiPort, c.consolePort, ...Object.values(seaweedPorts(c))] : [c.apiPort, c.consolePort];
    for (const kind of STORAGE_KINDS) {
      const o = this.config(kind);
      if (!o || kind === c.kind) continue;
      const theirs = kind === 'seaweedfs' ? [o.apiPort, o.consolePort, ...Object.values(seaweedPorts(o))] : [o.apiPort, o.consolePort];
      const clash = used.find((p) => theirs.includes(p));
      if (clash) throw new Error(`Port ${clash} is used by ${ENGINES[kind].name}`);
      for (const label of [c.apiDomain, c.consoleDomain]) {
        if ([o.apiDomain, o.consoleDomain].includes(label)) throw new Error(`${host(label)} is used by ${ENGINES[kind].name}`);
      }
    }
    if (!/^[a-z0-9-]{2,32}$/.test(c.region)) throw new Error('Region: lowercase letters, digits and hyphens, e.g. us-east-1');
    if (!c.accessKey || c.accessKey.length < 3) throw new Error('Access key: at least 3 characters');
    if (!c.secretKey || c.secretKey.length < 8) throw new Error('Secret key: at least 8 characters');
  }

  async install(kind: StorageKind, input: StorageConfig): Promise<void> {
    if (this.config(kind)) throw new Error(`${ENGINES[kind].name} is already installed`);
    if (this.aborts.has(kind)) throw new Error(`${ENGINES[kind].name} is already being installed`);
    const c = { ...input, kind };
    this.validate(c);
    const own = Boolean(c.binaryPath);
    const steps = own
      ? ['Checking the binary', 'Checking the version', 'Preparing the data folder', 'Saving settings']
      : [...INSTALL_STEPS];
    if (c.autoStart) steps.push('Starting');
    const at = (name: string) => steps.indexOf(name);
    const t = this.task(kind, { kind: 'install', title: `Installing ${ENGINES[kind].name}`, steps, step: 0 });
    const abort = new AbortController();
    this.aborts.set(kind, abort);
    const signal = abort.signal;
    // A binary that was there before (reinstall into the same folder) is not ours to delete on cancel.
    const placed = !own && !existsSync(binaryOf(c));
    const dataExisted = existsSync(c.dataDir);
    try {
      if (own) {
        t.report({ step: 0, detail: c.binaryPath });
        if (!existsSync(c.binaryPath)) throw new Error(`${c.binaryPath} does not exist`);
      } else {
        await ENGINES[kind].install(binaryDirOf(c), t.report, signal);
      }
      check(signal);
      t.report({ step: at('Checking the version'), detail: binaryOf(c), received: undefined, total: undefined });
      c.version = await this.version(c);
      if (!c.version) throw new Error(`${binaryOf(c)} does not run (wrong file or architecture?)`);
      check(signal);
      t.report({ title: `Installing ${ENGINES[kind].name} ${c.version}`, step: at('Preparing the data folder'), detail: c.dataDir });
      mkdirSync(c.dataDir, { recursive: true });
      check(signal);
      // From here on the install is committed (Cancel no longer applies).
      this.aborts.delete(kind);
      t.report({ step: at('Saving settings'), detail: `https://${host(c.apiDomain)} · https://${host(c.consoleDomain)}` });
      store.setStorage(kind, c);
      this.onChange();
      if (c.autoStart) {
        t.report({ step: at('Starting'), detail: `127.0.0.1:${c.apiPort}` });
        await this.action(kind, 'start');
      }
      t.finish();
    } catch (err) {
      if (err instanceof Cancelled || signal.aborted) {
        // Leave nothing behind: the half-installed binary and a data folder we just created.
        if (placed) await rm(binaryOf(c), { force: true }).catch(() => undefined);
        if (!dataExisted) await rm(c.dataDir, { recursive: true, force: true }).catch(() => undefined);
        t.report({ cancelled: true, error: 'Install cancelled; nothing was kept.', received: undefined, total: undefined });
        throw new Error('Install cancelled');
      }
      t.fail(err);
    } finally {
      this.aborts.delete(kind);
    }
  }

  private async version(c: StorageConfig): Promise<string | null> {
    const bin = binaryOf(c);
    if (!existsSync(bin)) return null;
    const args = c.kind === 'seaweedfs' ? ['version'] : ['--version'];
    const r = await run(bin, args, { timeout: 15_000 });
    const text = `${r.stdout}\n${r.stderr}`;
    const v =
      c.kind === 'seaweedfs'
        ? text.match(/version\s+(?:\S+\s+)?(\d+\.\d+)/i)?.[1]
        : c.kind === 'minio'
          ? text.match(/RELEASE\.[\dT:-]+Z/)?.[0]
          : text.match(/rustfs\s+([\w.-]+)/)?.[1];
    return r.code === 0 || v ? (v ?? 'unknown') : null;
  }

  async update(kind: StorageKind, input: StorageConfig): Promise<void> {
    const old = this.config(kind);
    if (!old) throw new Error('Not installed');
    const c = { ...old, ...input, kind, version: old.version };
    this.validate(c);
    // Managed binary moved to another folder: take the file along.
    if (!c.binaryPath && !old.binaryPath && binaryDirOf(c) !== binaryDirOf(old)) {
      const from = binaryOf(old);
      const to = binaryOf(c);
      if (existsSync(from) && !existsSync(to)) {
        mkdirSync(binaryDirOf(c), { recursive: true });
        copyFileSync(from, to);
        chmodSync(to, 0o755);
        rmSync(from, { force: true });
      }
    }
    if (c.binaryPath !== old.binaryPath || binaryDirOf(c) !== binaryDirOf(old)) {
      c.version = await this.version(c);
      if (!c.version) throw new Error(`${binaryOf(c)} does not run`);
    }
    mkdirSync(c.dataDir, { recursive: true });
    store.setStorage(kind, c);
    if (this.isActive(kind)) await this.action(kind, 'restart');
    this.onChange();
  }

  async uninstall(kind: StorageKind, deleteData: boolean): Promise<void> {
    const c = this.config(kind);
    if (!c) return;
    const steps = ['Stopping the service', ...(c.binaryPath ? [] : ['Removing the binary']), ...(deleteData ? ['Deleting the data folder'] : []), 'Removing settings'];
    const at = (name: string) => steps.indexOf(name);
    const t = this.task(kind, { kind: 'uninstall', title: `Uninstalling ${ENGINES[kind].name}`, steps, step: 0 });
    try {
      t.report({ step: 0, detail: this.isActive(kind) ? `127.0.0.1:${c.apiPort}` : 'not running' });
      await this.processes.stop(storageId(kind));
      if (!c.binaryPath) {
        // Only our file: a chosen binary folder may hold other things.
        t.report({ step: at('Removing the binary'), detail: binaryOf(c) });
        await rm(join(binaryDirOf(c), ENGINES[kind].exe), { force: true });
      }
      if (deleteData) {
        t.report({ step: at('Deleting the data folder'), detail: c.dataDir });
        await rm(c.dataDir, { recursive: true, force: true });
      }
      t.report({ step: at('Removing settings'), detail: deleteData ? undefined : `Data kept in ${c.dataDir}` });
      store.setStorage(kind, null);
      this.processes.clearLogs(storageId(kind));
      t.finish();
    } catch (err) {
      t.fail(err);
    }
  }

  isActive(kind: StorageKind): boolean {
    return this.processes.isActive(storageId(kind));
  }

  async action(kind: StorageKind, action: StorageAction): Promise<void> {
    const id = storageId(kind);
    const c = this.config(kind);
    if (!c) throw new Error(`${ENGINES[kind].name} is not installed`);
    if (action === 'stop' || action === 'restart') await this.processes.stop(id);
    if (action === 'stop') return;
    for (let i = 0; i < 10 && (await isPortOpen(c.apiPort)); i++) await new Promise((r) => setTimeout(r, 300));
    const ports = c.kind === 'seaweedfs' ? [c.apiPort, c.consolePort, ...Object.values(seaweedPorts(c))] : [c.apiPort, c.consolePort];
    for (const port of ports) {
      if (await isPortOpen(port)) {
        const owner = await portOwner(port);
        const msg = `Port ${port} is already in use${owner ? ` by ${owner}` : ''}; change it in ${ENGINES[kind].name}'s settings.`;
        this.processes.log(id, 'sys', msg);
        this.errors.set(kind, msg);
        this.onChange();
        throw new Error(msg);
      }
    }
    this.errors.delete(kind);
    const bin = binaryOf(c);
    if (!existsSync(bin)) throw new Error(`${bin} is missing; reinstall ${ENGINES[kind].name}`);
    mkdirSync(c.dataDir, { recursive: true });
    this.processes.startMany(
      id,
      ENGINES[kind].specs(c, bin).map((s) => ({ ...s, cwd: c.dataDir })),
    );
  }

  autoStart(): void {
    for (const kind of STORAGE_KINDS) {
      if (this.config(kind)?.autoStart) this.action(kind, 'start').catch((e) => console.error(`${kind}:`, e.message));
    }
  }

  stopAll(): Promise<void> {
    return this.processes.stopAll();
  }

  /** Proxy routes: API and console domains, Host kept (S3 signatures and virtual-hosted buckets need it). */
  routes(): Route[] {
    const out: Route[] = [];
    for (const kind of STORAGE_KINDS) {
      const c = this.config(kind);
      if (!c) continue;
      const running = this.isActive(kind);
      out.push({ domain: host(c.apiDomain), port: c.apiPort, projectName: `${ENGINES[kind].name} API`, running, secure: true, keepHost: true });
      out.push({
        domain: host(c.consoleDomain),
        port: c.consolePort,
        projectName: `${ENGINES[kind].name} console`,
        running,
        secure: true,
        keepHost: true,
        rootRedirect: ENGINES[kind].consolePath,
      });
    }
    return out;
  }

  state(): StorageState[] {
    return STORAGE_KINDS.map((kind) => {
      const c = this.config(kind);
      const { status } = this.processes.getStatus(storageId(kind));
      return {
        kind,
        name: ENGINES[kind].name,
        description: ENGINES[kind].description,
        installed: Boolean(c),
        config: c,
        defaults: defaultsFor(kind),
        binary: c ? binaryOf(c) : null,
        status,
        error: this.errors.get(kind) ?? null,
        task: this.tasks.get(kind) ?? null,
        // A binary the user chose is theirs to update.
        update: c && !c.binaryPath ? (this.updates.get(kind) ?? null) : null,
        urls: c
          ? {
              api: `https://${host(c.apiDomain)}`,
              console: `https://${host(c.consoleDomain)}${ENGINES[kind].consolePath ?? ''}`,
              apiLocal: `http://127.0.0.1:${c.apiPort}`,
              consoleLocal: `http://127.0.0.1:${c.consolePort}`,
            }
          : null,
        internalPorts: c && kind === 'seaweedfs' ? seaweedPorts(c) : undefined,
      };
    });
  }
}
