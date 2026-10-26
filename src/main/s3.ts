import { createHash, createHmac } from 'node:crypto';
import { createReadStream, createWriteStream, statSync } from 'node:fs';
import { request } from 'node:http';
import { pipeline } from 'node:stream/promises';
import type { S3Bucket, S3Entry } from '@shared/types';

/**
 * Minimal S3 client (AWS Signature V4) for the local object storage services:
 * buckets, listing, upload/download, delete and the public-read policy. It
 * talks to http://127.0.0.1:<apiPort> directly (path-style), no SDK needed.
 */
export interface S3Target {
  port: number;
  accessKey: string;
  secretKey: string;
  region?: string;
}

const EMPTY_SHA = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const enc = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const encPath = (p: string) => p.split('/').map(enc).join('/');
const hmac = (key: Buffer | string, data: string) => createHmac('sha256', key).update(data).digest();
const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');

interface Req {
  method: string;
  path: string;
  query?: Record<string, string>;
  headers?: Record<string, string>;
  body?: Buffer | string;
  /** Streamed body (uploads): sent with UNSIGNED-PAYLOAD. */
  file?: { path: string; size: number };
  /** Bytes of `file` sent so far. */
  onSent?: (bytes: number) => void;
  signal?: AbortSignal;
}

function sign(t: S3Target, r: Req): { path: string; headers: Record<string, string> } {
  const region = t.region ?? 'us-east-1';
  const host = `127.0.0.1:${t.port}`;
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const day = amzDate.slice(0, 8);
  const payloadHash = r.file ? 'UNSIGNED-PAYLOAD' : r.body ? sha256(r.body) : EMPTY_SHA;
  const headers: Record<string, string> = { host, 'x-amz-date': amzDate, 'x-amz-content-sha256': payloadHash, ...(r.headers ?? {}) };
  const canonicalPath = encPath(r.path);
  const q = Object.entries(r.query ?? {})
    .map(([k, v]) => [enc(k), enc(v)] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const names = Object.keys(headers)
    .map((h) => h.toLowerCase())
    .sort();
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v).trim()]));
  const canonical = [r.method, canonicalPath, q, names.map((n) => `${n}:${lower[n]}\n`).join(''), names.join(';'), payloadHash].join('\n');
  const scope = `${day}/${region}/s3/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n');
  const key = hmac(hmac(hmac(hmac(`AWS4${t.secretKey}`, day), region), 's3'), 'aws4_request');
  const signature = createHmac('sha256', key).update(toSign).digest('hex');
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${t.accessKey}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`;
  return { path: canonicalPath + (q ? `?${q}` : ''), headers };
}

interface Res {
  status: number;
  body: string;
}

function send(t: S3Target, r: Req): Promise<Res> {
  const { path, headers } = sign(t, r);
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: t.port, method: r.method, path, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.setTimeout(60_000, () => req.destroy(new Error('S3 request timed out')));
    const abort = () => req.destroy(new Error('Cancelled'));
    if (r.signal?.aborted) return abort();
    r.signal?.addEventListener('abort', abort, { once: true });
    req.on('close', () => r.signal?.removeEventListener('abort', abort));
    if (r.file) {
      const stream = createReadStream(r.file.path);
      let sent = 0;
      stream.on('data', (c) => r.onSent?.((sent += c.length)));
      stream.on('error', reject);
      stream.pipe(req);
    } else req.end(r.body);
  });
}

const tag = (xml: string, name: string) => xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))?.[1] ?? '';
const all = (xml: string, name: string) => [...xml.matchAll(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, 'g'))].map((m) => m[1]);
const unxml = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

async function ok(t: S3Target, r: Req, allow: number[] = []): Promise<Res> {
  const res = await send(t, r);
  if (res.status >= 300 && !allow.includes(res.status)) {
    const code = tag(res.body, 'Code');
    const msg = tag(res.body, 'Message');
    throw new Error(code ? `${code}: ${unxml(msg)}` : `S3 ${r.method} ${r.path}: HTTP ${res.status}`);
  }
  return res;
}

const publicPolicy = (bucket: string) =>
  JSON.stringify({
    Version: '2012-10-17',
    Statement: [{ Effect: 'Allow', Principal: { AWS: ['*'] }, Action: ['s3:GetObject'], Resource: [`arn:aws:s3:::${bucket}/*`] }],
  });

export async function isPublic(t: S3Target, bucket: string): Promise<boolean> {
  const res = await send(t, { method: 'GET', path: `/${bucket}`, query: { policy: '' } });
  return res.status === 200 && res.body.includes('s3:GetObject') && /"\*"/.test(res.body);
}

export async function listBuckets(t: S3Target): Promise<S3Bucket[]> {
  const res = await ok(t, { method: 'GET', path: '/' });
  const buckets = all(res.body, 'Bucket').map((b) => ({ name: unxml(tag(b, 'Name')), created: tag(b, 'CreationDate'), public: false }));
  await Promise.all(buckets.map(async (b) => (b.public = await isPublic(t, b.name).catch(() => false))));
  return buckets.sort((a, b) => a.name.localeCompare(b.name));
}

