import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import bcrypt from 'bcryptjs';
import type { StorageConfig, StorageKind, TaskProgress } from '@shared/types';
import { defaultContainer, gatewayCompose, gatewayEngineReady, type GwContainer } from './docker';
import { getShellEnv, run } from './env';
import { killTree } from './platform';
import { dataDir, tld } from './store';
import { app } from 'electron';

const RESOURCES = app.isPackaged ? process.resourcesPath : join(__dirname, '../../resources');

/**
 * Object storage that runs as a container (DevCatz TODO §40), on DoCatz's engine by default (the system's engine when
 * DoCatz is not there), the same on macOS, Windows and Linux:
 *  · Ceph: no build for macOS / Windows and a real cluster is heavy, so one container of the official
 *    quay.io/ceph/ceph image runs a single-node cluster (MON, MGR, one file-backed OSD, RGW) from resources/storage/
 *    ceph-start.sh; the dashboard is the console, logged in with the S3 access key and secret key.
 *  · Garage: official builds are Linux-only and published without checksums, so the official dxflrs/garage image runs
 *    it everywhere; Garage has no web console of its own yet, so the community Garage Web UI (khairul169/garage-webui)
 *    can run next to it — on by default but optional, since it is not Garage's own (user, 2026-11-18; replaced by
 *    Garage's official UI once that ships).
 * Each is a compose project `devcatz-svc-<kind>` (DoCatz lists those under DevCatz Services); data lives in a named
 * volume (BlueStore / SQLite on a shared host folder is slow and fragile), the configuration in DevCatz's data folder.
 * DevCatz keeps `compose up` attached as the server's process, like the Windows search engines (svcdocker.ts).
 */

export const project = (kind: StorageKind) => `devcatz-svc-${kind}`;
export const volumeOf = (kind: StorageKind) => `devcatz-storage-${kind}`;
export const configDir = (kind: StorageKind) => dataDir('storage', kind);
export const composeFile = (kind: StorageKind) => join(configDir(kind), 'docker-compose.yml');

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const host = (label: string) => `${label}.${tld()}`;
/** A host path in the compose file (DoCatz's compose maps C:\… itself on Windows). */
const vol = (path: string, inside: string, ro = false) => JSON.stringify(`${path}:${inside}${ro ? ':ro' : ''}`);

export const where = (c: Pick<StorageConfig, 'docker'>): GwContainer => c.docker?.container ?? defaultContainer();

export function compose(c: StorageConfig, args: string[], timeout = 120_000) {
  const [bin, ...pre] = gatewayCompose(where(c));
  return run(bin, [...pre, '-f', composeFile(c.kind), '-p', project(c.kind), ...args], { timeout, cwd: configDir(c.kind) });
}

/** The server's process: `compose up`, attached (its output is the log; stopping it stops the containers). */
export const upCommand = (c: StorageConfig) =>
  [...gatewayCompose(where(c)), '-f', composeFile(c.kind), '-p', project(c.kind), 'up', '--remove-orphans'].map(q).join(' ');

/** Runs a command inside a running service container. */
export function exec(c: StorageConfig, service: string, cmd: string[], timeout = 60_000) {
  return compose(c, ['exec', '-T', service, ...cmd], timeout);
}

export const engineReady = (c: StorageConfig, report?: (d: string) => void, signal?: AbortSignal) => gatewayEngineReady(where(c), report, signal);

/** `compose pull` with its progress lines as the task's detail; cancellable. */
export function pull(c: StorageConfig, report: (p: Partial<TaskProgress>) => void, signal: AbortSignal): Promise<void> {
  const [bin, ...pre] = gatewayCompose(where(c));
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, [...pre, '-f', composeFile(c.kind), '-p', project(c.kind), 'pull'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: configDir(c.kind),
      env: getShellEnv() as NodeJS.ProcessEnv,
      windowsHide: true,
    });
    let last = '';
    const onLine = (d: Buffer) => {
      for (const line of d.toString().split(/\r?\n/)) if (line.trim()) report({ detail: (last = line.trim()).slice(0, 120) });
    };
    proc.stdout.on('data', onLine);
    proc.stderr.on('data', onLine);
    const onAbort = () => (proc.pid ? killTree(proc.pid) : proc.kill());
    signal.addEventListener('abort', onAbort, { once: true });
    proc.on('error', reject);
    proc.on('close', (code) => {
      signal.removeEventListener('abort', onAbort);
      if (signal.aborted) reject(new Error('Cancelled'));
      else if (code === 0) resolve();
      else reject(new Error(`docker compose pull failed: ${last || `exit ${code}`}`));
    });
  });
}

