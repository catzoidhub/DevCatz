import { chmodSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { InstalledRuby, RemoteRuby, RubyChoice, RuntimeInstallProgress } from '@shared/types';
import { words } from '@shared/platform';
import { downloadVerified } from './download';
import { getShellEnv, run } from './env';
import { githubJson } from './github';
import { runAsRootLinux } from './linuxadmin';
import { compare, shimDir, writeCmdShim } from './node';
import { brewBin } from './php';
import { exe, isLinux, isWin, joinPath, pathKey, removeTemp, TAR } from './platform';
import { dataDir } from './store';

/**
 * Ruby (TODO §37), the way Python uses uv: DevCatz downloads **rv** (spinel-coop, by the Bundler / RubyGems team;
 * GitHub release, SHA-256 checked), and rv installs prebuilt, relocatable Rubies (3.2 and newer) into DevCatz's data
 * folder in seconds — macOS, Linux and Windows. Older Rubies (2.7 – 3.1) are compiled with **ruby-build** on macOS and
 * Linux (minutes, needs a C compiler and OpenSSL / libyaml headers). Gems live inside each Ruby (its own GEM_HOME), so
 * uninstalling a Ruby takes its gems with it. Rubies the user has (Homebrew, rbenv, asdf, the system's) are listed
 * read-only, like Go and Python.
 *
 * Layout: ruby/bin/rv, ruby/versions/ruby-<x.y.z>/bin/{ruby,gem,bundle,irb}, ruby/ruby-build/ (the tool itself).
 */
export const rubyDir = () => {
  const d = dataDir('ruby');
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
  return d;
};
const rvDir = () => join(rubyDir(), 'bin');
export const rubyVersionsDir = () => {
  const d = join(rubyDir(), 'versions');
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
  return d;
};
const rubyBuildDir = () => join(rubyDir(), 'ruby-build');
const VERSION = /^\d+\.\d+\.\d+$/;
/** Minors rv does not build: compiled with ruby-build (macOS / Linux only). */
export const LEGACY_RUBY_MINORS = ['3.1', '3.0', '2.7'];

export function rvPath(): string | null {
  const own = join(rvDir(), exe('rv'));
  return existsSync(own) ? own : null;
}

/** rv's settings: Rubies go to DevCatz's folder, rv never updates itself (DevCatz does that). */
export function rvEnv(base: Record<string, string | undefined> = {}): Record<string, string> {
  const env = { ...getShellEnv(), ...base };
  return {
    RUBIES_PATH: rubyVersionsDir(),
    RV_UPDATE_MODE: 'none',
    RV_COLOR: 'never',
    [pathKey(env)]: joinPath([rvDir(), env[pathKey(env)] ?? '']),
  };
}

async function rv(args: string[], timeout = 120_000) {
  const bin = rvPath();
  if (!bin) throw new Error('rv is not installed: install it on the Ruby page (sidebar)');
  return run(bin, args, { timeout, env: rvEnv() });
}

export async function rvVersion(): Promise<string | null> {
  if (!rvPath()) return null;
  const r = await rv(['--version'], 10_000).catch(() => null);
  return r?.stdout.match(/rv ([\d.]+)/)?.[1] ?? null;
}

/** Downloads rv from its latest GitHub release, checksum-verified (the release's own .sha256 files). */
export async function installRv(progress: (p: RuntimeInstallProgress) => void): Promise<string> {
  const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
  const triple = isWin ? `${arch}-pc-windows-msvc` : `${arch}-${isLinux ? 'unknown-linux-gnu' : 'apple-darwin'}`;
  const ext = isWin ? 'zip' : 'tar.xz';
  const rel = await githubJson<{ tag_name: string; assets: { name: string; browser_download_url: string; digest?: string }[] }>('/repos/spinel-coop/rv/releases/latest');
  const asset = rel.assets.find((a) => a.name === `rv-${triple}.${ext}`);
  const sum = rel.assets.find((a) => a.name === `rv-${triple}.${ext}.sha256`);
  if (!asset) throw new Error(`No rv build for this ${words.computer} (${triple})`);
  let sha = asset.digest?.startsWith('sha256:') ? asset.digest.slice(7) : '';
  if (!sha && sum) sha = (await fetch(sum.browser_download_url).then((r) => r.text())).trim().split(/\s+/)[0];
  if (!/^[a-f0-9]{64}$/i.test(sha)) throw new Error('rv: no checksum to check the download against');
  const tmp = join(rubyDir(), `.rv-${Date.now()}`);
  mkdirSync(tmp, { recursive: true });
  try {
    const archive = join(tmp, `rv.${ext}`);
    const label = `rv ${rel.tag_name}`;
    await downloadVerified(asset.browser_download_url, archive, sha, (received, total) => progress({ version: label, phase: 'download', received, total }));
    progress({ version: label, phase: 'extract', received: 0, total: 0 });
    // Windows' bsdtar unpacks the .zip; elsewhere a .tar.xz with a top folder.
    const r = isWin ? await run(TAR, ['-xf', archive, '-C', tmp]) : await run(TAR, ['-xJf', archive, '-C', tmp]);
    if (r.code !== 0) throw new Error(`Unpacking rv failed: ${r.stderr.trim()}`);
    const found = [join(tmp, exe('rv')), join(tmp, `rv-${triple}`, exe('rv'))].find((p) => existsSync(p));
    if (!found) throw new Error('rv: the archive has no rv program');
    mkdirSync(rvDir(), { recursive: true });
    rmSync(join(rvDir(), exe('rv')), { force: true });
    renameSync(found, join(rvDir(), exe('rv')));
    if (!isWin) chmodSync(join(rvDir(), 'rv'), 0o755);
    if (!isWin && !isLinux) await run('xattr', ['-dr', 'com.apple.quarantine', rvDir()]);
    progress({ version: label, phase: 'done', received: 0, total: 0 });
    return rel.tag_name;
  } finally {
    removeTemp(tmp);
  }
}

// ---------------------------------------------------------------- installed

/** `ruby -e 'print RUBY_VERSION'` of a ruby binary ('' when it does not run). */
async function versionOf(ruby: string): Promise<string> {
  const r = await run(ruby, ['-e', 'print RUBY_VERSION'], { timeout: 10_000 }).catch(() => null);
  const v = r?.stdout.trim() ?? '';
  return r?.code === 0 && VERSION.test(v) ? v : '';
}

/** Rubies on this computer: DevCatz's own first (rv or ruby-build, in its folder), then the user's own (read-only). */
export async function listInstalled(): Promise<InstalledRuby[]> {
  const out: InstalledRuby[] = [];
  const add = async (binDir: string, source: InstalledRuby['source']) => {
    const ruby = join(binDir, exe('ruby'));
    if (!existsSync(ruby)) return;
    const version = await versionOf(ruby);
    if (version && !out.some((o) => o.version === version && o.source === source)) out.push({ version, source, binDir, path: ruby });
  };
  let own: string[] = [];
  try {
    own = readdirSync(rubyVersionsDir()).filter((d) => d.startsWith('ruby-'));
  } catch {
    /* none yet */
  }
  for (const d of own) await add(join(rubyVersionsDir(), d, 'bin'), 'mrcatz');
  // The user's own: Homebrew, rbenv, asdf, the distribution's (not macOS's old system Ruby, which cannot install gems).
  const h = homedir();
  const system: string[] = [];
  for (const root of [join(h, '.rbenv', 'versions'), join(h, '.asdf', 'installs', 'ruby'), join(h, '.rubies'), join(h, '.local', 'share', 'rv', 'rubies')]) {
    try {
      for (const v of readdirSync(root)) system.push(join(root, v, 'bin'));
    } catch {
      /* not used */
    }
  }
  if (!isWin) system.push('/opt/homebrew/opt/ruby/bin', '/usr/local/opt/ruby/bin');
  if (isLinux) system.push('/usr/bin', '/usr/local/bin');
  if (isWin) for (const d of ['C:\\Ruby34-x64', 'C:\\Ruby33-x64', 'C:\\Ruby32-x64']) system.push(join(d, 'bin'));
  for (const b of system) await add(b, 'system');
  return out.sort((a, b) => (a.source === b.source ? compare(b.version, a.version) : a.source === 'mrcatz' ? -1 : 1));
}

// ------------------------------------------------------------------- remote

interface RvRow {
  Remote?: { version: string };
  Installed?: { version: string };
}

/** The newest patch of each minor rv offers (3.2+), then the legacy minors ruby-build compiles (not on Windows). */
export async function listRemote(): Promise<RemoteRuby[]> {
  const r = await rv(['ruby', 'list', '--format', 'json'], 60_000);
  if (r.code !== 0) throw new Error(r.stderr.trim() || 'rv ruby list failed');
  const rows = JSON.parse(r.stdout) as RvRow[];
  const byMinor = new Map<string, RemoteRuby>();
  for (const row of rows) {
    const v = (row.Remote ?? row.Installed)?.version.replace(/^ruby-/, '') ?? '';
    if (!VERSION.test(v)) continue; // previews, dev builds
    const minor = v.split('.').slice(0, 2).join('.');
    const prev = byMinor.get(minor);
    if (!prev || compare(v, prev.version) > 0) byMinor.set(minor, { version: v, minor, via: 'rv' });
  }
  const list = [...byMinor.values()].sort((a, b) => compare(b.version, a.version));
  if (isWin) return list;
  const legacy = await legacyVersions().catch(() => new Map<string, string>());
  for (const minor of LEGACY_RUBY_MINORS) if (!byMinor.has(minor)) list.push({ version: legacy.get(minor) ?? minor, minor, via: 'ruby-build' });
  return list;
}

// --------------------------------------------------------------- ruby-build

/** ext/socket/extconf.rb reads Apple's in6.h from the SDK instead of /usr/include (Ruby 2.7 – 3.1, macOS). */
const IN6_PATCH = (sdk: string) => `--- ext/socket/extconf.rb
+++ ext/socket/extconf.rb
@@ -1,3 +1,3 @@
     print "fixing apple's netinet6/in6.h ..."; $stdout.flush
-    in6 = File.read("/usr/include/#{hdr}")
+    in6 = File.read(File.join(${JSON.stringify(sdk)}, "usr/include", hdr))
     if in6.gsub!(/\\*\\(const\\s+__uint32_t\\s+\\*\\)\\(const\\s+void\\s+\\*\\)\\(&(\\(\\w+\\))->s6_addr\\[(\\d+)\\]\\)/) do
`;

function rubyBuildBin(): string | null {
  const b = join(rubyBuildDir(), 'bin', 'ruby-build');
  return existsSync(b) ? b : null;
}

/** ruby-build from its latest GitHub release (a shell program; the release has no checksum, so HTTPS from GitHub). */
async function ensureRubyBuild(progress: (p: RuntimeInstallProgress) => void): Promise<string> {
  const have = rubyBuildBin();
  if (have) return have;
  const rel = await githubJson<{ tag_name: string; tarball_url: string }>('/repos/rbenv/ruby-build/releases/latest');
  const tmp = join(rubyDir(), `.ruby-build-${Date.now()}`);
  mkdirSync(tmp, { recursive: true });
  try {
    progress({ version: `ruby-build ${rel.tag_name}`, phase: 'download', received: 0, total: 0 });
    const res = await fetch(rel.tarball_url);
    if (!res.ok) throw new Error(`ruby-build: HTTP ${res.status}`);
    const archive = join(tmp, 'ruby-build.tar.gz');
    writeFileSync(archive, Buffer.from(await res.arrayBuffer()));
    const r = await run(TAR, ['-xzf', archive, '-C', tmp, '--strip-components=1']);
    if (r.code !== 0) throw new Error(`Unpacking ruby-build failed: ${r.stderr.trim()}`);
    rmSync(join(tmp, 'ruby-build.tar.gz'), { force: true });
    rmSync(rubyBuildDir(), { recursive: true, force: true });
    renameSync(tmp, rubyBuildDir());
    return join(rubyBuildDir(), 'bin', 'ruby-build');
  } catch (e) {
    removeTemp(tmp);
    throw e;
  }
}

/** The newest patch of each legacy minor ruby-build knows (`ruby-build --definitions`). */
async function legacyVersions(): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const bin = rubyBuildBin();
  if (!bin) return out;
  const r = await run(bin, ['--definitions'], { timeout: 20_000 });
  for (const v of r.stdout.split('\n').map((l) => l.trim()).filter((l) => VERSION.test(l))) {
    const minor = v.split('.').slice(0, 2).join('.');
    if (LEGACY_RUBY_MINORS.includes(minor) && (!out.has(minor) || compare(v, out.get(minor)!) > 0)) out.set(minor, v);
  }
  return out;
}

