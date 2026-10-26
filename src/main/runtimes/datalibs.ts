import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { DataLib, PackageManager, StackInfo, StackTask } from '@shared/types';
import { pythonDependencies } from './python';
import { goDbInfo } from '../gorm';

/**
 * The data layer of a site, for its Database tab: the ORMs, query builders
 * and migration tools it uses (from its manifests, and for a few from its
 * code), and the commands of those with a CLI, added to the stack's tasks so
 * they run like the framework commands.
 *
 *   JS      Knex, Drizzle, Sequelize, Kysely, TypeORM, MikroORM, Prisma (its own
 *           card), Mongoose, Objection.js, node-pg-migrate, db-migrate, Umzug
 *   Python  Django ORM, SQLAlchemy (Core or ORM), SQLModel, Peewee, Tortoise ORM
 *           (+ Aerich), Pony ORM, Piccolo, PyPika, Alembic, Flask-Migrate, Yoyo
 *   PHP     Eloquent ORM, Laravel DB facade, Doctrine (ORM / DBAL), Phinx,
 *           Propel, Cycle ORM, RedBeanPHP, Medoo, Laminas DB, Hydrahon
 *   Go      GORM, ent, sqlc, sqlx, Bun, pgx, SQLBoiler, Squirrel, goqu and the
 *           migration tools goose, golang-migrate, Atlas, dbmate, sql-migrate,
 *           tern (their commands are in the Go card)
 */

type Json = Record<string, unknown>;
const readJson = (f: string): Json | null => {
  try {
    return JSON.parse(readFileSync(f, 'utf8')) as Json;
  } catch {
    return null;
  }
};
const readText = (f: string): string | null => {
  try {
    return readFileSync(f, 'utf8');
  } catch {
    return null;
  }
};
const firstFile = (dir: string, names: string[]) => names.find((n) => existsSync(join(dir, n))) ?? null;

/** Source files under some folders (skipping vendor / node_modules / virtualenvs), at most `max`. */
function sourceFiles(root: string, dirs: string[], ext: RegExp, max = 400): string[] {
  const out: string[] = [];
  const skip = /^(node_modules|vendor|\.venv|venv|env|\.git|storage|__pycache__|dist|build|\..*)$/;
  const walk = (d: string, depth: number) => {
    if (out.length >= max || depth > 6) return;
    let entries: string[] = [];
    try {
      entries = readdirSync(d);
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= max) return;
      const p = join(d, e);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (!skip.test(e)) walk(p, depth + 1);
      } else if (ext.test(e) && st.size < 400_000) out.push(p);
    }
  };
  for (const d of dirs) if (existsSync(join(root, d))) walk(join(root, d), 0);
  return out;
}
const anyFile = (files: string[], re: RegExp) => files.some((f) => re.test(readText(f) ?? ''));

/** How a package manager runs a binary from node_modules without fetching one. */
function execPrefix(pm: PackageManager | null): string {
  if (pm === 'pnpm') return 'pnpm exec';
  if (pm === 'yarn') return 'yarn';
  if (pm === 'bun') return 'bunx';
  return 'npx --no --';
}

const t = (tool: string, id: string, label: string, command: string, cwd: string, extra: Partial<StackTask> = {}): StackTask => ({ id, tool, label, command, cwd, ...extra });

// ---------------------------------------------------------------- JS

