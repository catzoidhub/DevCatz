import { createServer, type Server, type Socket } from 'node:net';

/**
 * A tiny SMPP 3.4 SMSC that catches every SMS an SMS gateway (Jasmin) hands it,
 * like the mail catcher does for SMTP: binds are accepted (any system_id /
 * password), submit_sm is answered with a message id and the message is
 * reported to `onMessage`; enquire_link and unbind are answered. Nothing is
 * delivered anywhere.
 */

export interface CaughtSms {
  /** Our message id (given back in submit_sm_resp). */
  id: string;
  at: string;
  /** system_id of the client that bound (Jasmin's connector username). */
  systemId: string;
  from: string;
  to: string;
  text: string;
  /** SMPP data_coding: 0 GSM/ASCII, 8 UCS-2, 3 Latin-1 … */
  dataCoding: number;
  /** Parts of a long SMS joined (UDH concatenation), when present. */
  parts: number;
}

const CMD = {
  bind_receiver: 0x00000001,
  bind_transmitter: 0x00000002,
  submit_sm: 0x00000004,
  unbind: 0x00000006,
  bind_transceiver: 0x00000009,
  enquire_link: 0x00000015,
  generic_nack: 0x80000000,
} as const;
const RESP = 0x80000000;

/** Reads a NUL-terminated C-octet string at `o`; returns the value and the next offset. */
function cstr(b: Buffer, o: number): [string, number] {
  const end = b.indexOf(0, o);
  const e = end < 0 ? b.length : end;
  return [b.subarray(o, e).toString('latin1'), e + 1];
}

function pdu(command: number, status: number, seq: number, body: Buffer = Buffer.alloc(0)): Buffer {
  const head = Buffer.alloc(16);
  head.writeUInt32BE(16 + body.length, 0);
  head.writeUInt32BE(command >>> 0, 4);
  head.writeUInt32BE(status >>> 0, 8);
  head.writeUInt32BE(seq >>> 0, 12);
  return Buffer.concat([head, body]);
}
const cbuf = (s: string) => Buffer.concat([Buffer.from(s, 'latin1'), Buffer.from([0])]);

function decode(raw: Buffer, dataCoding: number): string {
  // Some clients (Jasmin's HTTP API with coding=8 and plain text) pass UTF-8 under the UCS-2 flag; UCS-2 of
  // Latin text always carries 0x00 bytes, so a NUL-free valid UTF-8 body is read as UTF-8.
  if (dataCoding === 8 && !raw.includes(0) && Buffer.from(raw.toString('utf8'), 'utf8').equals(raw)) return raw.toString('utf8');
  if (dataCoding === 8) {
    // UCS-2 big endian
    const le = Buffer.alloc(raw.length);
    for (let i = 0; i + 1 < raw.length; i += 2) {
      le[i] = raw[i + 1];
      le[i + 1] = raw[i];
    }
    return le.toString('utf16le');
  }
  return dataCoding === 3 ? raw.toString('latin1') : raw.toString('utf8');
}

export class SmppCatcher {
  private server: Server | null = null;
  private sockets = new Set<Socket>();
  private seq = 1;
  /** Long SMS parts waiting for the rest: ref → parts. */
  private pending = new Map<string, { total: number; parts: Map<number, string>; first: Omit<CaughtSms, 'text' | 'parts'> }>();

  constructor(private onMessage: (m: CaughtSms) => void) {}

  get listening(): boolean {
    return Boolean(this.server?.listening);
  }

