import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { run } from './env';
import { isLinux, isWin } from './platform';

/**
 * PHP that is already on the computer (TODO §39, every platform): installed by the system, a package manager or
 * another local-server app, so a project can use a version DevCatz does not offer yet. DevCatz serves it with its
 * own PHP-FPM pool (php-cgi on Windows) and its own php.ini, and leaves that PHP's own service and files alone.
 * Laravel Herd's and Homebrew's PHP are found in php.ts as before.
 */

export interface FoundPhp {
  php: string;
  /** php-fpm (macOS / Linux) or php-cgi.exe (Windows): what serves sites. */
  fpm: string;
  binDir: string;
  /** Where it came from, for the badge: MacPorts, MAMP, apt, XAMPP, Laragon … */
  label: string;
  /** That PHP's own folder of extension .ini files (Debian's conf.d, Fedora's php.d …): scanned before DevCatz's. */
  confD: string | null;
}

const home = homedir();
const ls = (dir: string): string[] => {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
};
const first = (...paths: string[]): string | null => paths.find((p) => existsSync(p)) ?? null;

/** phpenv / asdf / mise / phpbrew installs: <root>/<version>/bin/php + sbin/php-fpm. */
function managerInstalls(): Omit<FoundPhp, 'confD'>[] {
  const roots: [string, string][] = [
    [join(home, '.phpenv', 'versions'), 'phpenv'],
    [join(home, '.asdf', 'installs', 'php'), 'asdf'],
    [join(home, '.local', 'share', 'mise', 'installs', 'php'), 'mise'],
    [join(home, '.phpbrew', 'php'), 'phpbrew'],
  ];
  const out: Omit<FoundPhp, 'confD'>[] = [];
  for (const [root, label] of roots)
    for (const v of ls(root)) {
      const php = join(root, v, 'bin', 'php');
      const fpm = first(join(root, v, 'sbin', 'php-fpm'), join(root, v, 'bin', 'php-fpm'));
      if (existsSync(php) && fpm) out.push({ php, fpm, binDir: dirname(php), label });
    }
  return out;
}

function macCandidates(): FoundPhp[] {
  const out: FoundPhp[] = [];
  // MacPorts: php83 + php-fpm83, extension .ini files in /opt/local/var/db/php83.
  for (const f of ls('/opt/local/bin')) {
    const m = /^php(\d)(\d+)$/.exec(f);
    if (!m) continue;
    const fpm = first(`/opt/local/sbin/php-fpm${m[1]}${m[2]}`);
    if (fpm) out.push({ php: join('/opt/local/bin', f), fpm, binDir: '/opt/local/bin', label: 'MacPorts', confD: first(`/opt/local/var/db/php${m[1]}${m[2]}`) });
  }
  // MAMP (and MAMP PRO): /Applications/MAMP/bin/php/php8.3.9/bin/php + sbin/php-fpm.
  for (const root of ['/Applications/MAMP/bin/php', '/Applications/MAMP PRO/bin/php'])
    for (const d of ls(root)) {
      const php = join(root, d, 'bin', 'php');
      const fpm = first(join(root, d, 'sbin', 'php-fpm'), join(root, d, 'bin', 'php-fpm'));
      if (existsSync(php) && fpm) out.push({ php, fpm, binDir: dirname(php), label: 'MAMP', confD: null });
    }
  return [...out, ...managerInstalls().map((x) => ({ ...x, confD: null }))];
}

function linuxCandidates(): FoundPhp[] {
  const out: FoundPhp[] = [];
  // Debian / Ubuntu (also the ondrej PPA, sury): /usr/bin/php8.3 + /usr/sbin/php-fpm8.3, modules in /etc/php/8.3/fpm/conf.d.
  for (const f of ls('/usr/bin')) {
    const m = /^php(\d+\.\d+)$/.exec(f);
    if (!m) continue;
    const fpm = first(`/usr/sbin/php-fpm${m[1]}`);
    if (fpm) out.push({ php: join('/usr/bin', f), fpm, binDir: '/usr/bin', label: 'apt', confD: first(`/etc/php/${m[1]}/fpm/conf.d`, `/etc/php/${m[1]}/cli/conf.d`) });
  }
  // Fedora / RHEL / Arch / openSUSE: one php + php-fpm; Fedora's modules in /etc/php.d, Arch's in /etc/php/conf.d.
  const fpm = first('/usr/sbin/php-fpm', '/usr/bin/php-fpm');
  if (existsSync('/usr/bin/php') && fpm) out.push({ php: '/usr/bin/php', fpm, binDir: '/usr/bin', label: 'system', confD: first('/etc/php.d', '/etc/php/conf.d', '/etc/php8/fpm/conf.d') });
  // Remi's parallel versions: /opt/remi/php83/root/usr/{bin/php,sbin/php-fpm}, modules in /etc/opt/remi/php83/php.d.
  for (const d of ls('/opt/remi')) {
    const root = join('/opt/remi', d, 'root', 'usr');
    const php = join(root, 'bin', 'php');
    const f = first(join(root, 'sbin', 'php-fpm'));
    if (existsSync(php) && f) out.push({ php, fpm: f, binDir: dirname(php), label: 'Remi', confD: first(`/etc/opt/remi/${d}/php.d`) });
  }
  return [...out, ...managerInstalls().map((x) => ({ ...x, confD: null }))];
}

