import { createServer, connect as netConnect, type Server, type Socket } from 'node:net';
import { connect as tlsConnect, type TLSSocket } from 'node:tls';

/**
 * A catch-all SMTP server (every mail is accepted and handed over, nothing is
 * relayed) and a small SMTP client used to forward one mail to a real inbox.
 */

export interface Envelope {
  from: string;
  to: string[];
  /** AUTH username, if the client logged in (sites put their name here). */
  username: string | null;
  remote: string;
}

export type OnMail = (raw: Buffer, envelope: Envelope) => Promise<string> | string;

const MAX_SIZE = 50 * 1024 * 1024;

export class SmtpCatcher {
  private server: Server | null = null;
  constructor(
    private host: string,
    private onMail: OnMail,
  ) {}

  listen(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = createServer((socket) => this.session(socket));
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        server.off('error', reject);
        this.server = server;
        resolve();
      });
    });
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
      this.server = null;
    });
  }

  get listening(): boolean {
    return Boolean(this.server?.listening);
  }

  private session(socket: Socket): void {
    const write = (line: string) => socket.writable && socket.write(`${line}\r\n`);
    let buffer = Buffer.alloc(0);
    let envelope: Envelope = { from: '', to: [], username: null, remote: socket.remoteAddress ?? '' };
    let inData = false;
    let authState: 'none' | 'user' | 'pass' = 'none';
    let data: Buffer[] = [];
    let dataSize = 0;
    socket.setTimeout(5 * 60_000, () => socket.destroy());
    socket.on('error', () => undefined);
    write(`220 ${this.host} DevCatz mail catcher ready`);

    const reset = () => {
      envelope = { ...envelope, from: '', to: [] };
      data = [];
      dataSize = 0;
    };

    const finishData = async () => {
      inData = false;
      // Dot-unstuffing: a leading ".." was ".".
      const raw = Buffer.from(Buffer.concat(data).toString('latin1').replace(/^\.\./gm, '.'), 'latin1');
      try {
        const id = await this.onMail(raw, envelope);
        write(`250 OK queued as ${id}`);
      } catch (e) {
        write(`451 ${(e as Error).message}`);
      }
      reset();
    };

    const command = (line: string) => {
      const [verb, ...rest] = line.split(' ');
      const arg = rest.join(' ');
      switch (verb.toUpperCase()) {
        case 'EHLO':
          write(`250-${this.host} Hello ${arg || 'there'}`);
          write(`250-SIZE ${MAX_SIZE}`);
          write('250-8BITMIME');
          write('250-SMTPUTF8');
          write('250-PIPELINING');
          write('250-ENHANCEDSTATUSCODES');
          write('250 AUTH PLAIN LOGIN');
          return;
        case 'HELO':
          write(`250 ${this.host}`);
          return;
        case 'STARTTLS':
          write('454 4.7.0 TLS not available: use MAIL_ENCRYPTION=null / no TLS for the catcher');
          return;
        case 'AUTH': {
          const [mech, initial] = arg.split(' ');
          if ((mech ?? '').toUpperCase() === 'PLAIN') {
            if (initial) {
              const parts = Buffer.from(initial, 'base64').toString('utf8').split('\0');
              envelope.username = parts[1] || parts[0] || null;
              write('235 2.7.0 Authentication successful');
            } else {
              authState = 'pass';
              write('334 ');
            }
          } else if ((mech ?? '').toUpperCase() === 'LOGIN') {
            authState = 'user';
            write(`334 ${Buffer.from('Username:').toString('base64')}`);
          } else write('504 5.5.4 Unrecognized authentication type');
          return;
        }
        case 'MAIL':
          envelope.from = arg.match(/<([^>]*)>/)?.[1] ?? arg.replace(/^FROM:\s*/i, '').split(' ')[0];
          write('250 2.1.0 OK');
          return;
        case 'RCPT':
          envelope.to.push(arg.match(/<([^>]*)>/)?.[1] ?? arg.replace(/^TO:\s*/i, '').split(' ')[0]);
          write('250 2.1.5 OK');
          return;
        case 'DATA':
          if (!envelope.to.length) return write('503 5.5.1 RCPT TO first');
          inData = true;
          write('354 End data with <CR><LF>.<CR><LF>');
          return;
        case 'RSET':
          reset();
          write('250 2.0.0 OK');
          return;
        case 'NOOP':
          write('250 2.0.0 OK');
          return;
        case 'VRFY':
          write('252 2.1.5 Cannot verify, but will try');
          return;
        case 'QUIT':
          write('221 2.0.0 Bye');
          socket.end();
          return;
        default:
          write('500 5.5.1 Command not recognized');
      }
    };

    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (true) {
        if (inData) {
          const end = buffer.indexOf('\r\n.\r\n');
          const startsWithDot = buffer.length >= 3 && buffer.subarray(0, 3).toString() === '.\r\n';
          if (startsWithDot) {
            buffer = buffer.subarray(3);
            void finishData();
            continue;
          }
          if (end < 0) {
            // Keep everything but a possible partial terminator.
            const keep = Math.min(buffer.length, 4);
            if (buffer.length > keep) {
              data.push(buffer.subarray(0, buffer.length - keep));
              dataSize += buffer.length - keep;
              buffer = buffer.subarray(buffer.length - keep);
            }
            if (dataSize > MAX_SIZE) {
              write('552 5.3.4 Message too big');
              socket.destroy();
            }
            return;
          }
          data.push(buffer.subarray(0, end + 2));
          buffer = buffer.subarray(end + 5);
          void finishData();
          continue;
        }
        const nl = buffer.indexOf('\r\n');
        if (nl < 0) return;
        const line = buffer.subarray(0, nl).toString('utf8');
        buffer = buffer.subarray(nl + 2);
        if (authState === 'user') {
          envelope.username = Buffer.from(line, 'base64').toString('utf8') || null;
          authState = 'pass';
          write(`334 ${Buffer.from('Password:').toString('base64')}`);
        } else if (authState === 'pass') {
          if (!envelope.username) {
            const parts = Buffer.from(line, 'base64').toString('utf8').split('\0');
            envelope.username = parts[1] || parts[0] || null;
          }
          authState = 'none';
          write('235 2.7.0 Authentication successful');
        } else command(line);
      }
    });
  }
}

