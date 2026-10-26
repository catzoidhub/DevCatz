import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { DatabaseInfo, Framework, PackageManager } from '@shared/types';

export interface PackageJson {
  name?: string;
  /** Entry file (`app.js`), read for the listen port when the dev script names none. */
  main?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  workspaces?: string[] | { packages?: string[] };
  packageManager?: string;
  engines?: { node?: string };
}

export function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

export function readText(file: string): string | null {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}


/** `My Shop_v2` → `my-shop-v2` (a valid DNS label). */
export function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 63) || 'site'
  );
}

export function detectPackageManager(dir: string, pkg: PackageJson | null): PackageManager {
  if (existsSync(join(dir, 'bun.lock')) || existsSync(join(dir, 'bun.lockb'))) return 'bun';
  if (existsSync(join(dir, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(join(dir, 'yarn.lock'))) return 'yarn';
  if (existsSync(join(dir, 'package-lock.json'))) return 'npm';
  const declared = pkg?.packageManager?.split('@')[0];
  if (declared === 'bun' || declared === 'pnpm' || declared === 'yarn' || declared === 'npm') return declared;
  return 'npm';
}

export function runScriptCommand(pm: PackageManager, script: string): string {
  return pm === 'yarn' ? `yarn ${script}` : `${pm} run ${script}`;
}

/** Command prefix that runs a binary from node_modules/.bin. */
export function execCommand(pm: PackageManager, bin: string): string {
  switch (pm) {
    case 'bun':
      // `--bun` so TypeScript configs (prisma.config.ts) load under Bun.
      return `bun --bun ${bin}`;
    case 'pnpm':
      return `pnpm exec ${bin}`;
    case 'yarn':
      return `yarn ${bin}`;
    default:
      return `npx --no-install ${bin}`;
  }
}

export const DEFAULT_PORTS: Record<Framework, number | null> = {
  nuxt: 3000,
  next: 3000,
  'vite-vue': 5173,
  'vite-react': 5173,
  'tanstack-start': 3000,
  vite: 5173,
  sveltekit: 5173,
  astro: 4321,
  nestjs: 3000,
  express: 3000,
  node: null,
  go: 8080,
  mix: null,
  laravel: null,
  codeigniter: null,
  yii: null,
  symfony: null,
  cakephp: null,
  wordpress: null,
  drupal: null,
  joomla: null,
  slim: null,
  php: null,
  django: 8000,
  flask: 5000,
  fastapi: 8000,
  litestar: 8000,
  python: 8000,
};

/** Simple `KEY=value` parser; good enough for picking up ports. */
export function readEnvFiles(...files: string[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const file of files) {
    const text = readText(file);
    if (!text) continue;
    for (const line of text.split('\n')) {
      const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*['"]?([^'"#\n]*)['"]?/);
      if (m && !(m[1] in env)) env[m[1]] = m[2].trim();
    }
  }
  return env;
}

export function firstExisting(dir: string, names: string[]): string | null {
  for (const n of names) if (existsSync(join(dir, n))) return join(dir, n);
  return null;
}

const COMPOSE_FILES = ['compose.yaml', 'compose.yml', 'docker-compose.yml', 'docker-compose.yaml'];

/**
 * Finds the database service in the project's compose file. Only the bits
 * we need are parsed (service names, image, first published port), so no
 * YAML dependency is required.
 */
function engineOf(text: string): DatabaseInfo['engine'] {
  if (/mariadb/i.test(text)) return 'mariadb';
  if (/mysql/i.test(text)) return 'mysql';
  if (/postgres|postgis/i.test(text)) return 'postgres';
  return 'unknown';
}

/** Database known only from .env: DATABASE_URL, or Laravel's DB_CONNECTION/DB_HOST/DB_PORT/DB_DATABASE. */
function databaseFromEnv(root: string, dirs: string[]): DatabaseInfo | null {
  const env = readEnvFiles(...dirs.flatMap((d) => [join(d, '.env'), join(d, '.env.local')]), join(root, '.env'));
  const url = env.DATABASE_URL;
  if (url && !url.startsWith('file:')) {
    const m = url.match(/^(\w+):\/\/(?:[^@/]*@)?([^:/?]+)(?::(\d+))?(?:\/([^?#]+))?/);
    if (m) {
      const engine = engineOf(m[1]);
      const port = m[3] ? Number(m[3]) : engine === 'postgres' ? 5432 : engine === 'unknown' ? null : 3306;
      // The database name (URL path) too: DevCatz's .env writer keeps using it.
      return { engine, composeFile: null, service: null, image: null, host: m[2], hostPort: port, database: m[4] ? decodeURIComponent(m[4]) : null };
    }
  }
  // Go and other apps: DB_DRIVER / DB_DIALECT, or just DB_HOST + DB_PORT.
  const conn = (env.DB_CONNECTION || env.DB_DRIVER || env.DB_DIALECT || (env.DB_HOST ? (env.DB_PORT === '5432' ? 'pgsql' : 'mysql') : ''))
    .toLowerCase()
    .replace(/^postgres(ql)?$/, 'pgsql');
  if (conn && conn !== 'sqlite') {
    const engine = conn === 'pgsql' ? 'postgres' : conn === 'mariadb' ? 'mariadb' : conn === 'mysql' ? 'mysql' : 'unknown';
    const port = Number(env.DB_PORT) || (engine === 'postgres' ? 5432 : 3306);
    return { engine, composeFile: null, service: null, image: null, host: env.DB_HOST || '127.0.0.1', hostPort: port, database: env.DB_DATABASE || env.DB_NAME || null };
  }
  if (conn === 'sqlite') return { engine: 'sqlite', composeFile: null, service: null, image: null, host: null, hostPort: null, database: env.DB_DATABASE || 'database/database.sqlite' };
  return null;
}

export function detectDatabase(root: string, dirs: string[] = []): DatabaseInfo | null {
  const compose = detectComposeDatabase(root);
  const env = databaseFromEnv(root, dirs);
  if (compose && env) {
    // DATABASE_URL on this Mac (DBngin, Laravel Herd, Postgres.app) that is not
    // the compose service's published port: the app uses that one, not Docker.
    const local = /^(localhost|127\.0\.0\.1|::1|\[::1\])$/i.test(env.host ?? '');
    if (local && env.hostPort !== compose.hostPort) return env;
    if (!local && env.hostPort !== null && compose.hostPort !== null && env.hostPort !== compose.hostPort) return env;
  }
  return compose ?? env;
}

function detectComposeDatabase(root: string): DatabaseInfo | null {
  const file = firstExisting(root, COMPOSE_FILES);
  if (!file) return null;
  const text = readText(file) ?? '';
  const services: { name: string; body: string }[] = [];
  const section = text.split(/^services:\s*$/m)[1];
  if (!section) return null;
  const lines = section.split('\n');
  let current: { name: string; body: string } | null = null;
  for (const line of lines) {
    if (/^\S/.test(line)) break; // next top-level key (volumes:, networks:)
    const m = line.match(/^ {2}([A-Za-z0-9._-]+):\s*$/);
    if (m) {
      current = { name: m[1], body: '' };
      services.push(current);
    } else if (current) {
      current.body += line + '\n';
    }
  }
  const isDb = (s: { name: string; body: string }) =>
    /image:\s*['"]?(postgres|postgis|bitnami\/postgresql|mysql|mariadb)/.test(s.body);
  const svc =
    services.find((s) => ['db', 'database', 'postgres', 'postgresql'].includes(s.name) && isDb(s)) ??
    services.find(isDb) ??
    services.find((s) => ['db', 'database', 'postgres'].includes(s.name));
  if (!svc) return null;
  const image = svc.body.match(/image:\s*['"]?([^'"\s]+)/)?.[1] ?? null;
  const port = svc.body.match(/['"]?(?:[\d.]+:)?(\d+):\d+['"]?/)?.[1];
  return {
    engine: engineOf(image ?? svc.name),
    composeFile: basename(file),
    service: svc.name,
    image,
    hostPort: port ? Number(port) : null,
  };
}
