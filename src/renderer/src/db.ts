import type { DbEngine, DbServiceState } from '@shared/types';
import mysql from './assets/logos/db/mysql.svg';
import mariadb from './assets/logos/db/mariadb.svg';
import postgresql from './assets/logos/db/postgresql.svg';
import redis from './assets/logos/db/redis.svg';
import valkey from './assets/logos/db/valkey.png';
import mongodb from './assets/logos/db/mongodb.svg';
import elasticsearch from './assets/logos/db/elasticsearch.svg';
import sqlite from './assets/logos/db/sqlite.svg';

/** Engine marks (Simple Icons in brand colours; Valkey from valkey.io; see assets/logos/SOURCES.md). */
export const DB_LOGO: Record<DbEngine, string> = { mysql, mariadb, postgresql, redis, valkey, mongodb, elasticsearch, sqlite };

export const isActive = (s: Pick<DbServiceState, 'status'>) => s.status === 'running' || s.status === 'starting';

/** Engines whose root password lives in the server (changed with SQL), or Redis (requirepass). */
export const hasPassword = (e: DbEngine) => e === 'mysql' || e === 'mariadb' || e === 'postgresql' || e === 'redis' || e === 'valkey';

/** What the config file is called for each engine (form hint). */
export const CONFIG_HINT: Record<DbEngine, string> = {
  mysql: 'my.cnf',
  mariadb: 'my.cnf',
  postgresql: 'postgresql.conf',
  redis: 'redis.conf',
  valkey: 'valkey.conf',
  mongodb: 'mongod.conf (YAML)',
  elasticsearch: 'elasticsearch.yml',
  sqlite: '',
};