/** What compiling Ruby needs: a C compiler, OpenSSL, libyaml, zlib, libffi headers. */
async function buildPrerequisites(): Promise<Record<string, string>> {
  if (isLinux) {
    const missing = (await run('which', ['cc'], { timeout: 5000 })).code !== 0 || !existsSync('/usr/include/openssl/ssl.h') || !existsSync('/usr/include/yaml.h');
    if (missing) {
      const root = await runAsRootLinux(
        'if command -v apt-get >/dev/null 2>&1; then DEBIAN_FRONTEND=noninteractive apt-get install -y -qq build-essential libssl-dev libyaml-dev zlib1g-dev libffi-dev libreadline-dev >/dev/null; elif command -v dnf >/dev/null 2>&1; then dnf install -y -q gcc make openssl-devel libyaml-devel zlib-devel libffi-devel readline-devel >/dev/null; fi',
      );
      if (!root.ok) throw new Error(root.cancelled ? 'Cancelled: compiling an older Ruby needs build tools and headers' : `Installing the build tools failed: ${root.message}`);
    }
    return {};
  }
  // macOS: the Command Line Tools, and Homebrew's openssl@3 / libyaml (ruby-build finds Homebrew's on its own).
  if ((await run('xcode-select', ['-p'], { timeout: 10_000 })).code !== 0) throw new Error(`Compiling an older Ruby needs ${words.buildTools}`);
  if (!brewBin()) throw new Error('Compiling an older Ruby needs Homebrew (for OpenSSL and libyaml): install it from https://brew.sh first');
  return {};
}

