import { createHash } from 'node:crypto';
import { appendFileSync, chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { connect } from 'node:net';
import { release } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type {
  LogLine,
  SearchConfig,
  SearchHit,
  SearchIndex,
  SearchKey,
  SearchKind,
  SearchQuery,
  SearchResult,
  SearchBackup,
  SearchState,
  SearchTask,
  StorageAction,
  TaskProgress,
} from '@shared/types';
import { downloadVerified } from './download';
import { isPortOpen, portOwner, run } from './env';
import { ProcessManager } from './processes';
import type { Route } from './proxy';
import { Cancelled, check, githubAsset } from './storage';
import { brewLatest, isNewer, UPDATE_TAIL, upgradeBinaries } from './svcupdate';
import { dataDir, store, tld } from './store';

/**
 * Search engines, one instance per kind (like Object Storage), installed into
 * <userData>/search/<kind>/bin and served on https://<label>.<tld>:
 *
 * - Meilisearch: GitHub release binary (SHA-256 from the release).
 * - Typesense: dl.typesense.org tarball; the binary's MD5 shipped inside is checked.
 * - OpenSearch: the "min" distribution (core, Java) with its SHA-512, run on
 *   Eclipse Temurin 21 for macOS (Adoptium API, SHA-256): OpenSearch publishes
 *   no macOS build, its bundled Linux JDK is dropped.
 * - Manticore: macOS tarball from repo.manticoresearch.com (HTTPS; the binary
 *   must report its version before it is kept).
 * - ZincSearch: GitHub release tarball (SHA-256 from the release), Elasticsearch-
 *   compatible API under /es, basic auth with the admin user.
 * - Sonic: Homebrew's bottle (no macOS build on GitHub) fetched straight from
 *   ghcr.io with the SHA-256 in formulae.brew.sh, no Homebrew needed; TCP only
 *   (Sonic Channel), it keeps ids, so DevCatz keeps the documents next to it.
 */
export const SEARCH_KINDS: SearchKind[] = ['meilisearch', 'typesense', 'opensearch', 'manticore', 'zincsearch', 'sonic'];

type Report = (p: Partial<TaskProgress>) => void;

const STEPS = ['Finding the latest release', 'Downloading', 'Verifying', 'Unpacking', 'Installing', 'Checking the version', 'Preparing the data folder', 'Saving settings'];
const S = { find: 0, download: 1, verify: 2, unpack: 3, place: 4, version: 5, data: 6, save: 7 } as const;

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const host = (label: string) => `${label}.${tld()}`;
const ARM = process.arch === 'arm64';

interface Engine {
  name: string;
  description: string;
  /** Path of the server below the binary folder. */
  exe: string;
  fields: SearchState['fields'];
  features: SearchState['features'];
  defaults: Pick<SearchConfig, 'port' | 'extraPort' | 'domain'>;
  /** A key is generated for the install. */
  needsKey: boolean;
  install(dir: string, report: Report, signal: AbortSignal): Promise<void>;
  /** Newest release, from the installer's source (update check). */
  latest(): Promise<string>;
  version(dir: string): Promise<string | null>;
  spec(c: SearchConfig, dir: string): { command: string; env: Record<string, string> };
  admin?: string;
}

/** Downloads `url` into a fresh temp folder (next to DevCatz's data) and returns the file and its digest. */
async function fetchTmp(
  url: string,
  name: string,
  expected: string,
  algo: 'sha256' | 'sha512' | 'md5',
  report: Report,
  signal: AbortSignal,
  headers?: Record<string, string>,
): Promise<{ tmp: string; file: string; digest: string }> {
  const tmp = join(dataDir('search'), `.tmp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
  mkdirSync(tmp, { recursive: true });
  const file = join(tmp, name);
  report({ step: S.download, received: 0, total: 0, detail: decodeURIComponent(url.split('/').pop() ?? url) });
  try {
    const digest = await downloadVerified(url, file, '', (received, total) => report({ step: S.download, received, total }), headers, signal, algo);
    check(signal);
    report({ step: S.verify, received: undefined, total: undefined, detail: expected ? `${algo.toUpperCase()} ${digest.slice(0, 16)}…` : `HTTPS · ${algo.toUpperCase()} ${digest.slice(0, 16)}…` });
    if (expected && digest !== expected.toLowerCase()) throw new Error(`Checksum mismatch (expected ${expected.slice(0, 12)}…, got ${digest.slice(0, 12)}…); download discarded`);
    return { tmp, file, digest };
  } catch (err) {
    rmSync(tmp, { recursive: true, force: true });
    throw signal.aborted ? new Cancelled() : err;
  }
}

async function untar(file: string, into: string): Promise<void> {
  mkdirSync(into, { recursive: true });
  const r = await run('tar', ['-xzf', file, '-C', into], { timeout: 600_000 });
  if (r.code !== 0) throw new Error(`Unpacking failed: ${r.stderr.trim()}`);
}

/** Replaces `dest` by `from` (a file or folder). */
function place(from: string, dest: string): void {
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(join(dest, '..'), { recursive: true });
  try {
    renameSync(from, dest);
  } catch {
    cpSync(from, dest, { recursive: true });
  }
}

async function latestTag(repo: string): Promise<string> {
  const res = await fetch(`https://api.github.com/repos/${repo}/releases?per_page=10`, { headers: { Accept: 'application/vnd.github+json' } });
  if (!res.ok) throw new Error(`GitHub: HTTP ${res.status}${res.status === 403 ? ' (rate limit, try again later)' : ''}`);
  const list = (await res.json()) as { tag_name: string; prerelease: boolean; draft: boolean }[];
  const tag = list.find((r) => !r.prerelease && !r.draft)?.tag_name;
  if (!tag) throw new Error(`No release found in ${repo}`);
  return tag;
}

const ENGINES: Record<SearchKind, Engine> = {
  meilisearch: {
    name: 'Meilisearch',
    description: 'Fast, typo-tolerant search with a built-in mini dashboard; Laravel Scout’s default engine.',
    exe: 'meilisearch',
    fields: { key: 'Master key', extraPort: null, memory: false },
    features: { keys: true, facets: true, editSettings: true, schemaOnCreate: true, tasks: true, backups: true, filters: true, http: true },
    defaults: { port: 7700, extraPort: 0, domain: 'meilisearch' },
    needsKey: true,
    admin: '/',
    async install(dir, report, signal) {
      report({ step: S.find, detail: 'github.com/meilisearch/meilisearch releases' });
      const a = await githubAsset('meilisearch/meilisearch', ARM ? /^meilisearch-macos-apple-silicon$/ : /^meilisearch-macos-amd64$/);
      report({ title: `Installing Meilisearch ${a.tag}` });
      const d = await fetchTmp(a.url, 'meilisearch', a.sha256, 'sha256', report, signal);
      try {
        report({ step: S.place, detail: join(dir, 'meilisearch') });
        chmodSync(d.file, 0o755);
        place(d.file, join(dir, 'meilisearch'));
      } finally {
        rmSync(d.tmp, { recursive: true, force: true });
      }
    },
    latest: async () => (await githubAsset('meilisearch/meilisearch', ARM ? /^meilisearch-macos-apple-silicon$/ : /^meilisearch-macos-amd64$/)).tag.replace(/^v/, ''),
    async version(dir) {
      const r = await run(join(dir, 'meilisearch'), ['--version'], { timeout: 15_000 });
      return r.stdout.match(/meilisearch\s+([\w.-]+)/)?.[1] ?? null;
    },
    spec(c, dir) {
      const data = c.dataDir;
      return {
        command: `${q(join(dir, 'meilisearch'))} --db-path ${q(join(data, 'data.ms'))} --dump-dir ${q(join(data, 'dumps'))} --snapshot-dir ${q(join(data, 'snapshots'))} --http-addr 127.0.0.1:${c.port} --env development --no-analytics`,
        env: { MEILI_MASTER_KEY: c.key },
      };
    },
  },
  typesense: {
    name: 'Typesense',
    description: 'Typo-tolerant search with strict schemas, faceting, geo and vector search; Laravel Scout driver.',
    exe: 'typesense-server',
    fields: { key: 'Admin API key', extraPort: 'Peering port', memory: false },
    features: { keys: true, facets: true, editSettings: true, schemaOnCreate: false, tasks: false, backups: false, filters: true, http: true },
    defaults: { port: 8108, extraPort: 8107, domain: 'typesense' },
    needsKey: true,
    async install(dir, report, signal) {
      report({ step: S.find, detail: 'github.com/typesense/typesense releases' });
      const v = (await latestTag('typesense/typesense')).replace(/^v/, '');
      report({ title: `Installing Typesense ${v}` });
      const url = `https://dl.typesense.org/releases/${v}/typesense-server-${v}-darwin-${ARM ? 'arm64' : 'amd64'}.tar.gz`;
      const d = await fetchTmp(url, 'typesense.tar.gz', '', 'sha256', report, signal);
      try {
        report({ step: S.unpack, detail: 'tar.gz' });
        await untar(d.file, join(d.tmp, 'x'));
        const bin = join(d.tmp, 'x', 'typesense-server');
        // The tarball ships the binary's MD5 next to it.
        const md5File = join(d.tmp, 'x', 'typesense-server.md5.txt');
        if (existsSync(md5File)) {
          const want = readFileSync(md5File, 'utf8').trim().split(/\s+/)[0];
          const got = createHash('md5').update(readFileSync(bin)).digest('hex');
          report({ step: S.verify, detail: `MD5 ${got.slice(0, 16)}… (from the tarball)` });
          if (want && want !== got) throw new Error('typesense-server does not match the MD5 in its tarball');
        }
        report({ step: S.place, detail: join(dir, 'typesense-server') });
        chmodSync(bin, 0o755);
        place(bin, join(dir, 'typesense-server'));
      } finally {
        rmSync(d.tmp, { recursive: true, force: true });
      }
    },
    latest: async () => (await latestTag('typesense/typesense')).replace(/^v/, ''),
    async version(dir) {
      const r = await run(join(dir, 'typesense-server'), ['--version'], { timeout: 15_000 });
      return `${r.stdout}${r.stderr}`.match(/Typesense\s+([\w.-]+)/)?.[1] ?? null;
    },
    spec(c, dir) {
      const cors = c.allowedOrigins.trim() && c.allowedOrigins.trim() !== '*' ? ` --cors-domains ${q(c.allowedOrigins.split(/[\s,]+/).filter(Boolean).join(','))}` : '';
      return {
        command: `${q(join(dir, 'typesense-server'))} --listen-address 127.0.0.1 --api-port ${c.port} --peering-address 127.0.0.1 --peering-port ${c.extraPort} --enable-cors${cors}`,
        env: { TYPESENSE_API_KEY: c.key, TYPESENSE_DATA_DIR: c.dataDir },
      };
    },
  },
  opensearch: {
    name: 'OpenSearch',
    description: 'Apache-licensed Elasticsearch fork: full query DSL, aggregations; runs on its own Java (Temurin 21).',
    exe: 'opensearch/bin/opensearch',
    fields: { key: null, extraPort: 'Transport port', memory: true },
    features: { keys: false, facets: true, editSettings: true, schemaOnCreate: false, tasks: false, backups: false, filters: true, http: true },
    defaults: { port: 9210, extraPort: 9310, domain: 'opensearch' },
    needsKey: false,
    async install(dir, report, signal) {
      report({ step: S.find, detail: 'github.com/opensearch-project/OpenSearch releases' });
      const v = (await latestTag('opensearch-project/OpenSearch')).replace(/^v/, '');
      report({ title: `Installing OpenSearch ${v}` });
      const arch = ARM ? 'arm64' : 'x64';
      const url = `https://artifacts.opensearch.org/releases/core/opensearch/${v}/opensearch-min-${v}-linux-${arch}.tar.gz`;
      const sumRes = await fetch(`${url}.sha512`);
      if (!sumRes.ok) throw new Error(`No checksum for OpenSearch ${v} (HTTP ${sumRes.status})`);
      const sha512 = (await sumRes.text()).trim().split(/\s+/)[0];
      const d = await fetchTmp(url, 'opensearch.tar.gz', sha512, 'sha512', report, signal);
      try {
        report({ step: S.unpack, detail: 'opensearch (core) + Java runtime' });
        await untar(d.file, join(d.tmp, 'x'));
        const root = readdirSync(join(d.tmp, 'x')).find((e) => e.startsWith('opensearch-'));
        if (!root) throw new Error('opensearch-* folder not found in the download');
        // Its JDK is for Linux; DevCatz runs it on Temurin for macOS.
        rmSync(join(d.tmp, 'x', root, 'jdk'), { recursive: true, force: true });
        check(signal);
        // Java: Eclipse Temurin 21 JRE (Adoptium API, SHA-256).
        const jre = (await (await fetch(`https://api.adoptium.net/v3/assets/latest/21/hotspot?architecture=${ARM ? 'aarch64' : 'x64'}&image_type=jre&os=mac&vendor=eclipse`)).json()) as {
          release_name: string;
          binary: { package: { link: string; checksum: string } };
        }[];
        const pkg = jre[0]?.binary.package;
        if (!pkg) throw new Error('No Temurin 21 JRE for this Mac');
        const j = await fetchTmp(pkg.link, 'jre.tar.gz', pkg.checksum, 'sha256', report, signal);
        try {
          await untar(j.file, join(j.tmp, 'x'));
          const jroot = readdirSync(join(j.tmp, 'x')).find((e) => e.startsWith('jdk'));
          if (!jroot) throw new Error('Java runtime folder not found');
          report({ step: S.place, detail: join(dir, 'opensearch') });
          place(join(j.tmp, 'x', jroot), join(dir, 'jre'));
        } finally {
          rmSync(j.tmp, { recursive: true, force: true });
        }
        place(join(d.tmp, 'x', root), join(dir, 'opensearch'));
        await run('xattr', ['-dr', 'com.apple.quarantine', dir]);
      } finally {
        rmSync(d.tmp, { recursive: true, force: true });
      }
    },
    latest: async () => (await latestTag('opensearch-project/OpenSearch')).replace(/^v/, ''),
    async version(dir) {
      const lib = join(dir, 'opensearch', 'lib');
      if (!existsSync(lib) || !existsSync(javaHome(dir))) return null;
      return readdirSync(lib).map((f) => f.match(/^opensearch-(\d+\.\d+\.\d+)\.jar$/)?.[1]).find(Boolean) ?? null;
    },
    spec(c, dir) {
      const conf = join(c.dataDir, 'config');
      // Own config folder (OPENSEARCH_PATH_CONF), copied from the build once.
      if (!existsSync(join(conf, 'opensearch.yml'))) cpSync(join(dir, 'opensearch', 'config'), conf, { recursive: true });
      const origin = c.allowedOrigins.trim() || '*';
      return {
        command:
          `${q(join(dir, 'opensearch', 'bin', 'opensearch'))} -E http.port=${c.port} -E transport.port=${c.extraPort} -E network.host=127.0.0.1 ` +
          `-E discovery.type=single-node -E path.data=${q(join(c.dataDir, 'data'))} -E path.logs=${q(join(c.dataDir, 'logs'))} ` +
          `-E http.cors.enabled=true -E http.cors.allow-origin=${q(origin === '*' ? '*' : origin.split(/[\s,]+/)[0])} -E cluster.name=devcatz`,
        env: { OPENSEARCH_JAVA_HOME: javaHome(dir), OPENSEARCH_PATH_CONF: conf, OPENSEARCH_JAVA_OPTS: `-Xms${c.memoryMb}m -Xmx${c.memoryMb}m` },
      };
    },
  },
  manticore: {
    name: 'Manticore',
    description: 'SQL-first full-text search (MySQL protocol and HTTP JSON), real-time tables, very low memory.',
    exe: 'manticore/bin/searchd',
    fields: { key: null, extraPort: 'SQL (MySQL) port', memory: false },
    features: { keys: false, facets: true, editSettings: false, schemaOnCreate: true, tasks: false, backups: false, filters: true, http: true },
    defaults: { port: 9308, extraPort: 9306, domain: 'manticore' },
    needsKey: false,
    async install(dir, report, signal) {
      report({ step: S.find, detail: 'repo.manticoresearch.com (macOS builds)' });
      const base = 'https://repo.manticoresearch.com/repository/manticoresearch_macos/release/';
      const listing = await (await fetch(base)).text();
      const arch = ARM ? 'arm64' : 'x86_64';
      const files = [...new Set([...listing.matchAll(new RegExp(`manticore-(\\d+)\\.(\\d+)\\.(\\d+)-[\\w-]+-osx[\\d.]+-${arch}-main\\.tar\\.gz`, 'g'))].map((m) => m[0]))];
      const ver = (f: string) => f.match(/manticore-(\d+)\.(\d+)\.(\d+)/)!.slice(1).map(Number);
      const latest = files.sort((a, b) => {
        const [x, y] = [ver(a), ver(b)];
        return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
      }).at(-1);
      if (!latest) throw new Error('No Manticore build for this Mac');
      report({ title: `Installing Manticore ${ver(latest).join('.')}` });
      const d = await fetchTmp(base + latest, 'manticore.tar.gz', '', 'sha256', report, signal);
      try {
        report({ step: S.unpack, detail: latest });
        await untar(d.file, join(d.tmp, 'x'));
        if (!existsSync(join(d.tmp, 'x', 'bin', 'searchd'))) throw new Error('searchd not found in the download');
        report({ step: S.place, detail: join(dir, 'manticore') });
        place(join(d.tmp, 'x'), join(dir, 'manticore'));
        await run('xattr', ['-dr', 'com.apple.quarantine', join(dir, 'manticore')]);
      } finally {
        rmSync(d.tmp, { recursive: true, force: true });
      }
    },
    latest: async () => {
      const arch = ARM ? 'arm64' : 'x86_64';
      const listing = await (await fetch('https://repo.manticoresearch.com/repository/manticoresearch_macos/release/')).text();
      const vs = [...listing.matchAll(new RegExp(`manticore-(\\d+\\.\\d+\\.\\d+)-[\\w-]+-osx[\\d.]+-${arch}-main\\.tar\\.gz`, 'g'))].map((m) => m[1]);
      const best = vs.reduce<string | null>((a, b) => (!a || isNewer(b, a) ? b : a), null);
      if (!best) throw new Error('No Manticore build');
      return best;
    },
    async version(dir) {
      const r = await run(join(dir, 'manticore', 'bin', 'searchd'), ['--version'], { timeout: 15_000 });
      return `${r.stdout}${r.stderr}`.match(/Manticore\s+([\d.]+)/)?.[1] ?? null;
    },
    spec(c, dir) {
      const file = join(c.dataDir, 'searchd.conf');
      writeFileSync(
        file,
        [
          'searchd {',
          `  listen = 127.0.0.1:${c.extraPort}:mysql`,
          `  listen = 127.0.0.1:${c.port}:http`,
          `  data_dir = ${join(c.dataDir, 'data')}`,
          `  log = ${join(c.dataDir, 'searchd.log')}`,
          `  query_log = ${join(c.dataDir, 'query.log')}`,
          `  pid_file = ${join(c.dataDir, 'searchd.pid')}`,
          '}',
          '',
        ].join('\n'),
      );
      mkdirSync(join(c.dataDir, 'data'), { recursive: true });
      return { command: `${q(join(dir, 'manticore', 'bin', 'searchd'))} --nodetach --config ${q(file)}`, env: {} };
    },
  },
  zincsearch: {
    name: 'ZincSearch',
    description: 'Lightweight Elasticsearch alternative in one Go binary: Elasticsearch-compatible API (/es), web UI, low memory.',
    exe: 'zincsearch',
    fields: { key: 'Admin password', extraPort: null, memory: false },
    features: { keys: false, facets: true, editSettings: true, schemaOnCreate: false, tasks: false, backups: false, filters: true, http: true },
    defaults: { port: 4080, extraPort: 0, domain: 'zincsearch' },
    needsKey: true,
    admin: '/',
    async install(dir, report, signal) {
      report({ step: S.find, detail: 'github.com/zincsearch/zincsearch releases' });
      const a = await githubAsset('zincsearch/zincsearch', ARM ? /^zincsearch_.+_darwin_arm64\.tar\.gz$/ : /^zincsearch_.+_darwin_x86_64\.tar\.gz$/);
      const v = a.tag.replace(/^v/, '');
      report({ title: `Installing ZincSearch ${v}` });
      const d = await fetchTmp(a.url, 'zincsearch.tar.gz', a.sha256, 'sha256', report, signal);
      try {
        report({ step: S.unpack, detail: 'tar.gz' });
        await untar(d.file, join(d.tmp, 'x'));
        const bin = join(d.tmp, 'x', 'zincsearch');
        if (!existsSync(bin)) throw new Error('zincsearch not found in the download');
        report({ step: S.place, detail: join(dir, 'zincsearch') });
        chmodSync(bin, 0o755);
        place(bin, join(dir, 'zincsearch'));
        // `zincsearch version` needs credentials, so the release tag is kept next to it.
        writeFileSync(join(dir, 'VERSION'), v);
      } finally {
        rmSync(d.tmp, { recursive: true, force: true });
      }
    },
    latest: async () => (await githubAsset('zincsearch/zincsearch', ARM ? /^zincsearch_.+_darwin_arm64\.tar\.gz$/ : /^zincsearch_.+_darwin_x86_64\.tar\.gz$/)).tag.replace(/^v/, ''),
    async version(dir) {
      if (!existsSync(join(dir, 'zincsearch'))) return null;
      try {
        return readFileSync(join(dir, 'VERSION'), 'utf8').trim() || null;
      } catch {
        return null;
      }
    },
    spec(c, dir) {
      return {
        command: q(join(dir, 'zincsearch')),
        env: {
          // Only read when the data folder is new; DevCatz changes the password through the API afterwards.
          ZINC_FIRST_ADMIN_USER: 'admin',
          ZINC_FIRST_ADMIN_PASSWORD: c.key,
          ZINC_DATA_PATH: join(c.dataDir, 'data'),
          ZINC_SERVER_ADDRESS: '127.0.0.1',
          ZINC_SERVER_PORT: String(c.port),
          ZINC_TELEMETRY: 'false',
          GIN_MODE: 'release',
        },
      };
    },
  },
  sonic: {
    name: 'Sonic',
    description: 'Tiny schema-less search backend (Rust, a few MB of RAM): returns ids for words, typo-tolerant, suggestions; TCP protocol, no HTTP.',
    exe: 'sonic',
    fields: { key: 'Channel password', extraPort: null, memory: false },
    features: { keys: false, facets: false, editSettings: false, schemaOnCreate: false, tasks: false, backups: false, filters: false, http: false },
    defaults: { port: 1491, extraPort: 0, domain: 'sonic' },
    needsKey: true,
    async install(dir, report, signal) {
      report({ step: S.find, detail: 'formulae.brew.sh (Homebrew bottle of sonic)' });
      const f = (await (await fetch('https://formulae.brew.sh/api/formula/sonic.json')).json()) as {
        versions: { stable: string };
        bottle: { stable: { files: Record<string, { url: string; sha256: string }> } };
      };
      // Bottles are per macOS release: this one, else the newest older one (they run on later releases).
      const NAMES = ['golden_gate', 'tahoe', 'sequoia', 'sonoma', 'ventura', 'monterey'];
      const darwin = Number(release().split('.')[0]);
      const mine = Math.max(0, NAMES.length - 1 - (darwin - 21));
      const files = f.bottle.stable.files;
      const pick = NAMES.slice(Math.min(mine, NAMES.length - 1)).map((n) => (ARM ? `arm64_${n}` : n)).find((n) => files[n]);
      if (!pick) throw new Error(`No Sonic build for this Mac (Homebrew has ${Object.keys(files).join(', ')})`);
      const v = f.versions.stable;
      report({ title: `Installing Sonic ${v}` });
      const token = ((await (await fetch('https://ghcr.io/token?scope=repository:homebrew/core/sonic:pull')).json()) as { token: string }).token;
      const d = await fetchTmp(files[pick].url, 'sonic.tar.gz', files[pick].sha256, 'sha256', report, signal, { Authorization: `Bearer ${token}` });
      try {
        report({ step: S.unpack, detail: `bottle ${pick}` });
        await untar(d.file, join(d.tmp, 'x'));
        const bin = join(d.tmp, 'x', 'sonic', v, 'bin', 'sonic');
        if (!existsSync(bin)) throw new Error('sonic not found in the bottle');
        report({ step: S.place, detail: join(dir, 'sonic') });
        chmodSync(bin, 0o755);
        place(bin, join(dir, 'sonic'));
        await run('xattr', ['-dr', 'com.apple.quarantine', dir]);
      } finally {
        rmSync(d.tmp, { recursive: true, force: true });
      }
    },
    latest: () => brewLatest('sonic'),
    async version(dir) {
      const r = await run(join(dir, 'sonic'), ['--version'], { timeout: 15_000 });
      return `${r.stdout}${r.stderr}`.match(/sonic-server\s+([\d.]+)/)?.[1] ?? null;
    },
    spec(c, dir) {
      const file = join(c.dataDir, 'sonic.cfg');
      const store = (p: string) => JSON.stringify(join(c.dataDir, 'store', p) + '/');
      writeFileSync(
        file,
        [
          // Same layout as Sonic's own config.cfg (1.10).
          '[server]',
          'log_level = "info"',
          '[channel]',
          `inet = "127.0.0.1:${c.port}"`,
          'tcp_timeout = 300',
          `auth_password = ${JSON.stringify(c.key)}`,
          '[normalization]',
          'unicode_normalization = "none"',
          'diacritic_folding_enabled = false',
          'stemming_enabled = false',
          '[tokenization]',
          'detect_special_patterns = true',
          'compat_split_special_patterns = true',
          '[search]',
          'query_limit_default = 20',
          'query_limit_maximum = 200',
          'query_alternates_try = 4',
          'query_minimum_term_idf_default = 0.1',
          'query_minimum_term_idf_minimum_object_count = 100',
          'suggest_limit_default = 5',
          'suggest_limit_maximum = 20',
          'list_limit_default = 100',
          'list_limit_maximum = 500',
          '[store.kv]',
          `path = ${store('kv')}`,
          'retain_word_objects = 1000',
          'pool.inactive_after = 1800',
          'database.flush_after = 900',
          'database.compression_type = "zstd"',
          'database.parallelism = 2',
          'database.max_files = 100',
          'database.write_buffer_size = 16384',
          'database.write_ahead_log = true',
          '[store.fst]',
          `path = ${store('fst')}`,
          'pool.inactive_after = 300',
          'graph.consolidate_after = 30',
          'graph.max_size = 2048',
          'graph.max_words = 250000',
          '',
        ].join('\n'),
      );
      return { command: `${q(join(dir, 'sonic'))} -c ${q(file)}`, env: {} };
    },
  },
};

// ------------------------------------------------------------------ Sonic Channel (TCP)

/** One Sonic Channel session: START <mode>, the commands in order, QUIT; each command's final line (OK / RESULT / EVENT …). */
function sonicSession(c: SearchConfig, mode: 'search' | 'ingest' | 'control', cmds: string[]): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const s = connect(c.port, '127.0.0.1');
    let buf = '';
    let started = false;
    const out: string[] = [];
    let i = 0;
    const timer = setTimeout(() => {
      s.destroy();
      reject(new Error('Sonic: no answer in 15 s'));
    }, 15_000);
    const done = (err?: Error) => {
      clearTimeout(timer);
      s.end('QUIT\r\n');
      if (err) reject(err);
      else resolve(out);
    };
    const next = () => {
      if (i >= cmds.length) return done();
      s.write(`${cmds[i++]}\r\n`);
    };
    s.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error(`Sonic: ${e.message}`));
    });
    s.on('data', (d) => {
      buf += d.toString();
      let nl: number;
      while ((nl = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 2);
        if (line.startsWith('CONNECTED')) s.write(`START ${mode} ${c.key}\r\n`);
        else if (line.startsWith('STARTED')) (started = true), next();
        else if (line.startsWith('ERR')) return done(new Error(`Sonic: ${line.slice(4)}${started ? '' : ' (wrong password?)'}`));
        else if (line.startsWith('PENDING') || line.startsWith('ENDED')) continue;
        else if (started) out.push(line), next();
      }
    });
  });
}