/** The Web UI turned off: its container and image go (Garage keeps running). */
export async function removeGarageWebUi(c: StorageConfig): Promise<void> {
  await compose(c, ['rm', '-sf', 'webui'], 60_000).catch(() => undefined);
  const [bin, ...pre] = gatewayCompose(where(c)).slice(0, -1);
  await run(bin, [...pre, 'rmi', GARAGE_WEBUI], { timeout: 60_000 }).catch(() => undefined);
}

/** Containers down (and the data volume with `deleteData`), the images removed. */
export async function remove(c: StorageConfig, deleteData: boolean): Promise<void> {
  await compose(c, ['down', '--remove-orphans', '--rmi', 'all', ...(deleteData ? ['-v'] : [])], 300_000).catch(() => undefined);
}

// ---------------------------------------------------------------- per engine

/** Secrets that must not change between starts (Garage's RPC secret and admin token). */
function secrets(kind: StorageKind): { rpc: string; admin: string } {
  const file = join(configDir(kind), 'secrets.json');
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as { rpc: string; admin: string };
  } catch {
    const s = { rpc: randomBytes(32).toString('hex'), admin: randomBytes(24).toString('hex') };
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(s), { mode: 0o600 });
    return s;
  }
}

/** Garage's key formats: an access key id "GK" + 24 hex digits, a secret of 64 hex digits. */
export const GARAGE_KEY = /^GK[0-9a-f]{24}$/;
export const GARAGE_SECRET = /^[0-9a-f]{64}$/;
/** A key pair in Garage's format, made once and kept so the install form shows the same values. */
export function garageDefaultKeys(): { accessKey: string; secretKey: string } {
  const file = join(configDir('garage'), 'default-keys.json');
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as { accessKey: string; secretKey: string };
  } catch {
    const k = { accessKey: `GK${randomBytes(12).toString('hex')}`, secretKey: randomBytes(32).toString('hex') };
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(k), { mode: 0o600 });
    return k;
  }
}
/** Garage's static-website endpoint: public buckets at https://<bucket>.web.<api domain>. */
export const garageWebDomain = (c: Pick<StorageConfig, 'apiDomain'>) => `web.${c.apiDomain}`;
export const garageWebPort = (c: Pick<StorageConfig, 'apiPort'>) => c.apiPort + 2;

export const GARAGE_WEBUI = 'khairul169/garage-webui:1.1.0';

