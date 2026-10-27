import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { getCACertificates, rootCertificates } from 'node:tls';
import type { InstalledPhp, PhpChoice, PhpIniSettings, RemotePhp, RuntimeInstallProgress } from '@shared/types';
import { downloadVerified } from './download';
import { spawn } from 'node:child_process';
import { getShellEnv, run } from './env';
import { compare, shimDir } from './node';
import { isWin, TAR, moveDir } from './platform';
import { dataDir } from './store';

/**
 * PHP versions, managed like Node/Bun/Go. Builds come from static-php.dev
 * ("bulk" set: Laravel's usual extensions incl. gd, intl, pdo_mysql, redis,
 * zip, bcmath, pcntl, sodium, imagick, OPcache). static-php.dev publishes no
 * checksums, so each download is fetched over HTTPS, its SHA-256 recorded,
 * and the binary must report the expected version before it is kept.
 * Laravel Herd's PHP (if installed) is picked up read-only.
 *
 * Layout: php/<version>/bin/{php,php-fpm}, php/<version>/etc/php.ini (base)
 * and etc/conf.d/99-mrcatz.ini (the user's settings from the PHP page).
 *
 * Windows: the official NTS x64 zips from windows.php.net (SHA-256 from its
 * releases.json), unpacked as php/<version>/{php.exe,php-cgi.exe,ext/*.dll};
 * no php-fpm (fpm.ts runs php-cgi workers), no Herd / Homebrew / static-php.
 */
const BASE = 'https://dl.static-php.dev/static-php-cli/bulk';
const ARCH = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
const VERSION = /^\d+\.\d+\.\d+$/;
const HERD_BIN = join(homedir(), 'Library/Application Support/Herd/bin');
/** static-php.dev starts at 8.0; older apps (Laravel ≤ 8, CodeIgniter 3, …) get PHP from shivammathur/php via Homebrew. */
export const LEGACY_MINORS = ['7.4', '7.3', '7.2', '7.1', '7.0', '5.6'];
const BREW_TAP = 'shivammathur/php';
const BREW_PREFIXES = ['/opt/homebrew', '/usr/local'];
/** Windows builds: current release of each minor in releases.json, older patches under archives/ (SHA-1 only). */
// windows.php.net redirects here; its own address is unreachable over IPv4 from some networks (seen 2026-10-27).
const WIN_BASE = 'https://downloads.php.net/~windows/releases';

export function brewBin(): string | null {
  return BREW_PREFIXES.map((p) => join(p, 'bin/brew')).find((b) => existsSync(b)) ?? null;
}

export const phpDir = () => {
  const d = dataDir('php');
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
  return d;
};

let listing: { at: number; versions: string[] } | null = null;

interface WinRelease {
  version: string;
  path: string;
  sha256: string;
}
let winListing: { at: number; byMinor: Map<string, WinRelease> } | null = null;

/** Windows: the NTS x64 zip of each minor's current release (8.4.27-1 = a rebuild of 8.4.27, kept as 8.4.27). */
async function winReleases(): Promise<Map<string, WinRelease>> {
  if (winListing && Date.now() - winListing.at < 3600_000) return winListing.byMinor;
  const res = await fetch(`${WIN_BASE}/releases.json`);
  if (!res.ok) throw new Error(`windows.php.net: HTTP ${res.status}`);
  const json = (await res.json()) as Record<string, Record<string, unknown>>;
  const byMinor = new Map<string, WinRelease>();
  for (const [minor, rel] of Object.entries(json)) {
    const version = String(rel.version ?? '').replace(/-\d+$/, '');
    if (!VERSION.test(version) || !version.startsWith(`${minor}.`)) continue;
    // Newest toolchain first (vs17 for 8.4+, vs16 for 8.0–8.3, vc15 for 7.x).
    const key = Object.keys(rel)
      .filter((k) => /^nts-v[cs]\d+-x64$/.test(k))
      .sort((a, b) => Number(b.replace(/\D/g, '')) - Number(a.replace(/\D/g, '')))[0];
    const zip = key ? (rel[key] as { zip?: { path?: string; sha256?: string } }).zip : undefined;
    if (zip?.path && /^[a-f0-9]{64}$/i.test(zip.sha256 ?? '')) byMinor.set(minor, { version, path: zip.path, sha256: zip.sha256!.toLowerCase() });
  }
  winListing = { at: Date.now(), byMinor };
  return byMinor;
}

