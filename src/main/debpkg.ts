import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { downloadVerified } from './download';
import { run } from './env';

/**
 * Linux builds that a project publishes only as .deb packages in its own apt repository (MariaDB on ARM64,
 * Manticore): DevCatz reads the repository's Packages index, downloads the packages it needs, checks each SHA-256
 * from that index and unpacks them with dpkg-deb into its own folder. Nothing is installed into the system, so a
 * copy from the distribution is left alone, and the build runs from DevCatz's folder like every other one.
 */

export interface DebFile {
  url: string;
  hash: string;
}

/** The Ubuntu or Debian release this system is (derivatives name the one they follow), null elsewhere. */
export function debDistro(): { os: 'ubuntu' | 'debian'; codename: string; version: number } | null {
  let txt = '';
  try {
    txt = readFileSync('/etc/os-release', 'utf8');
  } catch {
    return null;
  }
  const v = (k: string) => txt.match(new RegExp(`^${k}=["']?([^"'\\n]*)`, 'm'))?.[1] ?? '';
  const ubuntu = v('UBUNTU_CODENAME') || (v('ID') === 'ubuntu' ? v('VERSION_CODENAME') : '');
  if (ubuntu) return { os: 'ubuntu', codename: ubuntu, version: Number(v('ID') === 'ubuntu' ? v('VERSION_ID') : 0) || 0 };
  if ((v('ID') === 'debian' || /\bdebian\b/.test(v('ID_LIKE'))) && v('VERSION_CODENAME'))
    return { os: 'debian', codename: v('VERSION_CODENAME'), version: Number(v('VERSION_ID')) || 0 };
  return null;
}

/** Debian's name for this CPU. */
export const DEB_ARCH = process.arch === 'arm64' ? 'arm64' : 'amd64';

export const hasDpkgDeb = async () => (await run('/bin/sh', ['-c', 'command -v dpkg-deb'], { timeout: 10_000 })).code === 0;

/** `1:11.4.13+maria~ubu2404` → 11.4.13, `29.9.0-26091108-58e88d5ab` → 29.9.0 */
export const debUpstream = (v: string) => v.replace(/^\d+:/, '').replace(/[+~-].*$/, '');

const cmp = (a: string, b: string) => {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pb[i] ?? 0) - (pa[i] ?? 0);
  return 0;
};

export interface DebEntry {
  name: string;
  /** Upstream version (no epoch / revision). */
  version: string;
  file: string;
  hash: string;
  /** The Depends field as written. */
  depends?: string;
  /** Virtual packages it provides (`libssl3` for libssl3t64), names only. */
  provides?: string[];
}

/** Every package of a Packages index. */
export function parsePackages(index: string): DebEntry[] {
  return index
    .split(/\n\n+/)
    .map((st) => ({
      name: st.match(/^Package: (.+)$/m)?.[1] ?? '',
      version: debUpstream(st.match(/^Version: (.+)$/m)?.[1] ?? ''),
      file: (st.match(/^Filename: (.+)$/m)?.[1] ?? '').replace(/\/\.\//g, '/'),
      hash: st.match(/^SHA256: (.+)$/m)?.[1] ?? '',
      depends: [...st.matchAll(/^(?:Pre-)?Depends: (.+)$/gm)].map((m) => m[1]).join(', '),
      provides: (st.match(/^Provides: (.+)$/m)?.[1] ?? '')
        .split(',')
        .map((p) => p.trim().split(/[\s(:]/)[0])
        .filter(Boolean),
    }))
    .filter((p) => p.name && p.file && /^[a-f0-9]{64}$/.test(p.hash) && /^\d+(\.\d+)*$/.test(p.version));
}

/** The newest `name` in the index (optionally of one version). */
export function newestDeb(entries: DebEntry[], name: string, version?: string): DebEntry | undefined {
  return entries.filter((p) => p.name === name && (!version || p.version === version)).sort((a, b) => cmp(a.version, b.version))[0];
}

/**
 * Downloads `files`, checks each SHA-256, unpacks them all into `into` (a fresh folder: it gets their usr/, etc/ …).
 * `step(phase, detail, received?, total?)` reports progress; `signal` cancels.
 */
export async function unpackDebs(
  files: DebFile[],
  into: string,
  step: (phase: 'download' | 'verify' | 'unpack', detail: string, received?: number, total?: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  mkdirSync(into, { recursive: true });
  const work = join(into, '..', `.debs-${Date.now()}`);
  mkdirSync(work, { recursive: true });
  try {
    for (const [i, f] of files.entries()) {
      const name = f.url.split('/').pop()!;
      const deb = join(work, `${i}.deb`);
      step('download', name, 0, 0);
      const digest = await downloadVerified(f.url, deb, '', (received, total) => step('download', name, received, total), undefined, signal);
      step('verify', `SHA-256 ${digest.slice(0, 16)}…`);
      if (digest !== f.hash.toLowerCase()) throw new Error(`Checksum mismatch for ${name}; download discarded`);
      step('unpack', name);
      const r = await run('dpkg-deb', ['-x', deb, into], { timeout: 300_000 });
      if (r.code !== 0) throw new Error(`Unpacking ${name} failed: ${(r.stderr || r.stdout).trim() || 'dpkg-deb is missing'}`);
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  if (!existsSync(into)) throw new Error('Nothing was unpacked');
}
