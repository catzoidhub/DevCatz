import { createSocket, type Socket } from 'node:dgram';

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
export const DNS_PORT = 53531;

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

export function answer(query: Buffer, tld: string): Buffer | null {
  if (query.length < 12) return null;
  const qdcount = query.readUInt16BE(4);
  if (qdcount !== 1) return null;
  const { name, end } = readName(query, 12);
  if (end + 4 > query.length) return null;
  const qtype = query.readUInt16BE(end);
  const question = query.subarray(12, end + 4);
  const ours = name === tld || name.endsWith(`.${tld}`);

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
    if (tld === 'localhost') return; // resolved by the OS and browsers
    const socket = createSocket('udp4');
    socket.on('message', (msg, rinfo) => {
      const reply = answer(msg, this.tld);
      if (reply) socket.send(reply, rinfo.port, rinfo.address);
    });
    await new Promise<void>((resolve) => {
      socket.once('error', (err) => {
        this.error = `DNS: ${(err as NodeJS.ErrnoException).code ?? err.message} on 127.0.0.1:${DNS_PORT}`;
        resolve();
      });
      socket.bind(DNS_PORT, '127.0.0.1', () => resolve());
    });
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