/** Sonic text: one line, quotes escaped, within the channel buffer (20 000 bytes). */
const sonicText = (s: string) => s.replace(/[\r\n\t]+/g, ' ').replace(/\\/g, ' ').replace(/"/g, '\\"').slice(0, 18_000);
const sonicName = (s: string) => {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(s)) throw new Error('Sonic collections: letters, digits, _ and - (no spaces or dots)');
  return s;
};
/** Sonic keeps only ids: DevCatz keeps each collection's documents next to it (shown in the playground, exported). */
const sonicDocsFile = (c: SearchConfig, collection: string) => join(c.dataDir, 'devcatz-docs', `${sonicName(collection)}.json`);
function sonicDocs(c: SearchConfig, collection: string): Record<string, Record<string, unknown>> {
  try {
    return JSON.parse(readFileSync(sonicDocsFile(c, collection), 'utf8')) as Record<string, Record<string, unknown>>;
  } catch {
    return {};
  }
}
function saveSonicDocs(c: SearchConfig, collection: string, docs: Record<string, Record<string, unknown>>): void {
  mkdirSync(join(c.dataDir, 'devcatz-docs'), { recursive: true });
  writeFileSync(sonicDocsFile(c, collection), JSON.stringify(docs));
}
/** The words Sonic indexes for a document: its string and number values. */
const docText = (d: Record<string, unknown>): string =>
  Object.entries(d)
    .filter(([k]) => k !== 'id')
    .flatMap(([, v]) => (typeof v === 'string' || typeof v === 'number' ? [String(v)] : Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []))
    .join(' ');