/** Windows: a folder with php.exe and php-cgi.exe (the FastCGI server DevCatz runs). */
function winDir(dir: string, label: string): FoundPhp | null {
  const php = join(dir, 'php.exe');
  const cgi = join(dir, 'php-cgi.exe');
  return existsSync(php) && existsSync(cgi) ? { php, fpm: cgi, binDir: dir, label, confD: null } : null;
}

async function winCandidates(): Promise<FoundPhp[]> {
  const drive = process.env.SystemDrive ?? 'C:';
  const scoop = process.env.SCOOP ?? join(home, 'scoop');
  const dirs: [string, string][] = [
    [join(drive, '\\', 'xampp', 'php'), 'XAMPP'],
    ...ls(join(drive, '\\', 'laragon', 'bin', 'php')).map((d): [string, string] => [join(drive, '\\', 'laragon', 'bin', 'php', d), 'Laragon']),
    ...['wamp64', 'wamp'].flatMap((w) => ls(join(drive, '\\', w, 'bin', 'php')).map((d): [string, string] => [join(drive, '\\', w, 'bin', 'php', d), 'WampServer'])),
    ...ls(join(scoop, 'apps')).filter((d) => /^php(\d+)?(-nts)?$/.test(d)).map((d): [string, string] => [join(scoop, 'apps', d, 'current'), 'Scoop']),
    ...ls(join(drive, '\\', 'tools')).filter((d) => /^php\d*$/.test(d)).map((d): [string, string] => [join(drive, '\\', 'tools', d), 'Chocolatey']),
    [join(drive, '\\', 'php'), 'C:\\php'],
  ];
  const out = dirs.flatMap(([d, label]) => winDir(d, label) ?? []);
  // Any php.exe on the Path with php-cgi.exe beside it (winget, a zip of php.net's own).
  const r = await run('where.exe', ['php'], { timeout: 5000 });
  if (r.code === 0)
    for (const line of r.stdout.split(/\r?\n/).map((l) => l.trim()).filter((l) => /php\.exe$/i.test(l))) {
      const hit = winDir(dirname(line), 'on the Path');
      if (hit) out.push(hit);
    }
  return out;
}

/** A folder the user added (Runtimes → PHP → Add a PHP folder…): the PHP folder itself or its bin folder. */
export function phpInFolder(dir: string): FoundPhp | null {
  if (isWin) return winDir(dir, 'added by you');
  for (const bin of [dir, join(dir, 'bin')]) {
    const php = join(bin, 'php');
    if (!existsSync(php)) continue;
    const fpm = first(join(bin, 'php-fpm'), join(bin, '..', 'sbin', 'php-fpm'));
    if (fpm) return { php, fpm, binDir: bin, label: 'added by you', confD: null };
  }
  return null;
}

/** The PHP version a binary reports (without any php.ini), or null when it does not run. */
export async function phpVersion(php: string): Promise<string | null> {
  const r = await run(php, ['-n', '-r', 'echo PHP_VERSION;'], { timeout: 8000 });
  const v = r.stdout.trim();
  return r.code === 0 && /^\d+\.\d+\.\d+$/.test(v) ? v : null;
}

/** Every PHP found on this computer outside DevCatz (plus the folders the user added), each with its version. */
export async function systemPhps(added: string[]): Promise<(FoundPhp & { version: string })[]> {
  const found = [...added.flatMap((d) => phpInFolder(d) ?? []), ...(isWin ? await winCandidates() : isLinux ? linuxCandidates() : macCandidates())];
  const seen = new Set<string>();
  const out: (FoundPhp & { version: string })[] = [];
  for (const f of found) {
    const key = isWin ? f.php.toLowerCase() : f.php;
    if (seen.has(key)) continue;
    seen.add(key);
    const version = await phpVersion(f.php);
    if (version) out.push({ ...f, version });
  }
  return out;
}

/** A short name for a folder in messages. */
export const folderName = (dir: string): string => basename(dir) || dir;
