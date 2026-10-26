import { app, crashReporter, net } from 'electron';
import { randomUUID } from 'node:crypto';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir, release } from 'node:os';
import type { ReportKind, ReportPreview, ReportShot, ReportsState } from '@shared/types';
import { siteBase } from './shared';
import { dataDir, store } from './store';

/**
 * Reports to the Catzoid site (Catzoid family #65, the in-app side of #28):
 *  · Report a Bug / Send Feedback (Help menu, Settings → About): `POST <site>/api/reports`, type `feedback` with the
 *    kind in `extra`; queued in DevCatz's data folder and sent again when the site cannot be reached;
 *  · crash and error reports, opt-in (Settings → General, off until turned on, asked once after the first one):
 *    uncaught errors of the main process and the window, renderer / helper crashes, and native crashes through
 *    Electron's crashReporter to `<site>/api/reports/minidump`; one report per kind of crash per version per day;
 *  · everything scrubbed first: no tokens, keys, passwords, .env values, hosts or paths outside the app; the email
 *    only when the user typed it for a reply;
 *  · headers X-Catzoid-Install (a random id, nothing personal), -Version, -Channel.
 * Never carried (DevCatz): .env values, database credentials, site hosts and paths, request / response bodies.
 */

const QUEUE_MAX = 50;
/** Screenshots on a bug report (Catzoid #67): how many, how large, and how many queued reports may keep theirs. */
const SHOTS_MAX = 3;
const SHOT_BYTES = 2.5 * 1024 * 1024;
const QUEUED_WITH_SHOTS = 3;
const RETRY = 10 * 60 * 1000;

interface Body {
  type: 'crash' | 'error' | 'feedback';
  app: 'devcatz';
  version: string;
  channel: string;
  os: 'macos';
  osVersion: string;
  arch: string;
  platform: string;
  message: string;
  stack?: string;
  log?: string;
  installId: string;
  email?: string;
  process?: string;
  extra?: Record<string, unknown>;
  /** Not part of the JSON report: sent as multipart `image` parts next to it. */
  shots?: ReportShot[];
}

/** The screenshots that may go: PNG / JPEG by their bytes, at most SHOTS_MAX of at most SHOT_BYTES each. */
function checkShots(shots: unknown[]): ReportShot[] {
  if (shots.length > SHOTS_MAX) throw new Error(`At most ${SHOTS_MAX} screenshots`);
  return shots.map((x) => {
    const s = x as Partial<ReportShot>;
    const bytes = Buffer.from(String(s.data ?? ''), 'base64');
    const png = bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8;
    if (!png && !jpeg) throw new Error('Screenshots must be PNG or JPEG');
    if (bytes.length > SHOT_BYTES) throw new Error('A screenshot is too large — try a smaller window');
    return { type: png ? 'image/png' : 'image/jpeg', data: String(s.data) };
  });
}

