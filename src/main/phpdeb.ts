import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import type { RuntimeInstallProgress } from '@shared/types';
import { DEB_ARCH, debDistro, hasDpkgDeb, newestDeb, parsePackages, unpackDebs, type DebEntry } from './debpkg';
import { run } from './env';
import { runAsRootLinux } from './linuxadmin';
import { moveDir, removeTemp } from './platform';

/**
 * Linux: PHP 8.0, 7.x and 5.6, which static-php.dev does not build (its glibc builds start at 8.1) — the counterpart
 * of Homebrew's shivammathur/php tap on macOS and php.net's zips on Windows (user, 2026-11-09). They come from the
 * repositories Ubuntu and Debian users take old PHP from: Ondřej Surý's PPA (ppa.launchpadcontent.net/ondrej/php) on
 * Ubuntu and its derivatives, packages.sury.org/php on Debian. DevCatz unpacks the packages (SHA-256 from the
 * repository's index) into php/<version>/ — nothing goes into the system, so a PHP of the distribution is left alone —
 * and installs the shared libraries they link (their Depends) through the password dialog when some are missing.
 *
 * Layout: php/<version>/usr (the packages' /usr), bin/php and bin/php-fpm pointing into it, and deb.json (the
 * extension folder). Their extensions are shared .so files: the base php.ini loads the ones others depend on
 * (pdo, mysqlnd, xml, json), each other one has its own conf.d/20-<name>.ini, switched on the PHP page like Windows'.
 */

export const LINUX_LEGACY_MINORS = ['8.0', '7.4', '7.3', '7.2', '7.1', '7.0', '5.6'];

/** The extension packages installed with each version (when the repository has them for that minor). */
const EXT_PACKAGES = ['common', 'opcache', 'readline', 'json', 'mysql', 'pgsql', 'sqlite3', 'mbstring', 'xml', 'curl', 'zip', 'gd', 'intl', 'bcmath', 'soap'];
/** Loaded by the base php.ini (others need them first); the rest are switchable. Priority 10 in the packages. */
export const DEB_CORE_EXTENSIONS = ['opcache', 'pdo', 'mysqlnd', 'xml', 'json'];

function repo(): { base: string; dist: string; label: string } {
  const d = debDistro();
  if (!d) throw new Error('PHP before 8.1 comes from the Ubuntu / Debian PHP repositories (ondrej / sury) here; on this distribution use PHP 8.1 or newer');
  return d.os === 'ubuntu'
    ? { base: 'https://ppa.launchpadcontent.net/ondrej/php/ubuntu', dist: d.codename, label: 'ppa:ondrej/php' }
    : { base: 'https://packages.sury.org/php', dist: d.codename, label: 'packages.sury.org/php' };
}

let indexCache: { at: number; entries: DebEntry[] } | null = null;
async function index(force = false): Promise<DebEntry[]> {
  if (!force && indexCache && Date.now() - indexCache.at < 3_600_000) return indexCache.entries;
  const r = repo();
  const res = await fetch(`${r.base}/dists/${r.dist}/main/binary-${DEB_ARCH}/Packages.gz`);
  if (!res.ok) throw new Error(`${r.label} has no packages for ${r.dist} (HTTP ${res.status})`);
  const entries = parsePackages(gunzipSync(Buffer.from(await res.arrayBuffer())).toString('utf8'));
  indexCache = { at: Date.now(), entries };
  return entries;
}

/** Newest version of each legacy minor the repository has for this system (cli and fpm both). */
export async function debLegacyVersions(force = false): Promise<{ minor: string; version: string }[]> {
  const entries = await index(force).catch(() => [] as DebEntry[]);
  const out: { minor: string; version: string }[] = [];
  for (const minor of LINUX_LEGACY_MINORS) {
    const cli = newestDeb(entries, `php${minor}-cli`);
    if (cli && newestDeb(entries, `php${minor}-fpm`, cli.version)) out.push({ minor, version: cli.version });
  }
  return out;
}

