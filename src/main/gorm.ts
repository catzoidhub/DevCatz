import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { GoDbInfo, GoDbTask } from '@shared/types';
import { readEnvFiles, readText } from './detect';

/**
 * Database tooling of Go modules, whatever they are built with: data
 * libraries (GORM, ent, sqlc, sqlx, Bun, pgx, SQLBoiler, Squirrel, goqu) and
 * migration tools (goose, golang-migrate, Atlas, dbmate, sql-migrate, tern).
 * Go ORMs have no CLI of their own like `prisma migrate` / `artisan migrate`:
 * schemas change through GORM's AutoMigrate, ent / sqlc code generation or
 * one of those tools, and seeding is the project's own `make seed` /
 * `go run ./cmd/seed`. This finds what a module uses and turns it into a fixed
 * list of tasks; the renderer only picks a task id, never a command.
 */

/** Data libraries and migration tools a Go module uses (go.mod requires, config files), in display order. */
const GO_MOD_LIBS: [string, RegExp][] = [
  ['gorm', /\bgorm\.io\/gorm\b/],
  ['ent', /\bentgo\.io\/ent\b/],
  ['bun', /github\.com\/uptrace\/bun\b/],
  ['sqlboiler', /github\.com\/(?:volatiletech|aarondl)\/sqlboiler\b/],
  ['sqlx', /github\.com\/jmoiron\/sqlx\b/],
  ['squirrel', /github\.com\/Masterminds\/squirrel\b/],
  ['goqu', /github\.com\/doug-martin\/goqu\b/],
  ['pgx', /github\.com\/jackc\/pgx\b/],
];
export function goDataLibs(mod: string): string[] {
  const gomod = (readText(join(mod, 'go.mod')) ?? '').replace(/^module\s+\S+/m, '');
  const out = GO_MOD_LIBS.filter(([, re]) => re.test(gomod)).map(([id]) => id);
  if (['sqlc.yaml', 'sqlc.yml', 'sqlc.json'].some((f) => existsSync(join(mod, f)))) out.splice(out.includes('gorm') || out.includes('ent') ? 1 : 0, 0, 'sqlc');
  return out;
}

/** dbmate SQL files carry `-- migrate:up`. */
function dbmateAnnotated(dir: string): boolean {
  try {
    const f = readdirSync(dir).find((x) => x.endsWith('.sql'));
    return Boolean(f && /--\s*migrate:up/i.test(readText(join(dir, f)) ?? ''));
  } catch {
    return false;
  }
}

const SKIP = new Set(['vendor', 'node_modules', '.git', 'tmp', 'bin', 'dist', 'web', 'frontend']);
const MIGRATION_DIRS = ['migrations', 'db/migrations', 'database/migrations', 'internal/db/migrations', 'sql/migrations', 'migrate', 'sql/schema'];

function goFiles(dir: string, depth = 0, out: string[] = []): string[] {
  if (depth > 5 || out.length > 400) return out;
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.startsWith('.') || SKIP.has(e)) continue;
    const p = join(dir, e);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) goFiles(p, depth + 1, out);
    else if (e.endsWith('.go') && !e.endsWith('_test.go')) out.push(p);
  }
  return out;
}

const SQL_MIGRATION = /^\d+_.+\.(up\.)?sql$/;
function migrationDir(mod: string): string | null {
  for (const d of MIGRATION_DIRS) {
    try {
      if (readdirSync(join(mod, d)).some((f) => SQL_MIGRATION.test(f) || /^\d+_.+\.go$/.test(f))) return d;
    } catch {
      /* not there */
    }
  }
  return null;
}

/** Connection from DATABASE_URL or DB_* (module .env first, then the project's). */
export function connection(root: string, mod: string): { engine: 'mysql' | 'postgres' | 'sqlite' | null; url: string | null } {
  const env = readEnvFiles(join(root, '.env'), join(mod, '.env'), join(mod, '.env.local'));
  const raw = env.DATABASE_URL || env.DB_URL || env.DB_DSN;
  if (raw && /^(mysql|postgres|postgresql|sqlite):/.test(raw)) {
    const engine = raw.startsWith('mysql') ? 'mysql' : raw.startsWith('sqlite') ? 'sqlite' : 'postgres';
    return { engine, url: raw };
  }
  const driver = (env.DB_DRIVER || env.DB_CONNECTION || env.DB_DIALECT || '').toLowerCase();
  const host = env.DB_HOST;
  if (!host) return { engine: null, url: null };
  const engine = /postgres|pgsql|pg/.test(driver) || env.DB_PORT === '5432' ? 'postgres' : 'mysql';
  const user = env.DB_USER || env.DB_USERNAME || (engine === 'postgres' ? 'postgres' : 'root');
  const pass = env.DB_PASSWORD || env.DB_PASS || '';
  const port = env.DB_PORT || (engine === 'postgres' ? '5432' : '3306');
  const name = env.DB_NAME || env.DB_DATABASE || '';
  const auth = `${encodeURIComponent(user)}${pass ? `:${encodeURIComponent(pass)}` : ''}@`;
  return { engine, url: `${engine}://${auth}${host}:${port}/${name}` };
}