/** Strips what must never leave the Mac. */
export function scrub(text: string): string {
  const home = homedir();
  const own = app.getAppPath();
  return (
    text
      // keys and tokens
      .replace(/\b(sk-[\w-]{10,}|sk-ant-[\w-]{10,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_\w{20,}|xox[abprs]-[\w-]{10,}|AKIA[0-9A-Z]{16}|AIza[\w-]{30,}|eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,})\b/g, '<secret>')
      .replace(/\b(bearer|basic|token)\s+[\w.~+/=-]{8,}/gi, '$1 <secret>')
      .replace(/\b([A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASS|PWD|AUTH|CREDENTIALS?|DSN|URL))\s*[=:]\s*\S+/g, '$1=<value>')
      .replace(/("?(?:password|passwd|secret|token|apiKey|api_key|authorization)"?\s*[:=]\s*)("[^"]*"|'[^']*'|\S+)/gi, '$1<secret>')
      // URLs with credentials, then hosts (sites, databases, services)
      .replace(/([a-z][\w+.-]*:\/\/)[^\s/@]+@/gi, '$1<credentials>@')
      .replace(/\b(https?|wss?|postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis|amqp):\/\/[^\s/'")]+/gi, '$1://<host>')
      .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '<ip>')
      // paths: the app's own stay, the rest of the home folder does not
      .split(own)
      .join('<app>')
      .replace(new RegExp(home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[^\\s:\'")]*', 'g'), '<path>')
      .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '<email>')
  );
}

export class Reports {
  onChange: () => void = () => undefined;
  private file = dataDir('reports-queue.json');
  private queue: Body[] = [];
  private sentToday = new Map<string, string>();
  private askCrash = false;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    try {
      this.queue = JSON.parse(readFileSync(this.file, 'utf8')) as Body[];
    } catch {
      this.queue = [];
    }
  }

  /** The random install id (created once; no personal data). */
  installId(): string {
    const f = dataDir('install-id');
    try {
      const id = readFileSync(f, 'utf8').trim();
      if (/^[\w-]{8,64}$/.test(id)) return id;
    } catch {
      /* first time */
    }
    const id = randomUUID();
    writeFileSync(f, id);
    return id;
  }

  channel(): string {
    return store.settings.appUpdateChannel === 'beta' ? 'beta' : 'stable';
  }

  headers(): Record<string, string> {
    return { 'X-Catzoid-Install': this.installId(), 'X-Catzoid-Version': app.getVersion(), 'X-Catzoid-Channel': this.channel() };
  }

  state(): ReportsState {
    return { crashReports: store.settings.crashReports, askCrash: this.askCrash && !store.settings.crashReports && !store.settings.crashAsked, queued: this.queue.length, site: siteBase() };
  }

  /** Native crashes (minidumps) through Electron's crashReporter; uploads only while crash reports are on. */
  startCrashReporter(): void {
    try {
      crashReporter.start({
        submitURL: `${siteBase()}/api/reports/minidump`,
        uploadToServer: store.settings.crashReports,
        compress: true,
        globalExtra: { app: 'devcatz', _productName: 'DevCatz', platform: process.arch === 'arm64' ? 'mac-arm64' : 'mac-x64', channel: this.channel() },
      });
    } catch (e) {
      console.warn('crashReporter:', (e as Error).message);
    }
    this.timer = setInterval(() => void this.flush(), RETRY);
    setTimeout(() => void this.flush(), 20_000);
  }

  setCrashReports(on: boolean): void {
    store.updateSettings({ crashReports: on, crashAsked: true });
    try {
      crashReporter.setUploadToServer(on);
    } catch {
      /* not started (development build) */
    }
    this.askCrash = false;
    this.onChange();
  }

  /** "Not now" on the question asked after the first crash. */
  dismissAsk(): void {
    store.updateSettings({ crashAsked: true });
    this.askCrash = false;
    this.onChange();
  }

  private base(type: Body['type'], message: string): Body {
    return {
      type,
      app: 'devcatz',
      version: app.getVersion(),
      channel: this.channel(),
      os: 'macos',
      osVersion: process.getSystemVersion?.() ?? release(),
      arch: process.arch,
      platform: process.arch === 'arm64' ? 'mac-arm64' : 'mac-x64',
      message,
      installId: this.installId(),
    };
  }

  /** What a feedback report sends, for "Preview what is sent" (screenshots shown as what they are, not their bytes). */
  preview(kind: ReportKind, message: string, email: string, shots = 0): ReportPreview {
    const body = this.feedbackBody(kind, message, email) as unknown as Record<string, unknown>;
    if (kind === 'bug' && shots > 0) body.screenshots = `${Math.min(shots, SHOTS_MAX)} image(s), sent as separate parts — exactly as shown in the dialog`;
    return { url: `${siteBase()}/api/reports`, headers: this.headers(), body };
  }

  private feedbackBody(kind: ReportKind, message: string, email: string): Body {
    const b = this.base('feedback', scrub(message.trim()).slice(0, 10_000));
    const mail = email.trim();
    if (mail) b.email = mail.slice(0, 200);
    b.extra = { kind };
    return b;
  }

  /** Sends a bug report / idea / question; queued when the site cannot be reached. */
  async sendFeedback(kind: ReportKind, message: string, email: string, shots: unknown[] = []): Promise<{ sent: boolean; queued: boolean }> {
    if (!message.trim()) throw new Error('Write a few words first');
    if (email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) throw new Error('That email address does not look right');
    const body = this.feedbackBody(kind, message, email);
    if (kind === 'bug' && shots.length) body.shots = checkShots(shots);
    const r = await this.post(body);
    if (r === 'ok') return { sent: true, queued: false };
    if (r === 'retry') {
      this.enqueue(body);
      return { sent: false, queued: true };
    }
    throw new Error(r);
  }

  /**
   * An uncaught error or a crash. Sent only with crash reports on (otherwise the user is asked once); one per kind per
   * version per day.
   */
  error(type: 'crash' | 'error', proc: string, message: string, stack?: string): void {
    if (!store.settings.crashReports) {
      if (!store.settings.crashAsked && !this.askCrash) {
        this.askCrash = true;
        this.onChange();
      }
      return;
    }
    const first = scrub(message).split('\n')[0].slice(0, 300);
    const key = `${type}|${proc}|${first}|${app.getVersion()}`;
    const today = new Date().toISOString().slice(0, 10);
    if (this.sentToday.get(key) === today) return;
    this.sentToday.set(key, today);
    const b = this.base(type, scrub(message).slice(0, 10_000));
    if (stack) b.stack = scrub(stack).slice(0, 20_000);
    b.process = proc;
    void this.post(b).then((r) => r === 'retry' && this.enqueue(b));
  }

  private enqueue(b: Body): void {
    this.queue = [...this.queue, b].slice(-QUEUE_MAX);
    // screenshots are heavy: only the newest few queued reports keep theirs, older ones go without
    let withShots = 0;
    for (let i = this.queue.length - 1; i >= 0; i--) {
      if (!this.queue[i].shots?.length) continue;
      if (++withShots > QUEUED_WITH_SHOTS) this.queue[i] = { ...this.queue[i], shots: undefined };
    }
    this.save();
  }

  private save(): void {
    try {
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.queue), { mode: 0o600 });
      renameSync(tmp, this.file);
    } catch (e) {
      console.warn('reports queue:', (e as Error).message);
    }
    this.onChange();
  }

  /** Sends what is queued (every 10 minutes, and after a send that worked). */
  async flush(): Promise<void> {
    if (!this.queue.length) return;
    const left: Body[] = [];
    for (const b of this.queue) {
      const r = await this.post(b, false);
      if (r === 'retry') left.push(b);
    }
    if (left.length !== this.queue.length) {
      this.queue = left;
      this.save();
    }
  }

  /** 'ok', 'retry' (no connection, the site is down or busy) or the server's reason in plain words. */
  private async post(b: Body, flushAfter = true): Promise<'ok' | 'retry' | string> {
    try {
      const { shots, ...report } = b;
      let init: RequestInit;
      if (shots?.length) {
        // with screenshots: the same JSON in `report`, each image in an `image` part (Catzoid #67)
        const form = new FormData();
        form.append('report', JSON.stringify(report));
        shots.forEach((s, i) => form.append('image', new Blob([Buffer.from(s.data, 'base64')], { type: s.type }), `screenshot-${i + 1}.${s.type === 'image/png' ? 'png' : 'jpg'}`));
        init = { method: 'POST', headers: this.headers(), body: form };
      } else {
        init = { method: 'POST', headers: { 'Content-Type': 'application/json', ...this.headers() }, body: JSON.stringify(report) };
      }
      const res = await net.fetch(`${siteBase()}/api/reports`, { ...init, signal: AbortSignal.timeout(shots?.length ? 60_000 : 15_000) });
      if (res.ok) {
        if (flushAfter) void this.flush();
        return 'ok';
      }
      if (res.status === 429 || res.status >= 500) return 'retry';
      const why = ((await res.json().catch(() => null)) as { error?: string; issues?: string[] } | null) ?? null;
      return `The site refused the report: ${[why?.error, ...(why?.issues ?? [])].filter(Boolean).join('; ') || `HTTP ${res.status}`}`;
    } catch {
      return 'retry';
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

}