export function writeGarage(c: StorageConfig, image: string): void {
  const dir = configDir('garage');
  mkdirSync(dir, { recursive: true });
  const s = secrets('garage');
  writeFileSync(
    join(dir, 'garage.toml'),
    [
      'metadata_dir = "/var/lib/garage/meta"',
      'data_dir = "/var/lib/garage/data"',
      'db_engine = "sqlite"',
      'replication_factor = 1',
      'rpc_bind_addr = "0.0.0.0:3901"',
      'rpc_public_addr = "127.0.0.1:3901"',
      `rpc_secret = "${s.rpc}"`,
      '',
      '[s3_api]',
      `s3_region = "${c.region}"`,
      'api_bind_addr = "0.0.0.0:3900"',
      `root_domain = ".${host(c.apiDomain)}"`,
      '',
      '[s3_web]',
      'bind_addr = "0.0.0.0:3902"',
      `root_domain = ".${host(garageWebDomain(c))}"`,
      'index = "index.html"',
      '',
      '[admin]',
      'api_bind_addr = "0.0.0.0:3903"',
      `admin_token = "${s.admin}"`,
      '',
    ].join('\n'),
    { mode: 0o600 },
  );
  // The optional Web UI's login: the S3 key pair (bcrypt, as it expects).
  const login = c.webUi !== false ? `${c.accessKey}:${bcrypt.hashSync(c.secretKey, 10)}` : '';
  const toml = join(dir, 'garage.toml');
  writeFileSync(
    composeFile('garage'),
    [
      'services:',
      '  garage:',
      `    image: ${image}`,
      '    restart: "no"',
      '    ports:',
      `      - "127.0.0.1:${c.apiPort}:3900"`,
      `      - "127.0.0.1:${garageWebPort(c)}:3902"`,
      '    volumes:',
      `      - ${JSON.stringify(`${volumeOf('garage')}:/var/lib/garage`)}`,
      `      - ${vol(toml, '/etc/garage.toml', true)}`,
      ...(c.webUi !== false
        ? [
        '  webui:',
        `    image: ${GARAGE_WEBUI}`,
        '    restart: "no"',
        '    depends_on: [garage]',
        '    ports:',
        `      - "127.0.0.1:${c.consolePort}:3909"`,
        '    environment:',
        '      CONFIG_PATH: /etc/garage.toml',
        '      API_BASE_URL: http://garage:3903',
        '      S3_ENDPOINT_URL: http://garage:3900',
        `      S3_REGION: ${JSON.stringify(c.region)}`,
        // compose interpolates $ in values: $$ keeps bcrypt's $2a$… as it is.
        `      AUTH_USER_PASS: ${JSON.stringify(login.replace(/\$/g, '$$$$'))}`,
        '    volumes:',
        `      - ${vol(toml, '/etc/garage.toml', true)}`,
        ]
        : []),
      'volumes:',
      `  ${volumeOf('garage')}:`,
      `    name: ${volumeOf('garage')}`,
      '',
    ].join('\n'),
    { mode: 0o600 },
  );
}

/** The `garage` CLI inside its container. */
export const garage = (c: StorageConfig, args: string[], timeout = 60_000) => exec(c, 'garage', ['/garage', ...args], timeout);

/**
 * After every start (idempotent): a one-node layout the first time, the S3 key pair imported with permission to create
 * buckets. Throws until the node answers (the caller retries).
 */
export async function garageSetup(c: StorageConfig): Promise<void> {
  const status = await garage(c, ['status']);
  if (status.code !== 0) throw new Error(`garage status: ${(status.stderr || status.stdout).trim().split('\n').pop()}`);
  if (/NO ROLE ASSIGNED/.test(status.stdout)) {
    const id = (await garage(c, ['node', 'id', '-q'])).stdout.trim().split('@')[0];
    if (!/^[0-9a-f]{16,}$/.test(id)) throw new Error('garage node id: no answer yet');
    const assign = await garage(c, ['layout', 'assign', '-z', 'dc1', '-c', '100G', id]);
    if (assign.code !== 0) throw new Error(`garage layout assign: ${assign.stderr.trim()}`);
    const show = await garage(c, ['layout', 'show']);
    const current = Number(show.stdout.match(/Current cluster layout version:\s*(\d+)/)?.[1] ?? 0);
    const apply = await garage(c, ['layout', 'apply', '--version', String(current + 1)]);
    if (apply.code !== 0) throw new Error(`garage layout apply: ${apply.stderr.trim()}`);
  }
  if ((await garage(c, ['key', 'info', c.accessKey])).code !== 0) {
    const imp = await garage(c, ['key', 'import', '--yes', '-n', 'devcatz', c.accessKey, c.secretKey]);
    if (imp.code !== 0) throw new Error(`garage key import: ${imp.stderr.trim()}`);
  }
  await garage(c, ['key', 'allow', '--create-bucket', c.accessKey]);
}