async function remoteVersions(): Promise<string[]> {
  if (listing && Date.now() - listing.at < 3600_000) return listing.versions;
  if (isWin) {
    const versions = [...(await winReleases()).values()].map((r) => r.version);
    listing = { at: Date.now(), versions };
    return versions;
  }
  const res = await fetch(`${BASE}/?format=json`);
  if (!res.ok) throw new Error(`static-php.dev: HTTP ${res.status}`);
  const files = (await res.json()) as { name: string }[];
  const kinds = new Map<string, Set<string>>();
  for (const f of files) {
    const m = f.name.match(new RegExp(`^php-(\\d+\\.\\d+\\.\\d+)-(cli|fpm)-macos-${ARCH}\\.tar\\.gz$`));
    if (m) kinds.set(m[1], (kinds.get(m[1]) ?? new Set()).add(m[2]));
  }
  const versions = [...kinds].filter(([, k]) => k.has('cli') && k.has('fpm')).map(([v]) => v);
  listing = { at: Date.now(), versions };
  return versions;
}

let upstreamCache: { at: number; byMinor: Map<string, NonNullable<RemotePhp['upstream']>> } | null = null;

/**
 * php.net's newest release of each minor (releases/index.php?json&version=8.4),
 * for a note when static-php.dev has not built it yet. Cached for an hour;
 * a minor php.net does not answer for is simply left out.
 */
async function upstreamReleases(minors: string[], force: boolean): Promise<Map<string, NonNullable<RemotePhp['upstream']>>> {
  if (!force && upstreamCache && Date.now() - upstreamCache.at < 3600_000 && minors.every((m) => upstreamCache!.byMinor.has(m))) return upstreamCache.byMinor;
  const byMinor = new Map<string, NonNullable<RemotePhp['upstream']>>();
  await Promise.all(
    minors.map(async (minor) => {
      try {
        const res = await fetch(`https://www.php.net/releases/index.php?json&version=${minor}`, { signal: AbortSignal.timeout(8000) });
        if (!res.ok) return;
        const j = (await res.json()) as { version?: string; date?: string; tags?: string[] };
        if (j.version && VERSION.test(j.version) && j.version.startsWith(`${minor}.`)) byMinor.set(minor, { version: j.version, date: j.date ?? '', security: (j.tags ?? []).includes('security') });
      } catch {
        /* offline or php.net busy: no note */
      }
    }),
  );
  upstreamCache = { at: Date.now(), byMinor };
  return byMinor;
}

/** Newest patch of each minor (8.5, 8.4, …), newest first; with php.net's newer release when there is one. */
export async function listRemote(force = false): Promise<RemotePhp[]> {
  if (force) listing = winListing = null;
  const byMinor = new Map<string, string>();
  for (const v of await remoteVersions()) {
    const minor = v.split('.').slice(0, 2).join('.');
    const prev = byMinor.get(minor);
    if (!prev || compare(v, prev) > 0) byMinor.set(minor, v);
  }
  const upstream = await upstreamReleases([...byMinor.keys()], force).catch(() => new Map<string, NonNullable<RemotePhp['upstream']>>());
  const builds: RemotePhp[] = [...byMinor]
    .map(([minor, version]) => {
      const up = upstream.get(minor);
      return up && compare(up.version, version) > 0 ? { minor, version, upstream: up } : { minor, version };
    })
    .sort((a, b) => compare(b.version, a.version));
  // Windows: every minor windows.php.net still lists (7.4 included) is a download; there is no Homebrew.
  if (isWin) return builds;
  return [...builds, ...LEGACY_MINORS.filter((m) => !byMinor.has(m)).map((minor) => ({ minor, version: minor, via: 'homebrew' as const }))];
}

