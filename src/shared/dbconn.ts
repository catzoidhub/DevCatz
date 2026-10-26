import type { DbEngine } from './types';

/** How a connection is written into .env: Laravel's DB_* keys, one URL (Prisma, Node, Go), or a Go-style DSN. */
export type DbEnvFormat = 'laravel' | 'url' | 'go';

export interface DbConnInput {
  engine: DbEngine;
  host: string;
  port: number;
  user: string;
  password: string;
  /** Database name (SQL engines, MongoDB); for SQLite the absolute file path. */
  database: string;
}

const enc = encodeURIComponent;
const auth = (c: DbConnInput) => (c.user ? `${enc(c.user)}${c.password ? `:${enc(c.password)}` : ''}@` : c.password ? `:${enc(c.password)}@` : '');

/** One URL for the connection (DATABASE_URL, REDIS_URL, MONGODB_URI, ELASTICSEARCH_URL). */
export function connectionUrl(c: DbConnInput): string {
  const hp = `${c.host}:${c.port}`;
  switch (c.engine) {
    case 'mysql':
    case 'mariadb':
      return `mysql://${auth(c)}${hp}/${enc(c.database)}`;
    case 'postgresql':
      return `postgresql://${auth(c)}${hp}/${enc(c.database)}`;
    case 'sqlite':
      return `file:${c.database}`;
    case 'redis':
    case 'valkey':
      return `redis://${c.password ? `:${enc(c.password)}@` : ''}${hp}`;
    case 'mongodb':
      return `mongodb://${hp}/${enc(c.database)}`;
    case 'elasticsearch':
      return `http://${hp}`;
  }
}

/** The .env entries for a connection in the chosen format. */
export function connectionEnv(c: DbConnInput, format: DbEnvFormat): Record<string, string> {
  const url = connectionUrl(c);
  // Valkey speaks the Redis protocol: same keys and redis:// URL.
  if (c.engine === 'redis' || c.engine === 'valkey') {
    if (format === 'laravel') return { REDIS_HOST: c.host, REDIS_PORT: String(c.port), REDIS_PASSWORD: c.password || 'null' };
    if (format === 'go') return { REDIS_ADDR: `${c.host}:${c.port}`, REDIS_PASSWORD: c.password };
    return { REDIS_URL: url };
  }
  if (c.engine === 'elasticsearch') return format === 'laravel' ? { ELASTICSEARCH_HOST: url } : { ELASTICSEARCH_URL: url };
  if (c.engine === 'mongodb') return format === 'laravel' ? { MONGODB_URI: `mongodb://${c.host}:${c.port}`, MONGODB_DATABASE: c.database } : { MONGODB_URI: url };
  if (c.engine === 'sqlite') {
    if (format === 'laravel') return { DB_CONNECTION: 'sqlite', DB_DATABASE: c.database };
    if (format === 'go') return { DB_DSN: c.database };
    return { DATABASE_URL: url };
  }
  if (format === 'laravel') {
    return {
      // Laravel's mysql driver also serves MariaDB (the `mariadb` one needs Laravel 11+).
      DB_CONNECTION: c.engine === 'postgresql' ? 'pgsql' : 'mysql',
      DB_HOST: c.host,
      DB_PORT: String(c.port),
      DB_DATABASE: c.database,
      DB_USERNAME: c.user,
      DB_PASSWORD: c.password,
    };
  }
  if (format === 'go') {
    return {
      DB_DSN:
        c.engine === 'postgresql'
          ? `host=${c.host} port=${c.port} user=${c.user} password=${c.password} dbname=${c.database} sslmode=disable`
          : `${c.user}${c.password ? `:${c.password}` : ''}@tcp(${c.host}:${c.port})/${c.database}?charset=utf8mb4&parseTime=True&loc=Local`,
    };
  }
  return { DATABASE_URL: url };
}

/** Engines with named databases inside one server. */
export const hasDatabases = (e: DbEngine) => e === 'mysql' || e === 'mariadb' || e === 'postgresql' || e === 'mongodb' || e === 'sqlite';