function jsLibs(root: string, stack: StackInfo, libs: DataLib[], tasks: StackTask[]): void {
  // The project root and every app / workspace that has a package.json.
  const dirs = [...new Set(['.', ...stack.apps.map((a) => a.dir), ...(stack.libs ?? []).map((l) => l.dir)])].filter((d) => existsSync(join(root, d, 'package.json')));
  const x = execPrefix(stack.packageManager);
  for (const dir of dirs) {
    const pkg = readJson(join(root, dir, 'package.json')) ?? {};
    const deps = { ...(pkg.dependencies as Json), ...(pkg.devDependencies as Json) };
    const has = (n: string) => n in deps;
    const at = join(root, dir);
    const suffix = dir === '.' ? '' : `-${dir.replace(/[^\w]+/g, '-')}`;
    const where = dir === '.' ? '' : ` in ${dir}`;

    if (has('knex')) {
      const knexfile = firstFile(at, ['knexfile.js', 'knexfile.ts', 'knexfile.cjs', 'knexfile.mjs']);
      libs.push({ id: 'knex', name: 'Knex.js', kind: 'query-builder', dir, note: knexfile ? `${knexfile}${where}` : `no knexfile${where}: commands need one` });
      if (knexfile) {
        const k = `${x} knex`;
        tasks.push(
          t('Knex', `knex-latest${suffix}`, 'migrate:latest', `${k} migrate:latest`, dir),
          t('Knex', `knex-status${suffix}`, 'migrate:status', `${k} migrate:status`, dir),
          t('Knex', `knex-make${suffix}`, 'migrate:make…', `${k} migrate:make {name}`, dir, { needsName: true, namePlaceholder: 'create_users_table' }),
          t('Knex', `knex-seed${suffix}`, 'seed:run', `${k} seed:run`, dir),
          t('Knex', `knex-seed-make${suffix}`, 'seed:make…', `${k} seed:make {name}`, dir, { needsName: true, namePlaceholder: 'users' }),
          t('Knex', `knex-rollback${suffix}`, 'migrate:rollback', `${k} migrate:rollback`, dir, { danger: true }),
        );
      }
    }
    if (has('drizzle-orm')) {
      const cfg = firstFile(at, ['drizzle.config.ts', 'drizzle.config.js', 'drizzle.config.mjs', 'drizzle.config.json']);
      libs.push({ id: 'drizzle', name: 'Drizzle ORM', kind: 'orm', dir, note: cfg ? `${cfg}${where}` : `no drizzle.config${where}` });
      if (cfg && has('drizzle-kit')) {
        const k = `${x} drizzle-kit`;
        tasks.push(
          t('Drizzle', `drizzle-generate${suffix}`, 'generate', `${k} generate`, dir),
          t('Drizzle', `drizzle-generate-named${suffix}`, 'generate --name…', `${k} generate --name {name}`, dir, { needsName: true, namePlaceholder: 'add_users' }),
          t('Drizzle', `drizzle-migrate${suffix}`, 'migrate', `${k} migrate`, dir),
          t('Drizzle', `drizzle-check${suffix}`, 'check', `${k} check`, dir),
          t('Drizzle', `drizzle-push${suffix}`, 'push', `${k} push --force`, dir, { danger: true }),
        );
      }
    }
    if (has('sequelize')) {
      const cli = has('sequelize-cli');
      libs.push({ id: 'sequelize', name: 'Sequelize', kind: 'orm', dir, note: cli ? `sequelize-cli${where}` : `no sequelize-cli${where}` });
      if (cli) {
        const k = `${x} sequelize-cli`;
        tasks.push(
          t('Sequelize', `sequelize-migrate${suffix}`, 'db:migrate', `${k} db:migrate`, dir),
          t('Sequelize', `sequelize-status${suffix}`, 'db:migrate:status', `${k} db:migrate:status`, dir),
          t('Sequelize', `sequelize-generate${suffix}`, 'migration:generate…', `${k} migration:generate --name {name}`, dir, { needsName: true, namePlaceholder: 'create-users' }),
          t('Sequelize', `sequelize-seed${suffix}`, 'db:seed:all', `${k} db:seed:all`, dir),
          t('Sequelize', `sequelize-seed-gen${suffix}`, 'seed:generate…', `${k} seed:generate --name {name}`, dir, { needsName: true, namePlaceholder: 'demo-users' }),
          t('Sequelize', `sequelize-undo${suffix}`, 'db:migrate:undo', `${k} db:migrate:undo`, dir, { danger: true }),
        );
      }
    }
    if (has('kysely')) {
      const ctl = has('kysely-ctl');
      libs.push({ id: 'kysely', name: 'Kysely', kind: 'query-builder', dir, note: ctl ? `kysely-ctl${where}` : `no kysely-ctl${where}` });
      if (ctl) {
        const k = `${x} kysely`;
        tasks.push(
          t('Kysely', `kysely-latest${suffix}`, 'migrate:latest', `${k} migrate:latest`, dir),
          t('Kysely', `kysely-list${suffix}`, 'migrate:list', `${k} migrate:list`, dir),
          t('Kysely', `kysely-make${suffix}`, 'migrate:make…', `${k} migrate:make {name}`, dir, { needsName: true, namePlaceholder: 'create_users' }),
          t('Kysely', `kysely-seed${suffix}`, 'seed:run', `${k} seed:run`, dir),
          t('Kysely', `kysely-seed-make${suffix}`, 'seed:make…', `${k} seed:make {name}`, dir, { needsName: true, namePlaceholder: 'users' }),
          t('Kysely', `kysely-down${suffix}`, 'migrate:down', `${k} migrate:down`, dir, { danger: true }),
        );
      }
    }
    if (has('typeorm')) {
      const ds = firstFile(at, ['src/data-source.ts', 'src/data-source.js', 'data-source.ts', 'data-source.js', 'src/database/data-source.ts', 'src/db/data-source.ts', 'src/config/data-source.ts']);
      const ormconfig = firstFile(at, ['ormconfig.ts', 'ormconfig.js', 'ormconfig.json']);
      libs.push({ id: 'typeorm', name: 'TypeORM', kind: 'orm', dir, note: ds ? `${ds}${where}` : ormconfig ? `${ormconfig}${where}` : `no data source file found${where}` });
      if (ds || ormconfig) {
        const ts = /\.ts$/.test(ds ?? ormconfig ?? '');
        const cli = ts ? (has('ts-node') ? `${x} typeorm-ts-node-commonjs` : `${x} typeorm`) : `${x} typeorm`;
        const d = ds ? ` -d ${ds}` : '';
        const migrations = existsSync(join(at, 'src/migrations')) ? 'src/migrations' : existsSync(join(at, 'migrations')) ? 'migrations' : 'src/migrations';
        tasks.push(
          t('TypeORM', `typeorm-show${suffix}`, 'migration:show', `${cli} migration:show${d}`, dir),
          t('TypeORM', `typeorm-run${suffix}`, 'migration:run', `${cli} migration:run${d}`, dir),
          t('TypeORM', `typeorm-generate${suffix}`, 'migration:generate…', `${cli} migration:generate ${migrations}/{name}${d}`, dir, { needsName: true, namePlaceholder: 'AddUsers' }),
          t('TypeORM', `typeorm-create${suffix}`, 'migration:create…', `${x} typeorm migration:create ${migrations}/{name}`, dir, { needsName: true, namePlaceholder: 'AddUsers' }),
          t('TypeORM', `typeorm-revert${suffix}`, 'migration:revert', `${cli} migration:revert${d}`, dir, { danger: true }),
        );
      }
    }
    if (has('@mikro-orm/core')) {
      const cli = has('@mikro-orm/cli');
      libs.push({ id: 'mikroorm', name: 'MikroORM', kind: 'orm', dir, note: cli ? `@mikro-orm/cli${where}` : `no @mikro-orm/cli${where}` });
      if (cli) {
        const k = `${x} mikro-orm`;
        tasks.push(
          t('MikroORM', `mikro-pending${suffix}`, 'migration:pending', `${k} migration:pending`, dir),
          t('MikroORM', `mikro-up${suffix}`, 'migration:up', `${k} migration:up`, dir),
          t('MikroORM', `mikro-create${suffix}`, 'migration:create…', `${k} migration:create --name {name}`, dir, { needsName: true, namePlaceholder: 'add_users' }),
          t('MikroORM', `mikro-list${suffix}`, 'migration:list', `${k} migration:list`, dir),
          t('MikroORM', `mikro-down${suffix}`, 'migration:down', `${k} migration:down`, dir, { danger: true }),
        );
      }
    }
    if (has('mongoose')) libs.push({ id: 'mongoose', name: 'Mongoose', kind: 'orm', dir, note: `MongoDB ODM${where}` });
    if (has('objection')) libs.push({ id: 'objection', name: 'Objection.js', kind: 'orm', dir, note: `on Knex${where}` });
    if (has('node-pg-migrate')) {
      libs.push({ id: 'node-pg-migrate', name: 'node-pg-migrate', kind: 'migrations', dir });
      const env = existsSync(join(at, '.env')) ? ' --envPath .env' : '';
      const k = `${x} node-pg-migrate`;
      tasks.push(
        t('node-pg-migrate', `npm-up${suffix}`, 'up', `${k} up${env}`, dir),
        t('node-pg-migrate', `npm-create${suffix}`, 'create…', `${k} create {name}`, dir, { needsName: true, namePlaceholder: 'add-users' }),
        t('node-pg-migrate', `npm-down${suffix}`, 'down', `${k} down${env}`, dir, { danger: true }),
      );
    }
    if (has('db-migrate')) {
      libs.push({ id: 'db-migrate', name: 'db-migrate', kind: 'migrations', dir, note: existsSync(join(at, 'database.json')) ? `database.json${where}` : `no database.json${where}` });
      const k = `${x} db-migrate`;
      tasks.push(
        t('db-migrate', `dbm-up${suffix}`, 'up', `${k} up`, dir),
        t('db-migrate', `dbm-create${suffix}`, 'create…', `${k} create {name} --sql-file`, dir, { needsName: true, namePlaceholder: 'add-users' }),
        t('db-migrate', `dbm-down${suffix}`, 'down', `${k} down`, dir, { danger: true }),
      );
    }
    if (has('umzug')) libs.push({ id: 'umzug', name: 'Umzug', kind: 'migrations', dir, note: `migrations run from your own script${where}` });
    if (has('prisma') || has('@prisma/client')) libs.push({ id: 'prisma', name: 'Prisma', kind: 'orm', dir, note: `Prisma card below${where}` });
  }
}