export async function listInstalled(): Promise<InstalledPhp[]> {
  const out: InstalledPhp[] = [];
  if (isWin) {
    // Windows: the zip's own layout, php.exe + php-cgi.exe (the FastCGI server fpm.ts runs) in the version folder.
    try {
      for (const v of readdirSync(phpDir())) {
        const dir = join(phpDir(), v);
        if (VERSION.test(v) && existsSync(join(dir, 'php.exe')) && existsSync(join(dir, 'php-cgi.exe'))) {
          out.push({ version: v, source: 'mrcatz', php: join(dir, 'php.exe'), fpm: join(dir, 'php-cgi.exe'), binDir: dir });
        }
      }
    } catch {
      /* none yet */
    }
    return out.sort((a, b) => compare(b.version, a.version));
  }
  try {
    for (const v of readdirSync(phpDir())) {
      const bin = join(phpDir(), v, 'bin');
      if (VERSION.test(v) && existsSync(join(bin, 'php')) && existsSync(join(bin, 'php-fpm'))) {
        out.push({ version: v, source: 'mrcatz', php: join(bin, 'php'), fpm: join(bin, 'php-fpm'), binDir: bin });
      }
    }
  } catch {
    /* none yet */
  }
  // Laravel Herd's builds (php84 + php84-fpm, …), usable while Herd is installed.
  try {
    for (const f of readdirSync(HERD_BIN)) {
      const m = f.match(/^php(\d)(\d+)$/);
      if (!m || !existsSync(join(HERD_BIN, `${f}-fpm`))) continue;
      const v = await run(join(HERD_BIN, f), ['-r', 'echo PHP_VERSION;'], { timeout: 5000 });
      const version = v.stdout.trim();
      if (v.code === 0 && VERSION.test(version) && !out.some((o) => o.version === version)) {
        out.push({ version, source: 'herd', php: join(HERD_BIN, f), fpm: join(HERD_BIN, `${f}-fpm`), binDir: HERD_BIN });
      }
    }
  } catch {
    /* Herd not installed */
  }
  // Homebrew's PHP (php, php@7.4, … from homebrew-core or shivammathur/php), read-only.
  for (const prefix of BREW_PREFIXES) {
    let entries: string[] = [];
    try {
      entries = readdirSync(join(prefix, 'opt'));
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!/^php(@\d+\.\d+)?$/.test(e)) continue;
      const bin = join(prefix, 'opt', e, 'bin');
      const php = join(bin, 'php');
      const fpm = join(prefix, 'opt', e, 'sbin/php-fpm');
      if (!existsSync(php) || !existsSync(fpm)) continue;
      const v = await run(php, ['-n', '-r', 'echo PHP_VERSION;'], { timeout: 5000 });
      const version = v.stdout.trim();
      if (v.code === 0 && VERSION.test(version) && !out.some((o) => o.version === version)) {
        out.push({ version, source: 'homebrew', php, fpm, binDir: bin });
      }
    }
  }
  return out.sort((a, b) => compare(b.version, a.version));
}

/**
 * Installs `version` and returns the exact version installed: a static-php.dev
 * build for x.y.z, or `brew install shivammathur/php/php@x.y` for a legacy minor.
 */
