import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { S3Info } from '@shared/types';
import { readEnvFiles } from './detect';

/**
 * S3 use of a site: client libraries (manifests of the root and workspace
 * apps) and the .env settings (FILESYSTEM_DISK=s3, AWS_* / S3_* endpoint and
 * bucket), so the site's Storage tab can point it at DevCatz's object storage.
 */

type Rule = [match: string | RegExp, name: string];
const NODE: Rule[] = [
  ['@aws-sdk/client-s3', 'AWS SDK v3 (S3)'],
  ['aws-sdk', 'AWS SDK v2'],
  ['minio', 'MinIO JS'],
  ['@aws-sdk/s3-request-presigner', 'S3 presigner'],
  ['@aws-sdk/lib-storage', 'S3 uploads (lib-storage)'],
  ['multer-s3', 'multer-s3'],
];
const PHP: Rule[] = [
  ['league/flysystem-aws-s3-v3', 'Flysystem S3 (Laravel s3 disk)'],
  ['aws/aws-sdk-php', 'AWS SDK for PHP'],
  ['aws/aws-sdk-php-laravel', 'AWS SDK for Laravel'],
  ['spatie/laravel-medialibrary', 'Media Library'],
];
const PYTHON: Rule[] = [
  ['boto3', 'boto3'],
  ['django-storages', 'django-storages'],
  ['minio', 'MinIO Python'],
  ['s3fs', 's3fs'],
];
const GO: Rule[] = [
  [/^github\.com\/aws\/aws-sdk-go-v2\/service\/s3$/, 'aws-sdk-go-v2 (S3)'],
  ['github.com/aws/aws-sdk-go', 'aws-sdk-go'],
  [/^github\.com\/minio\/minio-go(\/v\d+)?$/, 'minio-go'],
];

const read = (f: string) => {
  try {
    return readFileSync(f, 'utf8');
  } catch {
    return null;
  }
};
function match(rules: Rule[], names: string[], source: string, out: S3Info['libs']): void {
  for (const [m, name] of rules) {
    if (names.some((n) => (typeof m === 'string' ? n === m : m.test(n))) && !out.some((o) => o.name === name)) out.push({ name, source });
  }
}
function packageJsons(root: string): string[] {
  const out = [join(root, 'package.json')];
  for (const dir of ['apps', 'packages', 'services']) {
    try {
      for (const e of readdirSync(join(root, dir))) out.push(join(root, dir, e, 'package.json'));
    } catch {
      /* none */
    }
  }
  return out.filter((f) => existsSync(f));
}

const cache = new Map<string, { sig: string; info: S3Info }>();

export function detectS3(root: string): S3Info {
  const files = [...new Set(['composer.json', 'go.mod', 'requirements.txt', 'pyproject.toml', 'Pipfile', '.env', '.env.local'].map((m) => join(root, m)).concat(packageJsons(root)))].filter((f) => existsSync(f));
  const sig = files.map((f) => `${f}:${statSync(f).mtimeMs}`).join('|');
  const hit = cache.get(root);
  if (hit && hit.sig === sig) return hit.info;

  const libs: S3Info['libs'] = [];
  for (const f of packageJsons(root)) {
    try {
      const pkg = JSON.parse(read(f) ?? '{}') as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
      match(NODE, Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }), relative(root, f), libs);
    } catch {
      /* invalid JSON */
    }
  }
  const composer = read(join(root, 'composer.json'));
  if (composer) {
    try {
      const c = JSON.parse(composer) as { require?: Record<string, string>; 'require-dev'?: Record<string, string> };
      match(PHP, Object.keys({ ...c.require, ...c['require-dev'] }), 'composer.json', libs);
    } catch {
      /* invalid JSON */
    }
  }
  const goMod = read(join(root, 'go.mod'));
  if (goMod) match(GO, [...goMod.matchAll(/^\s*(?:require\s+)?([\w./-]+)\s+v\d/gm)].map((m) => m[1]), 'go.mod', libs);
  for (const f of ['requirements.txt', 'pyproject.toml', 'Pipfile']) {
    const text = read(join(root, f));
    if (text) match(PYTHON, [...text.matchAll(/^[\s"']*([A-Za-z][\w.-]*)(?=[\s\[<>=~!;,"']|$)/gm)].map((m) => m[1].toLowerCase()), f, libs);
  }

  const env = readEnvFiles(join(root, '.env'), join(root, '.env.local'));
  const endpoint = env.AWS_ENDPOINT || env.S3_ENDPOINT || env.AWS_ENDPOINT_URL_S3 || env.AWS_ENDPOINT_URL || env.MINIO_ENDPOINT || null;
  const bucket = env.AWS_BUCKET || env.S3_BUCKET || env.AWS_STORAGE_BUCKET_NAME || env.MINIO_BUCKET || null;
  const disk = env.FILESYSTEM_DISK || env.FILESYSTEM_DRIVER || null;
  const keys = Boolean(env.AWS_ACCESS_KEY_ID || env.S3_ACCESS_KEY || env.MINIO_ACCESS_KEY);
  const info: S3Info = {
    libs,
    // The Laravel s3 disk is used when it is the default disk or credentials are set.
    used: libs.length > 0 && (disk === 's3' || keys || Boolean(bucket) || Boolean(endpoint) || !composer),
    endpoint,
    bucket,
    disk,
  };
  cache.set(root, { sig, info });
  return info;
}

/** Does a .env endpoint point at a DevCatz storage service (its domain or its 127.0.0.1 port)? */
export function endpointMatches(endpoint: string | null, domain: string, port: number): boolean {
  if (!endpoint) return false;
  try {
    const u = new URL(endpoint.includes('://') ? endpoint : `http://${endpoint}`);
    return u.hostname === domain || ((u.hostname === '127.0.0.1' || u.hostname === 'localhost') && Number(u.port) === port);
  } catch {
    return false;
  }
}