/** ISO 8601 duration (Meilisearch: PT0.012345S) → ms. */
const isoMs = (d: string | null | undefined): number | null => {
  const m = d?.match(/^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?$/);
  return m ? Math.round(((Number(m[1] ?? 0) * 24 + Number(m[2] ?? 0)) * 3600 + Number(m[3] ?? 0) * 60 + Number(m[4] ?? 0)) * 1000) : null;
};

/** OpenSearch's Java: the Temurin JRE DevCatz installed next to it. */
const javaHome = (dir: string) => join(dir, 'jre', 'Contents', 'Home');

export const searchId = (kind: SearchKind) => `search:${kind}`;
const managedDir = (kind: SearchKind) => dataDir('search', kind);
export const binaryDirOf = (c: Pick<SearchConfig, 'kind' | 'binaryDir'>) => c.binaryDir || join(managedDir(c.kind), 'bin');
const portsOf = (c: SearchConfig) => [c.port, ...(c.extraPort ? [c.extraPort] : [])];
const LABEL = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;
const NAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/;

export function defaultsFor(kind: SearchKind): SearchConfig {
  const e = ENGINES[kind];
  return {
    kind,
    ...e.defaults,
    key: e.needsKey ? createHash('sha256').update(`${kind}:${Date.now()}:${Math.random()}`).digest('base64url').slice(0, 32) : '',
    memoryMb: store.settings.searchOpenSearchHeapMb || 512,
    allowedOrigins: store.settings.searchAllowedOrigins || '*',
    dataDir: join(managedDir(kind), 'data'),
    binaryDir: join(managedDir(kind), 'bin'),
    autoStart: true,
  };
}

// ------------------------------------------------------------------ manager

export class SearchManager {
  readonly processes = new ProcessManager('search-pids.json');
  private tasks = new Map<SearchKind, TaskProgress>();
  private aborts = new Map<SearchKind, AbortController>();
  private errors = new Map<SearchKind, string>();
  /** Newer releases found by checkUpdates (kind → version). */
  private updates = new Map<SearchKind, string>();
  /** Extra arguments for the next start only (Meilisearch --import-dump / --import-snapshot). */
  private oneShot = new Map<SearchKind, string>();
  /** Latest index / document counts (Monitoring). */
  readonly lastCounts = new Map<SearchKind, { indexes: number; docs: number }>();
  onChange: () => void = () => undefined;
  takenDomains: () => string[] = () => [];

  constructor() {
    this.processes.on('status', () => this.onChange());
    this.processes.on('log', (lines: LogLine[]) => {
      for (const l of lines) {
        try {
          appendFileSync(join(dataDir('logs'), `search-${l.projectId.replace(/^search:/, '')}.log`), `${new Date(l.time).toISOString()} ${l.stream} ${l.text}\n`);
        } catch {
          /* best effort */
        }
      }
    });
    setInterval(() => void this.poll(), 1500);
    // Update check shortly after launch, then every 6 hours.
    setTimeout(() => void this.checkUpdates(), 30_000);
    setInterval(() => void this.checkUpdates(), 6 * 3600_000);
    setInterval(() => {
      for (const kind of SEARCH_KINDS) {
        if (this.config(kind) && this.processes.getStatus(searchId(kind)).status === 'running') {
          void this.indexes(kind)
            .then((list) => this.lastCounts.set(kind, { indexes: list.length, docs: list.reduce((n, i) => n + i.docs, 0) }))
            .catch(() => undefined);
        }
      }
    }, 15_000);
  }

  /** "Starts with DevCatz" only: saved without restarting a running service. */
  setAutoStart(kind: SearchKind, on: boolean): void {
    const c = this.config(kind);
    if (!c) throw new Error('Not installed');
    store.setSearchEngine(kind, { ...c, autoStart: on });
    this.onChange();
  }

  config(kind: SearchKind): SearchConfig | null {
    return store.searchEngines[kind] ?? null;
  }

  private cfg(kind: SearchKind): SearchConfig {
    const c = this.config(kind);
    if (!c) throw new Error(`${ENGINES[kind].name} is not installed`);
    if (!this.isActive(kind)) throw new Error(`${ENGINES[kind].name} is not running`);
    return c;
  }

  private async poll(): Promise<void> {
    for (const kind of SEARCH_KINDS) {
      const c = this.config(kind);
      if (!c || this.processes.getStatus(searchId(kind)).status !== 'starting') continue;
      if (await isPortOpen(c.port)) {
        this.processes.markRunning(searchId(kind));
        this.processes.log(searchId(kind), 'sys', `Ready → https://${host(c.domain)}`);
      }
    }
  }