// ---------------------------------------------------------------- Python

function pythonLibs(root: string, stack: StackInfo, libs: DataLib[], tasks: StackTask[]): void {
  const deps = pythonDependencies(root);
  if (stack.apps.some((a) => a.framework === 'django')) libs.push({ id: 'django', name: 'Django ORM', kind: 'orm', dir: '.', note: 'manage.py commands below' });
  if (deps.has('sqlmodel')) libs.push({ id: 'sqlmodel', name: 'SQLModel', kind: 'orm', dir: '.' });
  if (deps.has('sqlalchemy') || deps.has('flask-sqlalchemy')) {
    // Core (Table, select, text) vs the ORM (mapped classes, Session).
    const files = sourceFiles(root, ['.'], /\.py$/);
    const orm = deps.has('flask-sqlalchemy') || deps.has('sqlmodel') || anyFile(files, /sqlalchemy\.orm|declarative_base|DeclarativeBase|mapped_column|db\.Model\b/);
    libs.push({ id: 'sqlalchemy', name: orm ? 'SQLAlchemy ORM' : 'SQLAlchemy Core', kind: orm ? 'orm' : 'query-builder', dir: '.' });
  }
  if (deps.has('peewee')) libs.push({ id: 'peewee', name: 'Peewee', kind: 'orm', dir: '.' });
  if (deps.has('tortoise-orm')) {
    const aerich = deps.has('aerich');
    libs.push({ id: 'tortoise', name: 'Tortoise ORM', kind: 'orm', dir: '.', note: aerich ? 'Aerich migrations below' : 'no Aerich' });
    if (aerich) {
      libs.push({ id: 'aerich', name: 'Aerich', kind: 'migrations', dir: '.' });
      tasks.push(
        t('Aerich', 'aerich-heads', 'heads', 'aerich heads', '.'),
        t('Aerich', 'aerich-upgrade', 'upgrade', 'aerich upgrade', '.'),
        t('Aerich', 'aerich-migrate', 'migrate --name…', 'aerich migrate --name {name}', '.', { needsName: true, namePlaceholder: 'add_users' }),
        t('Aerich', 'aerich-history', 'history', 'aerich history', '.'),
        t('Aerich', 'aerich-downgrade', 'downgrade', 'aerich downgrade --yes', '.', { danger: true }),
      );
    }
  }
  if (deps.has('pony')) libs.push({ id: 'pony', name: 'Pony ORM', kind: 'orm', dir: '.' });
  if (deps.has('piccolo')) {
    libs.push({ id: 'piccolo', name: 'Piccolo', kind: 'orm', dir: '.' });
    tasks.push(
      t('Piccolo', 'piccolo-check', 'migrations check', 'piccolo migrations check', '.'),
      t('Piccolo', 'piccolo-forwards', 'migrations forwards all', 'piccolo migrations forwards all', '.'),
      t('Piccolo', 'piccolo-backwards', 'backwards (1)', 'piccolo migrations backwards all --migration_id=1 --auto_agree', '.', { danger: true }),
    );
  }
  if (deps.has('pypika')) libs.push({ id: 'pypika', name: 'PyPika', kind: 'query-builder', dir: '.' });
  if (existsSync(join(root, 'alembic.ini'))) libs.push({ id: 'alembic', name: 'Alembic', kind: 'migrations', dir: '.', note: 'commands below' });
  if (deps.has('flask-migrate')) libs.push({ id: 'flask-migrate', name: 'Flask-Migrate', kind: 'migrations', dir: '.', note: 'commands below' });
  if (deps.has('yoyo-migrations')) {
    libs.push({ id: 'yoyo', name: 'Yoyo', kind: 'migrations', dir: '.', note: existsSync(join(root, 'yoyo.ini')) ? 'yoyo.ini' : 'no yoyo.ini' });
    tasks.push(
      t('Yoyo', 'yoyo-list', 'list', 'yoyo list --batch', '.'),
      t('Yoyo', 'yoyo-apply', 'apply', 'yoyo apply --batch', '.'),
      t('Yoyo', 'yoyo-new', 'new…', 'yoyo new --batch -m {name}', '.', { needsName: true, namePlaceholder: 'add users' }),
      t('Yoyo', 'yoyo-rollback', 'rollback', 'yoyo rollback --batch', '.', { danger: true }),
    );
  }
}

