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
 * A release the repository does not build for yet (Ubuntu 26.04 in 2026-11) gets the newest older release's packages
 * (noble), with the libraries this system lacks unpacked from that release's archive into php/<version>/libs and
 * bin/php / bin/php-fpm as small scripts that put them on LD_LIBRARY_PATH — no password, nothing in the system.
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

/**
 * Releases to fall back on, newest first, when the PHP repository has nothing for this one yet (a new Ubuntu such as
 * 26.04 before the PPA builds for it). Their packages run here with the libraries this system lacks taken from that
 * release's own archive into the PHP's folder (see privateLibs).
 */
const FALLBACK: Record<'ubuntu' | 'debian', string[]> = { ubuntu: ['noble', 'jammy'], debian: ['trixie', 'bookworm'] };

interface Repo {
  base: string;
  dist: string;
  label: string;
  os: 'ubuntu' | 'debian';
  /** Built for this release (false: an older release's packages, with private libraries). */
  native: boolean;
}

function repoFor(os: 'ubuntu' | 'debian', dist: string, native: boolean): Repo {
  return os === 'ubuntu'
    ? { base: 'https://ppa.launchpadcontent.net/ondrej/php/ubuntu', dist, label: 'ppa:ondrej/php', os, native }
    : { base: 'https://packages.sury.org/php', dist, label: 'packages.sury.org/php', os, native };
}

async function packagesOf(url: string): Promise<DebEntry[] | null> {
  const res = await fetch(url).catch(() => null);
  if (!res?.ok) return null;
  try {
    return parsePackages(gunzipSync(Buffer.from(await res.arrayBuffer())).toString('utf8'));
  } catch {
    return null;
  }
}

let indexCache: { at: number; repo: Repo; entries: DebEntry[] } | null = null;
/** The repository's packages for this release, else for the newest older release it still builds for. */
async function index(force = false): Promise<{ at: number; repo: Repo; entries: DebEntry[] }> {
  if (!force && indexCache && Date.now() - indexCache.at < 3_600_000) return indexCache;
  const d = debDistro();
  if (!d) throw new Error('PHP before 8.1 comes from the Ubuntu / Debian PHP repositories (ondrej / sury) here; on this distribution use PHP 8.1 or newer');
  for (const dist of [d.codename, ...FALLBACK[d.os].filter((x) => x !== d.codename)]) {
    const repo = repoFor(d.os, dist, dist === d.codename);
    const entries = await packagesOf(`${repo.base}/dists/${dist}/main/binary-${DEB_ARCH}/Packages.gz`);
    if (entries?.some((e) => /^php\d\.\d-fpm$/.test(e.name))) return (indexCache = { at: Date.now(), repo, entries });
  }
  throw new Error(`${repoFor(d.os, d.codename, true).label} has no packages for ${d.codename}`);
}

/** The distribution's own archive for `repo.dist` (an older release): where its libraries come from. */
async function releaseArchive(repo: Repo, universe: boolean): Promise<{ base: string; entries: DebEntry[] }[]> {
  const sets: { base: string; suite: string }[] =
    repo.os === 'ubuntu'
      ? ['', '-updates', '-security'].map((s) => ({ base: DEB_ARCH === 'amd64' ? 'https://archive.ubuntu.com/ubuntu' : 'https://ports.ubuntu.com/ubuntu-ports', suite: `${repo.dist}${s}` }))
      : [
          { base: 'https://deb.debian.org/debian', suite: repo.dist },
          { base: 'https://deb.debian.org/debian', suite: `${repo.dist}-updates` },
          { base: 'https://deb.debian.org/debian-security', suite: `${repo.dist}-security` },
        ];
  const comps = repo.os === 'ubuntu' ? (universe ? ['main', 'universe'] : ['main']) : ['main'];
  const out: { base: string; entries: DebEntry[] }[] = [];
  for (const s of sets)
    for (const c of comps) {
      const entries = await packagesOf(`${s.base}/dists/${s.suite}/${c}/binary-${DEB_ARCH}/Packages.gz`);
      if (entries) out.push({ base: s.base, entries });
    }
  return out;
}

/**
 * An older release's packages on this system: the library packages they need (and those need) that are not
 * installed here, from that release's archive, to be unpacked next to PHP — e.g. libxml2.so.2 and ICU 74 on Ubuntu
 * 26.04, which only has libxml2.so.16 (without symbols PHP 7.4 uses) and a newer ICU. Nothing goes into the system.
 */
