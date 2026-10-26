import type { MailAddress } from '@shared/types';

/**
 * A small MIME reader for caught development mail: headers (RFC 2047 words),
 * nested multipart bodies, base64 / quoted-printable, the usual charsets.
 * Enough for what Laravel, Nodemailer, Django, Go and Python send.
 */

export interface MimePart {
  headers: Map<string, string>;
  contentType: string;
  params: Record<string, string>;
  disposition: string;
  dispositionParams: Record<string, string>;
  cid: string | null;
  body: Buffer;
  parts: MimePart[];
}

export interface ParsedMail {
  headers: { name: string; value: string }[];
  subject: string;
  from: MailAddress | null;
  to: MailAddress[];
  cc: MailAddress[];
  date: string | null;
  text: string | null;
  html: string | null;
  attachments: { filename: string; contentType: string; data: Buffer; cid: string | null; inline: boolean }[];
}

const CRLF = /\r?\n/;

function decodeCharset(buf: Buffer, charset: string | undefined): string {
  const cs = (charset ?? 'utf-8').toLowerCase().replace(/^"|"$/g, '');
  try {
    return new TextDecoder(cs === 'us-ascii' || cs === 'ascii' ? 'utf-8' : cs).decode(buf);
  } catch {
    return buf.toString('utf8');
  }
}

/** RFC 2047 encoded words in header values: =?utf-8?B?…?= / =?iso-8859-1?Q?…?= */
export function decodeWords(value: string): string {
  return value
    .replace(/(=\?[^?]+\?[BbQq]\?[^?]*\?=)\s+(?==\?)/g, '$1')
    .replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_, cs: string, enc: string, text: string) => {
      const bytes = enc.toUpperCase() === 'B' ? Buffer.from(text, 'base64') : Buffer.from(text.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16))), 'latin1');
      return decodeCharset(bytes, cs);
    });
}

function decodeQp(text: string): Buffer {
  const out: number[] = [];
  const s = text.replace(/=\r?\n/g, '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '=' && /^[0-9A-Fa-f]{2}$/.test(s.slice(i + 1, i + 3))) {
      out.push(parseInt(s.slice(i + 1, i + 3), 16));
      i += 2;
    } else out.push(s.charCodeAt(i) & 0xff);
  }
  return Buffer.from(out);
}

function decodeBody(raw: Buffer, encoding: string): Buffer {
  const e = encoding.toLowerCase().trim();
  if (e === 'base64') return Buffer.from(raw.toString('latin1').replace(/[^A-Za-z0-9+/=]/g, ''), 'base64');
  if (e === 'quoted-printable') return decodeQp(raw.toString('latin1'));
  return raw;
}

/** `text/html; charset="utf-8"; name=x` → type + params. */
function parseParams(value: string): { main: string; params: Record<string, string> } {
  const [main, ...rest] = value.split(';');
  const params: Record<string, string> = {};
  const cont: Record<string, string[]> = {};
  for (const r of rest) {
    const m = r.match(/^\s*([^=]+?)(\*(\d+))?(\*)?=\s*(.*?)\s*$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    let v = m[5].replace(/^"|"$/g, '');
    if (m[4]) {
      // RFC 2231: charset'lang'percent-encoded
      const parts = v.split("'");
      if (parts.length >= 3) v = decodeCharset(Buffer.from(parts.slice(2).join("'").replace(/%([0-9A-Fa-f]{2})/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16))), 'latin1'), parts[0]);
    }
    if (m[3] !== undefined) (cont[key] ??= [])[Number(m[3])] = v;
    else params[key] = decodeWords(v);
  }
  for (const [k, v] of Object.entries(cont)) params[k] = v.join('');
  return { main: main.trim().toLowerCase(), params };
}

function splitHeaders(raw: Buffer): { headers: Map<string, string>; list: { name: string; value: string }[]; body: Buffer } {
  const text = raw.toString('latin1');
  let end = text.search(/\r?\n\r?\n/);
  let bodyStart: number;
  if (end < 0) {
    end = text.length;
    bodyStart = text.length;
  } else bodyStart = end + (text.slice(end, end + 4) === '\r\n\r\n' ? 4 : 2);
  const headerText = text.slice(0, end).replace(/\r?\n[ \t]+/g, ' ');
  const headers = new Map<string, string>();
  const list: { name: string; value: string }[] = [];
  for (const line of headerText.split(CRLF)) {
    const i = line.indexOf(':');
    if (i <= 0) continue;
    const name = line.slice(0, i).trim();
    const value = decodeWords(Buffer.from(line.slice(i + 1).trim(), 'latin1').toString('utf8'));
    list.push({ name, value });
    if (!headers.has(name.toLowerCase())) headers.set(name.toLowerCase(), value);
  }
  return { headers, list, body: raw.subarray(Buffer.byteLength(text.slice(0, bodyStart), 'latin1')) };
}