// ------------------------------------------------------------------ install

export async function install(version: string, via: RemoteRuby['via'], progress: (p: RuntimeInstallProgress) => void): Promise<void> {
  if (!/^\d+\.\d+(\.\d+)?$/.test(version)) throw new Error(`Invalid Ruby version ${version}`);
  if (via === 'rv') {
    progress({ version, phase: 'download', received: 0, total: 0, detail: `rv ruby install ${version}` });
    const r = await rv(['ruby', 'install', version, '--install-dir', rubyVersionsDir()], 600_000);
    if (r.code !== 0) throw new Error(`rv ruby install ${version} failed: ${(r.stderr || r.stdout).trim().split('\n').slice(-3).join(' ')}`);
    progress({ version, phase: 'done', received: 0, total: 0 });
    return;
  }
  if (isWin) throw new Error('Ruby older than 3.2 is not offered on Windows');
  const bin = await ensureRubyBuild(progress);
  let full = version;
  if (!VERSION.test(full)) full = (await legacyVersions()).get(version) ?? '';
  if (!VERSION.test(full)) throw new Error(`ruby-build has no Ruby ${version}`);
  const env = await buildPrerequisites();
  const prefix = join(rubyVersionsDir(), `ruby-${full}`);
  progress({ version: full, phase: 'extract', received: 0, total: 0, detail: `ruby-build ${full} — compiling, this takes several minutes` });
  const buildEnv = { ...env, RUBY_CONFIGURE_OPTS: '--disable-install-doc', MAKE_OPTS: '-j4' };
  let r: { code: number; stdout: string; stderr: string };
  if (!isLinux) {
    // macOS: Ruby < 3.2's socket extension reads /usr/include/netinet6/in6.h, which only the SDK has now; without this
    // patch ruby-build "succeeds" with no socket library (nothing that serves HTTP runs).
    const sdk = (await run('xcrun', ['--show-sdk-path'], { timeout: 20_000 })).stdout.trim();
    const patch = join(rubyDir(), `.in6-${Date.now()}.patch`);
    writeFileSync(patch, IN6_PATCH(sdk));
    try {
      r = await run('/bin/sh', ['-c', `"$0" --patch "$1" "$2" < "$3"`, bin, full, prefix, patch], { timeout: 60 * 60_000, env: buildEnv });
    } finally {
      rmSync(patch, { force: true });
    }
  } else r = await run(bin, [full, prefix], { timeout: 60 * 60_000, env: buildEnv });
  if (r.code !== 0) {
    rmSync(prefix, { recursive: true, force: true });
    throw new Error(`ruby-build ${full} failed: ${(r.stderr || r.stdout).trim().split('\n').slice(-4).join(' ')}`);
  }
  // ruby-build only checks OpenSSL: make sure what web apps need was built too.
  const libs = ['socket', 'openssl', 'psych', 'zlib'];
  const check = await run(join(prefix, 'bin', 'ruby'), ['-e', `${libs.map((l) => `require "${l}"`).join(';')}; print "ok"`], { timeout: 30_000 });
  if (check.stdout.trim() !== 'ok') {
    rmSync(prefix, { recursive: true, force: true });
    const lib = check.stderr.match(/cannot load such file -- (\S+)/)?.[1];
    throw new Error(`Ruby ${full} compiled without ${lib ?? 'a standard library'}; it was removed again. ${lib === 'psych' ? 'Install libyaml (Homebrew / apt) and try again.' : 'See the build tools above and try again.'}`);
  }
  progress({ version: full, phase: 'done', received: 0, total: 0 });
}

