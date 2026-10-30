import { existsSync, readdirSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import type { AppInfo, StackInfo } from '@shared/types';
import { detectDatabase, readEnvFiles, readJson, readText, slugify } from '../detect';
import { detectRedis } from '../redis';
import type { RuntimeDriver } from './types';

/**
 * Rust crates (Cargo.toml) as apps. The web framework goes in `library` (like Go's): servers (Actix Web, Axum,
 * Rocket, Warp, Poem, Salvo, Tide, Loco, tonic, hyper) run with `cargo run` on the port their code reads (PORT,
 * ROCKET_PORT …) or writes ("0.0.0.0:3000"); WebAssembly frontends (Yew, Sycamore, client-side Leptos) with
 * `trunk serve`, Dioxus with `dx serve`, server-side Leptos with `cargo leptos watch`; Tauri with `cargo tauri dev`
 * (its window plus the frontend dev server); Anchor programs with `anchor localnet` (a local Solana validator with
 * the programs deployed, RPC on 8899). Bevy, Burn, Candle and plain binaries run with `cargo run` and have no port.
 * A workspace's members with a server or frontend each become an app, run from their folder.
 */

/** Dependency → library, first match wins (a Tauri app's crate also lists its frontend framework). */
const LIBS: [RegExp, string][] = [
  [/^anchor-lang$/, 'anchor'],
  [/^tauri$/, 'tauri'],
  [/^loco-rs$/, 'loco'],
  [/^leptos$/, 'leptos'],
  [/^dioxus$/, 'dioxus'],
  [/^yew$/, 'yew'],
  [/^sycamore$/, 'sycamore'],
  [/^actix-web$/, 'actix'],
  [/^axum$/, 'axum'],
  [/^rocket$/, 'rocket'],
  [/^warp$/, 'warp'],
  [/^poem$/, 'poem'],
  [/^salvo$/, 'salvo'],
  [/^tide$/, 'tide'],
  [/^tonic$/, 'tonic'],
  [/^hyper$/, 'hyper'],
  [/^bevy$/, 'bevy'],
  [/^burn$/, 'burn'],
  [/^candle-(core|nn|transformers)$/, 'candle'],
];
const SERVERS = new Set(['loco', 'actix', 'axum', 'rocket', 'warp', 'poem', 'salvo', 'tide', 'tonic', 'hyper']);
/** WebAssembly frontends: the browser runs them, trunk / dx build and serve them. */
const FRONTENDS = new Set(['yew', 'sycamore', 'leptos', 'dioxus']);
/** Where each server listens when its code does not say. */
const DEFAULT_PORT: Record<string, number> = { axum: 3000, actix: 8080, rocket: 8000, warp: 3030, poem: 3000, salvo: 5800, tide: 8080, tonic: 50051, hyper: 3000, loco: 5150 };
/** Port variables of backing services, never the app's own listen port. */
const SERVICE_PORT = /REDIS|DB_|DATABASE|PG|POSTGRES|MYSQL|MARIA|SMTP|MAIL|S3|MINIO|RABBIT|AMQP|KAFKA|MONGO|ELASTIC|MEILI|PROXY/i;

export interface CargoManifest {
  name: string | null;
  deps: string[];
  members: string[];
  isPackage: boolean;
  /** [package.metadata.leptos] (cargo-leptos): its site-addr port. */
  leptosPort: number | null;
  leptosSsr: boolean;
}

/** Enough of Cargo.toml for detection: the package name, dependency names, workspace members, Leptos metadata. */
export function readCargo(dir: string): CargoManifest | null {
  const text = readText(join(dir, 'Cargo.toml'));
  if (text === null) return null;
  const deps = new Set<string>();
  let section = '';
  let name: string | null = null;
  let leptosPort: number | null = null;
  let leptosSsr = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, '').trim();
    const head = line.match(/^\[\[?([^\]]+)\]\]?$/);
    if (head) {
      section = head[1].trim();
      // [dependencies.axum], [target.'cfg(…)'.dependencies.yew]
      const dep = section.match(/(?:^|\.)dependencies\.([\w-]+)$/);
      if (dep && !section.startsWith('dev-')) deps.add(dep[1]);
      if (section === 'package.metadata.leptos') leptosSsr = true;
      continue;
    }
    if (section === 'package' && !name) name = line.match(/^name\s*=\s*["']([^"']+)/)?.[1] ?? null;
    if (/(^|\.)dependencies$/.test(section) && !section.startsWith('dev-') && section !== 'build-dependencies') {
      const key = line.match(/^([\w-]+)\s*=/)?.[1];
      if (key) deps.add(key);
    }
    if (section === 'package.metadata.leptos') {
      const port = line.match(/^site-addr\s*=\s*["'][^"']*:(\d+)["']/)?.[1];
      if (port) leptosPort = Number(port);
    }
  }
  const membersText = text.match(/^\s*members\s*=\s*\[([\s\S]*?)\]/m)?.[1] ?? '';
  const members = [...membersText.matchAll(/["']([^"']+)["']/g)].map((m) => m[1]);
  return { name, deps: [...deps], members, isPackage: /^\s*\[package\]/m.test(text), leptosPort, leptosSsr };
}