/** Buckets made through the CLI get a global name (S3 CreateBucket would make it local to the key: no website). */
export async function garageCreateBucket(c: StorageConfig, bucket: string): Promise<void> {
  const r = await garage(c, ['bucket', 'create', bucket]);
  if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim().split('\n').pop() || 'garage bucket create failed');
  await garage(c, ['bucket', 'allow', '--read', '--write', '--owner', bucket, '--key', c.accessKey]);
}
export async function garageDeleteBucket(c: StorageConfig, bucket: string): Promise<void> {
  const r = await garage(c, ['bucket', 'delete', '--yes', bucket]);
  if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim().split('\n').pop() || 'garage bucket delete failed');
}
/** Public = Garage's website access on the bucket (it has no bucket policies). */
export async function garageSetPublic(c: StorageConfig, bucket: string, on: boolean): Promise<void> {
  const r = await garage(c, ['bucket', 'website', on ? '--allow' : '--deny', bucket]);
  if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim().split('\n').pop() || 'garage bucket website failed');
}
export async function garageIsPublic(c: StorageConfig, bucket: string): Promise<boolean> {
  return /Website access:\s*true/.test((await garage(c, ['bucket', 'info', bucket])).stdout);
}

// ---------------------------------------------------------------- Ceph

export const CEPH_IMAGE = 'quay.io/ceph/ceph';

export function writeCeph(c: StorageConfig, image: string): void {
  const dir = configDir('ceph');
  mkdirSync(dir, { recursive: true });
  // The start script is copied next to the compose file: the app bundle is not shared with DoCatz's VM.
  const script = join(dir, 'ceph-start.sh');
  // LF only: bash in the container stops at a CRLF line (a Windows checkout could have converted it).
  writeFileSync(script, readFileSync(join(RESOURCES, 'storage', 'ceph-start.sh'), 'utf8').replace(/\r\n/g, '\n'), { mode: 0o755 });
  writeFileSync(
    composeFile('ceph'),
    [
      'services:',
      '  ceph:',
      `    image: ${image}`,
      '    restart: "no"',
      '    entrypoint: ["/bin/bash", "/devcatz/ceph-start.sh"]',
      '    stop_grace_period: 30s',
      '    ports:',
      `      - "127.0.0.1:${c.apiPort}:7480"`,
      `      - "127.0.0.1:${c.consolePort}:8080"`,
      '    environment:',
      `      S3_ACCESS_KEY: ${JSON.stringify(c.accessKey)}`,
      `      S3_SECRET_KEY: ${JSON.stringify(c.secretKey.replace(/\$/g, '$$$$'))}`,
      `      S3_REGION: ${JSON.stringify(c.region)}`,
      `      RGW_DNS_NAME: ${JSON.stringify(host(c.apiDomain))}`,
      // The dashboard's login is the same key pair DevCatz shows (user, 2026-11-18: "admin" was not guessable).
      `      DASH_USER: ${JSON.stringify(c.accessKey)}`,
      `      DASH_PASSWORD: ${JSON.stringify(c.secretKey.replace(/\$/g, '$$$$'))}`,
      '      OSD_SIZE: "10"',
      '    volumes:',
      `      - ${JSON.stringify(`${volumeOf('ceph')}:/var/lib/ceph`)}`,
      `      - ${vol(script, '/devcatz/ceph-start.sh', true)}`,
      'volumes:',
      `  ${volumeOf('ceph')}:`,
      `    name: ${volumeOf('ceph')}`,
      '',
    ].join('\n'),
    { mode: 0o600 },
  );
}

/**
 * Newest stable Ceph release image tag on quay.io: vMAJOR.2.PATCH is the stable series, and its .0 is left out (21.2.0's
 * image reported itself "dev", 20.2.5's "stable", 2026-11-18).
 */
export async function cephLatest(): Promise<string> {
  const res = await fetch('https://quay.io/api/v1/repository/ceph/ceph/tag/?limit=100&onlyActiveTags=true');
  if (!res.ok) throw new Error(`quay.io: HTTP ${res.status}`);
  const tags = ((await res.json()) as { tags: { name: string }[] }).tags.map((t) => t.name).filter((n) => /^v\d+\.2\.[1-9]\d*$/.test(n));
  tags.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  if (!tags[0]) throw new Error('No Ceph release tag found on quay.io');
  return tags[0].slice(1);
}

