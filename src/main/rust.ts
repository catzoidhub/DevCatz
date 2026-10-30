import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { InstalledRust, RemoteRust, RuntimeInstallProgress, RustToolId, RustToolState } from '@shared/types';
import { downloadVerified } from './download';
import { getShellEnv, run } from './env';
import { compare } from './node';
import { exe, isWin, joinPath, pathKey, TAR } from './platform';
import { dataDir } from './store';

/**
 * Rust, through the official **rustup** in its standard place (~/.rustup and ~/.cargo, or RUSTUP_HOME / CARGO_HOME),
 * so editors (rust-analyzer), terminals and DevCatz share one set of toolchains; rustup also honours a project's
 * rust-toolchain.toml on its own. DevCatz downloads rustup-init (SHA-256 from static.rust-lang.org) when there is
 * none, lists / installs / removes toolchains, adds the WebAssembly target, and installs the CLIs Rust frameworks run
 * with (trunk, dx, cargo-leptos, cargo-tauri) through cargo-binstall's prebuilt binaries. Solana (Agave) and Anchor
 * (through avm) for Anchor programs come from their own installers.
 */

const TRIPLE = isWin ? 'x86_64-pc-windows-msvc' : process.arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin';
export const WASM_TARGET = 'wasm32-unknown-unknown';

export const cargoHome = () => process.env.CARGO_HOME || join(homedir(), '.cargo');
export const cargoBin = () => join(cargoHome(), 'bin');
/** Agave's installer puts the active Solana release here (on Windows too, under the user folder). */
export const solanaBin = () => join(homedir(), '.local', 'share', 'solana', 'install', 'active_release', 'bin');
const avmBin = () => join(homedir(), '.avm', 'bin');

/** Folders the Rust tools live in, for PATH: cargo's bin (rustup, cargo, cargo-installed CLIs), Solana, avm. */
export const rustPathDirs = () => [cargoBin(), solanaBin(), avmBin()];

export function rustEnv(): Record<string, string> {
  const env = getShellEnv();
  const key = pathKey(env);
  return { [key]: joinPath([...rustPathDirs(), env[key] ?? '']) };
}

export function rustupPath(): string | null {
  const own = join(cargoBin(), exe('rustup'));
  if (existsSync(own)) return own;
  // Homebrew's rustup (brew install rustup) keeps its proxies in the same ~/.cargo/bin once initialised.
  for (const p of isWin ? [] : ['/opt/homebrew/bin/rustup', '/usr/local/bin/rustup']) if (existsSync(p)) return p;
  return null;
}

/** A tool in cargo's bin (or Solana's / avm's folder): its path, or null. */
export function toolPath(bin: string): string | null {
  for (const d of rustPathDirs()) if (existsSync(join(d, exe(bin)))) return join(d, exe(bin));
  return null;
}

async function rustup(args: string[], timeout = 60_000) {
  const bin = rustupPath();
  if (!bin) throw new Error('Rust is not installed: install it on the Rust page (sidebar)');
  return run(bin, args, { timeout, env: rustEnv() });
}

/** Runs a command and hands every output line to `line` (rustup / cargo print progress on stderr). */
function streamLines(cmd: string, args: string[], line: (text: string) => void, cwd?: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, windowsHide: true, env: { ...getShellEnv(), ...rustEnv() }, stdio: ['ignore', 'pipe', 'pipe'] });
    const feed = (d: Buffer) => d.toString().split(/[\r\n]+/).map((l) => l.trim()).filter(Boolean).forEach(line);
    child.stdout.on('data', feed);
    child.stderr.on('data', feed);
    child.on('error', (e) => line(e.message));
    child.on('exit', (code) => resolve(code ?? 1));
  });
}

export async function rustupVersion(): Promise<string | null> {
  if (!rustupPath()) return null;
  const r = await rustup(['--version'], 10_000).catch(() => null);
  return r?.stdout.match(/rustup ([\d.]+)/)?.[1] ?? null;
}

/** macOS links Rust programs with the Xcode Command Line Tools' linker; without them every build fails. */
export async function linkerMissing(): Promise<boolean> {
  if (isWin) return false;
  return (await run('xcode-select', ['-p'], { timeout: 10_000 })).code !== 0;
}

