import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { cpus, homedir, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { PhpExtCatalogItem, PhpExtension, PhpExtTask } from '@shared/types';
import { downloadVerified } from './download';
import { getShellEnv, run } from './env';
import { brewBin, etcDir, phpDir } from './php';
import { isWin, TAR } from './platform';

/**
 * PHP extensions beyond the ones compiled into static-php.dev's build: built
 * from PECL source with phpize and loaded as shared modules (the static
 * binaries export PHP's symbols and keep dl() on, so a matching .so loads).
 *
 * static-php.dev ships no headers, so a "toolkit" (phpize, php-config,
 * headers) is made once per PHP version from php.net's source tarball
 * (SHA-256 from php.net's release API): configure + install-headers only, no
 * full PHP build. Toolkits and build folders live outside "Application
 * Support" because autotools break on paths with spaces.
 *
 * Layout: php/<version>/lib/extensions/<module>.so and
 * php-etc/<version>/conf.d/20-<module>.ini (".ini.disabled" when turned off).
 */

/** Extensions offered on the PHP page; any other PECL package can be typed in. */
export const CATALOG: PhpExtCatalogItem[] = [
  { pkg: 'xdebug', title: 'Xdebug', description: 'Step debugger, profiler and code coverage', zend: true },
  { pkg: 'pcov', title: 'PCOV', description: 'Fast code coverage for PHPUnit / Pest' },
  { pkg: 'mongodb', title: 'MongoDB', description: 'Driver for MongoDB (laravel-mongodb, Doctrine ODM)', configure: ['--with-mongodb-ssl=darwin', '--with-mongodb-sasl=no'] },
  { pkg: 'igbinary', title: 'igbinary', description: 'Compact binary serializer (sessions, cache)' },
  { pkg: 'msgpack', title: 'MessagePack', description: 'MessagePack serializer' },
  { pkg: 'ds', title: 'Data Structures', description: 'Vector, Map, Set, Deque, PriorityQueue' },
  { pkg: 'ast', title: 'php-ast', description: 'Abstract syntax tree (Phan, static analysis)' },
  { pkg: 'xhprof', title: 'XHProf', description: 'Hierarchical profiler' },
  { pkg: 'excimer', title: 'Excimer', description: 'Low-overhead sampling profiler' },
  { pkg: 'yaml', title: 'YAML', description: 'YAML parser (libyaml)', brew: ['libyaml'], configure: ['--with-yaml={libyaml}'] },
  { pkg: 'memcached', title: 'Memcached', description: 'Memcached client (libmemcached)', brew: ['libmemcached', 'zlib'], configure: ['--with-libmemcached-dir={libmemcached}', '--with-zlib-dir={zlib}', '--disable-memcached-sasl'] },
  { pkg: 'ssh2', title: 'SSH2', description: 'SSH / SFTP client (libssh2)', brew: ['libssh2'], configure: ['--with-ssh2={libssh2}'] },
  { pkg: 'rdkafka', title: 'rdkafka', description: 'Apache Kafka client (librdkafka)', brew: ['librdkafka'], configure: ['--with-rdkafka={librdkafka}'] },
  { pkg: 'decimal', title: 'Decimal', description: 'Arbitrary-precision decimals (libmpdec)', brew: ['mpdecimal'], configure: ['--with-libmpdec-path={mpdecimal}'] },
  { pkg: 'mailparse', title: 'Mailparse', description: 'Parse RFC 822 / MIME e-mail' },
  { pkg: 'zstd', title: 'Zstandard', description: 'zstd compression (bundled library)' },
  { pkg: 'lzf', title: 'LZF', description: 'LZF compression' },
  { pkg: 'uploadprogress', title: 'Upload progress', description: 'Track file upload progress' },
  { pkg: 'grpc', title: 'gRPC', description: 'gRPC client (long build: 10+ minutes)' },
];

const VERSION = /^\d+\.\d+\.\d+$/;
const PKG = /^[A-Za-z][A-Za-z0-9_]{1,40}$/;

/** A folder without spaces for autotools: ~/Library/Caches/DevCatz, else the temp folder. */
function noSpaceDir(...parts: string[]): string {
  const home = join(homedir(), 'Library/Caches/DevCatz');
  const base = /\s/.test(home) ? join(tmpdir(), 'devcatz') : home;
  const d = join(base, ...parts);
  mkdirSync(d, { recursive: true });
  return d;
}
const toolkitDir = (version: string) => noSpaceDir('php-dev', version);
const extDir = (version: string) => join(phpDir(), version, 'lib', 'extensions');
const iniFile = (version: string, module: string, on = true) => join(etcDir(version), 'conf.d', `20-${module}.ini${on ? '' : '.disabled'}`);
export const hasToolkit = (version: string) => existsSync(join(toolkitDir(version), 'bin', 'phpize'));

/**
 * Windows: no compiler. The PHP zip's own ext\php_<name>.dll are switched on and off; PECL packages come as ready-made
 * DLLs from php.net's Windows PECL builds (downloads.php.net/~windows/pecl), matched to the PHP minor, NTS, x64. They
 * live in php/<version>/pecl (module + <module>.json), libraries they ship (libssh2.dll …) next to php.exe, where the
 * loader finds them. Every one is loaded from conf.d/20-<module>.ini.
 */
const WIN_PECL = 'https://downloads.php.net/~windows/pecl/releases';
const peclDir = (version: string) => join(phpDir(), version, 'pecl');
const bundledDir = (version: string) => join(phpDir(), version, 'ext');
/** The module file of an installed extension (DevCatz's build, or on Windows a PECL DLL). */
const moduleFile = (version: string, module: string) => (isWin ? join(peclDir(version), `php_${module}.dll`) : join(extDir(version), `${module}.so`));
const metaFile = (version: string, module: string) => join(isWin ? peclDir(version) : extDir(version), `${module}.json`);

/** Windows: the zip's own extensions (ext\php_*.dll), each with its on/off state. */
export function listBundled(version: string): PhpExtension[] {
  if (!isWin) return [];
  const dir = bundledDir(version);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map((f) => f.match(/^php_(\w+)\.dll$/i)?.[1])
    .filter((m): m is string => !!m)
    .map((m) => m.toLowerCase())
    .map((module) => ({ module, pkg: module, version, zend: module === 'opcache' || module === 'xdebug', enabled: existsSync(iniFile(version, module)) }))
    .sort((a, b) => a.module.localeCompare(b.module));
}

/** PATH etc. for builds: Homebrew's tools (autoconf, pkg-config) first. */
function buildEnv(): Record<string, string> {
  const brew = brewBin();
  const prefix = brew ? join(brew, '..', '..') : '';
  const path = getShellEnv().PATH ?? '/usr/bin:/bin';
  return {
    PATH: brew ? `${join(prefix, 'bin')}:${path}` : path,
    ...(brew ? { PKG_CONFIG_PATH: `${join(prefix, 'lib/pkgconfig')}:${join(prefix, 'share/pkgconfig')}` } : {}),
    LC_ALL: 'C',
  };
}

/** Runs a command, streaming its output lines to `log`; throws with the tail on failure. */
function stream(cmd: string, args: string[], cwd: string, log: (line: string) => void, env: Record<string, string> = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, env: { ...getShellEnv(), ...buildEnv(), ...env } });
    const tail: string[] = [];
    const onData = (buf: Buffer) => {
      for (const line of buf.toString().split('\n')) {
        if (!line.trim()) continue;
        log(line);
        tail.push(line);
        if (tail.length > 8) tail.shift();
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${basename(cmd)} ${args[0] ?? ''} failed (exit ${code}): ${tail.slice(-3).join(' ')}`))));
  });
}

/** What a build needs: Xcode Command Line Tools, autoconf (from Homebrew when missing). */
export async function buildProblem(): Promise<string | null> {
  if (isWin) return null; // ready-made DLLs: nothing to build with
  const clt = await run('xcode-select', ['-p'], { timeout: 10_000 });
  if (clt.code !== 0) return 'Xcode Command Line Tools are needed to build extensions: run “xcode-select --install” in Terminal.';
  const ac = await run('/bin/sh', ['-c', 'command -v autoconf'], { env: buildEnv(), timeout: 10_000 });
  if (ac.code !== 0 && !brewBin()) return 'autoconf is needed (phpize uses it): install Homebrew, or autoconf another way.';
  return null;
}

/** Built-in modules of a PHP binary (`php -n -m`, compiled in, cannot be removed). */
export async function builtin(phpBin: string): Promise<string[]> {
  const r = await run(phpBin, ['-n', '-m'], { timeout: 15_000 });
  return r.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('['))
    .filter((l, i, a) => a.indexOf(l) === i);
}

interface Meta {
  pkg: string;
  version: string;
  zend: boolean;
  /** Windows: libraries the PECL zip shipped, copied next to php.exe. */
  deps?: string[];
}

/** Extensions DevCatz built for a PHP version. */
export function listInstalled(version: string): PhpExtension[] {
  const dir = isWin ? peclDir(version) : extDir(version);
  if (!existsSync(dir)) return [];
  const out: PhpExtension[] = [];
  for (const f of readdirSync(dir)) {
    const module = isWin ? f.match(/^php_(\w+)\.dll$/)?.[1] : f.endsWith('.so') ? f.slice(0, -3) : undefined;
    if (!module) continue;
    let meta: Meta = { pkg: module, version: '', zend: false };
    try {
      meta = JSON.parse(readFileSync(metaFile(version, module), 'utf8')) as Meta;
    } catch {
      /* built before metadata */
    }
    out.push({ module, pkg: meta.pkg, version: meta.version, zend: meta.zend, enabled: existsSync(iniFile(version, module)) });
  }
  return out.sort((a, b) => a.module.localeCompare(b.module));
}

function iniText(file: string, meta: Meta, module: string): string {
  const lines = [`; Installed by DevCatz: PECL ${meta.pkg} ${meta.version}`, `${meta.zend ? 'zend_extension' : 'extension'}="${file}"`];
  // Xdebug only when asked for (XDEBUG_TRIGGER / browser extension), so it does not slow every request.
  if (module === 'xdebug') lines.push('xdebug.mode=debug,develop,coverage', 'xdebug.start_with_request=trigger', 'xdebug.client_port=9003');
  return `${lines.join('\n')}\n`;
}

export function setEnabled(version: string, module: string, on: boolean): void {
  if (!/^\w+$/.test(module)) throw new Error('Unknown extension');
  const from = iniFile(version, module, !on);
  const to = iniFile(version, module, on);
  if (existsSync(from)) renameSync(from, to);
  else if (on && !existsSync(to)) {
    const meta = listInstalled(version).find((e) => e.module === module);
    const bundled = listBundled(version).find((e) => e.module === module);
    if (meta) writeFileSync(to, iniText(moduleFile(version, module), { pkg: meta.pkg, version: meta.version, zend: meta.zend }, module));
    else if (bundled) writeFileSync(to, `; Part of PHP ${version} (ext\\php_${module}.dll)\r\n${bundled.zend ? 'zend_extension' : 'extension'}=${module}\r\n`);
    else throw new Error(`${module} is not installed for PHP ${version}`);
  }
}

export function remove(version: string, module: string): void {
  if (!/^\w+$/.test(module)) throw new Error('Unknown extension');
  // Libraries another PECL extension of this version still ships stay.
  if (isWin) {
    const meta = readMeta(version, module);
    const kept = new Set(listInstalled(version).filter((e) => e.module !== module).flatMap((e) => readMeta(version, e.module)?.deps ?? []));
    for (const d of meta?.deps ?? []) if (!kept.has(d)) rmSync(join(phpDir(), version, d), { force: true });
  }
  for (const f of [iniFile(version, module), iniFile(version, module, false), moduleFile(version, module), metaFile(version, module)]) {
    if (existsSync(f)) unlinkSync(f);
  }
}

function readMeta(version: string, module: string): Meta | null {
  try {
    return JSON.parse(readFileSync(metaFile(version, module), 'utf8')) as Meta;
  } catch {
    return null;
  }
}

/** Drops ini files whose module is gone (PHP uninstalled and reinstalled, folder cleaned up). */
export function pruneIni(version: string): void {
  const d = join(etcDir(version), 'conf.d');
  for (const f of readdirSync(d)) {
    const m = f.match(/^20-(.+)\.ini(\.disabled)?$/);
    const there = (mod: string) => existsSync(moduleFile(version, mod)) || (isWin && existsSync(join(bundledDir(version), `php_${mod}.dll`)));
    if (m && !there(m[1])) unlinkSync(join(d, f));
  }
}

/**
 * A new patch of the same minor (8.4.23 → 8.4.24) keeps the module API, so its
 * extensions are copied over instead of rebuilt.
 */
export function carryOver(from: string, to: string): string[] {
  const list = listInstalled(from);
  if (!list.length) return [];
  mkdirSync(isWin ? peclDir(to) : extDir(to), { recursive: true });
  for (const e of list) {
    copyFileSync(moduleFile(from, e.module), moduleFile(to, e.module));
    const meta: Meta = { pkg: e.pkg, version: e.version, zend: e.zend, ...(isWin ? { deps: readMeta(from, e.module)?.deps ?? [] } : {}) };
    for (const d of meta.deps ?? []) if (existsSync(join(phpDir(), from, d))) copyFileSync(join(phpDir(), from, d), join(phpDir(), to, d));
    writeFileSync(metaFile(to, e.module), JSON.stringify(meta));
    if (e.enabled) writeFileSync(iniFile(to, e.module), iniText(moduleFile(to, e.module), meta, e.module));
  }
  return list.map((e) => e.module);
}

/** phpize + headers for one PHP version, from php.net's source (checksum from its release API). */
async function makeToolkit(version: string, task: (t: Partial<PhpExtTask>) => void, log: (l: string) => void): Promise<string> {
  const prefix = toolkitDir(version);
  if (hasToolkit(version)) return prefix;
  task({ phase: 'toolkit', detail: `Downloading PHP ${version} source (headers for phpize)` });
  const info = (await (await fetch(`https://www.php.net/releases/index.php?json&version=${version}`)).json()) as { source?: { filename: string; sha256: string }[] };
  const src = info.source?.find((s) => s.filename === `php-${version}.tar.xz`) ?? info.source?.find((s) => s.filename === `php-${version}.tar.gz`);
  if (!src?.sha256) throw new Error(`php.net has no source tarball with a checksum for PHP ${version}`);
  const work = mkdtempSync(join(noSpaceDir('build'), `php-${version}-`));
  try {
    const archive = join(work, src.filename);
    await downloadVerified(`https://www.php.net/distributions/${src.filename}`, archive, src.sha256, (received, total) =>
      task({ detail: `Downloading PHP ${version} source ${(received / 1048576).toFixed(1)}${total ? ` / ${(total / 1048576).toFixed(1)}` : ''} MB` }),
    );
    const dir = join(work, 'src');
    mkdirSync(dir);
    await stream('tar', ['-xf', archive, '-C', dir, '--strip-components=1'], work, log);
    task({ detail: 'Preparing phpize and headers (configure, about a minute)' });
    // The static builds are NTS and non-debug, like this configure; pdo and session headers for extensions that use them.
    await stream(
      './configure',
      [`--prefix=${prefix}`, '--disable-all', '--disable-cgi', '--disable-phpdbg', '--without-pear', '--without-sqlite3', '--without-pdo-sqlite', '--without-libxml', '--disable-dom', '--disable-xml', '--disable-simplexml', '--disable-xmlreader', '--disable-xmlwriter', '--enable-pdo', '--enable-session'],
      dir,
      log,
    );
    await stream('make', ['install-headers', 'install-build', 'install-programs'], dir, log);
    if (!hasToolkit(version)) throw new Error('phpize was not installed');
    return prefix;
  } catch (err) {
    rmSync(prefix, { recursive: true, force: true });
    throw err;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

async function brewPrefix(formula: string, task: (t: Partial<PhpExtTask>) => void, log: (l: string) => void): Promise<string> {
  const brew = brewBin();
  if (!brew) throw new Error(`Needs ${formula} from Homebrew; install Homebrew first`);
  let r = await run(brew, ['--prefix', '--installed', formula], { timeout: 30_000 });
  if (r.code !== 0) {
    task({ phase: 'deps', detail: `brew install ${formula}` });
    await stream(brew, ['install', formula], homedir(), log, { HOMEBREW_NO_AUTO_UPDATE: '1' });
    r = await run(brew, ['--prefix', formula], { timeout: 30_000 });
  }
  return r.stdout.trim();
}

/** Latest stable release of a PECL package (latest when it has no stable one). */
async function peclVersion(pkg: string): Promise<string> {
  for (const which of ['stable', 'latest']) {
    const res = await fetch(`https://pecl.php.net/rest/r/${pkg.toLowerCase()}/${which}.txt`);
    if (res.ok) {
      const v = (await res.text()).trim();
      if (/^[\w.-]+$/.test(v)) return v;
    }
  }
  throw new Error(`“${pkg}” was not found on PECL`);
}

/** Does the module load into this PHP? Returns null when it does, else the warning. */
async function loads(phpBin: string, so: string, module: string, zend: boolean): Promise<string | null> {
  const r = await run(phpBin, ['-n', '-d', `${zend ? 'zend_extension' : 'extension'}=${so}`, '-r', `echo extension_loaded(${JSON.stringify(module)}) ? "ok" : "no";`], { timeout: 20_000 });
  return r.stdout.trim().endsWith('ok') ? null : (r.stderr || r.stdout).trim().split('\n').slice(-2).join(' ') || 'did not load';
}

/** Builds a PECL package for one PHP version and enables it. */
export async function install(
  version: string,
  phpBin: string,
  pkgName: string,
  task: (t: Partial<PhpExtTask>) => void,
  log: (l: string) => void,
): Promise<PhpExtension> {
  if (!VERSION.test(version)) throw new Error(`Invalid version ${version}`);
  if (!PKG.test(pkgName)) throw new Error('A PECL package name is letters, digits and _ only');
  if (isWin) return installWin(version, phpBin, pkgName.toLowerCase(), task, log);
  const problem = await buildProblem();
  if (problem) throw new Error(problem);
  const item = CATALOG.find((c) => c.pkg === pkgName.toLowerCase());
  if (!(await run('/bin/sh', ['-c', 'command -v autoconf'], { env: buildEnv() })).stdout.trim()) await brewPrefix('autoconf', task, log);

  const prefix = await makeToolkit(version, task, log);
  const vars: Record<string, string> = {};
  for (const f of item?.brew ?? []) vars[f] = await brewPrefix(f, task, log);

  task({ phase: 'download', detail: `Looking up ${pkgName} on PECL` });
  const pv = await peclVersion(pkgName);
  const work = mkdtempSync(join(noSpaceDir('build'), `${pkgName}-`));
  try {
    const archive = join(work, 'pkg.tgz');
    // PECL publishes no checksums; the download is over HTTPS and the build must load into PHP to be kept.
    await downloadVerified(`https://pecl.php.net/get/${pkgName}-${pv}.tgz`, archive, '', (received) => task({ detail: `Downloading ${pkgName} ${pv} (${Math.round(received / 1024)} KB)` }));
    const dir = join(work, 'src');
    mkdirSync(dir);
    await stream('tar', ['-xzf', archive, '-C', dir, '--strip-components=1'], work, log);

    task({ phase: 'build', detail: `phpize (PHP ${version})` });
    await stream(join(prefix, 'bin', 'phpize'), [], dir, log);
    task({ detail: `Configuring ${pkgName} ${pv}` });
    const extra = (item?.configure ?? []).map((a) => a.replace(/\{(\w+)\}/g, (_m, k: string) => vars[k] ?? ''));
    await stream('./configure', [`--with-php-config=${join(prefix, 'bin', 'php-config')}`, ...extra], dir, log);
    task({ detail: `Compiling ${pkgName} ${pv}` });
    await stream('make', [`-j${Math.max(2, cpus().length)}`], dir, log);

    task({ phase: 'verify', detail: 'Loading it into PHP' });
    const built = readdirSync(join(dir, 'modules')).filter((f) => f.endsWith('.so'));
    if (!built.length) throw new Error('The build produced no .so module');
    const module = built.includes(`${pkgName.toLowerCase()}.so`) ? pkgName.toLowerCase() : built[0].slice(0, -3);
    const tmpSo = join(dir, 'modules', `${module}.so`);
    let zend = item?.zend ?? false;
    let err = await loads(phpBin, tmpSo, module, zend);
    if (err && /zend_extension/i.test(err)) {
      zend = true;
      err = await loads(phpBin, tmpSo, module, zend);
    }
    if (err) throw new Error(`${module} built but does not load: ${err}`);

    mkdirSync(extDir(version), { recursive: true });
    const so = join(extDir(version), `${module}.so`);
    copyFileSync(tmpSo, so);
    const meta: Meta = { pkg: pkgName.toLowerCase(), version: pv, zend };
    writeFileSync(join(extDir(version), `${module}.json`), JSON.stringify(meta));
    if (existsSync(iniFile(version, module, false))) unlinkSync(iniFile(version, module, false));
    writeFileSync(iniFile(version, module), iniText(so, meta, module));
    return { module, pkg: meta.pkg, version: pv, zend, enabled: true };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** Folder names of an index page (`href="6.2.0/"`). */
async function listing(url: string): Promise<string[]> {
  const res = await fetch(url);
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`downloads.php.net: HTTP ${res.status}`);
  return [...(await res.text()).matchAll(/href="([^"/?]+)\/?"/g)].map((m) => decodeURIComponent(m[1]));
}

const versionKey = (v: string) => v.split(/[.-]/).map((p) => (/^\d+$/.test(p) ? p.padStart(6, '0') : p));
const newestFirst = (a: string, b: string) => (versionKey(b).join('.') > versionKey(a).join('.') ? 1 : -1);

/** Windows: a PECL package as the ready-made DLL for this PHP minor (NTS, x64), checked by loading it. */
async function installWin(version: string, phpBin: string, pkg: string, task: (t: Partial<PhpExtTask>) => void, log: (l: string) => void): Promise<PhpExtension> {
  const minor = version.split('.').slice(0, 2).join('.');
  const item = CATALOG.find((c) => c.pkg === pkg);
  task({ phase: 'download', detail: `Looking up ${pkg} for PHP ${minor} (Windows)` });
  const releases = (await listing(`${WIN_PECL}/${pkg}/`)).filter((v) => /^\d[\w.-]*$/.test(v));
  if (!releases.length) throw new Error(`php.net has no Windows builds of “${pkg}”`);
  // Stable releases first (newest first), then pre-releases; the first one built for this minor wins.
  const stable = (v: string) => /^\d+(\.\d+)*$/.test(v);
  const order = [...releases.filter(stable).sort(newestFirst), ...releases.filter((v) => !stable(v)).sort(newestFirst)];
  let found: { pv: string; file: string } | null = null;
  for (const pv of order.slice(0, 8)) {
    const files = await listing(`${WIN_PECL}/${pkg}/${pv}/`);
    const file = files
      .filter((f) => new RegExp(`^php_${pkg}-${pv.replace(/\./g, '\\.')}-${minor.replace('.', '\\.')}-nts-(vs|vc)\\d+-x64\\.zip$`, 'i').test(f))
      .sort(newestFirst)[0];
    if (file) {
      found = { pv, file };
      break;
    }
    log(`${pkg} ${pv}: no build for PHP ${minor} NTS x64`);
  }
  if (!found) throw new Error(`There is no Windows build of ${pkg} for PHP ${minor} on php.net yet (newest: ${order[0]})`);

  const work = mkdtempSync(join(tmpdir(), `devcatz-${pkg}-`));
  try {
    const archive = join(work, found.file);
    log(`GET ${WIN_PECL}/${pkg}/${found.pv}/${found.file}`);
    // php.net publishes no checksums for PECL DLLs; HTTPS, and the DLL must load into this PHP to be kept.
    await downloadVerified(`${WIN_PECL}/${pkg}/${found.pv}/${found.file}`, archive, '', (received) =>
      task({ detail: `Downloading ${pkg} ${found.pv} (${Math.round(received / 1024)} KB)` }),
    );
    const dir = join(work, 'zip');
    mkdirSync(dir);
    const x = await run(TAR, ['-xf', archive, '-C', dir], { timeout: 120_000 });
    if (x.code !== 0) throw new Error(`Could not unpack ${found.file}: ${x.stderr.trim()}`);
    const files = readdirSync(dir);
    const dll = files.find((f) => f.toLowerCase() === `php_${pkg}.dll`) ?? files.find((f) => /^php_\w+\.dll$/i.test(f));
    if (!dll) throw new Error(`${found.file} has no php_*.dll`);
    const module = dll.slice(4, -4).toLowerCase();
    // Libraries the extension links against (libssh2.dll, libyaml.dll …) go next to php.exe.
    const deps = files.filter((f) => /\.dll$/i.test(f) && !/^php_/i.test(f));
    for (const d of deps) {
      if (!existsSync(join(phpDir(), version, d))) copyFileSync(join(dir, d), join(phpDir(), version, d));
      log(`library ${d}`);
    }

    task({ phase: 'verify', detail: 'Loading it into PHP' });
    let zend = item?.zend ?? false;
    let err = await loads(phpBin, join(dir, dll), module, zend);
    if (err && /zend_extension/i.test(err)) {
      zend = true;
      err = await loads(phpBin, join(dir, dll), module, zend);
    }
    if (err) throw new Error(`${module} does not load into PHP ${version}: ${err}`);

    mkdirSync(peclDir(version), { recursive: true });
    copyFileSync(join(dir, dll), moduleFile(version, module));
    const meta: Meta = { pkg, version: found.pv, zend, deps };
    writeFileSync(metaFile(version, module), JSON.stringify(meta));
    if (existsSync(iniFile(version, module, false))) unlinkSync(iniFile(version, module, false));
    writeFileSync(iniFile(version, module), iniText(moduleFile(version, module), meta, module));
    return { module, pkg, version: found.pv, zend, enabled: true };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