/** A workspace's member folders, `crates/*` globs expanded one level. */
function memberDirs(root: string, members: string[]): string[] {
  const out: string[] = [];
  for (const m of members) {
    if (m.endsWith('/*')) {
      const base = join(root, m.slice(0, -2));
      try {
        for (const e of readdirSync(base).sort()) if (existsSync(join(base, e, 'Cargo.toml'))) out.push(join(base, e));
      } catch {
        /* missing */
      }
    } else if (existsSync(join(root, m, 'Cargo.toml'))) out.push(join(root, m));
  }
  return out;
}

export const rustLibrary = (deps: string[]) => LIBS.find(([re]) => deps.some((d) => re.test(d)))?.[1] ?? null;

/** The crate's own Rust sources the port is read from (main.rs, lib.rs, config modules), at most a few. */
function sources(dir: string): string {
  const files = ['src/main.rs', 'src/lib.rs', 'src/config.rs', 'src/settings.rs', 'src/server.rs', 'src/app.rs', 'src/bin/server.rs', 'src/config/mod.rs'];
  return files.map((f) => readText(join(dir, f)) ?? '').join('\n');
}

/** The port a server listens on, and the env vars it reads it from. */
function serverPort(dir: string, root: string, lib: string | null): { port: number | null; vars: string[] } {
  const src = sources(dir);
  const env = readEnvFiles(join(dir, '.env'), join(dir, '.env.local'), join(root, '.env'), join(root, '.env.local'));
  // env::var("PORT"), std::env::var("APP_PORT"), dotenvy::var("PORT"), env_or("PORT", …)
  const vars = [...src.matchAll(/\b(?:var|var_os|env_or|get_env|env_var|getenv)\w*\(\s*"([A-Z0-9_]*PORT[A-Z0-9_]*)"/g)]
    .map((m) => m[1])
    .filter((v, i, all) => !SERVICE_PORT.test(v) && all.indexOf(v) === i);
  if (lib === 'rocket' && !vars.includes('ROCKET_PORT')) vars.unshift('ROCKET_PORT');
  for (const v of vars) if (Number(env[v]) > 0) return { port: Number(env[v]), vars };
  if (lib === 'rocket') {
    const toml = readText(join(dir, 'Rocket.toml')) ?? readText(join(root, 'Rocket.toml')) ?? '';
    const p = toml.match(/^\s*port\s*=\s*(\d+)/m)?.[1];
    return { port: p ? Number(p) : 8000, vars };
  }
  if (lib === 'loco') {
    const yaml = readText(join(dir, 'config', 'development.yaml')) ?? '';
    const p = yaml.match(/^\s*port:\s*(\d+)/m)?.[1];
    return { port: p ? Number(p) : 5150, vars };
  }
  const literal =
    src.match(/"(?:[\w.\-[\]]*):(\d{2,5})"/)?.[1] ?? // "0.0.0.0:3000", "127.0.0.1:8080", ":3000"
    src.match(/\(\s*\[\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*\d+\s*\]\s*,\s*(\d{2,5})\s*\)/)?.[1] ?? // warp: ([127, 0, 0, 1], 3030)
    src.match(/\(\s*"[\w.:]+"\s*,\s*(\d{2,5})\s*\)/)?.[1] ?? // actix: .bind(("127.0.0.1", 8080))
    src.match(/unwrap_or\(\s*"?(\d{4,5})"?\s*\)/)?.[1]; // env var with a default: .unwrap_or("3000")
  return { port: literal ? Number(literal) : (DEFAULT_PORT[lib ?? ''] ?? 8080), vars };
}

/** trunk serve's port (Trunk.toml [serve] port), 8080 by default. */
const trunkPort = (dir: string) => Number((readText(join(dir, 'Trunk.toml')) ?? '').match(/^\s*port\s*=\s*(\d+)/m)?.[1] ?? 8080);

/** A Tauri app's frontend dev server (tauri.conf.json build.devUrl, v1 devPath), or null. */
function tauriDevPort(root: string): number | null {
  const conf = readJson<{ build?: { devUrl?: string; devPath?: string } }>(join(root, 'src-tauri', 'tauri.conf.json'));
  const url = conf?.build?.devUrl ?? conf?.build?.devPath ?? '';
  const port = url.match(/:(\d+)/)?.[1];
  return port ? Number(port) : null;
}

/**
 * `anchor localnet`: Anchor 1.x starts Surfpool by default, so it is asked for solana-test-validator (`legacy`, part of
 * the Solana CLI DevCatz installs), and NO_DNA=1 makes it run without waiting for input in the background.
 */
function anchorCommand(dir: string): string {
  const programs = join(dir, 'programs');
  let major = 0;
  try {
    for (const p of readdirSync(programs)) {
      const v = (readText(join(programs, p, 'Cargo.toml')) ?? '').match(/^\s*anchor-lang\s*=\s*(?:\{[^}]*version\s*=\s*)?["'][^\d]*(\d+)/m)?.[1];
      if (v) major = Math.max(major, Number(v));
    }
  } catch {
    /* no programs/ */
  }
  return major >= 1 ? 'env NO_DNA=1 anchor localnet --validator legacy' : 'anchor localnet';
}

/** One crate as an app (dir = the crate's folder). */
export function detectRustApp(dir: string, root: string, domain: string, manifest = readCargo(dir)): AppInfo & { command: string | null } {
  const lib = rustLibrary(manifest?.deps ?? []);
  const name = manifest?.name ?? basename(dir);
  const base = { dir: relative(root, dir) || '.', name, framework: 'rust' as const, library: lib, managedPort: false, prisma: false, domain };
  const app = (kind: AppInfo['kind'], command: string | null, port: number | null, more: Partial<AppInfo> = {}) => ({
    ...base,
    kind,
    devScript: command,
    command,
    port,
    configuredPort: port,
    portVars: [] as string[],
    ...more,
  });
  if (existsSync(join(dir, 'Anchor.toml'))) return app('api', anchorCommand(dir), 8899, { library: 'anchor' });
  if (existsSync(join(dir, 'src-tauri', 'tauri.conf.json'))) return app('web', 'cargo tauri dev', tauriDevPort(dir), { library: 'tauri' });
  if (lib === 'leptos' && manifest?.leptosSsr) return app('web', 'cargo leptos watch', manifest.leptosPort ?? 3000);
  if (lib === 'dioxus') {
    const port = 8080;
    return app('web', `dx serve --port ${port}`, port, { portFlag: true, flagCommand: 'dx serve --port {port}' });
  }
  if (lib && FRONTENDS.has(lib)) {
    const port = trunkPort(dir);
    return app('web', `trunk serve --port ${port}`, port, { portFlag: true, flagCommand: 'trunk serve --port {port}' });
  }
  if (lib === 'loco') {
    const { port, vars } = serverPort(dir, root, lib);
    return app('api', 'cargo loco start', port, { portVars: vars });
  }
  if (lib && SERVERS.has(lib)) {
    const { port, vars } = serverPort(dir, root, lib);
    return app('api', 'cargo run', port, { portVars: vars });
  }
  // Bevy, Burn, Candle, a CLI: no server. Machine learning is unbearably slow in debug builds.
  const command = lib === 'burn' || lib === 'candle' ? 'cargo run --release' : manifest?.isPackage ? 'cargo run' : null;
  return app('api', command, null);
}

function detectRustStack(root: string, domain: string): StackInfo {
  const manifest = readCargo(root);
  let apps: (AppInfo & { command: string | null })[] = [];
  // Anchor and Tauri: the whole folder is one app, whatever its workspace holds.
  if (manifest && manifest.members.length && !existsSync(join(root, 'Anchor.toml')) && !existsSync(join(root, 'src-tauri'))) {
    for (const d of memberDirs(root, manifest.members)) {
      const m = readCargo(d);
      const lib = rustLibrary(m?.deps ?? []);
      if (lib && (SERVERS.has(lib) || FRONTENDS.has(lib))) apps.push(detectRustApp(d, root, '', m));
    }
  }
  if (!apps.length || (manifest?.isPackage && rustLibrary(manifest.deps))) apps.unshift(detectRustApp(root, root, '', manifest));
  apps = apps.filter((a, i) => apps.findIndex((b) => b.dir === a.dir) === i);
  // The first web app owns the bare domain; the others get `<folder>.<domain>`.
  apps.sort((a, b) => (a.kind === b.kind ? a.dir.localeCompare(b.dir) : a.kind === 'web' ? -1 : 1));
  apps.forEach((app, i) => {
    app.domain = i === 0 ? domain : `${slugify(basename(app.dir === '.' ? root : app.dir))}.${domain}`;
  });
  const many = apps.length > 1;
  const dirs = apps.map((a) => join(root, a.dir));
  return {
    packageManager: null,
    detectedPackageManager: null,
    monorepo: many,
    // Members run app by app, each from its own folder (`cargo run` there builds that package).
    ...(many ? { layout: 'folders' as const, devCommand: `${apps.length} apps, each from its folder` } : { devCommand: apps[0]?.command ?? null }),
    apps,
    database: detectDatabase(root, dirs),
    redis: detectRedis(root, dirs),
    prismaDir: null,
    node: null,
    runtime: 'rust',
    depsMissing: false,
    warnings: [],
    libs: [],
  };
}

export const rustDriver: RuntimeDriver = {
  id: 'rust',
  // A Tauri app with a plain HTML frontend has only src-tauri/Cargo.toml (with a package.json it is a JS project).
  matches: (dir) => existsSync(join(dir, 'Cargo.toml')) || (existsSync(join(dir, 'src-tauri', 'tauri.conf.json')) && !existsSync(join(dir, 'package.json'))),
  detect: detectRustStack,
};