/** Removes one of DevCatz's Rubies, its gems with it (they live inside it). */
export function uninstall(version: string): void {
  if (!VERSION.test(version)) throw new Error(`Invalid Ruby version ${version}`);
  const dir = join(rubyVersionsDir(), `ruby-${version}`);
  if (!existsSync(dir)) throw new Error(`Ruby ${version} is not managed by DevCatz`);
  rmSync(dir, { recursive: true, force: true });
}

// --------------------------------------------------------------- resolution

/** `.ruby-version` (3.4.7, ruby-3.4.7, 3.4) or the Gemfile's `ruby "~> 3.3"`. */
export function satisfiesRuby(version: string, spec: string): boolean {
  const s = spec.trim().replace(/^ruby-/, '');
  const v = version.split('.').map(Number);
  const cmp = (a: number[], b: number[]) => {
    for (let i = 0; i < Math.max(a.length, b.length); i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) - (b[i] ?? 0);
    return 0;
  };
  return s.split(',').every((part) => {
    const m = part.trim().match(/^(~>|>=|<=|>|<|=|!=)?\s*(\d+(?:\.\d+){0,2})$/);
    if (!m) return true;
    const want = m[2].split('.').map(Number);
    switch (m[1] ?? '') {
      case '':
      case '=':
        return cmp(v.slice(0, want.length), want) === 0;
      case '!=':
        return cmp(v.slice(0, want.length), want) !== 0;
      case '>=':
        return cmp(v, want) >= 0;
      case '<=':
        return cmp(v, want) <= 0;
      case '>':
        return cmp(v, want) > 0;
      case '<':
        return cmp(v, want) < 0;
      case '~>':
        // Pessimistic: ~> 3.3 = >= 3.3, < 4; ~> 3.3.1 = >= 3.3.1, < 3.4.
        return cmp(v, want) >= 0 && cmp(v.slice(0, want.length - 1), want.slice(0, -1)) === 0;
      default:
        return true;
    }
  });
}