// ------------------------------------------------------------ client (forwarding, test mails)

export interface SendOptions {
  host: string;
  port: number;
  security: 'tls' | 'starttls' | 'none';
  username?: string;
  password?: string;
  from: string;
  to: string[];
  raw: Buffer;
  timeoutMs?: number;
}

/** Sends one message (raw RFC 822) through an SMTP server; throws with the server's reply on failure. */
export async function sendMail(o: SendOptions): Promise<string> {
  let socket: Socket | TLSSocket = o.security === 'tls' ? tlsConnect({ host: o.host, port: o.port, servername: o.host }) : netConnect({ host: o.host, port: o.port });
  const timeout = o.timeoutMs ?? 30_000;
  let buf = '';
  let waiter: { resolve: (s: string) => void; reject: (e: Error) => void } | null = null;
  const attach = (s: Socket) => {
    s.setTimeout(timeout, () => s.destroy(new Error('SMTP timeout')));
    s.on('data', (d: Buffer) => {
      buf += d.toString('utf8');
      // A reply is complete when its last line has a space after the code.
      const lines = buf.split('\r\n');
      const complete = lines.length > 1 && /^\d{3} /.test(lines[lines.length - 2]);
      if (complete && waiter) {
        const reply = buf;
        buf = '';
        const w = waiter;
        waiter = null;
        w.resolve(reply);
      }
    });
    s.on('error', (e) => waiter?.reject(e));
    s.on('close', () => waiter?.reject(new Error('Connection closed by the server')));
  };
  attach(socket);
  const read = () => new Promise<string>((resolve, reject) => (waiter = { resolve, reject }));
  const expect = (reply: string, ok: RegExp, what: string) => {
    if (!ok.test(reply)) throw new Error(`${what}: ${reply.trim().split('\r\n').pop()}`);
  };
  const cmd = async (line: string, ok: RegExp, what = line.split(' ')[0]) => {
    socket.write(`${line}\r\n`);
    const r = await read();
    expect(r, ok, what);
    return r;
  };
  try {
    expect(await read(), /^220/, 'Greeting');
    const hello = async () => cmd('EHLO devcatz.local', /^250/, 'EHLO');
    let ehlo = await hello();
    if (o.security === 'starttls') {
      if (!/STARTTLS/i.test(ehlo)) throw new Error('The server does not offer STARTTLS');
      await cmd('STARTTLS', /^220/);
      const plain = socket;
      socket = tlsConnect({ socket: plain, servername: o.host });
      await new Promise<void>((resolve, reject) => {
        (socket as TLSSocket).once('secureConnect', resolve);
        (socket as TLSSocket).once('error', reject);
      });
      plain.removeAllListeners('data');
      attach(socket);
      ehlo = await hello();
    }
    if (o.username) {
      if (/AUTH[^\r\n]*PLAIN/i.test(ehlo)) {
        await cmd(`AUTH PLAIN ${Buffer.from(`\0${o.username}\0${o.password ?? ''}`).toString('base64')}`, /^235/, 'AUTH');
      } else {
        await cmd('AUTH LOGIN', /^334/);
        await cmd(Buffer.from(o.username).toString('base64'), /^334/, 'AUTH');
        await cmd(Buffer.from(o.password ?? '').toString('base64'), /^235/, 'AUTH');
      }
    }
    await cmd(`MAIL FROM:<${o.from}>`, /^250/);
    for (const t of o.to) await cmd(`RCPT TO:<${t}>`, /^25[01]/);
    await cmd('DATA', /^354/);
    const body = o.raw.toString('latin1').replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..');
    socket.write(Buffer.from(body.endsWith('\r\n') ? body : `${body}\r\n`, 'latin1'));
    const done = await cmd('.', /^250/, 'DATA');
    socket.write('QUIT\r\n');
    return done.trim();
  } finally {
    socket.destroy();
  }
}
