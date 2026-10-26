import { connect } from 'node:net';
import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * Minimal FastCGI client (the part of nginx's fastcgi_pass that a PHP-FPM
 * site needs): one request per connection, request body streamed as STDIN,
 * response headers parsed from STDOUT and the body streamed to the browser.
 */
const VERSION = 1;
const BEGIN_REQUEST = 1;
const END_REQUEST = 3;
const PARAMS = 4;
const STDIN = 5;
const STDOUT = 6;
const STDERR = 7;
const RESPONDER = 1;
const MAX = 0xffff;

function record(type: number, body: Buffer = Buffer.alloc(0), id = 1): Buffer {
  const padding = (8 - (body.length % 8)) % 8;
  const header = Buffer.alloc(8);
  header[0] = VERSION;
  header[1] = type;
  header.writeUInt16BE(id, 2);
  header.writeUInt16BE(body.length, 4);
  header[6] = padding;
  return Buffer.concat([header, body, Buffer.alloc(padding)]);
}

function lengthBytes(n: number): Buffer {
  if (n < 128) return Buffer.from([n]);
  const b = Buffer.alloc(4);
  b.writeUInt32BE((n | 0x80000000) >>> 0);
  return b;
}

function encodeParams(params: Record<string, string>): Buffer[] {
  const pairs = Object.entries(params).map(([k, v]) => {
    const name = Buffer.from(k);
    const value = Buffer.from(v);
    return Buffer.concat([lengthBytes(name.length), lengthBytes(value.length), name, value]);
  });
  const all = Buffer.concat(pairs);
  const records: Buffer[] = [];
  for (let i = 0; i < all.length; i += MAX) records.push(record(PARAMS, all.subarray(i, i + MAX)));
  records.push(record(PARAMS));
  return records;
}

export interface FastCgiOptions {
  socketPath: string;
  params: Record<string, string>;
  req: IncomingMessage;
  res: ServerResponse;
  onStderr?: (text: string) => void;
  timeoutMs?: number;
}

/** Runs one request against PHP-FPM; resolves when the response is complete. */
export function fastcgi({ socketPath, params, req, res, onStderr, timeoutMs = 300_000 }: FastCgiOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    let buf = Buffer.alloc(0);
    let headerBuf = Buffer.alloc(0);
    let headersSent = false;
    let finished = false;

    const finish = (err?: Error) => {
      if (finished) return;
      finished = true;
      socket.destroy();
      if (err) {
        if (!res.headersSent) reject(err);
        else {
          res.end();
          resolve();
        }
        return;
      }
      if (!headersSent) writeHead(); // empty body
      res.end();
      resolve();
    };

    const writeHead = () => {
      headersSent = true;
      const text = headerBuf.toString('latin1');
      let status = 200;
      let statusText: string | undefined;
      const headers: Record<string, string | string[]> = {};
      for (const line of text.split(/\r?\n/)) {
        const i = line.indexOf(':');
        if (i <= 0) continue;
        const key = line.slice(0, i).trim();
        const value = line.slice(i + 1).trim();
        if (key.toLowerCase() === 'status') {
          status = Number(value.slice(0, 3)) || 200;
          statusText = value.slice(4) || undefined;
        } else {
          const lk = key.toLowerCase();
          const prev = headers[lk];
          headers[lk] = prev === undefined ? value : Array.isArray(prev) ? [...prev, value] : [prev, value];
        }
      }
      if (headers.location && status === 200) status = 302;
      res.writeHead(status, statusText, headers);
    };

    const onStdout = (chunk: Buffer) => {
      if (headersSent) {
        res.write(chunk);
        return;
      }
      headerBuf = Buffer.concat([headerBuf, chunk]);
      let end = headerBuf.indexOf('\r\n\r\n');
      let skip = 4;
      if (end < 0) {
        end = headerBuf.indexOf('\n\n');
        skip = 2;
      }
      if (end < 0) return;
      const rest = headerBuf.subarray(end + skip);
      headerBuf = headerBuf.subarray(0, end);
      writeHead();
      if (rest.length) res.write(rest);
    };

    socket.setTimeout(timeoutMs, () => finish(new Error('PHP-FPM timed out')));
    socket.on('error', (e) => finish(e));
    socket.on('close', () => finish());
    socket.on('data', (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 8) {
        const type = buf[1];
        const len = buf.readUInt16BE(4);
        const pad = buf[6];
        if (buf.length < 8 + len + pad) break;
        const body = buf.subarray(8, 8 + len);
        buf = buf.subarray(8 + len + pad);
        if (type === STDOUT && len) onStdout(Buffer.from(body));
        else if (type === STDERR && len) onStderr?.(body.toString('utf8'));
        else if (type === END_REQUEST) return finish();
      }
    });
    socket.on('connect', () => {
      const begin = Buffer.alloc(8);
      begin.writeUInt16BE(RESPONDER, 0);
      socket.write(record(BEGIN_REQUEST, begin));
      for (const r of encodeParams(params)) socket.write(r);
      req.on('data', (chunk: Buffer) => {
        for (let i = 0; i < chunk.length; i += MAX) socket.write(record(STDIN, chunk.subarray(i, i + MAX)));
      });
      req.on('end', () => socket.write(record(STDIN)));
      req.on('error', (e) => finish(e));
      if (req.readableEnded) socket.write(record(STDIN));
    });
    res.on('close', () => {
      if (!finished) finish();
    });
  });
}