  listen(port: number, host = '0.0.0.0'): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = createServer((socket) => this.session(socket));
      server.once('error', reject);
      server.listen(port, host, () => {
        server.off('error', reject);
        this.server = server;
        resolve();
      });
    });
  }

  /** Stops listening and drops bound clients (Jasmin keeps its session open, so close() alone would wait forever). */
  close(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
      this.server = null;
      for (const s of this.sockets) s.destroy();
      this.sockets.clear();
    });
  }

  private session(socket: Socket): void {
    let buf = Buffer.alloc(0);
    let systemId = '';
    this.sockets.add(socket);
    socket.on('close', () => this.sockets.delete(socket));
    socket.on('error', () => socket.destroy());
    socket.on('data', (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 16) {
        const len = buf.readUInt32BE(0);
        if (len < 16 || len > 65536) return socket.destroy();
        if (buf.length < len) break;
        const p = buf.subarray(0, len);
        buf = buf.subarray(len);
        const command = p.readUInt32BE(4);
        const seq = p.readUInt32BE(12);
        const body = p.subarray(16);
        if (command === CMD.bind_transceiver || command === CMD.bind_transmitter || command === CMD.bind_receiver) {
          [systemId] = cstr(body, 0);
          socket.write(pdu((command | RESP) >>> 0, 0, seq, cbuf('DevCatz')));
        } else if (command === CMD.enquire_link) {
          socket.write(pdu((command | RESP) >>> 0, 0, seq));
        } else if (command === CMD.unbind) {
          socket.write(pdu((command | RESP) >>> 0, 0, seq));
          socket.end();
        } else if (command === CMD.submit_sm) {
          const id = `${Date.now().toString(36)}${(this.seq++).toString(36)}`;
          try {
            this.submit(body, systemId, id);
          } catch {
            /* malformed: still acknowledged so the client does not retry forever */
          }
          socket.write(pdu((command | RESP) >>> 0, 0, seq, cbuf(id)));
        } else if (!(command & RESP)) {
          socket.write(pdu(CMD.generic_nack, 0x00000003, seq)); // ESME_RINVCMDID
        }
      }
    });
  }

  private submit(b: Buffer, systemId: string, id: string): void {
    let o = 0;
    let s: string;
    [s, o] = cstr(b, o); // service_type
    o += 2; // source_addr_ton, source_addr_npi
    const [from, o2] = cstr(b, o);
    o = o2 + 2; // dest_addr_ton, dest_addr_npi
    const [to, o3] = cstr(b, o);
    o = o3;
    const esmClass = b[o];
    o += 3; // esm_class, protocol_id, priority_flag
    [s, o] = cstr(b, o); // schedule_delivery_time
    [s, o] = cstr(b, o); // validity_period
    void s;
    o += 3; // registered_delivery, replace_if_present_flag, data_coding (read below)
    const dataCoding = b[o - 1];
    o += 1; // sm_default_msg_id
    const smLength = b[o];
    o += 1;
    let short = b.subarray(o, o + smLength);
    o += smLength;
    // message_payload TLV (0x0424) carries long texts when sm_length is 0.
    while (o + 4 <= b.length) {
      const tag = b.readUInt16BE(o);
      const len = b.readUInt16BE(o + 2);
      if (tag === 0x0424) short = b.subarray(o + 4, o + 4 + len);
      o += 4 + len;
    }
    const base = { id, at: new Date().toISOString(), systemId, from, to, dataCoding };
    // UDH concatenation (esm_class bit 0x40): IEI 0x00 (8-bit ref) or 0x08 (16-bit ref).
    if (esmClass & 0x40 && short.length > 1) {
      const udhl = short[0];
      const udh = short.subarray(1, 1 + udhl);
      const text = decode(short.subarray(1 + udhl), dataCoding);
      let ref: number | null = null;
      let total = 1;
      let part = 1;
      if (udh[0] === 0x00 && udh.length >= 5) [ref, total, part] = [udh[2], udh[3], udh[4]];
      else if (udh[0] === 0x08 && udh.length >= 6) [ref, total, part] = [udh.readUInt16BE(2), udh[4], udh[5]];
      if (ref !== null && total > 1) {
        const key = `${systemId}|${from}|${to}|${ref}`;
        const entry = this.pending.get(key) ?? { total, parts: new Map(), first: base };
        entry.parts.set(part, text);
        this.pending.set(key, entry);
        if (entry.parts.size < entry.total) return;
        this.pending.delete(key);
        const joined = [...entry.parts.entries()].sort((a, c) => a[0] - c[0]).map(([, t]) => t).join('');
        this.onMessage({ ...entry.first, text: joined, parts: entry.total });
        return;
      }
      this.onMessage({ ...base, text, parts: 1 });
      return;
    }
    this.onMessage({ ...base, text: decode(short, dataCoding), parts: 1 });
  }
}
