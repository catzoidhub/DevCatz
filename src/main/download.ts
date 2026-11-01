import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { currentSignal } from './cancel';

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
  // Inside a cancellable install, Cancel stops the download.
  signal ??= currentSignal();
  // A connection that stops sending (it happens on GitHub's CDN) would otherwise wait forever: no byte for a minute
  // ends the download with a message to try again. Cancel still works through the same controller.
  const stall = new AbortController();
  const both = signal ? AbortSignal.any([signal, stall.signal]) : stall.signal;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  const kick = () => {
    clearTimeout(watchdog);
    watchdog = setTimeout(() => stall.abort(), STALL_MS);
  };
  kick();
  let received = 0;
  try {
    // Never from or into the HTTP cache: a cached copy Windows Defender quarantined fails as ERR_CACHE_READ_FAILURE.
    const res = await fetch(url, { headers, signal: both, cache: 'no-store' });
    if (!res.ok || !res.body) throw new Error(`Download failed: HTTP ${res.status}`);
    const total = Number(res.headers.get('content-length')) || 0;
    const hash = createHash(algo);
    let last = 0;
    const body = Readable.fromWeb(res.body as import('node:stream/web').ReadableStream);
    body.on('data', (chunk: Buffer) => {
      kick();
      hash.update(chunk);
      received += chunk.length;
      if (Date.now() - last > 150) {
        last = Date.now();
        progress(received, total);
      }
    });
    await pipeline(body, createWriteStream(dest), { signal: both });
    progress(received, total);
    const digest = hash.digest('hex');
    if (expectedSha256 && digest !== expectedSha256) throw new Error('Checksum mismatch, download discarded');
    return digest;
  } catch (e) {
    if (stall.signal.aborted && !signal?.aborted) throw new Error(`The download stopped receiving data (${(received / 1048576).toFixed(1)} MB in); check the connection and try again`);
    throw e;
  } finally {
    clearTimeout(watchdog);
  }
}

/** No data for this long ends a download (the connection hung). */
const STALL_MS = 60_000;