/** The library packages a set of .deb files needs (their Depends, first alternative, `lib*` only). */
function libraryDepends(debs: DebEntry[]): string[] {
  const names = new Set<string>();
  for (const d of debs)
    for (const part of (d.depends ?? '').split(',')) {
      const name = part.split('|')[0].trim().split(/[\s(:]/)[0];
      if (/^lib[\w.+-]+$/.test(name)) names.add(name);
    }
  return [...names];
}

async function missingPackages(names: string[]): Promise<string[]> {
  const missing: string[] = [];
  for (const n of names) {
    const r = await run('dpkg-query', ['-W', '-f=${Status}', n], { timeout: 10_000 });
    if (r.code !== 0 || !r.stdout.includes('install ok installed')) missing.push(n);
  }
  return missing;
}

export const debInfoFile = (dir: string) => join(dir, 'deb.json');
export function debInfo(versionDir: string): { extensionDir: string; minor: string } | null {
  try {
    return JSON.parse(readFileSync(debInfoFile(versionDir), 'utf8')) as { extensionDir: string; minor: string };
  } catch {
    return null;
  }
}

/** Installs a legacy minor into `phpDir/<version>`; returns the exact version. */
export async function installDebPhp(phpDir: string, minor: string, progress: (p: RuntimeInstallProgress) => void): Promise<string> {
  if (!LINUX_LEGACY_MINORS.includes(minor)) throw new Error(`PHP ${minor} is not offered here`);
  if (!(await hasDpkgDeb())) throw new Error('Unpacking PHP’s packages needs dpkg-deb (the dpkg package)');
  const r = repo();
  progress({ version: minor, phase: 'download', received: 0, total: 0, detail: `${r.label} (${r.dist})` });
  const entries = await index();
  const cli = newestDeb(entries, `php${minor}-cli`);
  if (!cli) throw new Error(`${r.label} has no PHP ${minor} for ${r.dist}`);
  const version = cli.version;
  const target = join(phpDir, version);
  if (existsSync(join(target, 'bin', 'php-fpm'))) return version;
  const debs = ['cli', 'fpm', ...EXT_PACKAGES]
    .map((p) => newestDeb(entries, `php${minor}-${p}`, version) ?? newestDeb(entries, `php${minor}-${p}`))
    .filter((d): d is DebEntry => !!d);
  if (!debs.some((d) => d.name === `php${minor}-fpm`)) throw new Error(`${r.label} has no php${minor}-fpm for ${r.dist}`);

  // The shared libraries those packages link: installed from the distribution when missing (one password dialog).
  const missing = await missingPackages(libraryDepends(debs));
  if (missing.length) {
    progress({ version, phase: 'download', received: 0, total: 0, detail: `Installing ${missing.join(', ')} (password)` });
    const root = await runAsRootLinux(`DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ${missing.join(' ')} >/dev/null`);
    if (!root.ok) throw new Error(root.cancelled ? `Cancelled: PHP ${minor} needs ${missing.join(', ')}` : `Installing ${missing.join(', ')} failed: ${root.message}`);
  }

  const tmp = join(phpDir, `.tmp-${version}-${Date.now()}`);
  try {
    let total = 0;
    await unpackDebs(
      debs.map((d) => ({ url: `${r.base}/${d.file}`, hash: d.hash })),
      join(tmp, 'root'),
      (phase, detail, received, t) => {
        if (phase === 'download') progress({ version, phase: 'download', received: received ?? 0, total: (total = t ?? total), detail });
        else progress({ version, phase: 'extract', received: total, total, detail });
      },
    );
    const usr = join(tmp, 'root', 'usr');
    const php = join(usr, 'bin', `php${minor}`);
    const fpm = join(usr, 'sbin', `php-fpm${minor}`);
    if (!existsSync(php) || !existsSync(fpm)) throw new Error('php / php-fpm not found in the packages');
    const api = readdirSync(join(usr, 'lib', 'php')).find((d) => /^\d{8}$/.test(d));
    if (!api) throw new Error('The extension folder was not found in the packages');
    mkdirSync(join(tmp, 'bin'), { recursive: true });
    await moveDir(usr, join(tmp, 'usr'));
    symlinkSync(`../usr/bin/php${minor}`, join(tmp, 'bin', 'php'));
    symlinkSync(`../usr/sbin/php-fpm${minor}`, join(tmp, 'bin', 'php-fpm'));
    rmSync(join(tmp, 'root'), { recursive: true, force: true });
    const extensionDir = join(target, 'usr', 'lib', 'php', api);
    writeFileSync(debInfoFile(tmp), JSON.stringify({ minor, extensionDir, source: r.label, packages: debs.map((d) => `${d.name} ${d.version}`) }, null, 2));
    const check = await run(join(tmp, 'bin', 'php'), ['-n', '-r', 'echo PHP_VERSION;'], { timeout: 15_000 });
    if (!check.stdout.trim().startsWith(minor)) throw new Error(`PHP ${minor} does not run: ${(check.stderr || check.stdout).trim().split('\n').pop()}`);
    await moveDir(tmp, target);
    progress({ version, phase: 'done', received: total, total });
    return version;
  } finally {
    removeTemp(tmp);
  }
}

/** The extensions a deb build has (its .so files), core ones first. */
export function debExtensions(versionDir: string): string[] {
  const info = debInfo(versionDir);
  if (!info) return [];
  try {
    return readdirSync(info.extensionDir)
      .filter((f) => f.endsWith('.so'))
      .map((f) => f.slice(0, -3));
  } catch {
    return [];
  }
}
