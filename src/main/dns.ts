import { createSocket, type Socket } from 'node:dgram';
import { udpPortOwner } from './env';

/**
 * Tiny authoritative DNS server for the custom dev TLD (e.g. `.test`).
 *
 * macOS sends queries for `*.<tld>` here once /etc/resolver/<tld> says
 * `nameserver 127.0.0.1` + `port 53531` (installed with the admin prompt).
 * Every name under the TLD answers A 127.0.0.1 and AAAA ::1, so browsers use
 * the IPv6 loopback first, where the clean-URL forwarder hands them to the
 * proxy. `.localhost` needs none of this: the OS and browsers resolve it
 * themselves.
 */
// Windows: NRPT rules name a DNS server but no port, so DevCatz answers on 53 there (no rights needed to bind it) —
// on a loopback address of its own, out of the way of whatever else uses 127.0.0.1:53 or 0.0.0.0:53 (Internet
// Connection Sharing / Hyper-V, Docker, a local resolver). Windows routes all of 127.0.0.0/8 to loopback.
const WIN = process.platform === 'win32';
export const DNS_PORT = WIN ? 53 : 53531;
export const DNS_HOST = WIN ? '127.53.0.1' : '127.0.0.1';

/** Why the port could not be taken, in words: who has it and what to do (no admin rights needed to look). */
async function bindError(err: NodeJS.ErrnoException): Promise<string> {
  const at = `${DNS_HOST}:${DNS_PORT}`;
  const what = WIN ? '*.localhost and the default domain do not resolve outside browsers' : 'the default domain does not resolve';
  // Windows answers EACCES, not EADDRINUSE, when another program holds the port exclusively.
  const o = err.code === 'EADDRINUSE' || err.code === 'EACCES' ? await udpPortOwner(DNS_PORT).catch(() => null) : null;
  if (err.code === 'EADDRINUSE' || o) {
    if (!o) return `Port ${DNS_PORT} (${at}) is taken by another program, so ${what}. Close it, then Try again.`;
    const who = `${o.service ? `${o.service} (${o.name}, pid ${o.pid})` : `${o.name} (pid ${o.pid})`}`;
    const hint = /SharedAccess/i.test(o.service ?? '')
      ? 'It is Internet Connection Sharing (Mobile hotspot, Hyper-V\'s Default Switch): turn off Mobile hotspot, or stop "Internet Connection Sharing (ICS)" in Services'
      : /docker|vpnkit/i.test(o.name)
        ? 'Docker Desktop holds it: quit Docker Desktop'
        : 'Close that program';
    return `Port ${DNS_PORT} is taken by ${who} for every address, so ${what}. ${hint}, then Try again.`;
  }
  if (err.code === 'EACCES') return `${WIN ? 'Windows' : 'macOS'} refused ${at} to DevCatz (a firewall or security tool?), so ${what}.`;
  return `DNS: ${err.code ?? err.message} on ${at}`;
}

const TYPE_A = 1;
const TYPE_AAAA = 28;

function readName(msg: Buffer, offset: number): { name: string; end: number } {
  const labels: string[] = [];
  let i = offset;
  while (i < msg.length && msg[i] !== 0) {
    const len = msg[i];
    if ((len & 0xc0) === 0xc0) return { name: labels.join('.'), end: i + 2 }; // compression (not used in questions)
    labels.push(msg.subarray(i + 1, i + 1 + len).toString('ascii'));
    i += len + 1;
  }
  return { name: labels.join('.').toLowerCase(), end: i + 1 };
}

/** `zones`: the TLD, plus `localhost` on Windows (programs there do not resolve `x.localhost` by themselves). */
export function answer(query: Buffer, zones: string | string[]): Buffer | null {
  const list = Array.isArray(zones) ? zones : [zones];
  if (query.length < 12) return null;
  const qdcount = query.readUInt16BE(4);
  if (qdcount !== 1) return null;
  const { name, end } = readName(query, 12);
  if (end + 4 > query.length) return null;
  const qtype = query.readUInt16BE(end);
  const question = query.subarray(12, end + 4);
  const ours = list.some((z) => name === z || name.endsWith(`.${z}`));

  const records: Buffer[] = [];
  if (ours && (qtype === TYPE_A || qtype === 255)) records.push(rr(TYPE_A, Buffer.from([127, 0, 0, 1])));
  if (ours && (qtype === TYPE_AAAA || qtype === 255)) {
    const v6 = Buffer.alloc(16);
    v6[15] = 1;
    records.push(rr(TYPE_AAAA, v6));
  }
  const header = Buffer.alloc(12);
  header.writeUInt16BE(query.readUInt16BE(0), 0); // id
  // QR + AA + RD (copied) + RA; RCODE 3 (NXDOMAIN) for names outside the TLD.
  header.writeUInt16BE(0x8480 | (query.readUInt16BE(2) & 0x0100) | (ours ? 0 : 3), 2);
  header.writeUInt16BE(1, 4);
  header.writeUInt16BE(records.length, 6);
  return Buffer.concat([header, question, ...records]);
}

function rr(type: number, data: Buffer): Buffer {
  const b = Buffer.alloc(12);
  b.writeUInt16BE(0xc00c, 0); // pointer to the question name
  b.writeUInt16BE(type, 2);
  b.writeUInt16BE(1, 4); // IN
  b.writeUInt32BE(60, 6); // TTL
  b.writeUInt16BE(data.length, 10);
  return Buffer.concat([b, data]);
}

export class DnsServer {
  private socket: Socket | null = null;
  tld = '';
  error: string | null = null;

  async start(tld: string): Promise<void> {
    await this.stop();
    this.tld = tld;
    this.error = null;
    // macOS resolves .localhost itself; on Windows only browsers do, so DevCatz answers it there as well.
    const win = process.platform === 'win32';
    if (tld === 'localhost' && !win) return;
    const zones = win ? [...new Set([tld, 'localhost'])] : [tld];
    const socket = createSocket('udp4');
    socket.on('message', (msg, rinfo) => {
      const reply = answer(msg, zones);
      if (reply) socket.send(reply, rinfo.port, rinfo.address);
    });
    let failed: NodeJS.ErrnoException | null = null;
    await new Promise<void>((resolve) => {
      socket.once('error', (err) => {
        failed = err as NodeJS.ErrnoException;
        resolve();
      });
      socket.bind(DNS_PORT, DNS_HOST, () => resolve());
    });
    if (failed) this.error = await bindError(failed);
    if (!this.error) this.socket = socket;
  }

  async stop(): Promise<void> {
    const s = this.socket;
    this.socket = null;
    if (s) await new Promise<void>((resolve) => s.close(() => resolve()));
  }

  get running(): boolean {
    return this.socket !== null;
  }
}
