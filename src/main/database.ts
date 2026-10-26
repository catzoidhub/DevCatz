import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { execCommand } from './detect';
import { getShellEnv, isPortOpen, run } from './env';
import type { DbAction, DbStatus, ProjectState } from '@shared/types';

type Log = (text: string) => void;

/** Container state of the project's compose db service. */
export async function dbStatus(project: ProjectState): Promise<DbStatus> {
  const db = project.stack.database;
  if (!db) return 'none';
  if (db.engine === 'sqlite') {
    const file = db.database && isAbsolute(db.database) ? db.database : join(project.path, db.database ?? 'database/database.sqlite');
    return existsSync(file) ? 'running' : 'stopped';
  }
  if (!db.composeFile || !db.service) {
    return db.hostPort && (await isPortOpen(db.hostPort)) ? 'running' : 'stopped';
  }
  const { code, stdout } = await run(
    'docker',
    ['compose', '-f', db.composeFile, 'ps', '--all', '--format', '{{.State}} {{.Health}}', db.service],
    { cwd: project.path, timeout: 10_000 },
  );
  if (code !== 0) {
    // Docker not running: fall back to "is anything on the published port".
    if (db.hostPort && (await isPortOpen(db.hostPort))) return 'running';
    return 'unknown';
  }
  const line = stdout.trim().split('\n')[0] ?? '';
  if (line.startsWith('running')) return line.includes('starting') ? 'starting' : 'running';
  if (line.startsWith('restarting')) return 'starting';
  return 'stopped';
}

/** Streams a shell command's output line by line into the project log. */
export function stream(cwd: string, command: string, log: Log, env: Record<string, string> = {}): Promise<number> {
  log(`$ ${command}`);
  return new Promise((resolve) => {
    const child = spawn(process.env.SHELL || '/bin/zsh', ['-c', command], {
      cwd,
      env: { ...getShellEnv(), FORCE_COLOR: '1', CI: '1', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (d: Buffer) => log(d.toString()));
    child.stderr.on('data', (d: Buffer) => log(d.toString()));
    child.on('error', (e) => log(e.message));
    child.on('exit', (code) => {
      log(`→ exit ${code}`);
      resolve(code ?? 1);
    });
  });
}

const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export const DB_TASK_LABELS: Record<DbAction, string> = {
  start: 'Starting database',
  stop: 'Stopping database',
  migrate: 'prisma migrate dev',
  reset: 'prisma migrate reset',
  seed: 'prisma db seed',
  generate: 'prisma generate',
  'redis-start': 'Starting Redis',
  'redis-stop': 'Stopping Redis',
  'artisan-migrate': 'artisan migrate',
  'artisan-fresh': 'artisan migrate:fresh --seed',
  'artisan-seed': 'artisan db:seed',
};

export async function runDbAction(
  project: ProjectState,
  action: DbAction,
  arg: string | undefined,
  log: Log,
  env: Record<string, string> = {},
): Promise<number> {
  if (action === 'artisan-migrate' || action === 'artisan-fresh' || action === 'artisan-seed') {
    // `php` here is the site's version (wrapper folder first on PATH, see Herd.runtimeEnv).
    const cmd = { 'artisan-migrate': 'migrate', 'artisan-fresh': 'migrate:fresh --seed', 'artisan-seed': 'db:seed' }[action];
    return stream(project.path, `php artisan ${cmd} --force --no-interaction`, log, env);
  }
  if (action === 'redis-start' || action === 'redis-stop') {
    const r = project.stack.redis;
    if (!r?.composeFile || !r.service) throw new Error('Redis is not a compose service here; manage it where it runs, or use a DevCatz Redis service');
    const sub = action === 'redis-start' ? `up -d ${quote(r.service)}` : `stop ${quote(r.service)}`;
    return stream(project.path, `docker compose -f ${quote(r.composeFile)} ${sub}`, log, env);
  }
  const db = project.stack.database;
  if (action === 'start' || action === 'stop') {
    if (!db?.composeFile || !db.service) throw new Error('No database service in a compose file; manage this database outside DevCatz');
    const sub = action === 'start' ? `up -d ${quote(db.service)}` : `stop ${quote(db.service)}`;
    return stream(project.path, `docker compose -f ${quote(db.composeFile)} ${sub}`, log);
  }
  if (project.stack.prismaDir === null || !project.stack.packageManager) throw new Error('No Prisma schema found');
  const cwd = join(project.path, project.stack.prismaDir);
  const prisma = execCommand(project.stack.packageManager, 'prisma');
  switch (action) {
    case 'migrate':
      // Non-interactive: a name is required whenever the schema changed.
      return stream(cwd, `${prisma} migrate dev${arg ? ` --name ${quote(arg)}` : ''}`, log, env);
    case 'reset':
      return stream(cwd, `${prisma} migrate reset --force`, log, env);
    case 'seed':
      return stream(cwd, `${prisma} db seed`, log, env);
    case 'generate':
      return stream(cwd, `${prisma} generate`, log, env);
  }
}