// ---------------------------------------------------------------- PHP

function phpLibs(root: string, stack: StackInfo, libs: DataLib[], tasks: StackTask[]): StackTask[] {
  const composer = readJson(join(root, 'composer.json')) ?? {};
  const req = { ...(composer.require as Json), ...(composer['require-dev'] as Json) };
  const has = (n: string) => n in req;
  const laravel = stack.apps.some((a) => a.framework === 'laravel');
  if (laravel) {
    const files = sourceFiles(root, ['app', 'routes', 'database'], /\.php$/);
    if (anyFile(files, /extends\s+(?:\\?Illuminate\\Database\\Eloquent\\)?Model\b|Illuminate\\Database\\Eloquent\\Model/)) libs.push({ id: 'eloquent', name: 'Eloquent ORM', kind: 'orm', dir: '.', note: 'models in app/' });
    if (anyFile(files, /\bDB::|Illuminate\\Support\\Facades\\DB\b/)) libs.push({ id: 'db-facade', name: 'Laravel DB Facade', kind: 'query-builder', dir: '.', note: 'DB:: queries' });
  }
  if (!laravel && has('illuminate/database')) libs.push({ id: 'eloquent', name: 'Eloquent (Capsule)', kind: 'orm', dir: '.', note: 'illuminate/database outside Laravel' });
  if (has('robmorgan/phinx') || has('cakephp/phinx')) {
    const cfg = firstFile(root, ['phinx.php', 'phinx.yml', 'phinx.yaml', 'phinx.json']);
    libs.push({ id: 'phinx', name: 'Phinx', kind: 'migrations', dir: '.', note: cfg ?? 'no phinx config' });
    if (cfg && existsSync(join(root, 'vendor/bin/phinx'))) {
      const c = 'vendor/bin/phinx';
      tasks.push(
        t('Phinx', 'phinx-status', 'status', `${c} status`, '.'),
        t('Phinx', 'phinx-migrate', 'migrate', `${c} migrate`, '.'),
        t('Phinx', 'phinx-create', 'create…', `${c} create {name}`, '.', { needsName: true, namePlaceholder: 'CreateUsersTable' }),
        t('Phinx', 'phinx-seed', 'seed:run', `${c} seed:run`, '.'),
        t('Phinx', 'phinx-seed-create', 'seed:create…', `${c} seed:create {name}`, '.', { needsName: true, namePlaceholder: 'UserSeeder' }),
        t('Phinx', 'phinx-rollback', 'rollback', `${c} rollback`, '.', { danger: true }),
      );
    }
  }
  if (has('propel/propel')) {
    libs.push({ id: 'propel', name: 'Propel', kind: 'orm', dir: '.' });
    if (existsSync(join(root, 'vendor/bin/propel'))) {
      const c = 'vendor/bin/propel';
      tasks.push(
        t('Propel', 'propel-status', 'migration:status', `${c} migration:status`, '.'),
        t('Propel', 'propel-diff', 'diff', `${c} diff`, '.'),
        t('Propel', 'propel-migrate', 'migrate', `${c} migrate`, '.'),
        t('Propel', 'propel-build', 'model:build', `${c} model:build`, '.'),
        t('Propel', 'propel-down', 'migration:down', `${c} migration:down`, '.', { danger: true }),
      );
    }
  }
  if (has('cycle/orm')) libs.push({ id: 'cycle', name: 'Cycle ORM', kind: 'orm', dir: '.' });
  if (has('gabordemooij/redbean')) libs.push({ id: 'redbean', name: 'RedBeanPHP', kind: 'orm', dir: '.' });
  if (has('catfan/medoo')) libs.push({ id: 'medoo', name: 'Medoo', kind: 'query-builder', dir: '.' });
  if (has('laminas/laminas-db')) libs.push({ id: 'laminas', name: 'Laminas DB', kind: 'query-builder', dir: '.' });
  if (has('clancats/hydrahon')) libs.push({ id: 'hydrahon', name: 'Hydrahon', kind: 'query-builder', dir: '.' });
  const orm = has('doctrine/orm') || has('doctrine/doctrine-bundle');
  if (orm || has('doctrine/dbal')) {
    libs.push({ id: 'doctrine', name: orm ? 'Doctrine ORM' : 'Doctrine DBAL', kind: orm ? 'orm' : 'query-builder', dir: '.' });
    const console = existsSync(join(root, 'bin/console'));
    if (console && has('doctrine/doctrine-migrations-bundle')) {
      const c = 'php bin/console';
      tasks.push(
        t('Doctrine', 'doctrine-migrate', 'migrations:migrate', `${c} doctrine:migrations:migrate -n`, '.'),
        t('Doctrine', 'doctrine-status', 'migrations:status', `${c} doctrine:migrations:status`, '.'),
        t('Doctrine', 'doctrine-diff', 'migrations:diff', `${c} doctrine:migrations:diff -n`, '.'),
        ...(has('symfony/maker-bundle') ? [t('Doctrine', 'doctrine-make', 'make:migration', `${c} make:migration -n`, '.')] : []),
        t('Doctrine', 'doctrine-validate', 'schema:validate', `${c} doctrine:schema:validate`, '.'),
        t('Doctrine', 'doctrine-prev', 'migrate prev', `${c} doctrine:migrations:migrate prev -n`, '.', { danger: true }),
      );
      // The Symfony console group had the first two; they live with Doctrine now.
      return (stack.tasks ?? []).filter((x) => !(x.tool === 'console' && (x.id === 'migrate' || x.id === 'make-migration')));
    } else if (has('doctrine/migrations') && existsSync(join(root, 'vendor/bin/doctrine-migrations'))) {
      const c = 'vendor/bin/doctrine-migrations';
      tasks.push(
        t('Doctrine', 'doctrine-migrate', 'migrate', `${c} migrate -n`, '.'),
        t('Doctrine', 'doctrine-status', 'status', `${c} status`, '.'),
        t('Doctrine', 'doctrine-generate', 'generate', `${c} generate -n`, '.'),
        t('Doctrine', 'doctrine-diff', 'diff', `${c} diff -n`, '.'),
        t('Doctrine', 'doctrine-prev', 'migrate prev', `${c} migrate prev -n`, '.', { danger: true }),
      );
    }
  }
  return stack.tasks ?? [];
}

