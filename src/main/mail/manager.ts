import { safeStorage } from 'electron';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MailAttachment, MailForwardConfig, MailMessage, MailState, MailSummary, ProjectConfig } from '@shared/types';
import type { Route } from '../proxy';
import { dataDir, store, tld } from '../store';
import { parseMail, snippetOf, type ParsedMail } from './mime';
import { SmtpCatcher, sendMail, type Envelope } from './smtp';
import { WEB_INBOX_HTML } from './webinbox';
import { currentOS, words } from '@shared/platform';

/**
 * The mail catcher: an SMTP server on 127.0.0.1:<mailPort> that keeps every
 * mail as a .eml file plus an index (site, unread, summary), a web inbox on
 * https://mail.<tld> through the proxy, forwarding through the user's own
 * SMTP account, and .env lines per site.
 */

interface Stored extends MailSummary {
  file: string;
  envelope: Envelope;
}

interface Hooks {
  projects(): ProjectConfig[];
  runtime(siteId: string): 'node' | 'go' | 'php' | 'python' | null;
  framework(siteId: string): string | null;
  changed(): void;
  /** A mail arrived (notification). */
  onMail(m: MailSummary): void;
}

const INDEX_LIMIT_BYTES = 200 * 1024 * 1024;

export class MailManager {
  private catcher: SmtpCatcher | null = null;
  private web: HttpServer | null = null;
  private webPort = 0;
  private index: Stored[] = [];
  private error: string | null = null;
  private lastAt: string | null = null;
  private parsedCache = new Map<string, ParsedMail>();

  constructor(private h: Hooks) {
    mkdirSync(this.dir, { recursive: true });
    this.loadIndex();
    void this.listenWeb();
  }

  private get dir() {
    return dataDir('mail');
  }
  private get indexFile() {
    return join(this.dir, 'index.json');
  }

  private loadIndex(): void {
    try {
      this.index = JSON.parse(readFileSync(this.indexFile, 'utf8')) as Stored[];
      this.index = this.index.filter((m) => existsSync(join(this.dir, m.file)));
      this.lastAt = this.index[0]?.receivedAt ?? null;
    } catch {
      this.index = [];
    }
  }

  private saveIndex(): void {
    writeFileSync(this.indexFile, JSON.stringify(this.index));
  }

  state(): MailState {
    return {
      running: Boolean(this.catcher?.listening),
      port: store.settings.mailPort,
      webUrl: `https://${this.domain()}`,
      count: this.index.length,
      unread: this.index.filter((m) => m.unread).length,
      error: this.error,
      forwardReady: Boolean(this.forwardConfig()?.host),
      lastAt: this.lastAt,
    };
  }

  domain(): string {
    return `${store.settings.mailDomain || 'mail'}.${tld()}`;
  }

  /** Proxy route for the web inbox. */
  routes(): Route[] {
    return this.webPort ? [{ domain: this.domain(), port: this.webPort, projectName: 'Mail', running: true, secure: true }] : [];
  }

  // ---------------------------------------------------------------- SMTP

  async start(): Promise<void> {
    if (this.catcher?.listening) return;
    const port = store.settings.mailPort;
    const c = new SmtpCatcher(this.domain(), (raw, env) => this.receive(raw, env));
    try {
      await c.listen(port);
      this.catcher = c;
      this.error = null;
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      this.error = err.code === 'EADDRINUSE' ? `Port ${port} is already in use (another mail catcher? change it in Settings → Mail)` : err.message;
      throw new Error(this.error);
    } finally {
      this.h.changed();
    }
  }

  async stop(): Promise<void> {
    await this.catcher?.close();
    this.catcher = null;
    this.h.changed();
  }