/** Downloads rustup-init (checksum from static.rust-lang.org) and installs rustup with the stable toolchain. */
export async function installRustup(progress: (p: RuntimeInstallProgress) => void): Promise<void> {
  const base = `https://static.rust-lang.org/rustup/dist/${TRIPLE}/${exe('rustup-init')}`;
  const sumRes = await fetch(`${base}.sha256`);
  if (!sumRes.ok) throw new Error(`static.rust-lang.org: HTTP ${sumRes.status}`);
  const sha = (await sumRes.text()).trim().split(/\s+/)[0];
  const tmp = dataDir(`.rustup-${Date.now()}`);
  mkdirSync(tmp, { recursive: true });
  try {
    const init = join(tmp, exe('rustup-init'));
    await downloadVerified(base, init, sha, (received, total) => progress({ version: 'rustup', phase: 'download', received, total }));
    if (!isWin) {
      chmodSync(init, 0o755);
      await run('xattr', ['-d', 'com.apple.quarantine', init]);
    }
    progress({ version: 'stable', phase: 'extract', received: 0, total: 0, detail: 'Installing the stable toolchain…' });
    // The standard install: ~/.rustup + ~/.cargo, cargo's bin added to the shell profile, so terminals see it too.
    const code = await streamLines(init, ['-y', '--profile', 'default', '--default-toolchain', 'stable'], (detail) =>
      progress({ version: 'stable', phase: 'extract', received: 0, total: 0, detail }),
    );
    if (code !== 0) throw new Error(`rustup-init failed (exit ${code})`);
    progress({ version: 'stable', phase: 'done', received: 0, total: 0 });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** Installed toolchains (`rustup toolchain list`) with their rustc version. */
export async function listInstalled(): Promise<InstalledRust[]> {
  if (!rustupPath()) return [];
  const r = await rustup(['toolchain', 'list'], 20_000).catch(() => null);
  if (!r || r.code !== 0) return [];
  const out: InstalledRust[] = [];
  for (const line of r.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)) {
    if (/^no installed toolchains/i.test(line)) continue;
    const name = line.split(/\s+/)[0];
    const v = await rustup(['run', name, 'rustc', '--version'], 20_000).catch(() => null);
    out.push({
      name,
      channel: name.replace(`-${TRIPLE}`, ''),
      version: v?.stdout.match(/rustc (\S+)/)?.[1] ?? null,
      isDefault: /\(.*default.*\)/.test(line),
    });
  }
  return out;
}

let remoteCache: { at: number; list: RemoteRust[] } | null = null;

/** stable / beta / nightly, then the last stable releases (rust-lang/rust on GitHub), newest first. */
export async function listRemote(force = false): Promise<RemoteRust[]> {
  if (!force && remoteCache && Date.now() - remoteCache.at < 3600_000) return remoteCache.list;
  const channels: RemoteRust[] = [
    { name: 'stable', note: 'the current release, every six weeks' },
    { name: 'beta', note: 'the next release' },
    { name: 'nightly', note: 'daily builds (some crates need it)' },
  ];
  const res = await fetch('https://api.github.com/repos/rust-lang/rust/releases?per_page=12', { headers: { Accept: 'application/vnd.github+json' } });
  const rels = res.ok ? ((await res.json()) as { tag_name: string; prerelease: boolean }[]) : [];
  const versions = rels
    .filter((r) => !r.prerelease && /^\d+\.\d+\.\d+$/.test(r.tag_name))
    .map((r) => r.tag_name)
    .sort((a, b) => compare(b, a))
    .slice(0, 8)
    .map((name) => ({ name, note: null }));
  remoteCache = { at: Date.now(), list: [...channels, ...versions] };
  return remoteCache.list;
}

const TOOLCHAIN = /^(stable|beta|nightly|\d+\.\d+(\.\d+)?)(-[\w.-]+)?$/;

export async function installToolchain(name: string, detail: (line: string) => void): Promise<void> {
  if (!TOOLCHAIN.test(name)) throw new Error(`Invalid toolchain ${name}`);
  const code = await streamLines(rustupPath() ?? 'rustup', ['toolchain', 'install', name, '--profile', 'default'], detail);
  if (code !== 0) throw new Error(`rustup toolchain install ${name} failed (exit ${code})`);
}

export async function uninstallToolchain(name: string): Promise<void> {
  if (!TOOLCHAIN.test(name)) throw new Error(`Invalid toolchain ${name}`);
  const r = await rustup(['toolchain', 'uninstall', name], 120_000);
  if (r.code !== 0) throw new Error(r.stderr.trim() || 'rustup toolchain uninstall failed');
}

export async function setDefault(name: string): Promise<void> {
  if (!TOOLCHAIN.test(name)) throw new Error(`Invalid toolchain ${name}`);
  const r = await rustup(['default', name], 300_000);
  if (r.code !== 0) throw new Error(r.stderr.trim() || 'rustup default failed');
}

/** Targets installed for the default toolchain (wasm32-unknown-unknown for Yew, Leptos, Dioxus …). */
export async function installedTargets(): Promise<string[]> {
  if (!rustupPath()) return [];
  const r = await rustup(['target', 'list', '--installed'], 20_000).catch(() => null);
  return r?.code === 0 ? r.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean) : [];
}