// ---------------------------------------------------------------- Go

const GO_LIB: Record<string, [string, DataLib['kind']]> = {
  gorm: ['GORM', 'orm'],
  ent: ['ent', 'orm'],
  bun: ['Bun', 'orm'],
  sqlboiler: ['SQLBoiler', 'orm'],
  sqlc: ['sqlc', 'codegen'],
  sqlx: ['sqlx', 'query-builder'],
  squirrel: ['Squirrel', 'query-builder'],
  goqu: ['goqu', 'query-builder'],
  pgx: ['pgx', 'driver'],
  goose: ['goose', 'migrations'],
  'golang-migrate': ['golang-migrate', 'migrations'],
  atlas: ['Atlas', 'migrations'],
  dbmate: ['dbmate', 'migrations'],
  'sql-migrate': ['sql-migrate', 'migrations'],
  tern: ['tern', 'migrations'],
};

function goLibs(root: string, stack: StackInfo, libs: DataLib[]): void {
  for (const app of stack.apps.filter((a) => a.framework === 'go')) {
    const info = goDbInfo(root, app.dir, app.name);
    for (const id of info?.libs ?? []) {
      const [name, kind] = GO_LIB[id] ?? [id, 'orm'];
      if (!libs.some((l) => l.id === id && l.dir === app.dir)) libs.push({ id, name, kind, dir: app.dir, note: `Go card below${app.dir === '.' ? '' : ` · ${app.dir}`}` });
    }
  }
}

/** Adds `dataLibs` and the commands of their CLIs to a detected stack. */
export function withDataLibs(root: string, stack: StackInfo): StackInfo {
  const libs: DataLib[] = [];
  const tasks: StackTask[] = [];
  let base = stack.tasks ?? [];
  try {
    if (stack.runtime === 'php') base = phpLibs(root, stack, libs, tasks);
    if (stack.runtime === 'python') pythonLibs(root, stack, libs, tasks);
    // JS next to any runtime (Laravel's Vite has no data layer, but a Node API in a PHP repo might).
    if (stack.runtime === 'node' || stack.packageManager) jsLibs(root, stack, libs, tasks);
    goLibs(root, stack, libs);
  } catch (e) {
    console.warn(`data libraries of ${root}: ${(e as Error).message}`);
  }
  return { ...stack, dataLibs: libs, tasks: [...base, ...tasks] };
}