  /** Hides a task that ended (done, failed or cancelled). */
  dismissTask(kind: SearchKind): void {
    const t = this.tasks.get(kind);
    if (t && (t.done || t.error)) {
      this.tasks.delete(kind);
      this.onChange();
    }
  }

  private task(kind: SearchKind, init: TaskProgress) {
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
      fail: (err: unknown): never => {
        report({ error: (err as Error).message });
        throw err;
      },
      finish: () => {
        report({ step: this.tasks.get(kind)?.steps.length ?? 0, done: true, detail: undefined, received: undefined, total: undefined });
        setTimeout(() => {
          if (this.tasks.get(kind)?.done) {
            this.tasks.delete(kind);
            this.onChange();
          }
        }, 4000);
      },
    };
  }

  validate(c: SearchConfig): void {
    for (const p of portsOf(c)) if (!Number.isInteger(p) || p < 1024 || p > 65535) throw new Error(`Port ${p}: 1024–65535`);
    if (new Set(portsOf(c)).size !== portsOf(c).length) throw new Error('Ports must differ');
    if (!LABEL.test(c.domain)) throw new Error(`Domain "${c.domain}": lowercase letters, digits, hyphens and dots`);
    if (this.takenDomains().includes(host(c.domain))) throw new Error(`${host(c.domain)} is already used`);
    for (const kind of SEARCH_KINDS) {
      const o = this.config(kind);
      if (!o || kind === c.kind) continue;
      const clash = portsOf(c).find((p) => portsOf(o).includes(p));
      if (clash) throw new Error(`Port ${clash} is used by ${ENGINES[kind].name}`);
      if (o.domain === c.domain) throw new Error(`${host(c.domain)} is used by ${ENGINES[kind].name}`);
    }
    if (ENGINES[c.kind].needsKey && (!c.key || c.key.length < 16)) throw new Error(`${ENGINES[c.kind].fields.key}: at least 16 characters`);
    if (c.kind === 'opensearch' && (!Number.isInteger(c.memoryMb) || c.memoryMb < 256 || c.memoryMb > 32768)) throw new Error('Heap: 256–32768 MB');
  }

  async install(kind: SearchKind, input: SearchConfig): Promise<void> {
    if (this.config(kind)) throw new Error(`${ENGINES[kind].name} is already installed`);
    if (this.aborts.has(kind)) throw new Error(`${ENGINES[kind].name} is already being installed`);
    const c = { ...input, kind };
    this.validate(c);
    const steps = [...STEPS, ...(c.autoStart ? ['Starting'] : [])];
    const t = this.task(kind, { kind: 'install', title: `Installing ${ENGINES[kind].name}`, steps, step: 0 });
    const abort = new AbortController();
    this.aborts.set(kind, abort);
    const dir = binaryDirOf(c);
    const fresh = !existsSync(join(dir, ENGINES[kind].exe));
    const dataExisted = existsSync(c.dataDir);
    try {
      await ENGINES[kind].install(dir, t.report, abort.signal);
      check(abort.signal);
      t.report({ step: S.version, detail: join(dir, ENGINES[kind].exe), received: undefined, total: undefined });
      c.version = await ENGINES[kind].version(dir);
      if (!c.version) throw new Error(`${ENGINES[kind].name} does not run on this Mac`);
      t.report({ title: `Installing ${ENGINES[kind].name} ${c.version}`, step: S.data, detail: c.dataDir });
      mkdirSync(c.dataDir, { recursive: true });
      this.aborts.delete(kind);
      t.report({ step: S.save, detail: `https://${host(c.domain)}` });
      store.setSearchEngine(kind, c);
      this.onChange();
      if (c.autoStart) {
        t.report({ step: STEPS.length, detail: `127.0.0.1:${c.port}` });
        await this.action(kind, 'start');
      }
      t.finish();
    } catch (err) {
      if (err instanceof Cancelled || abort.signal.aborted) {
        if (fresh) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
        if (!dataExisted) await rm(c.dataDir, { recursive: true, force: true }).catch(() => undefined);
        t.report({ cancelled: true, error: 'Install cancelled; nothing was kept.', received: undefined, total: undefined });
        throw new Error('Install cancelled');
      }
      t.fail(err);
    } finally {
      this.aborts.delete(kind);
    }
  }

  /** Returns the names of the services that could not be checked (offline, GitHub rate limit …). */
  async checkUpdates(): Promise<string[]> {
    const failed: string[] = [];
    await Promise.all(
      SEARCH_KINDS.map(async (kind) => {
        const c = this.config(kind);
        if (!c) return void this.updates.delete(kind);
        const v = await ENGINES[kind].latest().catch(() => null);
        if (!v) failed.push(ENGINES[kind].name);
        else if (isNewer(v, c.version)) this.updates.set(kind, v);
        else this.updates.delete(kind);
      }),
    );
    this.onChange();
    return failed;
  }

  /** Newer release in place of the current binaries (data folder and settings stay). */
  async upgrade(kind: SearchKind): Promise<void> {
    const c = this.config(kind);
    if (!c) throw new Error(`${ENGINES[kind].name} is not installed`);
    if (this.aborts.has(kind)) throw new Error(`${ENGINES[kind].name} is busy`);
    const steps = [...STEPS.slice(0, 5), ...UPDATE_TAIL];
    const t = this.task(kind, { kind: 'update', title: `Updating ${ENGINES[kind].name}`, steps, step: 0 });
    const abort = new AbortController();
    this.aborts.set(kind, abort);
    const dir = binaryDirOf(c);
    try {
      const v = await upgradeBinaries({
        binDir: dir,
        install: (d, report, signal) => ENGINES[kind].install(d, report, signal),
        stop: () => this.processes.stop(searchId(kind)),
        start: () => this.action(kind, 'start'),
        wasActive: this.isActive(kind),
        version: () => ENGINES[kind].version(dir),
        report: t.report,
        signal: abort.signal,
        tailAt: 5,
      });
      store.setSearchEngine(kind, { ...this.config(kind)!, version: v });
      this.updates.delete(kind);
      this.processes.log(searchId(kind), 'sys', `Updated ${c.version ?? ''} → ${v}`);
      t.report({ title: `Updated ${ENGINES[kind].name} to ${v}` });
      t.finish();
    } catch (err) {
      t.fail(abort.signal.aborted ? new Error('Update cancelled; the current version was kept') : err);
    } finally {
      this.aborts.delete(kind);
      this.onChange();
    }
  }

  cancelInstall(kind: SearchKind): void {
    this.aborts.get(kind)?.abort();
  }

  async update(kind: SearchKind, input: SearchConfig): Promise<void> {
    const old = this.config(kind);
    if (!old) throw new Error('Not installed');
    const c = { ...old, ...input, kind, version: old.version, binaryDir: old.binaryDir };
    this.validate(c);
    mkdirSync(c.dataDir, { recursive: true });
    // A new master key invalidates the search-only key derived from the old one.
    if (c.key !== old.key) c.searchKey = undefined;
    // ZincSearch reads the first admin password once: change it through the API (with the old one).
    if (kind === 'zincsearch' && c.key !== old.key) {
      if (!this.isActive(kind)) throw new Error('Start ZincSearch first to change its admin password');
      await this.api(old, 'POST', '/api/user', { _id: 'admin', name: 'admin', role: 'admin', password: c.key });
    }
    store.setSearchEngine(kind, c);
    if (this.isActive(kind)) await this.action(kind, 'restart');
    this.onChange();
  }

  async uninstall(kind: SearchKind, deleteData: boolean): Promise<void> {
    const c = this.config(kind);
    if (!c) return;
    const steps = ['Stopping the engine', 'Removing the binaries', ...(deleteData ? ['Deleting the data folder'] : []), 'Removing settings'];
    const t = this.task(kind, { kind: 'uninstall', title: `Uninstalling ${ENGINES[kind].name}`, steps, step: 0 });
    try {
      await this.processes.stop(searchId(kind));
      t.report({ step: 1, detail: binaryDirOf(c) });
      await rm(binaryDirOf(c), { recursive: true, force: true });
      if (deleteData) {
        t.report({ step: steps.indexOf('Deleting the data folder'), detail: c.dataDir });
        await rm(c.dataDir, { recursive: true, force: true });
      }
      t.report({ step: steps.indexOf('Removing settings') });
      store.setSearchEngine(kind, null);
      this.processes.clearLogs(searchId(kind));
      t.finish();
    } catch (err) {
      t.fail(err);
    }
  }

  isActive(kind: SearchKind): boolean {
    return this.processes.isActive(searchId(kind));
  }

  async action(kind: SearchKind, action: StorageAction): Promise<void> {
    const id = searchId(kind);
    const c = this.config(kind);
    if (!c) throw new Error(`${ENGINES[kind].name} is not installed`);
    if (action === 'stop' || action === 'restart') await this.processes.stop(id);
    if (action === 'stop') return;
    for (let i = 0; i < 15 && (await isPortOpen(c.port)); i++) await new Promise((r) => setTimeout(r, 300));
    for (const port of portsOf(c)) {
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
    const dir = binaryDirOf(c);
    if (!existsSync(join(dir, ENGINES[kind].exe))) throw new Error(`${ENGINES[kind].name} is missing; reinstall it`);
    mkdirSync(c.dataDir, { recursive: true });
    const s = ENGINES[kind].spec(c, dir);
    const extra = this.oneShot.get(kind);
    this.oneShot.delete(kind);
    this.processes.startMany(id, [{ label: '', command: extra ? `${s.command} ${extra}` : s.command, env: s.env, cwd: c.dataDir }]);
  }

  autoStart(): void {
    for (const kind of SEARCH_KINDS) if (this.config(kind)?.autoStart) this.action(kind, 'start').catch((e) => console.error(`${kind}:`, e.message));
  }

  stopAll(): Promise<void> {
    return this.processes.stopAll();
  }

  routes(): Route[] {
    return SEARCH_KINDS.flatMap((kind) => {
      const c = this.config(kind);
      // Sonic speaks TCP only: nothing to proxy.
      return c && ENGINES[kind].features.http ? [{ domain: host(c.domain), port: c.port, projectName: ENGINES[kind].name, running: this.isActive(kind), secure: true }] : [];
    });
  }

  state(): SearchState[] {
    return SEARCH_KINDS.map((kind) => {
      const c = this.config(kind);
      const e = ENGINES[kind];
      return {
        kind,
        name: e.name,
        description: e.description,
        fields: e.fields,
        features: e.features,
        installed: Boolean(c),
        config: c,
        defaults: defaultsFor(kind),
        status: this.processes.getStatus(searchId(kind)).status,
        error: this.errors.get(kind) ?? null,
        task: this.tasks.get(kind) ?? null,
        update: c ? (this.updates.get(kind) ?? null) : null,
        urls: !c
          ? null
          : e.features.http
            ? { http: `https://${host(c.domain)}`, httpLocal: `http://127.0.0.1:${c.port}`, admin: e.admin ? `https://${host(c.domain)}${e.admin}` : null }
            : { http: `tcp://127.0.0.1:${c.port}`, httpLocal: `tcp://127.0.0.1:${c.port}`, admin: null },
      };
    });
  }

  // ------------------------------------------------------------------ HTTP API of each engine

  private async api<T>(c: SearchConfig, method: string, path: string, body?: unknown, contentType = 'application/json'): Promise<T> {
    const headers: Record<string, string> = {};
    if (c.kind === 'meilisearch') headers.Authorization = `Bearer ${c.key}`;
    if (c.kind === 'typesense') headers['X-TYPESENSE-API-KEY'] = c.key;
    if (c.kind === 'zincsearch') headers.Authorization = `Basic ${Buffer.from(`admin:${c.key}`).toString('base64')}`;
    if (body !== undefined) headers['Content-Type'] = contentType;
    const res = await fetch(`http://127.0.0.1:${c.port}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    let data: unknown = text;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      /* text */
    }
    if (!res.ok) {
      const d = data as { message?: string; error?: string | { reason?: string; type?: string } };
      const msg = d?.message ?? (typeof d?.error === 'string' ? d.error : d?.error?.reason) ?? text.slice(0, 300);
      throw new Error(`${ENGINES[c.kind].name}: ${msg || `HTTP ${res.status}`}`);
    }
    return data as T;
  }

  /** Manticore SQL over HTTP (/sql?mode=raw): one result set per statement. */
  private async sql(c: SearchConfig, query: string): Promise<{ columns?: Record<string, unknown>[]; data?: Record<string, unknown>[]; error?: string; total?: number }[]> {
    const r = await this.api<{ columns?: Record<string, unknown>[]; data?: Record<string, unknown>[]; error?: string; total?: number }[] | { error?: string }>(
      c,
      'POST',
      '/sql?mode=raw',
      `query=${encodeURIComponent(query)}`,
      'application/x-www-form-urlencoded',
    );
    const sets = Array.isArray(r) ? r : [r];
    const err = sets.find((s) => s.error)?.error;
    if (err) throw new Error(`Manticore: ${err}`);
    return sets as { columns?: Record<string, unknown>[]; data?: Record<string, unknown>[]; total?: number }[];
  }

  /** Meilisearch work is queued: wait for a task (≤ 15 s) so errors surface. */
  private async meiliWait(c: SearchConfig, uid: number, tries = 60): Promise<void> {
    for (let i = 0; i < tries; i++) {
      const t = await this.api<{ status: string; error?: { message: string } }>(c, 'GET', `/tasks/${uid}`);
      if (t.status === 'succeeded') return;
      if (t.status === 'failed' || t.status === 'canceled') throw new Error(`Meilisearch: ${t.error?.message ?? t.status}`);
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  private checkName(name: string): void {
    if (!NAME.test(name)) throw new Error('Index name: letters, digits, _ . - (starting with a letter, digit or _)');
  }

  async indexes(kind: SearchKind): Promise<SearchIndex[]> {
    const c = this.cfg(kind);
    if (kind === 'meilisearch') {
      const [list, stats] = await Promise.all([
        this.api<{ results: { uid: string; primaryKey: string | null }[] }>(c, 'GET', '/indexes?limit=1000'),
        this.api<{ indexes: Record<string, { numberOfDocuments: number; rawDocumentDbSize?: number }> }>(c, 'GET', '/stats'),
      ]);
      return list.results.map((i) => ({ name: i.uid, docs: stats.indexes[i.uid]?.numberOfDocuments ?? 0, sizeBytes: stats.indexes[i.uid]?.rawDocumentDbSize ?? null, primaryKey: i.primaryKey }));
    }
    if (kind === 'typesense') {
      const list = await this.api<{ name: string; num_documents: number }[]>(c, 'GET', '/collections');
      return list.map((x) => ({ name: x.name, docs: x.num_documents, sizeBytes: null, primaryKey: 'id' }));
    }
    if (kind === 'opensearch') {
      const list = await this.api<{ index: string; 'docs.count': string; 'store.size': string }[]>(c, 'GET', '/_cat/indices?format=json&bytes=b');
      return list
        .filter((x) => !x.index.startsWith('.'))
        .map((x) => ({ name: x.index, docs: Number(x['docs.count']) || 0, sizeBytes: Number(x['store.size']) || null, primaryKey: '_id' }))
        .sort((a, b) => a.name.localeCompare(b.name));
    }
    if (kind === 'zincsearch') {
      const r = await this.api<{ list: { name: string; stats?: { doc_num?: number; storage_size?: number } }[] }>(c, 'GET', '/api/index?page_size=1000');
      return (r.list ?? []).map((x) => ({ name: x.name, docs: x.stats?.doc_num ?? 0, sizeBytes: x.stats?.storage_size ?? null, primaryKey: '_id' })).sort((a, b) => a.name.localeCompare(b.name));
    }
    if (kind === 'sonic') {
      const dir = join(c.dataDir, 'devcatz-docs');
      const names = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)) : [];
      return names.sort().map((name) => ({ name, docs: Object.keys(sonicDocs(c, name)).length, sizeBytes: statSync(sonicDocsFile(c, name)).size, primaryKey: 'id' }));
    }
    const tables = (await this.sql(c, 'SHOW TABLES'))[0]?.data ?? [];
    return Promise.all(
      tables.map(async (t) => {
        const name = String(t.Table ?? t.Index ?? Object.values(t)[0]);
        const st = Object.fromEntries(((await this.sql(c, `SHOW TABLE ${name} STATUS`).catch(() => [{ data: [] }]))[0]?.data ?? []).map((r) => [r.Variable_name, r.Value]));
        return { name, docs: Number(st.indexed_documents) || 0, sizeBytes: Number(st.disk_bytes) || null, primaryKey: 'id' };
      }),
    );
  }

  async createIndex(kind: SearchKind, name: string, schema: string): Promise<void> {
    const c = this.cfg(kind);
    this.checkName(name);
    if (kind === 'meilisearch') {
      const t = await this.api<{ taskUid: number }>(c, 'POST', '/indexes', { uid: name, ...(schema.trim() ? { primaryKey: schema.trim() } : {}) });
      await this.meiliWait(c, t.taskUid);
    } else if (kind === 'typesense') {
      // Auto schema: fields are typed from the first documents.
      await this.api(c, 'POST', '/collections', { name, fields: [{ name: '.*', type: 'auto' }] });
    } else if (kind === 'opensearch') {
      await this.api(c, 'PUT', `/${encodeURIComponent(name.toLowerCase())}`, {});
    } else if (kind === 'zincsearch') {
      await this.api(c, 'POST', '/api/index', { name, storage_type: 'disk' });
    } else if (kind === 'sonic') {
      // Sonic makes collections on the first push; the (empty) document file lists it.
      if (existsSync(sonicDocsFile(c, name))) throw new Error(`${name} already exists`);
      saveSonicDocs(c, name, {});
    } else {
      if (!/^[a-z_][a-z0-9_]*$/i.test(name)) throw new Error('Manticore table names: letters, digits and _');
      const cols = schema.trim() || 'title text, body text';
      if (/;/.test(cols)) throw new Error('Columns: one list, no ;');
      await this.sql(c, `CREATE TABLE ${name}(${cols})`);
    }
  }

  async deleteIndex(kind: SearchKind, name: string): Promise<void> {
    const c = this.cfg(kind);
    this.checkName(name);
    if (kind === 'meilisearch') await this.meiliWait(c, (await this.api<{ taskUid: number }>(c, 'DELETE', `/indexes/${encodeURIComponent(name)}`)).taskUid);
    else if (kind === 'typesense') await this.api(c, 'DELETE', `/collections/${encodeURIComponent(name)}`);
    else if (kind === 'opensearch') await this.api(c, 'DELETE', `/${encodeURIComponent(name)}`);
    else if (kind === 'zincsearch') await this.api(c, 'DELETE', `/api/index/${encodeURIComponent(name)}`);
    else if (kind === 'sonic') {
      await sonicSession(c, 'ingest', [`FLUSHC ${sonicName(name)}`]);
      rmSync(sonicDocsFile(c, name), { force: true });
    } else await this.sql(c, `DROP TABLE ${name}`);
  }

  async getSettings(kind: SearchKind, index: string): Promise<{ text: string; editable: boolean }> {
    const c = this.cfg(kind);
    this.checkName(index);
    const pretty = (o: unknown) => JSON.stringify(o, null, 2);
    if (kind === 'meilisearch') return { text: pretty(await this.api(c, 'GET', `/indexes/${encodeURIComponent(index)}/settings`)), editable: true };
    if (kind === 'typesense') {
      const col = await this.api<{ fields: unknown[]; default_sorting_field?: string }>(c, 'GET', `/collections/${encodeURIComponent(index)}`);
      return { text: pretty({ fields: col.fields }), editable: true };
    }
    if (kind === 'opensearch') {
      const [s, m] = await Promise.all([this.api<Record<string, { settings: unknown }>>(c, 'GET', `/${index}/_settings`), this.api<Record<string, { mappings: unknown }>>(c, 'GET', `/${index}/_mapping`)]);
      return { text: pretty({ mappings: m[index]?.mappings ?? {}, settings: s[index]?.settings ?? {} }), editable: true };
    }
    if (kind === 'zincsearch') {
      const [m, s] = await Promise.all([
        this.api<Record<string, { mappings: unknown }>>(c, 'GET', `/api/${encodeURIComponent(index)}/_mapping`),
        this.api<Record<string, { settings: unknown }>>(c, 'GET', `/api/${encodeURIComponent(index)}/_settings`),
      ]);
      return { text: pretty({ mappings: m[index]?.mappings ?? {}, settings: s[index]?.settings ?? {} }), editable: true };
    }
    if (kind === 'sonic') {
      return {
        text: pretty({
          collection: index,
          bucket: 'default',
          documents: Object.keys(sonicDocs(c, index)).length,
          note: 'Sonic has no schema: every string / number value of a document is indexed as words for its id. DevCatz keeps the documents themselves next to Sonic (devcatz-docs) for the playground and export.',
        }),
        editable: false,
      };
    }
    const r = (await this.sql(c, `SHOW CREATE TABLE ${index}`))[0]?.data?.[0] ?? {};
    return { text: String(r['Create Table'] ?? Object.values(r)[1] ?? ''), editable: false };
  }

  async saveSettings(kind: SearchKind, index: string, text: string): Promise<void> {
    const c = this.cfg(kind);
    this.checkName(index);
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error('Settings must be JSON');
    }
    if (kind === 'meilisearch') await this.meiliWait(c, (await this.api<{ taskUid: number }>(c, 'PATCH', `/indexes/${encodeURIComponent(index)}/settings`, body)).taskUid);
    else if (kind === 'typesense') {
      // Typesense schema updates: new fields are added; a changed field is dropped and added again in the same
      // request (e.g. "facet": true on an auto-typed field); `"drop": true` removes one; unchanged fields are left out.
      const cur = await this.api<{ fields: Record<string, unknown>[] }>(c, 'GET', `/collections/${encodeURIComponent(index)}`);
      const KEYS = ['type', 'facet', 'optional', 'index', 'sort', 'infix', 'locale'];
      const same = (a: Record<string, unknown>, b: Record<string, unknown>) => KEYS.every((k) => b[k] === undefined || a[k] === b[k]);
      const fields: Record<string, unknown>[] = [];
      for (const f of (body.fields as Record<string, unknown>[]) ?? []) {
        const old = cur.fields.find((x) => x.name === f.name);
        if (f.drop) fields.push({ name: f.name, drop: true });
        else if (!old) fields.push(f);
        else if (!same(old, f)) fields.push({ name: f.name, drop: true }, { ...old, ...f });
      }
      if (!fields.length) throw new Error('Typesense: nothing changed (add fields, change one, or { "name": …, "drop": true })');
      await this.api(c, 'PATCH', `/collections/${encodeURIComponent(index)}`, { fields });
    } else if (kind === 'opensearch') {
      if (body.mappings) await this.api(c, 'PUT', `/${index}/_mapping`, body.mappings);
      const settings = (body.settings as { index?: Record<string, unknown> })?.index;
      if (settings) {
        // Only dynamic settings can change on an open index.
        const { number_of_replicas, refresh_interval, max_result_window, analysis } = settings as Record<string, unknown>;
        const dyn = Object.fromEntries(Object.entries({ number_of_replicas, refresh_interval, max_result_window }).filter(([, v]) => v !== undefined));
        if (Object.keys(dyn).length) await this.api(c, 'PUT', `/${index}/_settings`, { index: dyn });
        if (analysis) throw new Error('OpenSearch: analysis settings need a closed index (close, change, reopen); mappings and dynamic settings were saved');
      }
    } else if (kind === 'zincsearch') {
      if (body.mappings) await this.api(c, 'PUT', `/api/${encodeURIComponent(index)}/_mapping`, body.mappings);
      if (body.settings && Object.keys(body.settings as object).length) await this.api(c, 'PUT', `/api/${encodeURIComponent(index)}/_settings`, body.settings);
    } else if (kind === 'sonic') throw new Error('Sonic has no settings per collection');
    else throw new Error('Manticore: change tables with ALTER TABLE (SQL)');
  }

  async search(kind: SearchKind, qy: SearchQuery): Promise<SearchResult> {
    const c = this.cfg(kind);
    this.checkName(qy.index);
    const limit = Math.min(Math.max(qy.limit || 20, 1), 200);
    const offset = Math.max(qy.offset || 0, 0);
    const facets = (qy.facets ?? []).map((f) => f.trim()).filter(Boolean);
    const strip = (h: string) => h.replace(/<(?!\/?(mark|em|b)>)[^>]*>/g, '');
    if (kind === 'meilisearch') {
      const idx = await this.api<{ primaryKey: string | null }>(c, 'GET', `/indexes/${encodeURIComponent(qy.index)}`);
      const r = await this.api<{ hits: (Record<string, unknown> & { _formatted?: Record<string, unknown> })[]; estimatedTotalHits?: number; totalHits?: number; processingTimeMs: number; facetDistribution?: Record<string, Record<string, number>> }>(
        c,
        'POST',
        `/indexes/${encodeURIComponent(qy.index)}/search`,
        {
          q: qy.q,
          limit,
          offset,
          ...(qy.filter?.trim() ? { filter: qy.filter.trim() } : {}),
          ...(qy.sort?.trim() ? { sort: qy.sort.split(',').map((s) => s.trim()).filter(Boolean) } : {}),
          ...(facets.length ? { facets } : {}),
          attributesToHighlight: ['*'],
          highlightPreTag: '<mark>',
          highlightPostTag: '</mark>',
        },
      );
      const pk = idx.primaryKey ?? 'id';
      return {
        hits: r.hits.map(({ _formatted, ...doc }) => ({
          id: String(doc[pk] ?? ''),
          doc,
          highlight: Object.fromEntries(Object.entries(_formatted ?? {}).filter(([, v]) => typeof v === 'string' && v.includes('<mark>')).map(([k, v]) => [k, strip(String(v))])),
        })),
        total: r.totalHits ?? r.estimatedTotalHits ?? r.hits.length,
        ms: r.processingTimeMs,
        facets: r.facetDistribution ?? {},
      };
    }
    if (kind === 'typesense') {
      const col = await this.api<{ fields: { name: string; type: string; facet?: boolean }[] }>(c, 'GET', `/collections/${encodeURIComponent(qy.index)}`);
      const textFields = col.fields.filter((f) => /^string(\[\])?$/.test(f.type) && f.name !== '.*').map((f) => f.name);
      const params = new URLSearchParams({
        q: qy.q || '*',
        query_by: textFields.join(',') || '*',
        per_page: String(limit),
        page: String(Math.floor(offset / limit) + 1),
        highlight_start_tag: '<mark>',
        highlight_end_tag: '</mark>',
      });
      if (qy.filter?.trim()) params.set('filter_by', qy.filter.trim());
      if (qy.sort?.trim()) params.set('sort_by', qy.sort.trim());
      if (facets.length) params.set('facet_by', facets.join(','));
      const r = await this.api<{
        found: number;
        search_time_ms: number;
        hits: { document: Record<string, unknown>; highlights?: { field: string; snippet?: string }[] }[];
        facet_counts?: { field_name: string; counts: { value: string; count: number }[] }[];
      }>(c, 'GET', `/collections/${encodeURIComponent(qy.index)}/documents/search?${params}`);
      return {
        hits: r.hits.map((h) => ({ id: String(h.document.id ?? ''), doc: h.document, highlight: Object.fromEntries((h.highlights ?? []).filter((x) => x.snippet).map((x) => [x.field, strip(x.snippet!)])) })),
        total: r.found,
        ms: r.search_time_ms,
        facets: Object.fromEntries((r.facet_counts ?? []).map((f) => [f.field_name, Object.fromEntries(f.counts.map((x) => [x.value, x.count]))])),
      };
    }
    if (kind === 'opensearch') {
      // Text: typo-tolerant multi_match over every field (query_string syntax when the query uses it); filter: query_string.
      const text = qy.q.trim();
      const syntax = /[:"*()]|\b(AND|OR|NOT)\b/.test(text);
      const must = !text
        ? { match_all: {} }
        : syntax
          ? { query_string: { query: text, default_operator: 'AND', lenient: true } }
          : { multi_match: { query: text, fields: ['*'], fuzziness: 'AUTO', lenient: true } };
      const body: Record<string, unknown> = {
        from: offset,
        size: limit,
        track_total_hits: true,
        query: { bool: { must, ...(qy.filter?.trim() ? { filter: { query_string: { query: qy.filter.trim(), lenient: true } } } : {}) } },
        highlight: { pre_tags: ['<mark>'], post_tags: ['</mark>'], fields: { '*': {} } },
      };
      if (qy.sort?.trim()) body.sort = qy.sort.split(',').map((s) => s.trim()).filter(Boolean).map((s) => {
        const [f, dir] = s.split(':');
        return { [f]: { order: dir === 'desc' ? 'desc' : 'asc' } };
      });
      if (facets.length) body.aggs = Object.fromEntries(facets.map((f) => [f, { terms: { field: f, size: 20 } }]));
      const r = await this.api<{
        took: number;
        hits: { total: { value: number } | number; hits: { _id: string; _source: Record<string, unknown>; highlight?: Record<string, string[]> }[] };
        aggregations?: Record<string, { buckets: { key: string; doc_count: number }[] }>;
      }>(c, 'POST', `/${qy.index}/_search`, body);
      return {
        hits: r.hits.hits.map((h) => ({ id: h._id, doc: h._source, highlight: Object.fromEntries(Object.entries(h.highlight ?? {}).map(([k, v]) => [k, strip(v.join(' … '))])) })),
        total: typeof r.hits.total === 'number' ? r.hits.total : r.hits.total.value,
        ms: r.took,
        facets: Object.fromEntries(Object.entries(r.aggregations ?? {}).map(([k, v]) => [k, Object.fromEntries(v.buckets.map((b) => [String(b.key), b.doc_count]))])),
      };
    }
    if (kind === 'zincsearch') {
      // Elasticsearch-compatible /es API; free text: fuzzy match over every field (_all), query_string syntax when used.
      const text = qy.q.trim();
      const syntax = /[:"*()~]|\b(AND|OR|NOT)\b/.test(text);
      const must = !text ? { match_all: {} } : syntax ? { query_string: { query: text } } : { match: { _all: { query: text, fuzziness: 'AUTO' } } };
      const body: Record<string, unknown> = {
        from: offset,
        size: limit,
        track_total_hits: true,
        query: { bool: { must, ...(qy.filter?.trim() ? { filter: { query_string: { query: qy.filter.trim() } } } : {}) } },
        highlight: { pre_tags: ['<mark>'], post_tags: ['</mark>'], fields: { '*': {} } },
      };
      if (qy.sort?.trim()) body.sort = qy.sort.split(',').map((s) => s.trim()).filter(Boolean).map((s) => {
        const [f, dir] = s.split(':');
        return { [f]: { order: dir === 'desc' ? 'desc' : 'asc' } };
      });
      if (facets.length) body.aggs = Object.fromEntries(facets.map((f) => [f, { terms: { field: f, size: 20 } }]));
      const r = await this.api<{
        took: number;
        hits: { total: { value: number }; hits: { _id: string; _source: Record<string, unknown>; highlight?: Record<string, string[]> }[] };
        aggregations?: Record<string, { buckets: { key: string; doc_count: number }[] }>;
      }>(c, 'POST', `/es/${encodeURIComponent(qy.index)}/_search`, body);
      return {
        hits: r.hits.hits.map((h) => {
          // ZincSearch adds @timestamp to every document.
          const { '@timestamp': _ts, ...doc } = h._source;
          return { id: h._id, doc, highlight: Object.fromEntries(Object.entries(h.highlight ?? {}).map(([k, v]) => [k, strip(v.join(' … '))])) };
        }),
        total: r.hits.total.value,
        ms: r.took,
        facets: Object.fromEntries(Object.entries(r.aggregations ?? {}).map(([k, v]) => [k, Object.fromEntries((v.buckets ?? []).map((b) => [String(b.key), b.doc_count]))])),
      };
    }
    if (kind === 'sonic') {
      const docs = sonicDocs(c, qy.index);
      const t0 = Date.now();
      const text = qy.q.trim();
      let ids: string[];
      let total: number;
      if (!text) {
        // No words: the stored documents, in order.
        const all = Object.keys(docs);
        ids = all.slice(offset, offset + limit);
        total = all.length;
      } else {
        const [line] = await sonicSession(c, 'search', [`QUERY ${sonicName(qy.index)} default "${sonicText(text)}" LIMIT(${limit}) OFFSET(${offset})`]);
        ids = (line ?? '').split(' ').slice(3).filter(Boolean);
        // Sonic does not count matches: more pages exist while a page is full.
        total = offset + ids.length + (ids.length === limit ? 1 : 0);
      }
      const words = text.toLowerCase().split(/\s+/).filter((w) => w.length > 1);
      const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
      const mark = (s: string) => esc(s).replace(new RegExp(`(${words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi'), '<mark>$1</mark>');
      return {
        hits: ids.map((id) => {
          const doc = docs[id] ?? { id };
          const highlight = words.length
            ? Object.fromEntries(Object.entries(doc).filter(([, v]) => typeof v === 'string' && words.some((w) => v.toLowerCase().includes(w))).map(([k, v]) => [k, mark(String(v))]))
            : {};
          return { id, doc, highlight };
        }),
        total,
        ms: Date.now() - t0,
        facets: {},
      };
    }
    // Manticore: SQL, so filters and sort read like SQL.
    if (!/^[a-z_][a-z0-9_]*$/i.test(qy.index)) throw new Error('Manticore table names: letters, digits and _');
    for (const part of [qy.filter ?? '', qy.sort ?? '', ...facets]) if (/;/.test(part)) throw new Error('No ; in filters, sort or facets');
    const where = [qy.q.trim() ? `MATCH('${qy.q.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}')` : '', qy.filter?.trim() ? `(${qy.filter.trim()})` : ''].filter(Boolean).join(' AND ');
    const t0 = Date.now();
    const sets = await this.sql(
      c,
      `SELECT *${qy.q.trim() ? ", HIGHLIGHT({before_match='<mark>', after_match='</mark>'}) AS _hl" : ''} FROM ${qy.index}${where ? ` WHERE ${where}` : ''}` +
        `${qy.sort?.trim() ? ` ORDER BY ${qy.sort.trim()}` : ''} LIMIT ${offset},${limit}${facets.map((f) => ` FACET ${f}`).join('')}; SHOW META`,
    );
    const rows = sets[0]?.data ?? [];
    const meta = Object.fromEntries((sets.at(-1)?.data ?? []).map((r) => [r.Variable_name, r.Value]));
    const facetSets = sets.slice(1, 1 + facets.length);
    return {
      hits: rows.map(({ _hl, ...doc }): SearchHit => ({ id: String(doc.id ?? ''), doc, highlight: _hl ? { text: strip(String(_hl)) } : {} })),
      total: Number(meta.total_found ?? rows.length),
      ms: meta.time !== undefined ? Math.round(Number(meta.time) * 1000) : Date.now() - t0,
      facets: Object.fromEntries(
        facetSets.map((s, i) => [facets[i], Object.fromEntries((s.data ?? []).map((r) => [String(r[facets[i]] ?? Object.values(r)[0]), Number(r['count(*)'] ?? Object.values(r)[1] ?? 0)]))]),
      ),
    };
  }

  /** JSON array, a single object, or NDJSON → objects. */
  static parseDocs(text: string): Record<string, unknown>[] {
    const t = text.trim();
    if (!t) return [];
    if (t.startsWith('[')) return JSON.parse(t) as Record<string, unknown>[];
    try {
      const one = JSON.parse(t);
      if (one && typeof one === 'object') return [one as Record<string, unknown>];
    } catch {
      /* NDJSON */
    }
    return t
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  }

  /** CSV with a header row → objects (numbers kept as numbers). */
  static parseCsv(text: string): Record<string, unknown>[] {
    const rows: string[][] = [];
    let row: string[] = [];
    let cell = '';
    let quoted = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (quoted) {
        if (ch === '"' && text[i + 1] === '"') (cell += '"'), i++;
        else if (ch === '"') quoted = false;
        else cell += ch;
      } else if (ch === '"') quoted = true;
      else if (ch === ',') row.push(cell), (cell = '');
      else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && text[i + 1] === '\n') i++;
        row.push(cell);
        if (row.some((x) => x !== '')) rows.push(row);
        row = [];
        cell = '';
      } else cell += ch;
    }
    if (cell || row.length) rows.push([...row, cell]);
    const [head, ...body] = rows;
    if (!head) return [];
    return body.map((r) => Object.fromEntries(head.map((h, i) => [h.trim(), r[i] !== undefined && r[i] !== '' && !Number.isNaN(Number(r[i])) ? Number(r[i]) : (r[i] ?? '')])));
  }

  async upsert(kind: SearchKind, index: string, docs: Record<string, unknown>[]): Promise<number> {
    const c = this.cfg(kind);
    this.checkName(index);
    if (!docs.length) throw new Error('No documents');
    if (kind === 'meilisearch') {
      await this.meiliWait(c, (await this.api<{ taskUid: number }>(c, 'POST', `/indexes/${encodeURIComponent(index)}/documents`, docs)).taskUid);
    } else if (kind === 'typesense') {
      const ndjson = docs.map((d) => JSON.stringify(d.id === undefined ? d : { ...d, id: String(d.id) })).join('\n');
      const r = await this.api<string | Record<string, unknown>>(c, 'POST', `/collections/${encodeURIComponent(index)}/documents/import?action=upsert`, ndjson, 'text/plain');
      const lines = (typeof r === 'string' ? r : JSON.stringify(r)).split('\n').filter(Boolean).map((l) => JSON.parse(l) as { success: boolean; error?: string });
      const bad = lines.find((l) => !l.success);
      if (bad) throw new Error(`Typesense: ${bad.error} (${lines.filter((l) => !l.success).length} of ${lines.length} failed)`);
    } else if (kind === 'opensearch') {
      const body = docs.map((d) => `${JSON.stringify({ index: { _index: index, ...(d.id !== undefined ? { _id: String(d.id) } : {}) } })}\n${JSON.stringify(d)}`).join('\n') + '\n';
      const r = await this.api<{ errors: boolean; items: { index: { error?: { reason: string } } }[] }>(c, 'POST', '/_bulk?refresh=true', body, 'application/x-ndjson');
      if (r.errors) throw new Error(`OpenSearch: ${r.items.find((i) => i.index.error)?.index.error?.reason}`);
    } else if (kind === 'zincsearch') {
      const body = docs.map((d) => `${JSON.stringify({ index: { _index: index, ...(d.id !== undefined ? { _id: String(d.id) } : {}) } })}\n${JSON.stringify(d)}`).join('\n') + '\n';
      const r = await this.api<{ errors: boolean; error?: string; items?: { index: { error?: string | { reason: string } } }[] }>(c, 'POST', '/es/_bulk', body, 'application/x-ndjson');
      if (r.errors || r.error) {
        const e = r.items?.find((i) => i.index.error)?.index.error;
        throw new Error(`ZincSearch: ${r.error ?? (typeof e === 'string' ? e : e?.reason) ?? 'bulk insert failed'}`);
      }
    } else if (kind === 'sonic') {
      const store = sonicDocs(c, index);
      const cmds: string[] = [];
      for (const d of docs) {
        const id = String(d.id ?? d._id ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`);
        if (!/^[^\s"]{1,128}$/.test(id)) throw new Error(`Sonic ids: no spaces or quotes (${id})`);
        store[id] = { ...d, id: d.id ?? id };
        // Replace: forget the object's old words first.
        cmds.push(`FLUSHO ${sonicName(index)} default ${id}`);
        const text = sonicText(docText(d));
        if (text.trim()) cmds.push(`PUSH ${sonicName(index)} default ${id} "${text}"`);
      }
      for (let i = 0; i < cmds.length; i += 500) await sonicSession(c, 'ingest', cmds.slice(i, i + 500));
      saveSonicDocs(c, index, store);
      // Typo-tolerant and suggestions only after the word graph is rebuilt.
      await sonicSession(c, 'control', ['TRIGGER consolidate']).catch(() => undefined);
    } else {
      const body =
        docs
          .map((d) => {
            const { id, ...doc } = d;
            return JSON.stringify({ replace: { table: index, ...(id !== undefined && /^\d+$/.test(String(id)) ? { id: Number(id) } : {}), doc } });
          })
          .join('\n') + '\n';
      const r = await this.api<{ errors?: boolean; error?: string; items?: { replace?: { error?: string } }[] }>(c, 'POST', '/bulk', body, 'application/x-ndjson');
      if (r.errors || r.error) throw new Error(`Manticore: ${r.error ?? r.items?.find((i) => i.replace?.error)?.replace?.error ?? 'bulk insert failed'}`);
    }
    return docs.length;
  }

  importText(text: string, file: string): Record<string, unknown>[] {
    return /\.csv$/i.test(file) ? SearchManager.parseCsv(text) : SearchManager.parseDocs(text);
  }

  async deleteDoc(kind: SearchKind, index: string, id: string): Promise<void> {
    const c = this.cfg(kind);
    this.checkName(index);
    const e = encodeURIComponent(id);
    if (kind === 'meilisearch') await this.meiliWait(c, (await this.api<{ taskUid: number }>(c, 'DELETE', `/indexes/${encodeURIComponent(index)}/documents/${e}`)).taskUid);
    else if (kind === 'typesense') await this.api(c, 'DELETE', `/collections/${encodeURIComponent(index)}/documents/${e}`);
    else if (kind === 'opensearch') await this.api(c, 'DELETE', `/${index}/_doc/${e}?refresh=true`);
    else if (kind === 'zincsearch') await this.api(c, 'DELETE', `/es/${encodeURIComponent(index)}/_doc/${e}`);
    else if (kind === 'sonic') {
      await sonicSession(c, 'ingest', [`FLUSHO ${sonicName(index)} default ${id.replace(/[\s"]/g, '')}`]);
      const store = sonicDocs(c, index);
      delete store[id];
      saveSonicDocs(c, index, store);
    } else {
      if (!/^\d+$/.test(id)) throw new Error('Manticore ids are numbers');
      await this.api(c, 'POST', '/delete', { table: index, id: Number(id) });
    }
  }

  // ---- API keys (Meilisearch, Typesense)

  async keys(kind: SearchKind): Promise<SearchKey[]> {
    const c = this.cfg(kind);
    if (kind === 'meilisearch') {
      const r = await this.api<{ results: { uid: string; key: string; name: string | null; description: string | null; actions: string[]; indexes: string[]; expiresAt: string | null }[] }>(c, 'GET', '/keys?limit=200');
      return r.results.map((k) => ({ id: k.uid, name: k.name ?? k.description, value: k.key, actions: k.actions, indexes: k.indexes, expiresAt: k.expiresAt }));
    }
    if (kind === 'typesense') {
      const r = await this.api<{ keys: { id: number; value_prefix: string; description: string; actions: string[]; collections: string[]; expires_at: number }[] }>(c, 'GET', '/keys');
      return r.keys.map((k) => ({
        id: String(k.id),
        name: k.description,
        value: `${k.value_prefix}…`,
        actions: k.actions,
        indexes: k.collections,
        expiresAt: k.expires_at && k.expires_at < 64_000_000_000 ? new Date(k.expires_at * 1000).toISOString() : null,
      }));
    }
    throw new Error(`${ENGINES[kind].name} has no API keys in DevCatz (no auth locally)`);
  }

  async createKey(kind: SearchKind, name: string, actions: string[], indexes: string[], expiresAt: string | null): Promise<SearchKey> {
    const c = this.cfg(kind);
    const acts = actions.length ? actions : ['search'];
    const idx = indexes.length ? indexes : ['*'];
    if (kind === 'meilisearch') {
      const k = await this.api<{ uid: string; key: string; name: string; actions: string[]; indexes: string[]; expiresAt: string | null }>(c, 'POST', '/keys', {
        name: name || null,
        actions: acts,
        indexes: idx,
        expiresAt: expiresAt || null,
      });
      return { id: k.uid, name: k.name, value: k.key, actions: k.actions, indexes: k.indexes, expiresAt: k.expiresAt };
    }
    if (kind === 'typesense') {
      const k = await this.api<{ id: number; value: string; description: string; actions: string[]; collections: string[] }>(c, 'POST', '/keys', {
        description: name || 'DevCatz key',
        actions: acts.map((a) => (a === 'search' ? 'documents:search' : a)),
        collections: idx,
        ...(expiresAt ? { expires_at: Math.floor(new Date(expiresAt).getTime() / 1000) } : {}),
      });
      return { id: String(k.id), name: k.description, value: k.value, actions: k.actions, indexes: k.collections, expiresAt };
    }
    throw new Error(`${ENGINES[kind].name} has no API keys in DevCatz`);
  }

  async deleteKey(kind: SearchKind, id: string): Promise<void> {
    const c = this.cfg(kind);
    if (kind === 'meilisearch') await this.api(c, 'DELETE', `/keys/${encodeURIComponent(id)}`);
    else if (kind === 'typesense') await this.api(c, 'DELETE', `/keys/${encodeURIComponent(id)}`);
    else throw new Error('No API keys');
  }

  /** A key that can only search (for front ends): Meilisearch's default one, or one DevCatz creates in Typesense (kept in settings). */
  private async searchOnlyKey(kind: SearchKind): Promise<string | null> {
    const c = this.config(kind);
    if (!c || !this.isActive(kind)) return c?.searchKey ?? null;
    if (kind === 'meilisearch') {
      const k = (await this.keys(kind)).find((x) => x.actions.length === 1 && x.actions[0] === 'search' && x.indexes.includes('*') && !x.expiresAt);
      return k?.value ?? null;
    }
    if (kind === 'typesense') {
      if (c.searchKey) return c.searchKey;
      const k = await this.createKey(kind, 'DevCatz search-only (front end)', ['documents:search'], ['*'], null);
      store.setSearchEngine(kind, { ...c, searchKey: k.value });
      return k.value;
    }
    return null;
  }

  /** Backends use 127.0.0.1 (no TLS); front ends the https:// domain with a search-only key. */
  async env(kind: SearchKind, runtime: string, publicPort = 443): Promise<Record<string, string>> {
    const c = this.config(kind);
    if (!c) throw new Error(`${ENGINES[kind].name} is not installed`);
    const d = host(c.domain);
    const pub = publicPort === 443 ? d : `${d}:${publicPort}`;
    const laravel = runtime === 'php';
    const searchKey = await this.searchOnlyKey(kind).catch(() => null);
    if (kind === 'meilisearch') {
      return {
        ...(laravel ? { SCOUT_DRIVER: 'meilisearch' } : {}),
        MEILISEARCH_HOST: `http://127.0.0.1:${c.port}`,
        MEILISEARCH_KEY: c.key,
        MEILISEARCH_NO_ANALYTICS: 'true',
        VITE_MEILISEARCH_HOST: `https://${pub}`,
        ...(searchKey ? { VITE_MEILISEARCH_SEARCH_KEY: searchKey } : {}),
      };
    }
    if (kind === 'typesense') {
      return {
        ...(laravel ? { SCOUT_DRIVER: 'typesense' } : {}),
        TYPESENSE_HOST: '127.0.0.1',
        TYPESENSE_PORT: String(c.port),
        TYPESENSE_PROTOCOL: 'http',
        TYPESENSE_API_KEY: c.key,
        VITE_TYPESENSE_HOST: d,
        VITE_TYPESENSE_PORT: String(publicPort),
        VITE_TYPESENSE_PROTOCOL: 'https',
        ...(searchKey ? { VITE_TYPESENSE_SEARCH_KEY: searchKey } : {}),
      };
    }
    if (kind === 'opensearch') {
      return {
        OPENSEARCH_HOST: `http://127.0.0.1:${c.port}`,
        OPENSEARCH_URL: `http://127.0.0.1:${c.port}`,
        ...(laravel ? { ELASTICSEARCH_HOST: `127.0.0.1:${c.port}` } : {}),
      };
    }
    if (kind === 'zincsearch') {
      // Admin credentials stay on the backend (no search-only keys in ZincSearch).
      return {
        ZINC_URL: `http://127.0.0.1:${c.port}`,
        ZINC_USER: 'admin',
        ZINC_PASSWORD: c.key,
        // Elasticsearch clients: the compatible API lives under /es.
        ELASTICSEARCH_HOST: `http://127.0.0.1:${c.port}/es`,
        ELASTICSEARCH_USERNAME: 'admin',
        ELASTICSEARCH_PASSWORD: c.key,
      };
    }
    if (kind === 'sonic') {
      return { ...(laravel ? { SCOUT_DRIVER: 'sonic' } : {}), SONIC_HOST: '127.0.0.1', SONIC_PORT: String(c.port), SONIC_PASSWORD: c.key };
    }
    return { MANTICORE_HOST: '127.0.0.1', MANTICORE_PORT: String(c.port), MANTICORE_SQL_PORT: String(c.extraPort), MANTICORE_URL: `http://127.0.0.1:${c.port}` };
  }

  // ---- Meilisearch task queue

  async taskQueue(kind: SearchKind, status: string, from: number | null): Promise<{ tasks: SearchTask[]; next: number | null }> {
    const c = this.cfg(kind);
    if (kind !== 'meilisearch') throw new Error(`${ENGINES[kind].name} has no task queue`);
    const p = new URLSearchParams({ limit: '50' });
    if (status && /^[a-z,]+$/.test(status)) p.set('statuses', status);
    if (from !== null) p.set('from', String(from));
    const r = await this.api<{
      results: {
        uid: number;
        indexUid: string | null;
        status: SearchTask['status'];
        type: string;
        details?: Record<string, unknown>;
        error?: { message: string } | null;
        duration?: string | null;
        enqueuedAt: string;
        startedAt?: string | null;
        finishedAt?: string | null;
      }[];
      next: number | null;
    }>(c, 'GET', `/tasks?${p}`);
    const summary = (d: Record<string, unknown> | undefined) =>
      Object.entries(d ?? {})
        .filter(([, v]) => v !== null && v !== undefined)
        .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v).slice(0, 80) : v}`)
        .join(' · ');
    return {
      tasks: r.results.map((t) => ({
        uid: t.uid,
        index: t.indexUid,
        status: t.status,
        type: t.type,
        details: summary(t.details),
        error: t.error?.message ?? null,
        enqueuedAt: t.enqueuedAt,
        startedAt: t.startedAt ?? null,
        finishedAt: t.finishedAt ?? null,
        durationMs: isoMs(t.duration),
      })),
      next: r.next,
    };
  }

  /** Cancels queued / running tasks (all of them when `uids` is empty). */
  async cancelTasks(kind: SearchKind, uids: number[]): Promise<void> {
    const c = this.cfg(kind);
    const q = uids.length ? `uids=${uids.map((u) => Math.trunc(u)).join(',')}` : 'statuses=enqueued,processing';
    await this.meiliWait(c, (await this.api<{ taskUid: number }>(c, 'POST', `/tasks/cancel?${q}`)).taskUid);
  }

  /** Deletes finished tasks from the history. */
  async clearTasks(kind: SearchKind): Promise<void> {
    const c = this.cfg(kind);
    await this.meiliWait(c, (await this.api<{ taskUid: number }>(c, 'DELETE', '/tasks?statuses=succeeded,failed,canceled')).taskUid);
  }

  // ---- Meilisearch dumps and snapshots

  private backupDirs(c: SearchConfig) {
    return { dump: join(c.dataDir, 'dumps'), snapshot: join(c.dataDir, 'snapshots') };
  }

  backups(kind: SearchKind): SearchBackup[] {
    const c = this.config(kind);
    if (!c || kind !== 'meilisearch') return [];
    const out: SearchBackup[] = [];
    for (const [type, dir] of Object.entries(this.backupDirs(c)) as ['dump' | 'snapshot', string][]) {
      if (!existsSync(dir)) continue;
      for (const name of readdirSync(dir)) {
        if (!name.endsWith(`.${type}`)) continue;
        const st = statSync(join(dir, name));
        out.push({ file: join(dir, name), name, kind: type, sizeBytes: st.size, createdAt: st.mtime.toISOString() });
      }
    }
    return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** A backup file of this engine (never a path from elsewhere). */
  backupFile(kind: SearchKind, file: string): string {
    const c = this.config(kind);
    if (!c) throw new Error(`${ENGINES[kind].name} is not installed`);
    const dirs = Object.values(this.backupDirs(c));
    if (!dirs.includes(dirname(file)) || basename(file).startsWith('.') || !existsSync(file)) throw new Error('Not a backup of this engine');
    return file;
  }

  async createBackup(kind: SearchKind, type: 'dump' | 'snapshot'): Promise<void> {
    const c = this.cfg(kind);
    if (kind !== 'meilisearch') throw new Error(`${ENGINES[kind].name} has no dumps or snapshots`);
    const t = await this.api<{ taskUid: number }>(c, 'POST', type === 'dump' ? '/dumps' : '/snapshots');
    await this.meiliWait(c, t.taskUid, 600);
  }

  async deleteBackup(kind: SearchKind, file: string): Promise<void> {
    await rm(this.backupFile(kind, file), { force: true });
  }

  /**
   * Restores a dump or snapshot: the engine stops, the current database moves
   * aside (data.ms.before-restore-<time>, nothing is deleted) and it starts once
   * with --import-dump / --import-snapshot.
   */
  async restoreBackup(kind: SearchKind, file: string): Promise<void> {
    const c = this.config(kind);
    if (!c || kind !== 'meilisearch') throw new Error('Only Meilisearch backups can be restored');
    const f = this.backupFile(kind, file);
    await this.processes.stop(searchId(kind));
    const db = join(c.dataDir, 'data.ms');
    if (existsSync(db)) renameSync(db, `${db}.before-restore-${new Date().toISOString().replace(/[:.]/g, '-')}`);
    this.oneShot.set(kind, `${f.endsWith('.snapshot') ? '--import-snapshot' : '--import-dump'} ${q(f)}`);
    this.processes.log(searchId(kind), 'sys', `Restoring ${basename(f)} (the previous database was kept next to it)`);
    await this.action(kind, 'start');
  }

  // ---- export

  /** Every document of an index (export), in pages so large indexes do not load at once on the engine side. */
  async exportDocs(kind: SearchKind, index: string): Promise<Record<string, unknown>[]> {
    const c = this.cfg(kind);
    this.checkName(index);
    const out: Record<string, unknown>[] = [];
    const MAX = 1_000_000;
    if (kind === 'meilisearch') {
      for (let offset = 0; out.length < MAX; offset += 1000) {
        const r = await this.api<{ results: Record<string, unknown>[]; total: number }>(c, 'GET', `/indexes/${encodeURIComponent(index)}/documents?limit=1000&offset=${offset}`);
        out.push(...r.results);
        if (r.results.length < 1000) break;
      }
    } else if (kind === 'typesense') {
      const r = await this.api<string | Record<string, unknown>>(c, 'GET', `/collections/${encodeURIComponent(index)}/documents/export`);
      const text = typeof r === 'string' ? r : JSON.stringify(r);
      out.push(...text.split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>));
    } else if (kind === 'opensearch') {
      type Page = { _scroll_id: string; hits: { hits: { _id: string; _source: Record<string, unknown> }[] } };
      let r = await this.api<Page>(c, 'POST', `/${index}/_search?scroll=1m`, { size: 1000, sort: ['_doc'], query: { match_all: {} } });
      while (r.hits.hits.length && out.length < MAX) {
        out.push(...r.hits.hits.map((h) => ('id' in h._source ? h._source : { id: h._id, ...h._source })));
        r = await this.api<Page>(c, 'POST', '/_search/scroll', { scroll: '1m', scroll_id: r._scroll_id });
      }
      await this.api(c, 'DELETE', '/_search/scroll', { scroll_id: r._scroll_id }).catch(() => undefined);
    } else if (kind === 'zincsearch') {
      for (let from = 0; out.length < MAX; from += 1000) {
        const r = await this.api<{ hits: { hits: { _id: string; _source: Record<string, unknown> }[] } }>(c, 'POST', `/es/${encodeURIComponent(index)}/_search`, {
          from,
          size: 1000,
          query: { match_all: {} },
          sort: [{ _id: { order: 'asc' } }],
        });
        out.push(...r.hits.hits.map((h) => {
          const { '@timestamp': _ts, ...doc } = h._source;
          return 'id' in doc ? doc : { id: h._id, ...doc };
        }));
        if (r.hits.hits.length < 1000) break;
      }
    } else if (kind === 'sonic') {
      out.push(...Object.values(sonicDocs(c, index)));
    } else {
      if (!/^[a-z_][a-z0-9_]*$/i.test(index)) throw new Error('Manticore table names: letters, digits and _');
      // Keyset pages by id (Manticore caps OFFSET at max_matches).
      for (let last = -1; out.length < MAX; ) {
        const rows = (await this.sql(c, `SELECT * FROM ${index} WHERE id > ${last} ORDER BY id ASC LIMIT 1000 OPTION max_matches=1000`))[0]?.data ?? [];
        out.push(...rows);
        if (rows.length < 1000) break;
        last = Number(rows.at(-1)!.id);
      }
    }
    return out;
  }

  /** For tests: reads a file as documents. */
  readDocsFile(file: string): Record<string, unknown>[] {
    return this.importText(readFileSync(file, 'utf8'), file);
  }
}