function parsePart(raw: Buffer, depth = 0): MimePart {
  const { headers, body } = splitHeaders(raw);
  const ct = parseParams(headers.get('content-type') ?? 'text/plain; charset=us-ascii');
  const cd = parseParams(headers.get('content-disposition') ?? '');
  const part: MimePart = {
    headers,
    contentType: ct.main,
    params: ct.params,
    disposition: cd.main,
    dispositionParams: cd.params,
    cid: headers.get('content-id')?.replace(/^<|>$/g, '') ?? null,
    body: Buffer.alloc(0),
    parts: [],
  };
  if (ct.main.startsWith('multipart/') && ct.params.boundary && depth < 10) {
    const boundary = `--${ct.params.boundary}`;
    const text = body.toString('latin1');
    const chunks = text.split(new RegExp(`(?:^|\\r?\\n)${boundary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=--|\\r?\\n|$)`));
    // chunks[0] = preamble; the last one after `--` is the epilogue.
    for (const c of chunks.slice(1)) {
      if (c.startsWith('--')) break;
      const sub = c.replace(/^\r?\n/, '');
      part.parts.push(parsePart(Buffer.from(sub, 'latin1'), depth + 1));
    }
  } else if (ct.main === 'message/rfc822' && depth < 10) {
    part.parts.push(parsePart(decodeBody(body, headers.get('content-transfer-encoding') ?? '7bit'), depth + 1));
  } else part.body = decodeBody(body, headers.get('content-transfer-encoding') ?? '7bit');
  return part;
}

export function parseAddresses(value: string | undefined): MailAddress[] {
  if (!value) return [];
  const out: MailAddress[] = [];
  // Split on commas outside quotes and angle brackets.
  let depth = 0;
  let quoted = false;
  let cur = '';
  const items: string[] = [];
  for (const ch of value) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && ch === '<') depth++;
    else if (!quoted && ch === '>') depth--;
    if (ch === ',' && !quoted && depth <= 0) {
      items.push(cur);
      cur = '';
    } else cur += ch;
  }
  items.push(cur);
  for (const item of items) {
    const s = item.trim();
    if (!s) continue;
    const m = s.match(/^(.*?)\s*<([^>]+)>\s*$/);
    if (m) out.push({ name: m[1].trim().replace(/^"|"$/g, ''), address: m[2].trim() });
    else out.push({ name: '', address: s.replace(/^"|"$/g, '') });
  }
  return out;
}

export function parseMail(raw: Buffer): ParsedMail {
  const { headers, list } = splitHeaders(raw);
  const root = parsePart(raw);
  let text: string | null = null;
  let html: string | null = null;
  const attachments: ParsedMail['attachments'] = [];
  const walk = (p: MimePart, inAlternative: boolean) => {
    if (p.contentType.startsWith('multipart/')) {
      for (const c of p.parts) walk(c, p.contentType === 'multipart/alternative');
      return;
    }
    if (p.contentType === 'message/rfc822') {
      for (const c of p.parts) walk(c, false);
      return;
    }
    const filename = p.dispositionParams.filename ?? p.params.name ?? '';
    const isAttachment = p.disposition === 'attachment' || (filename && !p.cid && !p.contentType.startsWith('text/'));
    if (!isAttachment && p.contentType === 'text/plain' && (text === null || !inAlternative)) {
      const t = decodeCharset(p.body, p.params.charset);
      text = text === null ? t : `${text}\n${t}`;
    } else if (!isAttachment && p.contentType === 'text/html' && html === null) {
      html = decodeCharset(p.body, p.params.charset);
    } else {
      attachments.push({
        filename: filename || `${p.contentType.replace('/', '.')}`,
        contentType: p.contentType,
        data: p.body,
        cid: p.cid,
        inline: Boolean(p.cid) || p.disposition === 'inline',
      });
    }
  };
  walk(root, false);
  const from = parseAddresses(headers.get('from'))[0] ?? null;
  return {
    headers: list,
    subject: headers.get('subject') ?? '',
    from,
    to: parseAddresses(headers.get('to')),
    cc: parseAddresses(headers.get('cc')),
    date: headers.get('date') ?? null,
    text,
    html,
    attachments,
  };
}

/** Plain text of a mail for the list snippet / search (HTML stripped). */
export function snippetOf(m: ParsedMail, max = 160): string {
  const src = m.text ?? (m.html ? m.html.replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, '').replace(/<[^>]+>/g, ' ') : '');
  return src
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}