/** The site's Ruby: its own choice, else what the project asks for when installed, else the default, else the newest. */
export function chooseRuby(spec: string | null, pinned: string | undefined, all: InstalledRuby[], def: string | null): RubyChoice {
  const installed = [...all.filter((i) => i.source === 'mrcatz'), ...all.filter((i) => i.source !== 'mrcatz')];
  if (pinned) return { version: pinned, reason: 'site', spec, missing: !installed.some((i) => i.version === pinned) };
  if (spec) {
    const match = installed.find((i) => satisfiesRuby(i.version, spec));
    if (match) return { version: match.version, reason: 'project', spec, missing: false };
  }
  if (def && installed.some((i) => i.version === def)) return { version: def, reason: 'default', spec, missing: Boolean(spec) };
  if (installed[0]) return { version: installed[0].version, reason: 'newest', spec, missing: Boolean(spec) };
  return { version: null, reason: 'none', spec, missing: true };
}

/**
 * `ruby`, `gem`, `bundle`, `irb`, `rake` and `rv` in the shim folder ("Add to my Path"): the default Ruby DevCatz
 * installed (else its newest). The user's own Rubies keep their own PATH entries.
 */
export function writeShims(installed: InstalledRuby[], defaultVersion: string | null): void {
  const own = installed.filter((i) => i.source === 'mrcatz').sort((a, b) => compare(b.version, a.version));
  const rb = own.find((i) => i.version === defaultVersion) ?? own[0] ?? null;
  const dir = shimDir();
  mkdirSync(dir, { recursive: true });
  const names = ['ruby', 'gem', 'bundle', 'bundler', 'irb', 'rake'];
  if (isWin) {
    // RubyInstaller's programs end in .bat (bundle, irb, rake) or .cmd (gem), ruby itself in .exe.
    for (const n of names) writeCmdShim(dir, n, rb ? (['.exe', '.bat', '.cmd'].map((e) => join(rb.binDir, n + e)).find((f) => existsSync(f)) ?? null) : null);
    writeCmdShim(dir, 'rv', rvPath());
    return;
  }
  const links: [string, string | null][] = [...names.map((n): [string, string | null] => [n, rb ? join(rb.binDir, n) : null]), ['rv', rvPath()]];
  for (const [name, target] of links) {
    const link = join(dir, name);
    try {
      unlinkSync(link);
    } catch {
      /* not there */
    }
    if (target && existsSync(target)) symlinkSync(target, link);
  }
}