async function privateLibs(repo: Repo, debs: DebEntry[]): Promise<{ url: string; hash: string; name: string }[]> {
  let archive = await releaseArchive(repo, false);
  let universe = false;
  const find = (name: string) => {
    let best: { base: string; deb: DebEntry } | undefined;
    for (const a of archive) {
      const deb = newestDeb(a.entries, name);
      if (deb && (!best || newestDeb([best.deb, deb], name) === deb)) best = { base: a.base, deb };
    }
    if (best) return best;
    // A virtual name (libssl3 → libssl3t64 since Ubuntu 24.04's 64-bit time change).
    for (const a of archive) {
      const deb = a.entries.find((e) => e.provides?.includes(name));
      if (deb) return { base: a.base, deb: newestDeb(a.entries, deb.name) ?? deb };
    }
    return undefined;
  };
  const want = new Map<string, { base: string; deb: DebEntry }>();
  const pick = (g: string[]) => {
    for (const n of g) {
      const hit = find(n);
      if (hit) return hit;
    }
    return undefined;
  };
  let groups = await missingPackages(libraryDepends(debs));
  for (let round = 0; groups.length && round < 5; round++) {
    const found: DebEntry[] = [];
    for (const g of groups) {
      if (g.some((n) => want.has(n))) continue;
      let hit = pick(g);
      if (!hit && !universe && repo.os === 'ubuntu') {
        archive = await releaseArchive(repo, (universe = true));
        hit = pick(g);
      }
      if (!hit) throw new Error(`${g.join(' or ')}, which PHP needs, is in neither this system nor ${repo.os === 'ubuntu' ? 'Ubuntu' : 'Debian'} ${repo.dist}`);
      // Provided under another name that this system has (libssl3t64 for libssl3): nothing to fetch.
      if (!g.includes(hit.deb.name) && (await isInstalled(hit.deb.name))) continue;
      want.set(hit.deb.name, hit);
      found.push(hit.deb);
    }
    groups = (await missingPackages(libraryDepends(found))).filter((g) => !g.some((n) => want.has(n)));
  }
  return [...want.values()].map(({ base, deb }) => ({ url: `${base}/${deb.file}`, hash: deb.hash, name: deb.name }));
}

/** Debian's multiarch folder name for this CPU. */
const TRIPLET = DEB_ARCH === 'arm64' ? 'aarch64-linux-gnu' : 'x86_64-linux-gnu';

/** bin/php or bin/php-fpm for an older release's PHP: the binary with its private libraries on the path. */
function wrapper(binary: string, note: string): string {
  return [
    '#!/bin/sh',
    `# ${note} (written by DevCatz)`,
    'd="$(dirname "$(readlink -f "$0")")/.."',
    `LD_LIBRARY_PATH="$d/libs/usr/lib/${TRIPLET}:$d/libs/lib/${TRIPLET}\${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}" exec "$d/${binary}" "$@"`,
    '',
  ].join('\n');
}

/** Newest version of each legacy minor the repository has for this system (cli and fpm both). */
export async function debLegacyVersions(force = false): Promise<{ minor: string; version: string }[]> {
  const entries = await index(force).then((i) => i.entries, () => [] as DebEntry[]);
  const out: { minor: string; version: string }[] = [];
  for (const minor of LINUX_LEGACY_MINORS) {
    const cli = newestDeb(entries, `php${minor}-cli`);
    if (cli && newestDeb(entries, `php${minor}-fpm`, cli.version)) out.push({ minor, version: cli.version });
  }
  return out;
}