/** mysql://u:p@h:3306/db → u:p@tcp(h:3306)/db?parseTime=true (the Go driver's DSN, used by goose). */
function mysqlDsn(url: string): string {
  const u = new URL(url);
  const auth = u.username ? `${decodeURIComponent(u.username)}${u.password ? `:${decodeURIComponent(u.password)}` : ''}@` : '';
  return `${auth}tcp(${u.hostname}:${u.port || '3306'})${u.pathname}?parseTime=true&multiStatements=true`;
}

/** goose SQL files carry `-- +goose Up`. */
function gooseAnnotated(dir: string): boolean {
  try {
    const f = readdirSync(dir).find((x) => x.endsWith('.sql'));
    return Boolean(f && /\+goose\s+Up/i.test(readText(join(dir, f)) ?? ''));
  } catch {
    return false;
  }
}

/** sqlite://./app.db, sqlite:app.db → ./app.db */
const sqlitePath = (url: string) => url.replace(/^sqlite3?:(\/\/)?/, '') || 'app.db';

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

function makeTargets(mod: string, root: string): { dir: string; target: string }[] {
  const out: { dir: string; target: string }[] = [];
  for (const dir of [...new Set([mod, root])]) {
    const text = readText(join(dir, 'Makefile')) ?? '';
    for (const m of text.matchAll(/^([A-Za-z][\w:-]*)\s*:(?!=)/gm)) {
      if (/^(db[-:_])?(seed|migrate|migration|migrate[-:_]\w+|seed[-:_]\w+|db[-:_]\w+|schema[-:_]\w+)$/i.test(m[1]) && !out.some((t) => t.target === m[1])) {
        out.push({ dir, target: m[1] });
      }
    }
  }
  return out;
}