export async function addTarget(target: string, detail: (line: string) => void): Promise<void> {
  if (!/^[\w-]+$/.test(target)) throw new Error(`Invalid target ${target}`);
  const code = await streamLines(rustupPath() ?? 'rustup', ['target', 'add', target], detail);
  if (code !== 0) throw new Error(`rustup target add ${target} failed (exit ${code})`);
}

/** `channel = "1.82"` from rust-toolchain.toml (or the bare rust-toolchain file); rustup applies it by itself. */
export function readToolchainSpec(dir: string): string | null {
  for (const f of ['rust-toolchain.toml', 'rust-toolchain']) {
    try {
      const text = readFileSync(join(dir, f), 'utf8');
      return text.match(/^\s*channel\s*=\s*["']([^"']+)["']/m)?.[1] ?? (f === 'rust-toolchain' && !text.includes('[') ? text.trim() || null : null);
    } catch {
      /* next */
    }
  }
  return null;
}

// ------------------------------------------------------------------ tools

/** The CLIs Rust frameworks run with; `crate` = what cargo-binstall installs. */
export const RUST_TOOLS: { id: RustToolId; label: string; bin: string; crate: string | null; why: string }[] = [
  { id: 'trunk', label: 'Trunk', bin: 'trunk', crate: 'trunk', why: 'Builds and serves WebAssembly frontends: Yew, Sycamore, Leptos (client-side)' },
  { id: 'dioxus-cli', label: 'Dioxus CLI', bin: 'dx', crate: 'dioxus-cli', why: 'dx serve for Dioxus web, desktop and fullstack apps' },
  { id: 'cargo-leptos', label: 'cargo-leptos', bin: 'cargo-leptos', crate: 'cargo-leptos', why: 'cargo leptos watch for Leptos server-side (SSR) apps' },
  { id: 'tauri-cli', label: 'Tauri CLI', bin: 'cargo-tauri', crate: 'tauri-cli', why: 'cargo tauri dev for Tauri desktop apps without a package.json' },
  { id: 'solana', label: 'Solana CLI (Agave)', bin: 'solana', crate: null, why: 'The local validator and keys Anchor programs are built, deployed and tested with' },
  { id: 'anchor', label: 'Anchor (avm)', bin: 'anchor', crate: null, why: 'anchor build / test / localnet for Solana programs, through the Anchor version manager' },
];

export async function toolStates(): Promise<RustToolState[]> {
  return Promise.all(
    RUST_TOOLS.map(async (t) => {
      const path = toolPath(t.bin);
      let version: string | null = null;
      if (path) {
        const args = t.bin.startsWith('cargo-') ? [t.bin.slice(6), '--version'] : ['--version'];
        const r = await run(path, args, { timeout: 15_000, env: rustEnv() }).catch(() => null);
        version = r?.stdout.match(/\d+\.\d+\.\d+[\w.-]*/)?.[0] ?? (r?.code === 0 ? '?' : null);
      }
      return { id: t.id, label: t.label, why: t.why, version, installed: !!path };
    }),
  );
}

interface GhAsset {
  name: string;
  browser_download_url: string;
  digest?: string;
}

async function latestRelease(repo: string): Promise<{ tag: string; assets: GhAsset[] }> {
  const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, { headers: { Accept: 'application/vnd.github+json' } });
  if (!res.ok) throw new Error(`GitHub (${repo}): HTTP ${res.status}`);
  const rel = (await res.json()) as { tag_name: string; assets: GhAsset[] };
  return { tag: rel.tag_name, assets: rel.assets };
}

