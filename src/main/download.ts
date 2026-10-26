import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/** Expected SHA-256 for `file` from a `SHASUMS256.txt` (`<hash>  <file>` lines). */
export async function checksumFor(sumsUrl: string, file: string): Promise<string> {
  const res = await fetch(sumsUrl);
  if (!res.ok) throw new Error(`Checksums: HTTP ${res.status}`);
  const line = (await res.text()).split('\n').find((l) => l.trim().endsWith(` ${file}`) || l.trim().endsWith(`*${file}`));
  const hash = line?.trim().split(/\s+/)[0];
  if (!hash) throw new Error(`No checksum for ${file}`);
  return hash.toLowerCase();
}

/**
 * Streams `url` to `dest`, hashing as it goes; throws (and the caller deletes
 * the temp folder) when the SHA-256 does not match, so nothing unverified is
 * ever unpacked. `expectedSha256 = ''` (no upstream checksum) only records it:
 * the hex digest is returned either way. `algo` picks the hash (named sha256 for history).
 */
export async function downloadVerified(
  url: string,
  dest: string,
  expectedSha256: string,
  progress: (received: number, total: number) => void,
  headers?: Record<string, string>,
  signal?: AbortSignal,
  algo: 'sha256' | 'sha512' | 'md5' = 'sha256',
): Promise<string> {
  const res = await fetch(url, { headers, signal });
  if (!res.ok || !res.body) throw new Error(`Download failed: HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length')) || 0;
  const hash = createHash(algo);
  let received = 0;
  let last = 0;
  const body = Readable.fromWeb(res.body as import('node:stream/web').ReadableStream);
  body.on('data', (chunk: Buffer) => {
    hash.update(chunk);
    received += chunk.length;
    if (Date.now() - last > 150) {
      last = Date.now();
      progress(received, total);
    }
  });
  await pipeline(body, createWriteStream(dest), { signal });
  progress(received, total);
  const digest = hash.digest('hex');
  if (expectedSha256 && digest !== expectedSha256) throw new Error('Checksum mismatch, download discarded');
  return digest;
}