/** Database tooling of one Go module, with the tasks it supports; null when it has none. */
export function goDbInfo(root: string, modDir: string, appName: string): GoDbInfo | null {
  const mod = join(root, modDir);
  const gomod = readText(join(mod, 'go.mod')) ?? '';
  const libs = goDataLibs(mod);
  const files = goFiles(mod);
  const autoMigrate: string[] = [];
  let usesSeedFlag = false;
  for (const f of files) {
    let text = '';
    try {
      text = readFileSync(f, 'utf8');
    } catch {
      continue;
    }
    if (libs.includes('gorm') && /\.AutoMigrate\(/.test(text)) autoMigrate.push(relative(mod, f));
    if (/flag\.(Bool|String)\(\s*"seed"/.test(text)) usesSeedFlag = true;
  }
  const conn = connection(root, mod);
  const tasks: GoDbTask[] = [];
  const hints: string[] = [];
  const dir = migrationDir(mod);
  const cmdDir = (name: string) => existsSync(join(mod, 'cmd', name)) && readdirSync(join(mod, 'cmd', name)).some((f) => f.endsWith('.go'));

  // goose: SQL/Go migrations, version table goose_db_version.
  if (/github\.com\/pressly\/goose/.test(gomod) || (dir !== null && gooseAnnotated(join(mod, dir)))) {
    libs.push('goose');
    const goose = 'go run github.com/pressly/goose/v3/cmd/goose@latest';
    const mdir = dir ?? 'migrations';
    const dbs = conn.url ? (conn.engine === 'mysql' ? mysqlDsn(conn.url) : conn.engine === 'sqlite' ? sqlitePath(conn.url) : conn.url) : null;
    const env = dbs ? `GOOSE_DRIVER=${conn.engine === 'sqlite' ? 'sqlite3' : conn.engine} GOOSE_DBSTRING=${q(dbs)} GOOSE_MIGRATION_DIR=${q(mdir)} ` : '';
    if (!dbs) hints.push('goose: no DATABASE_URL / DB_* found in .env.');
    tasks.push(
      { id: 'goose-status', tool: 'goose', label: 'status', command: `${env}${goose} status`, cwd: modDir },
      { id: 'goose-up', tool: 'goose', label: 'up', command: `${env}${goose} up`, cwd: modDir },
      { id: 'goose-down', tool: 'goose', label: 'down (1 step)', command: `${env}${goose} down`, cwd: modDir, danger: true },
      { id: 'goose-create', tool: 'goose', label: 'create…', command: `${env}${goose} create {name} sql`, cwd: modDir, needsName: true },
    );
  }

  // golang-migrate: NNN_name.up.sql / .down.sql.
  if (/github\.com\/golang-migrate\/migrate/.test(gomod)) {
    libs.push('golang-migrate');
    const mdir = dir ?? 'migrations';
    // Build tags pick the drivers; `sqlite` is the pure-Go one (no cgo).
    const migrate = `go run -tags '${conn.engine ?? 'postgres'}' github.com/golang-migrate/migrate/v4/cmd/migrate@latest`;
    // golang-migrate wants mysql://user:pass@tcp(host:port)/db.
    const dbUrl = conn.url
      ? conn.engine === 'mysql'
        ? `mysql://${mysqlDsn(conn.url)}`
        : conn.engine === 'sqlite'
          ? `sqlite://${sqlitePath(conn.url)}`
          : conn.url
      : null;
    if (!dbUrl) hints.push('golang-migrate: no DATABASE_URL / DB_* found in .env.');
    const base = `${migrate} -path ${q(mdir)} -database ${q(dbUrl ?? '$DATABASE_URL')}`;
    tasks.push(
      { id: 'migrate-version', tool: 'golang-migrate', label: 'version', command: `${base} version`, cwd: modDir },
      { id: 'migrate-up', tool: 'golang-migrate', label: 'up', command: `${base} up`, cwd: modDir },
      { id: 'migrate-down', tool: 'golang-migrate', label: 'down 1', command: `${base} down 1`, cwd: modDir, danger: true },
      { id: 'migrate-create', tool: 'golang-migrate', label: 'create…', command: `${migrate} create -ext sql -dir ${q(mdir)} -seq {name}`, cwd: modDir, needsName: true },
    );
  }

  // Atlas: versioned migrations from an atlas.hcl (with the GORM provider it diffs the models, like `prisma migrate dev`).
  const atlasHcl = readText(join(mod, 'atlas.hcl'));
  if (atlasHcl || /ariga\.io\/atlas-provider-gorm/.test(gomod) || /\bariga\.io\/atlas\b/.test(gomod)) {
    libs.push('atlas');
    const envName = atlasHcl?.match(/env\s+"([\w-]+)"/)?.[1] ?? null;
    const envFlag = envName ? ` --env ${envName}` : '';
    if (!atlasHcl) hints.push('Atlas: it is in go.mod but there is no atlas.hcl yet (see atlasgo.io/getting-started).');
    const url = conn.url ? ` --url ${q(conn.url)}` : '';
    tasks.push(
      { id: 'atlas-status', tool: 'Atlas', label: 'status', command: `atlas migrate status${envFlag}${url}`, cwd: modDir, needsBin: 'atlas' },
      { id: 'atlas-diff', tool: 'Atlas', label: 'diff…', command: `atlas migrate diff {name}${envFlag}`, cwd: modDir, needsName: true, needsBin: 'atlas' },
      { id: 'atlas-apply', tool: 'Atlas', label: 'apply', command: `atlas migrate apply${envFlag}${url}`, cwd: modDir, needsBin: 'atlas' },
    );
  }

  // dbmate: plain SQL with `-- migrate:up` / `-- migrate:down`, version table schema_migrations.
  if (/github\.com\/amacneil\/dbmate/.test(gomod) || (dir !== null && dbmateAnnotated(join(mod, dir)))) {
    libs.push('dbmate');
    const mdir = dir ?? 'db/migrations';
    const dbmate = 'go run github.com/amacneil/dbmate/v2@latest';
    const env = conn.url ? `DATABASE_URL=${q(conn.engine === 'sqlite' ? `sqlite:${sqlitePath(conn.url)}` : conn.url)} ` : '';
    if (!conn.url) hints.push('dbmate: no DATABASE_URL / DB_* found in .env.');
    const base = `${env}${dbmate} --migrations-dir ${q(mdir)} --no-dump-schema`;
    tasks.push(
      { id: 'dbmate-status', tool: 'dbmate', label: 'status', command: `${base} status`, cwd: modDir },
      { id: 'dbmate-up', tool: 'dbmate', label: 'up', command: `${base} up`, cwd: modDir },
      { id: 'dbmate-new', tool: 'dbmate', label: 'new…', command: `${base} new {name}`, cwd: modDir, needsName: true },
      { id: 'dbmate-rollback', tool: 'dbmate', label: 'rollback', command: `${base} rollback`, cwd: modDir, danger: true },
    );
  }

  // sql-migrate: dbconfig.yml names the dialect, the datasource and the migrations folder.
  const dbconfig = existsSync(join(mod, 'dbconfig.yml'));
  if (dbconfig || /github\.com\/rubenv\/sql-migrate/.test(gomod)) {
    libs.push('sql-migrate');
    const sm = 'go run github.com/rubenv/sql-migrate/sql-migrate@latest';
    if (!dbconfig) hints.push('sql-migrate: no dbconfig.yml in the module (it holds the dialect, datasource and migrations dir).');
    tasks.push(
      { id: 'sqlmigrate-status', tool: 'sql-migrate', label: 'status', command: `${sm} status`, cwd: modDir },
      { id: 'sqlmigrate-up', tool: 'sql-migrate', label: 'up', command: `${sm} up`, cwd: modDir },
      { id: 'sqlmigrate-new', tool: 'sql-migrate', label: 'new…', command: `${sm} new {name}`, cwd: modDir, needsName: true },
      { id: 'sqlmigrate-down', tool: 'sql-migrate', label: 'down 1', command: `${sm} down -limit=1`, cwd: modDir, danger: true },
    );
  }

  // tern (PostgreSQL, from the pgx author): tern.conf, numbered .sql files.
  const ternConf = existsSync(join(mod, 'tern.conf'));
  if (ternConf || /github\.com\/jackc\/tern/.test(gomod)) {
    libs.push('tern');
    const mdir = dir ?? 'migrations';
    const tern = 'go run github.com/jackc/tern/v2@latest';
    const conf = ternConf ? ' --config tern.conf' : conn.url ? ` --conn-string ${q(conn.url)}` : '';
    if (!ternConf && !conn.url) hints.push('tern: no tern.conf and no DATABASE_URL in .env.');
    tasks.push(
      { id: 'tern-status', tool: 'tern', label: 'status', command: `${tern} status --migrations ${q(mdir)}${conf}`, cwd: modDir },
      { id: 'tern-migrate', tool: 'tern', label: 'migrate', command: `${tern} migrate --migrations ${q(mdir)}${conf}`, cwd: modDir },
      { id: 'tern-new', tool: 'tern', label: 'new…', command: `${tern} new --migrations ${q(mdir)} {name}`, cwd: modDir, needsName: true },
      { id: 'tern-down', tool: 'tern', label: 'migrate -1', command: `${tern} migrate --destination -1 --migrations ${q(mdir)}${conf}`, cwd: modDir, danger: true },
    );
  }

  // sqlc: Go code from SQL queries (sqlc.yaml).
  if (libs.includes('sqlc')) {
    const sqlc = 'go run github.com/sqlc-dev/sqlc/cmd/sqlc@latest';
    tasks.push(
      { id: 'sqlc-generate', tool: 'sqlc', label: 'generate', command: `${sqlc} generate`, cwd: modDir },
      { id: 'sqlc-vet', tool: 'sqlc', label: 'vet', command: `${sqlc} vet`, cwd: modDir },
      { id: 'sqlc-diff', tool: 'sqlc', label: 'diff', command: `${sqlc} diff`, cwd: modDir },
    );
  }

  // ent: schemas in ent/schema, code from `go generate ./ent`.
  if (libs.includes('ent') && existsSync(join(mod, 'ent'))) {
    const ent = 'go run -mod=mod entgo.io/ent/cmd/ent';
    tasks.push(
      { id: 'ent-generate', tool: 'ent', label: 'go generate ./ent', command: 'go generate ./ent', cwd: modDir },
      { id: 'ent-new', tool: 'ent', label: 'new schema…', command: `${ent} new {name}`, cwd: modDir, needsName: true },
      { id: 'ent-describe', tool: 'ent', label: 'describe', command: `${ent} describe ./ent/schema`, cwd: modDir },
    );
  }

  // The project's own commands.
  if (cmdDir('migrate')) tasks.push({ id: 'cmd-migrate', tool: 'project', label: 'go run ./cmd/migrate', command: 'go run ./cmd/migrate', cwd: modDir });
  if (cmdDir('seed')) tasks.push({ id: 'cmd-seed', tool: 'project', label: 'go run ./cmd/seed', command: 'go run ./cmd/seed', cwd: modDir });
  if (cmdDir('seeder')) tasks.push({ id: 'cmd-seeder', tool: 'project', label: 'go run ./cmd/seeder', command: 'go run ./cmd/seeder', cwd: modDir });
  if (usesSeedFlag) tasks.push({ id: 'flag-seed', tool: 'project', label: 'go run . -seed', command: 'go run . -seed', cwd: modDir });
  for (const t of makeTargets(mod, root)) {
    tasks.push({ id: `make-${t.target}`, tool: 'Makefile', label: `make ${t.target}`, command: `make ${t.target}`, cwd: relative(root, t.dir) || '.', danger: /fresh|reset|drop/i.test(t.target) });
  }

  if (!libs.length && !tasks.length && !autoMigrate.length) return null;
  return {
    app: appName,
    dir: modDir,
    libs,
    engine: conn.engine,
    autoMigrate,
    migrationDir: dir,
    tasks,
    hints,
  };
}