/** The library packages a set of .deb files needs (their Depends, `lib*` only): each with its alternatives (`a | b`). */
function libraryDepends(debs: DebEntry[]): string[][] {
  const groups = new Map<string, string[]>();
  for (const d of debs)
    for (const part of (d.depends ?? '').split(',')) {
      const alts = part
        .split('|')
        .map((a) => a.trim().split(/[\s(:]/)[0])
        .filter((n) => /^lib[\w.+-]+$/.test(n));
      if (alts.length) groups.set(alts.join('|'), alts);
    }
  return [...groups.values()];
}

const installedCache = new Map<string, boolean>();
async function isInstalled(name: string): Promise<boolean> {
  const hit = installedCache.get(name);
  if (hit !== undefined) return hit;
  const r = await run('dpkg-query', ['-W', '-f=${Status}', name], { timeout: 10_000 });
  const ok = r.code === 0 && r.stdout.includes('install ok installed');
  installedCache.set(name, ok);
  return ok;
}

/** The dependencies none of whose alternatives is installed. */
async function missingPackages(groups: string[][]): Promise<string[][]> {
  installedCache.clear();
  const missing: string[][] = [];
  for (const g of groups) {
    let any = false;
    for (const n of g) if ((any = await isInstalled(n))) break;
    if (!any) missing.push(g);
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
  progress({ version: minor, phase: 'download', received: 0, total: 0, detail: 'Reading the PHP packages' });
  const { repo: r, entries } = await index();
  progress({ version: minor, phase: 'download', received: 0, total: 0, detail: `${r.label} (${r.dist})` });
  const cli = newestDeb(entries, `php${minor}-cli`);
  if (!cli) throw new Error(`${r.label} has no PHP ${minor} for ${r.dist}`);
  const version = cli.version;
  const target = join(phpDir, version);
  if (existsSync(join(target, 'bin', 'php-fpm'))) return version;
  const debs = ['cli', 'fpm', ...EXT_PACKAGES]
    .map((p) => newestDeb(entries, `php${minor}-${p}`, version) ?? newestDeb(entries, `php${minor}-${p}`))
    .filter((d): d is DebEntry => !!d);
  if (!debs.some((d) => d.name === `php${minor}-fpm`)) throw new Error(`${r.label} has no php${minor}-fpm for ${r.dist}`);

  // The shared libraries those packages link: installed from the distribution when missing (one password dialog);
  // for an older release's packages, the missing ones come from that release's archive into the PHP's own folder.
  const libs = r.native ? [] : await privateLibs(r, debs);
  const missing = r.native ? (await missingPackages(libraryDepends(debs))).map((g) => g[0]) : [];
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
    if (libs.length)
      await unpackDebs(libs, join(tmp, 'libs'), (phase, detail, received, t) => {
        if (phase === 'download') progress({ version, phase: 'download', received: received ?? 0, total: t ?? 0, detail: `Library ${detail}` });
        else progress({ version, phase: 'extract', received: total, total, detail: `Library ${detail}` });
      });
    const usr = join(tmp, 'root', 'usr');
    const php = join(usr, 'bin', `php${minor}`);
    const fpm = join(usr, 'sbin', `php-fpm${minor}`);
    if (!existsSync(php) || !existsSync(fpm)) throw new Error('php / php-fpm not found in the packages');
    const api = readdirSync(join(usr, 'lib', 'php')).find((d) => /^\d{8}$/.test(d));
    if (!api) throw new Error('The extension folder was not found in the packages');
    mkdirSync(join(tmp, 'bin'), { recursive: true });
    await moveDir(usr, join(tmp, 'usr'));
    if (r.native) {
      symlinkSync(`../usr/bin/php${minor}`, join(tmp, 'bin', 'php'));
      symlinkSync(`../usr/sbin/php-fpm${minor}`, join(tmp, 'bin', 'php-fpm'));
    } else {
      const note = `PHP ${version} from ${r.label} (${r.dist}) with the libraries this system lacks in libs/`;
      writeFileSync(join(tmp, 'bin', 'php'), wrapper(`usr/bin/php${minor}`, note), { mode: 0o755 });
      writeFileSync(join(tmp, 'bin', 'php-fpm'), wrapper(`usr/sbin/php-fpm${minor}`, note), { mode: 0o755 });
    }
    rmSync(join(tmp, 'root'), { recursive: true, force: true });
    const extensionDir = join(target, 'usr', 'lib', 'php', api);
    writeFileSync(
      debInfoFile(tmp),
      JSON.stringify({ minor, extensionDir, source: `${r.label} (${r.dist})`, packages: debs.map((d) => `${d.name} ${d.version}`), libraries: libs.map((l) => l.name) }, null, 2),
    );
    const check = await run(join(tmp, 'bin', 'php'), ['-n', '-d', `extension_dir=${join(tmp, 'usr', 'lib', 'php', api)}`, '-r', 'echo PHP_VERSION;'], { timeout: 15_000 });
    if (check.stdout.trim().startsWith(minor)) {
      // Every extension must load too (a library missing here shows up only then).
      const exts = readdirSync(join(tmp, 'usr', 'lib', 'php', api)).filter((f) => f.endsWith('.so'));
      for (const so of exts) {
        const name = so.slice(0, -3);
        const kind = name === 'opcache' || name === 'xdebug' ? 'zend_extension' : 'extension';
        const dep = DEB_CORE_EXTENSIONS.filter((c) => c !== 'opcache' && c !== name && exts.includes(`${c}.so`)).flatMap((c) => ['-d', `extension=${c}.so`]);
        const e = await run(join(tmp, 'bin', 'php'), ['-n', '-d', `extension_dir=${join(tmp, 'usr', 'lib', 'php', api)}`, ...dep, '-d', `${kind}=${so}`, '-r', 'echo 1;'], { timeout: 15_000 });
        // Only a library this system lacks counts (an extension needing another one first, xmlreader → dom, is fine).
        const lib = `${e.stdout}${e.stderr}`.match(/(lib[\w.+-]+\.so[\w.]*): cannot open shared object file/);
        if (lib) throw new Error(`PHP ${minor}'s ${name} extension needs ${lib[1]}, which is missing here`);
      }
    }
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