export async function install(version: string, progress: (p: RuntimeInstallProgress) => void): Promise<string> {
  if (isWin) return installWin(version, progress);
  if (LEGACY_MINORS.includes(version)) return installWithBrew(version, progress);
  if (!VERSION.test(version)) throw new Error(`Invalid version ${version}`);
  const target = join(phpDir(), version);
  if (existsSync(join(target, 'bin/php-fpm'))) return '';
  const tmp = join(phpDir(), `.tmp-${version}-${Date.now()}`);
  mkdirSync(join(tmp, 'bin'), { recursive: true });
  const sums: string[] = [];
  try {
    let done = 0;
    for (const kind of ['cli', 'fpm'] as const) {
      const file = `php-${version}-${kind}-macos-${ARCH}.tar.gz`;
      const archive = join(tmp, file);
      // No upstream checksum: the SHA-256 is recorded in SHA256SUMS next to the binaries.
      const digest = await downloadVerified(`${BASE}/${file}`, archive, '', (r, t) =>
        progress({ version, phase: 'download', received: done + r, total: done + t * (kind === 'cli' ? 2 : 1) }),
      );
      sums.push(`${digest}  ${file}`);
      done += Number(readFileSync(archive).length);
      const { code, stderr } = await run('tar', ['-xzf', archive, '-C', join(tmp, 'bin')], { timeout: 180_000 });
      if (code !== 0) throw new Error(`tar: ${stderr.trim()}`);
      unlinkSync(archive);
    }
    progress({ version, phase: 'extract', received: done, total: done });
    const check = await run(join(tmp, 'bin/php'), ['-n', '-r', 'echo PHP_VERSION;'], { timeout: 15_000 });
    if (check.stdout.trim() !== version) throw new Error(`Downloaded binary reports "${check.stdout.trim() || check.stderr.trim()}", expected ${version}`);
    writeFileSync(join(tmp, 'SHA256SUMS'), sums.join('\n') + '\n');
    await moveDir(tmp, target);
    progress({ version, phase: 'done', received: done, total: done });
    return version;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * Windows: windows.php.net's NTS x64 zip, verified against releases.json's SHA-256 (the current
 * release of the minor) or archives/sha1sum.txt (an older patch), unpacked with Windows' tar.
 */
async function installWin(version: string, progress: (p: RuntimeInstallProgress) => void): Promise<string> {
  if (!VERSION.test(version)) throw new Error(`Invalid version ${version}`);
  const target = join(phpDir(), version);
  if (existsSync(join(target, 'php-cgi.exe'))) return '';
  const minor = version.split('.').slice(0, 2).join('.');
  const current = (await winReleases()).get(minor);
  let url: string;
  let file: string;
  let sha256 = '';
  let sha1 = '';
  if (current?.version === version) {
    file = current.path;
    url = `${WIN_BASE}/${file}`;
    sha256 = current.sha256;
  } else {
    const res = await fetch(`${WIN_BASE}/archives/sha1sum.txt`);
    if (!res.ok) throw new Error(`windows.php.net archives: HTTP ${res.status}`);
    const name = new RegExp(`^php-${version.replace(/\./g, '\\.')}(-\\d+)?-nts-Win32-v[cs]\\d+-x64\\.zip$`);
    // Rebuilds (-1, -2) sort after the plain build: take the last one.
    const hit = (await res.text())
      .split('\n')
      .map((l) => l.trim().split(/\s+\*?/))
      .filter(([h, f]) => /^[a-f0-9]{40}$/i.test(h ?? '') && name.test(f ?? ''))
      .sort((a, b) => a[1].localeCompare(b[1], undefined, { numeric: true }))
      .pop();
    if (!hit) throw new Error(`windows.php.net has no NTS x64 build of PHP ${version}`);
    [sha1, file] = [hit[0].toLowerCase(), hit[1]];
    url = `${WIN_BASE}/archives/${file}`;
  }
  const tmp = join(phpDir(), `.tmp-${version}-${Date.now()}`);
  mkdirSync(tmp, { recursive: true });
  try {
    const archive = join(tmp, file);
    const digest = await downloadVerified(url, archive, sha256, (r, t) => progress({ version, phase: 'download', received: r, total: t }));
    if (sha1 && createHash('sha1').update(readFileSync(archive)).digest('hex') !== sha1) throw new Error('Checksum mismatch, download discarded');
    const size = Number(readFileSync(archive).length);
    progress({ version, phase: 'extract', received: size, total: size });
    const { code, stderr } = await run(TAR, ['-xf', archive, '-C', tmp], { timeout: 180_000 });
    if (code !== 0) throw new Error(`tar: ${stderr.trim()}`);
    unlinkSync(archive);
    const check = await run(join(tmp, 'php.exe'), ['-n', '-r', 'echo PHP_VERSION;'], { timeout: 15_000 });
    // php.exe that cannot even start: the Visual C++ runtime (vcruntime140.dll) is missing.
    if (!check.stdout.trim() && !check.stderr.trim()) {
      throw new Error('PHP did not start. It needs the Microsoft Visual C++ Redistributable (x64): install it from https://aka.ms/vs/17/release/vc_redist.x64.exe and try again.');
    }
    if (check.stdout.trim() !== version) throw new Error(`Downloaded binary reports "${check.stdout.trim() || check.stderr.trim()}", expected ${version}`);
    writeFileSync(join(tmp, 'SHA256SUMS'), `${digest}  ${file}\n`);
    await moveDir(tmp, target);
    progress({ version, phase: 'done', received: size, total: size });
    return version;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

async function installWithBrew(minor: string, progress: (p: RuntimeInstallProgress) => void): Promise<string> {
  const brew = brewBin();
  if (!brew) throw new Error(`PHP ${minor} comes from Homebrew (static-php.dev only builds PHP 8). Install Homebrew from https://brew.sh first.`);
  const formula = `${BREW_TAP}/php@${minor}`;
  const report = (detail: string) => progress({ version: minor, phase: 'download', received: 0, total: 0, detail });
  report(`brew install ${formula}`);
  const tail: string[] = [];
  const code = await new Promise<number>((resolve) => {
    const child = spawn(brew, ['install', formula], {
      env: { ...getShellEnv(), HOMEBREW_NO_ENV_HINTS: '1', NONINTERACTIVE: '1', HOMEBREW_NO_INSTALLED_DEPENDENTS_CHECK: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const onData = (d: Buffer) => {
      for (const line of d.toString().split('\n').map((l) => l.trim()).filter(Boolean)) {
        tail.push(line);
        if (tail.length > 20) tail.shift();
        report(line.slice(0, 160));
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', () => resolve(1));
    child.on('close', (c) => resolve(c ?? 1));
  });
  if (code !== 0) throw new Error(`brew install ${formula} failed:\n${tail.slice(-6).join('\n')}`);
  const prefix = dirname(dirname(brew));
  const php = join(prefix, 'opt', `php@${minor}`, 'bin/php');
  const v = await run(php, ['-n', '-r', 'echo PHP_VERSION;'], { timeout: 10_000 });
  const version = v.stdout.trim();
  if (!VERSION.test(version) || !version.startsWith(`${minor}.`)) throw new Error(`Homebrew's php@${minor} reports "${version || v.stderr.trim()}"`);
  progress({ version, phase: 'done', received: 0, total: 0 });
  return version;
}

export function uninstall(version: string): void {
  if (!VERSION.test(version)) throw new Error(`Invalid version ${version}`);
  const target = join(phpDir(), version);
  if (!existsSync(target)) throw new Error(`PHP ${version} is not managed by DevCatz`);
  rmSync(target, { recursive: true, force: true });
}

// --------------------------------------------------------------- php.ini

/** Defaults mirror Laravel Herd's (512M memory, 64M uploads, 120 s). */
export const INI_DEFAULTS: PhpIniSettings = {
  memory_limit: '512M',
  upload_max_filesize: '64M',
  post_max_size: '64M',
  max_execution_time: '120',
  max_input_vars: '5000',
  display_errors: 'On',
  error_reporting: 'E_ALL',
  'date.timezone': Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
  'opcache.enable': '1',
  extra: '',
};

/** Config folder per PHP version (also for Herd's PHP, kept in our data dir). */
export const etcDir = (version: string) => {
  const d = join(dataDir('php-etc'), version);
  mkdirSync(join(d, 'conf.d'), { recursive: true });
  return d;
};

const caBundle = () => join(dataDir('php-etc'), 'cacert.pem');

/**
 * Writes the CA bundle PHP uses for curl/openssl: macOS root certificates
 * plus DevCatz's local CA, so Http::get('https://other-site.localhost') works.
 */
export async function writeCaBundle(localCa: string | null): Promise<void> {
  if (isWin) {
    // Windows: Node's bundled roots plus the ones in Windows' own store (no `security` command), then DevCatz's local CA.
    let system: string[] = [];
    try {
      system = getCACertificates('system');
    } catch {
      /* older Node: bundled roots only */
    }
    const local = localCa && existsSync(localCa) ? readFileSync(localCa, 'utf8') : '';
    writeFileSync(caBundle(), [...new Set([...rootCertificates, ...system])].join('\n') + '\n' + local);
    return;
  }
  const { stdout } = await run('security', ['find-certificate', '-a', '-p', '/System/Library/Keychains/SystemRootCertificates.keychain'], { timeout: 20_000 });
  const local = localCa && existsSync(localCa) ? readFileSync(localCa, 'utf8') : '';
  writeFileSync(caBundle(), stdout + '\n' + local);
}

export function readIni(version: string): PhpIniSettings {
  try {
    return { ...INI_DEFAULTS, ...JSON.parse(readFileSync(join(etcDir(version), 'settings.json'), 'utf8')) };
  } catch {
    return { ...INI_DEFAULTS };
  }
}

function iniText(settings: PhpIniSettings): string {
  const { extra, ...values } = settings;
  return [
    '; Managed by DevCatz (PHP page). Edit there; this file is rewritten.',
    ...Object.entries(values).map(([k, v]) => `${k} = ${/^[\w.+-]+$/.test(v) ? v : `"${v.replace(/"/g, '')}"`}`),
    `curl.cainfo = "${caBundle()}"`,
    `openssl.cafile = "${caBundle()}"`,
    'opcache.validate_timestamps = 1',
    'opcache.revalidate_freq = 0',
    extra.trim(),
    '',
  ].join('\n');
}

/** Extensions Laravel & co. expect, loaded on Windows when this build has the .dll (bcmath, … are built in). */
const WIN_EXTENSIONS = ['curl', 'fileinfo', 'mbstring', 'openssl', 'pdo_mysql', 'pdo_pgsql', 'pdo_sqlite', 'sqlite3', 'zip', 'gd', 'gd2', 'intl', 'bcmath', 'exif', 'sodium'];

/**
 * Windows' base php.ini: the zip's extensions are shared .dll files, so the base names the version's ext folder
 * and loads the usual ones (php.ini-development leaves them all commented out).
 */
function winBaseIni(phpBin: string): string {
  const ext = join(dirname(phpBin), 'ext');
  const has = (name: string) => existsSync(join(ext, `php_${name}.dll`));
  return [
    '; Base php.ini for DevCatz (Windows): this build\'s extensions. Settings live in conf.d/99-mrcatz.ini.',
    `extension_dir = "${ext}"`,
    // php-cgi as a FastCGI server behind DevCatz's proxy (no web server sets REDIRECT_STATUS).
    'cgi.force_redirect = 0',
    'cgi.fix_pathinfo = 1',
    ...WIN_EXTENSIONS.filter((e) => has(e) && !(e === 'gd2' && has('gd'))).map((e) => `extension=${e}`),
    ...(has('opcache') ? ['zend_extension=opcache'] : []),
    '',
  ].join('\r\n');
}

/** Validates with `php -n -c <candidate>` first, then writes php.ini + conf.d/99-mrcatz.ini. */
export async function writeIni(phpBin: string, version: string, settings: PhpIniSettings): Promise<void> {
  const dir = etcDir(version);
  const candidate = join(dir, '.candidate.ini');
  writeFileSync(candidate, iniText(settings));
  const check = await run(phpBin, ['-n', '-c', candidate, '-r', 'echo "ok";'], { timeout: 15_000 });
  const problems = (check.stdout + check.stderr).split('\n').filter((l) => /warning|error|unknown|parse/i.test(l));
  if (check.code !== 0 || !check.stdout.includes('ok') || problems.length) {
    rmSync(candidate, { force: true });
    throw new Error(`php.ini rejected: ${problems.join(' ') || check.stderr.trim() || 'unknown error'}`);
  }
  if (isWin) writeFileSync(join(dir, 'php.ini'), winBaseIni(phpBin));
  else if (!existsSync(join(dir, 'php.ini'))) writeFileSync(join(dir, 'php.ini'), '; Base php.ini for DevCatz. Settings live in conf.d/99-mrcatz.ini.\n');
  renameSync(candidate, join(dir, 'conf.d/99-mrcatz.ini'));
  writeFileSync(join(dir, 'settings.json'), JSON.stringify(settings, null, 2));
}

/** Env for any php process: our php.ini + conf.d instead of the binary's compiled-in paths. */
export function iniEnv(version: string): Record<string, string> {
  const dir = etcDir(version);
  return { PHPRC: dir, PHP_INI_SCAN_DIR: join(dir, 'conf.d') };
}

/** Effective values (`php -i`), so the page shows what is really active. */
export async function effectiveIni(phpBin: string, version: string, keys: string[]): Promise<Record<string, string>> {
  const code = `foreach (${JSON.stringify(keys)} as $k) echo $k, "=", ini_get($k), "\\n";`;
  if (isWin) {
    // No /usr/bin/env: the ini env goes in through run()'s env.
    const { stdout } = await run(phpBin, ['-r', code], { env: iniEnv(version), timeout: 10_000 });
    return Object.fromEntries(stdout.split(/\r?\n/).filter(Boolean).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
  }
  const { stdout } = await run('/usr/bin/env', [...Object.entries(iniEnv(version)).map(([k, v]) => `${k}=${v}`), phpBin, '-r', code], { timeout: 10_000 });
  return Object.fromEntries(stdout.split('\n').filter(Boolean).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
}

// ----------------------------------------------------------- composer + shims

const composerPhar = () => join(dataDir('php-etc'), 'composer.phar');

export const composerInstalled = () => existsSync(composerPhar());

/** composer.phar from getcomposer.org, verified against its published SHA-256. */
export async function installComposer(progress: (p: RuntimeInstallProgress) => void): Promise<void> {
  const sum = (await (await fetch('https://getcomposer.org/download/latest-stable/composer.phar.sha256sum')).text()).trim().split(/\s+/)[0];
  if (!/^[a-f0-9]{64}$/.test(sum)) throw new Error('Could not read the composer checksum');
  const tmp = `${composerPhar()}.tmp`;
  await downloadVerified('https://getcomposer.org/download/latest-stable/composer.phar', tmp, sum, (r, t) =>
    progress({ version: 'composer', phase: 'download', received: r, total: t }),
  );
  renameSync(tmp, composerPhar());
  // Windows: `composer` next to the phar, on whichever php.exe comes first on the Path.
  if (isWin) writeFileSync(join(dirname(composerPhar()), 'composer.bat'), '@php "%~dp0composer.phar" %*\r\n');
  progress({ version: 'composer', phase: 'done', received: 0, total: 0 });
}

/**
 * `php` and `composer` shims for the default version (shell scripts so they
 * carry PHPRC/PHP_INI_SCAN_DIR into terminals that add the shim folder).
 */
export function writeShims(def: InstalledPhp | null): void {
  const dir = shimDir();
  mkdirSync(dir, { recursive: true });
  if (isWin) {
    // Windows: php.cmd / composer.cmd setting the ini env for the call only.
    for (const name of ['php', 'composer']) rmSync(join(dir, `${name}.cmd`), { force: true });
    if (!def) return;
    writeFileSync(join(dir, 'php.cmd'), cmdWrapper(def, [def.php], `PHP ${def.version}`));
    if (composerInstalled()) writeFileSync(join(dir, 'composer.cmd'), cmdWrapper(def, [def.php, composerPhar()], `composer on PHP ${def.version}`));
    return;
  }
  for (const name of ['php', 'composer']) rmSync(join(dir, name), { force: true });
  if (!def) return;
  const env = Object.entries(iniEnv(def.version))
    .map(([k, v]) => `export ${k}="${v}"`)
    .join('\n');
  writeFileSync(join(dir, 'php'), `#!/bin/sh\n# DevCatz: PHP ${def.version}\n${env}\nexec "${def.php}" "$@"\n`);
  chmodSync(join(dir, 'php'), 0o755);
  // Only with DevCatz's Composer: a wrapper around a missing phar would hide Herd's / Homebrew's composer.
  if (composerInstalled()) {
    writeFileSync(join(dir, 'composer'), `#!/bin/sh\n# DevCatz: composer on PHP ${def.version}\n${env}\nexec "${def.php}" "${composerPhar()}" "$@"\n`);
    chmodSync(join(dir, 'composer'), 0o755);
  }
}

/** Windows wrapper: setlocal keeps PHPRC / PHP_INI_SCAN_DIR out of the calling console. */
function cmdWrapper(p: InstalledPhp, command: string[], note: string): string {
  const env = Object.entries(iniEnv(p.version)).map(([k, v]) => `set "${k}=${v}"`);
  return ['@echo off', `rem DevCatz: ${note}`, 'setlocal', ...env, `${command.map((c) => `"${c}"`).join(' ')} %*`, 'exit /b %ERRORLEVEL%', ''].join('\r\n');
}

/** Per-site bin folder: `php` + `composer` wrappers for that site's version (put first on PATH). */
export function siteBinDir(p: InstalledPhp): string {
  const dir = join(dataDir('php-etc'), 'bin', p.version + (p.source === 'herd' ? '-herd' : ''));
  mkdirSync(dir, { recursive: true });
  if (isWin) {
    writeFileSync(join(dir, 'php.cmd'), cmdWrapper(p, [p.php], `PHP ${p.version}`));
    if (composerInstalled()) writeFileSync(join(dir, 'composer.cmd'), cmdWrapper(p, [p.php, composerPhar()], `composer on PHP ${p.version}`));
    else rmSync(join(dir, 'composer.cmd'), { force: true });
    return dir;
  }
  const env = Object.entries(iniEnv(p.version))
    .map(([k, v]) => `export ${k}="${v}"`)
    .join('\n');
  writeFileSync(join(dir, 'php'), `#!/bin/sh\n${env}\nexec "${p.php}" "$@"\n`);
  chmodSync(join(dir, 'php'), 0o755);
  // Without DevCatz's Composer the site falls through to the composer on PATH (Herd's, Homebrew's).
  if (composerInstalled()) {
    writeFileSync(join(dir, 'composer'), `#!/bin/sh\n${env}\nexec "${p.php}" "${composerPhar()}" "$@"\n`);
    chmodSync(join(dir, 'composer'), 0o755);
  } else rmSync(join(dir, 'composer'), { force: true });
  return dir;
}

// ------------------------------------------------------------ resolution

/** `"php": "^8.2"` from composer.json. */
export function readPhpSpec(dir: string): string | null {
  try {
    return JSON.parse(readFileSync(join(dir, 'composer.json'), 'utf8')).require?.php ?? null;
  } catch {
    return null;
  }
}

/** Newest installed version satisfying a composer constraint (^8.2, >=8.1, ~8.3, 8.2.*, ||). */
export function satisfies(version: string, spec: string): boolean {
  return spec.split('||').some((alt) =>
    alt
      .trim()
      .split(/[\s,]+/)
      .filter(Boolean)
      .every((c) => {
        const m = c.match(/^(\^|~|>=|<=|>|<|=)?v?(\d+)(?:\.(\d+|\*))?(?:\.(\d+|\*))?/);
        if (!m) return true;
        const [, op = '', maj, min = '0', pat = '0'] = m;
        const want = `${maj}.${min === '*' ? 0 : min}.${pat === '*' ? 0 : pat}`;
        const [vM, vm] = version.split('.').map(Number);
        switch (op) {
          case '^':
            return Number(maj) === vM && compare(version, want) >= 0;
          case '~':
            return m[4] !== undefined ? Number(maj) === vM && Number(min) === vm && compare(version, want) >= 0 : Number(maj) === vM && compare(version, want) >= 0;
          case '>=':
            return compare(version, want) >= 0;
          case '>':
            return compare(version, want) > 0;
          case '<=':
            return compare(version, want) <= 0;
          case '<':
            return compare(version, want) < 0;
          default:
            return min === '*' || m[3] === undefined ? Number(maj) === vM : pat === '*' || m[4] === undefined ? Number(maj) === vM && Number(min) === vm : version === want;
        }
      }),
  );
}

export function choosePhp(spec: string | null, installed: InstalledPhp[], defaultVersion: string | null, pinned?: string): PhpChoice {
  const pick = (p: InstalledPhp | undefined, reason: PhpChoice['reason'], missing = false): PhpChoice =>
    p ? { version: p.version, binDir: p.binDir, reason, spec, missing, source: p.source } : { version: null, binDir: null, reason: 'none', spec, missing: true, source: null };
  if (pinned) {
    const p = installed.find((i) => i.version === pinned);
    if (p) return pick(p, 'site');
  }
  const ok = (v: string) => !spec || satisfies(v, spec);
  const def = installed.find((i) => i.version === defaultVersion);
  if (def && ok(def.version)) return pick(def, 'default');
  const match = installed.find((i) => ok(i.version));
  if (match) return pick(match, 'project');
  return pick(def ?? installed[0], def ? 'default' : 'system', true);
}