/** cargo-binstall (prebuilt binaries instead of compiling each CLI for minutes), from its GitHub release. */
async function ensureBinstall(detail: (line: string) => void): Promise<string> {
  const have = toolPath('cargo-binstall');
  if (have) return have;
  const rel = await latestRelease('cargo-bins/cargo-binstall');
  const asset = rel.assets.find((a) => a.name === `cargo-binstall-${TRIPLE}.zip`) ?? rel.assets.find((a) => a.name === `cargo-binstall-${TRIPLE}.tgz`);
  if (!asset?.digest?.startsWith('sha256:')) throw new Error('No cargo-binstall build with a checksum for this computer');
  const tmp = dataDir(`.binstall-${Date.now()}`);
  mkdirSync(tmp, { recursive: true });
  try {
    detail(`Downloading cargo-binstall ${rel.tag}…`);
    const archive = join(tmp, asset.name);
    await downloadVerified(asset.browser_download_url, archive, asset.digest.slice(7), () => {});
    // bsdtar unpacks both the .zip and the .tgz (Windows 10+ ships it as tar.exe).
    const r = await run(TAR, ['-xf', archive, '-C', tmp]);
    if (r.code !== 0) throw new Error(`Unpacking cargo-binstall failed: ${r.stderr.trim()}`);
    const found = readdirSync(tmp).find((f) => f === exe('cargo-binstall'));
    if (!found) throw new Error('cargo-binstall was not in its archive');
    mkdirSync(cargoBin(), { recursive: true });
    const dest = join(cargoBin(), found);
    rmSync(dest, { force: true });
    renameSync(join(tmp, found), dest);
    if (!isWin) {
      chmodSync(dest, 0o755);
      await run('xattr', ['-d', 'com.apple.quarantine', dest]);
    }
    return dest;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** Solana's installer (agave-install-init, checksum from the GitHub release), which fetches the stable release. */
async function installSolana(detail: (line: string) => void): Promise<void> {
  const rel = await latestRelease('anza-xyz/agave');
  const asset = rel.assets.find((a) => a.name === exe(`agave-install-init-${TRIPLE}`));
  if (!asset?.digest?.startsWith('sha256:')) throw new Error(`No Solana installer with a checksum for this computer (Agave ${rel.tag})`);
  const tmp = dataDir(`.agave-${Date.now()}`);
  mkdirSync(tmp, { recursive: true });
  try {
    detail(`Downloading the Solana installer (Agave ${rel.tag})…`);
    const init = join(tmp, asset.name);
    await downloadVerified(asset.browser_download_url, init, asset.digest.slice(7), () => {});
    if (!isWin) {
      chmodSync(init, 0o755);
      await run('xattr', ['-d', 'com.apple.quarantine', init]);
    }
    const code = await streamLines(init, [rel.tag], detail);
    if (code !== 0) throw new Error(`The Solana installer failed (exit ${code})`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** Anchor through avm (its version manager, compiled by cargo: a few minutes), then the latest Anchor. */
async function installAnchor(detail: (line: string) => void): Promise<void> {
  const cargo = toolPath('cargo');
  if (!cargo) throw new Error('Rust is not installed: install it first');
  if (!toolPath('avm')) {
    detail('Compiling avm, the Anchor version manager (a few minutes)…');
    const code = await streamLines(cargo, ['install', '--git', 'https://github.com/solana-foundation/anchor', 'avm', '--locked', '--force'], detail);
    if (code !== 0) throw new Error(`cargo install avm failed (exit ${code})`);
  }
  const avm = toolPath('avm')!;
  for (const args of [['install', 'latest'], ['use', 'latest']]) {
    const code = await streamLines(avm, args, detail);
    if (code !== 0) throw new Error(`avm ${args.join(' ')} failed (exit ${code})`);
  }
}

export async function installTool(id: RustToolId, detail: (line: string) => void): Promise<void> {
  const tool = RUST_TOOLS.find((t) => t.id === id);
  if (!tool) throw new Error(`Unknown tool ${id}`);
  if (id === 'solana') return installSolana(detail);
  if (id === 'anchor') return installAnchor(detail);
  if (!toolPath('cargo')) throw new Error('Rust is not installed: install it first');
  const binstall = await ensureBinstall(detail);
  // Prebuilt when the crate publishes one for this computer's own architecture (never an Intel build under Rosetta on
  // Apple silicon); otherwise cargo-binstall compiles it (cargo install) itself.
  const code = await streamLines(binstall, ['--no-confirm', '--locked', '--targets', TRIPLE, tool.crate!], detail);
  if (code !== 0) throw new Error(`Installing ${tool.label} failed (exit ${code})`);
}

/** Newest first, stable before beta before nightly. */
export function sortInstalled(list: InstalledRust[]): InstalledRust[] {
  const rank = (c: string) => (c.startsWith('stable') ? 0 : c.startsWith('beta') ? 1 : c.startsWith('nightly') ? 2 : 3);
  return [...list].sort((a, b) => rank(a.channel) - rank(b.channel) || compare(b.version ?? '0', a.version ?? '0'));
}