  async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }

  async autoStart(): Promise<void> {
    if (store.settings.mailAutoStart) await this.start().catch((e) => console.warn('mail:', (e as Error).message));
  }

  /** The site a mail came from: the SMTP username (site id, domain or name), else the sender's domain. */
  private siteOf(env: Envelope, from: string | undefined): ProjectConfig | null {
    const projects = this.h.projects();
    const u = env.username?.trim().toLowerCase();
    if (u) {
      const hit = projects.find((p) => p.id === u || p.domain.toLowerCase() === u || p.name.toLowerCase() === u || p.domain.toLowerCase().split('.')[0] === u);
      if (hit) return hit;
    }
    const host = (from ?? env.from).split('@')[1]?.toLowerCase();
    if (host) {
      const hit = projects.find((p) => p.domain.toLowerCase() === host || host.endsWith(`.${p.domain.toLowerCase()}`) || host === `${p.domain.split('.')[0]}.test`);
      if (hit) return hit;
    }
    return null;
  }

  private async receive(raw: Buffer, env: Envelope): Promise<string> {
    const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const file = `${id}.eml`;
    writeFileSync(join(this.dir, file), raw);
    const parsed = parseMail(raw);
    const site = this.siteOf(env, parsed.from?.address);
    const m: Stored = {
      id,
      file,
      envelope: env,
      receivedAt: new Date().toISOString(),
      from: parsed.from,
      to: parsed.to.length ? parsed.to : env.to.map((address) => ({ name: '', address })),
      cc: parsed.cc,
      subject: parsed.subject,
      siteId: site?.id ?? null,
      siteName: site?.name ?? null,
      unread: true,
      hasHtml: Boolean(parsed.html),
      attachments: parsed.attachments.filter((a) => !a.inline).length,
      size: raw.length,
      snippet: snippetOf(parsed),
    };
    this.parsedCache.set(id, parsed);
    this.index.unshift(m);
    this.prune();
    this.saveIndex();
    this.lastAt = m.receivedAt;
    this.h.changed();
    this.h.onMail(this.summary(m));
    return id;
  }

  /** Oldest mails beyond the keep limit (count, or 200 MB) go. */
  private prune(): void {
    const keep = Math.max(10, store.settings.mailKeep || 500);
    let total = 0;
    const kept: Stored[] = [];
    for (const m of this.index) {
      total += m.size;
      if (kept.length < keep && total < INDEX_LIMIT_BYTES) kept.push(m);
      else rmSync(join(this.dir, m.file), { force: true });
    }
    this.index = kept;
  }

  // ---------------------------------------------------------------- reading

  private summary({ file: _f, envelope: _e, ...m }: Stored): MailSummary {
    return m;
  }

  list(query: string, siteId: string | null, limit = 200): MailSummary[] {
    const q = query.trim().toLowerCase();
    return this.index
      .filter((m) => !siteId || m.siteId === siteId)
      .filter((m) => !q || [m.subject, m.from?.address, m.from?.name, ...m.to.map((t) => t.address), m.siteName, m.snippet].some((s) => s?.toLowerCase().includes(q)))
      .slice(0, limit)
      .map((m) => this.summary(m));
  }

  private stored(id: string): Stored {
    const m = this.index.find((x) => x.id === id);
    if (!m) throw new Error('Mail not found (deleted?)');
    return m;
  }

  raw(id: string): Buffer {
    return readFileSync(join(this.dir, this.stored(id).file));
  }

  private parsed(id: string): ParsedMail {
    let p = this.parsedCache.get(id);
    if (!p) {
      p = parseMail(this.raw(id));
      this.parsedCache.set(id, p);
      if (this.parsedCache.size > 50) this.parsedCache.delete(this.parsedCache.keys().next().value!);
    }
    return p;
  }

  private attachmentsOf(p: ParsedMail): MailAttachment[] {
    return p.attachments.map((a, i) => ({ id: String(i), filename: a.filename, contentType: a.contentType, size: a.data.length, cid: a.cid }));
  }

  get(id: string): MailMessage {
    const m = this.stored(id);
    const p = this.parsed(id);
    let remoteImages = 0;
    let html: string | null = null;
    if (p.html) {
      // Inline images (cid:) become data: URLs; remote ones are held back (the viewer can load them).
      html = p.html.replace(/\bsrc\s*=\s*(["']?)cid:([^"'\s>]+)\1/gi, (_m, _q, cid: string) => {
        const a = p.attachments.find((x) => x.cid === cid);
        return a ? `src="data:${a.contentType};base64,${a.data.toString('base64')}"` : 'src=""';
      });
      html = html.replace(/\b(src|srcset)\s*=\s*(["'])(https?:\/\/[^"']*)\2/gi, (_m, attr: string, q: string, url: string) => {
        remoteImages++;
        return `data-blocked-${attr}=${q}${url}${q}`;
      });
    }
    return {
      ...this.summary(m),
      html,
      text: p.text,
      headers: p.headers,
      attachmentList: this.attachmentsOf(p),
      remoteImages,
      hints: this.hints(p, remoteImages),
      envelope: { from: m.envelope.from, to: m.envelope.to, username: m.envelope.username },
    };
  }

  /** Small checks a mail client or spam filter would notice. */
  private hints(p: ParsedMail, remoteImages: number): string[] {
    const out: string[] = [];
    const h = (n: string) => p.headers.find((x) => x.name.toLowerCase() === n)?.value;
    if (!p.subject.trim()) out.push('Empty subject');
    if (p.html && !p.text) out.push('HTML only: add a plain-text part for clients that prefer text (and a better spam score)');
    if (p.html) {
      const imgs = p.html.match(/<img\b[^>]*>/gi) ?? [];
      const noAlt = imgs.filter((i) => !/\balt\s*=/i.test(i)).length;
      if (noAlt) out.push(`${noAlt} image${noAlt === 1 ? '' : 's'} without alt text`);
      const dev = p.html.match(/https?:\/\/[^"'\s)]*\.(localhost|test|local)(?=[/:"'\s)]|$)/gi) ?? [];
      if (dev.length) out.push(`${dev.length} link${dev.length === 1 ? '' : 's'} to a dev domain (${[...new Set(dev.map((d) => d.replace(/^https?:\/\//, '').split(/[/:]/)[0]))].slice(0, 3).join(', ')})`);
      if (!/<a\b[^>]*>[^<]*(unsubscribe|berhenti)/i.test(p.html) && !h('list-unsubscribe') && /newsletter|promo|offer|unsubscribe/i.test(p.subject + p.html.slice(0, 2000))) out.push('Looks like a bulk mail without a List-Unsubscribe header');
    }
    if (remoteImages) out.push(`${remoteImages} remote image${remoteImages === 1 ? '' : 's'} (blocked here; real clients may block them too)`);
    if (!h('message-id')) out.push('No Message-ID header');
    if (!h('date')) out.push('No Date header');
    if (!p.from) out.push('No From header');
    const big = p.attachments.filter((a) => a.data.length > 10 * 1024 * 1024);
    if (big.length) out.push(`Attachment over 10 MB: ${big.map((a) => a.filename).join(', ')}`);
    return out;
  }

  attachment(id: string, attachmentId: string): { filename: string; contentType: string; data: Buffer } {
    const a = this.parsed(id).attachments[Number(attachmentId)];
    if (!a) throw new Error('Attachment not found');
    return a;
  }

  markRead(ids: string[], read: boolean): void {
    for (const m of this.index) if (ids.includes(m.id)) m.unread = !read;
    this.saveIndex();
    this.h.changed();
  }

  delete(ids: string[]): void {
    for (const m of this.index.filter((x) => ids.includes(x.id))) rmSync(join(this.dir, m.file), { force: true });
    this.index = this.index.filter((m) => !ids.includes(m.id));
    for (const id of ids) this.parsedCache.delete(id);
    this.saveIndex();
    this.h.changed();
  }

  deleteAll(): void {
    for (const f of readdirSync(this.dir)) if (f.endsWith('.eml')) rmSync(join(this.dir, f), { force: true });
    this.index = [];
    this.parsedCache.clear();
    this.saveIndex();
    this.h.changed();
  }

  // ---------------------------------------------------------------- forwarding

  private forwardStored(): (MailForwardConfig & { password: string | null }) | null {
    return store.extra<MailForwardConfig & { password: string | null }>('mailForward') ?? null;
  }

  forwardConfig(): MailForwardConfig | null {
    const c = this.forwardStored();
    return c ? { ...c, password: c.password ? '' : null } : null;
  }

  setForwardConfig(c: MailForwardConfig | null): void {
    if (!c) return store.setExtra('mailForward', null);
    if (!c.host.trim()) throw new Error('Enter the SMTP host');
    if (!Number.isInteger(c.port) || c.port < 1 || c.port > 65535) throw new Error('Port: 1–65535');
    if (!/^[^\s@]+@[^\s@]+$/.test(c.from.trim())) throw new Error('From: an email address the account may send as');
    const prev = this.forwardStored();
    let password = prev?.password ?? null;
    if (c.password) {
      if (!safeStorage.isEncryptionAvailable()) throw new Error(`${currentOS === 'mac' ? 'macOS Keychain' : words.secretStore} encryption is not available`);
      password = safeStorage.encryptString(c.password).toString('base64');
    } else if (c.password === null) password = null;
    store.setExtra('mailForward', { host: c.host.trim(), port: c.port, security: c.security, username: c.username.trim(), from: c.from.trim(), password });
    this.h.changed();
  }

  async forward(id: string, to: string): Promise<void> {
    const c = this.forwardStored();
    if (!c?.host) throw new Error('Set up a forwarding account first (Settings → Mail)');
    const addr = to.trim();
    if (!/^[^\s@]+@[^\s@]+$/.test(addr)) throw new Error('Enter the address to forward to');
    const m = this.stored(id);
    const raw = this.raw(id);
    // Tell the real client where it came from, and send from the account's address (SPF).
    const text = raw.toString('latin1');
    const headerEnd = text.search(/\r?\n\r?\n/);
    const extra = `X-Forwarded-By: DevCatz mail catcher\r\nX-Original-From: ${m.from?.address ?? m.envelope.from}\r\nX-Original-To: ${m.envelope.to.join(', ')}\r\n`;
    const out = Buffer.from(extra + text.slice(0, headerEnd).replace(/^(From|Sender|Return-Path|Reply-To):[^\n]*\n?/gim, '') + `\r\nFrom: ${c.from}\r\nReply-To: ${m.from?.address ?? c.from}\r\nTo: ${addr}` + text.slice(headerEnd), 'latin1');
    await sendMail({
      host: c.host,
      port: c.port,
      security: c.security,
      username: c.username || undefined,
      password: c.password ? safeStorage.decryptString(Buffer.from(c.password, 'base64')) : undefined,
      from: c.from,
      to: [addr],
      raw: out,
    });
  }

  // ---------------------------------------------------------------- sites

  /** .env lines for a site's stack. */
  env(siteId: string): Record<string, string> {
    const p = this.h.projects().find((x) => x.id === siteId);
    if (!p) throw new Error('Unknown site');
    const port = String(store.settings.mailPort);
    const user = p.domain.split('.')[0];
    const fw = this.h.framework(siteId);
    const rt = this.h.runtime(siteId);
    if (rt === 'php' && fw === 'laravel') {
      return {
        MAIL_MAILER: 'smtp',
        MAIL_SCHEME: 'smtp',
        MAIL_HOST: '127.0.0.1',
        MAIL_PORT: port,
        MAIL_USERNAME: user,
        MAIL_PASSWORD: 'devcatz',
        MAIL_ENCRYPTION: 'null',
        MAIL_FROM_ADDRESS: `hello@${p.domain}`,
        MAIL_FROM_NAME: '"${APP_NAME}"',
      };
    }
    if (rt === 'php') return { MAIL_HOST: '127.0.0.1', MAIL_PORT: port, MAIL_USERNAME: user, MAIL_PASSWORD: 'devcatz', MAIL_ENCRYPTION: 'null', MAIL_FROM_ADDRESS: `hello@${p.domain}`, SMTP_HOST: '127.0.0.1', SMTP_PORT: port };
    if (rt === 'python') {
      return {
        EMAIL_BACKEND: 'django.core.mail.backends.smtp.EmailBackend',
        EMAIL_HOST: '127.0.0.1',
        EMAIL_PORT: port,
        EMAIL_HOST_USER: user,
        EMAIL_HOST_PASSWORD: 'devcatz',
        EMAIL_USE_TLS: 'False',
        EMAIL_USE_SSL: 'False',
        DEFAULT_FROM_EMAIL: `hello@${p.domain}`,
        MAIL_SERVER: '127.0.0.1',
        MAIL_PORT: port,
        MAIL_USERNAME: user,
        MAIL_PASSWORD: 'devcatz',
      };
    }
    // Node (Nodemailer, Resend-style env names) and Go (net/smtp): SMTP_* is the common shape.
    return {
      SMTP_HOST: '127.0.0.1',
      SMTP_PORT: port,
      SMTP_USER: user,
      SMTP_PASS: 'devcatz',
      SMTP_SECURE: 'false',
      MAIL_FROM: `hello@${p.domain}`,
    };
  }

  /** A test mail through the catcher itself, as the site would send it. */
  async sendTest(siteId: string | null): Promise<void> {
    if (!this.catcher?.listening) throw new Error('The mail catcher is not running');
    const p = siteId ? this.h.projects().find((x) => x.id === siteId) : null;
    const from = p ? `hello@${p.domain}` : `devcatz@${this.domain()}`;
    const now = new Date();
    const boundary = `devcatz-${Date.now().toString(36)}`;
    const raw = Buffer.from(
      [
        `From: ${p ? `"${p.name}" <${from}>` : `DevCatz <${from}>`}`,
        'To: you@example.com',
        `Subject: Test mail from ${p ? p.name : 'DevCatz'}`,
        `Date: ${now.toUTCString()}`,
        `Message-ID: <${boundary}@${this.domain()}>`,
        'MIME-Version: 1.0',
        `Content-Type: multipart/alternative; boundary="${boundary}"`,
        '',
        `--${boundary}`,
        'Content-Type: text/plain; charset=utf-8',
        '',
        `Hello from the DevCatz mail catcher. Sent ${now.toLocaleString()}.`,
        '',
        `--${boundary}`,
        'Content-Type: text/html; charset=utf-8',
        '',
        `<div style="font-family:system-ui,sans-serif;padding:24px"><h2 style="margin:0 0 8px">It works 🎉</h2><p>This mail was caught by DevCatz instead of being delivered. Every mail your sites send ends up here.</p><p style="color:#888;font-size:12px">${now.toLocaleString()}</p></div>`,
        '',
        `--${boundary}--`,
        '',
      ].join('\r\n'),
    );
    await sendMail({ host: '127.0.0.1', port: store.settings.mailPort, security: 'none', username: p ? p.domain.split('.')[0] : undefined, password: 'devcatz', from, to: ['you@example.com'], raw });
  }

  // ---------------------------------------------------------------- web inbox

  private async listenWeb(): Promise<void> {
    const server = createHttpServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://x');
      const json = (body: unknown, status = 200) => {
        res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(body));
      };
      try {
        const m = url.pathname.match(/^\/api\/messages\/([a-z0-9]+)(?:\/(raw|html|attachments\/(\d+)))?$/);
        if (url.pathname === '/api/messages') return json(this.list(url.searchParams.get('q') ?? '', url.searchParams.get('site'), Number(url.searchParams.get('limit')) || 200));
        if (m && !m[2]) {
          const msg = this.get(m[1]);
          this.markRead([m[1]], true);
          return json(msg);
        }
        if (m && m[2] === 'raw') {
          res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
          return res.end(this.raw(m[1]));
        }
        if (m && m[3] !== undefined) {
          const a = this.attachment(m[1], m[3]);
          res.writeHead(200, { 'Content-Type': a.contentType, 'Content-Disposition': `attachment; filename="${a.filename.replace(/"/g, '')}"` });
          return res.end(a.data);
        }
        if (url.pathname === '/' || url.pathname === '/index.html') {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
          return res.end(WEB_INBOX_HTML);
        }
        json({ error: 'Not found' }, 404);
      } catch (e) {
        json({ error: (e as Error).message }, 500);
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    this.web = server;
    this.webPort = (server.address() as { port: number }).port;
    this.h.changed();
  }

  async close(): Promise<void> {
    await this.stop();
    this.web?.close();
  }

  openData(): string {
    return this.dir;
  }

  /** Data folder size (Settings). */
  sizeBytes(): number {
    try {
      return readdirSync(this.dir).reduce((n, f) => n + statSync(join(this.dir, f)).size, 0);
    } catch {
      return 0;
    }
  }
}