export async function createBucket(t: S3Target, bucket: string): Promise<void> {
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) throw new Error('Bucket names: 3–63 characters, lowercase letters, digits, dots and hyphens');
  await ok(t, { method: 'PUT', path: `/${bucket}` });
}

/** Every object key under `prefix` (all pages). */
async function allKeys(t: S3Target, bucket: string, prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let token = '';
  do {
    const query: Record<string, string> = { 'list-type': '2', prefix, 'max-keys': '1000' };
    if (token) query['continuation-token'] = token;
    const res = await ok(t, { method: 'GET', path: `/${bucket}`, query });
    keys.push(...all(res.body, 'Contents').map((c) => unxml(tag(c, 'Key'))));
    token = tag(res.body, 'IsTruncated') === 'true' ? unxml(tag(res.body, 'NextContinuationToken')) : '';
  } while (token);
  return keys;
}

export async function deleteBucket(t: S3Target, bucket: string): Promise<void> {
  for (const key of await allKeys(t, bucket, '')) await ok(t, { method: 'DELETE', path: `/${bucket}/${key}` }, [404]);
  await ok(t, { method: 'DELETE', path: `/${bucket}` });
}

export async function setPublic(t: S3Target, bucket: string, on: boolean): Promise<void> {
  if (on) await ok(t, { method: 'PUT', path: `/${bucket}`, query: { policy: '' }, body: publicPolicy(bucket), headers: { 'content-type': 'application/json' } });
  else await ok(t, { method: 'DELETE', path: `/${bucket}`, query: { policy: '' } }, [404]);
}

/** One level of a bucket: folders (common prefixes) first, then objects. */
export async function list(t: S3Target, bucket: string, prefix: string): Promise<S3Entry[]> {
  const out: S3Entry[] = [];
  let token = '';
  do {
    const query: Record<string, string> = { 'list-type': '2', prefix, delimiter: '/', 'max-keys': '1000' };
    if (token) query['continuation-token'] = token;
    const res = await ok(t, { method: 'GET', path: `/${bucket}`, query });
    for (const p of all(res.body, 'CommonPrefixes')) out.push({ key: unxml(tag(p, 'Prefix')), folder: true, size: 0, modified: null });
    for (const c of all(res.body, 'Contents')) {
      const key = unxml(tag(c, 'Key'));
      if (key === prefix) continue; // the folder marker itself
      out.push({ key, folder: false, size: Number(tag(c, 'Size')) || 0, modified: tag(c, 'LastModified') || null });
    }
    token = tag(res.body, 'IsTruncated') === 'true' ? unxml(tag(res.body, 'NextContinuationToken')) : '';
  } while (token && out.length < 5000);
  const seen = new Set<string>();
  return out
    .filter((e) => (seen.has(e.key) ? false : (seen.add(e.key), true)))
    .sort((a, b) => Number(b.folder) - Number(a.folder) || a.key.localeCompare(b.key));
}

const MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', avif: 'image/avif',
  pdf: 'application/pdf', json: 'application/json', txt: 'text/plain', csv: 'text/csv', html: 'text/html', css: 'text/css', js: 'text/javascript',
  mp4: 'video/mp4', webm: 'video/webm', mp3: 'audio/mpeg', zip: 'application/zip', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

export async function upload(t: S3Target, bucket: string, key: string, file: string, onSent?: (bytes: number) => void, signal?: AbortSignal): Promise<void> {
  const size = statSync(file).size;
  const ext = file.split('.').pop()?.toLowerCase() ?? '';
  await ok(t, {
    method: 'PUT',
    path: `/${bucket}/${key}`,
    headers: { 'content-length': String(size), 'content-type': MIME[ext] ?? 'application/octet-stream' },
    file: { path: file, size },
    onSent,
    signal,
  });
}

export async function mkdir(t: S3Target, bucket: string, prefix: string): Promise<void> {
  await ok(t, { method: 'PUT', path: `/${bucket}/${prefix.replace(/\/?$/, '/')}`, body: '' });
}

export async function download(t: S3Target, bucket: string, key: string, dest: string): Promise<void> {
  const { path, headers } = sign(t, { method: 'GET', path: `/${bucket}/${key}` });
  await new Promise<void>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: t.port, method: 'GET', path, headers }, (res) => {
      if ((res.statusCode ?? 0) >= 300) {
        res.resume();
        return reject(new Error(`Download failed: HTTP ${res.statusCode}`));
      }
      pipeline(res, createWriteStream(dest)).then(resolve, reject);
    });
    req.on('error', reject);
    req.end();
  });
}

/** One object, or a whole folder when `key` ends with `/`. */
export async function remove(t: S3Target, bucket: string, key: string): Promise<void> {
  const keys = key.endsWith('/') ? await allKeys(t, bucket, key) : [key];
  if (key.endsWith('/') && !keys.includes(key)) keys.push(key);
  for (const k of keys) await ok(t, { method: 'DELETE', path: `/${bucket}/${k}` }, [404]);
}
