import { app, net } from 'electron';
import { siteBase } from './shared';
import { store } from './store';
import { isLinux, isWin } from './platform';
import type { SupportRating } from '@shared/types';

/**
 * Rate and review DevCatz (Catzoid #96), from the Support Catzoid card and Settings → About:
 *  · `POST <site>/api/devcatz/reviews` with the install id (#90: catzoid.com only), the stars, an optional text, the
 *    version and the build; one rating per install — sending again replaces it;
 *  · the answer (the cleaned text and its moderation status) is kept in settings as "Your rating": there is no GET for
 *    one's own review;
 *  · no connection / the site busy → kept as `supportRatingQueued` and sent again quietly (launch + every hour);
 *  · every rating goes the same way, whatever the stars (no gating).
 */

const PLATFORM = isWin ? 'win-x64' : isLinux ? (process.arch === 'arm64' ? 'linux-arm64' : 'linux-x64') : process.arch === 'arm64' ? 'mac-arm64' : 'mac-x64';
const HOUR = 60 * 60 * 1000;

type Answer = { review?: { rating: number; text: string | null; status: SupportRating['status']; version: string } };

export class Reviews {
  onChange: () => void = () => undefined;
  installId: () => string = () => '';
  private timer: ReturnType<typeof setInterval> | null = null;

  /** Sends a queued rating a minute after launch, then every hour while one waits. */
  start(): void {
    if (this.timer) return;
    setTimeout(() => void this.flush(), 60_000);
    this.timer = setInterval(() => void this.flush(), HOUR);
  }

  /** Sends the stars (1–5) and the optional text. `queued`: no connection, it goes later by itself. */
  async send(rating: number, text: string | null): Promise<{ sent: boolean; queued: boolean }> {
    const stars = Math.round(Number(rating));
    if (!(stars >= 1 && stars <= 5)) throw new Error('Pick from 1 to 5 stars');
    const t = (text ?? '').trim().slice(0, 1000) || null;
    const r = await this.post(stars, t);
    if (r === 'retry') {
      store.updateSettings({ supportRatingQueued: { rating: stars, text: t, at: Date.now() } });
      this.onChange();
      return { sent: false, queued: true };
    }
    if (typeof r === 'string') throw new Error(r);
    return { sent: true, queued: false };
  }

  private async flush(): Promise<void> {
    const q = store.settings.supportRatingQueued;
    if (!q) return;
    const r = await this.post(q.rating, q.text);
    // Refused for good (e.g. the text): drop it rather than retry forever; the card offers to rate again.
    if (r !== 'retry' && typeof r === 'string') {
      store.updateSettings({ supportRatingQueued: null });
      this.onChange();
    }
  }

  /** The answer stored, 'retry' (no connection, busy, the site down) or the site's reason in plain words. */
  private async post(rating: number, text: string | null): Promise<'retry' | string | true> {
    try {
      const res = await net.fetch(`${siteBase()}/api/devcatz/reviews`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ installId: this.installId(), rating, text, version: app.getVersion(), platform: PLATFORM, os: process.platform, arch: process.arch }),
        signal: AbortSignal.timeout(15_000),
      });
      const body = (await res.json().catch(() => null)) as (Answer & { error?: string; issues?: string[] }) | null;
      if (res.ok && body?.review) {
        const v = body.review;
        store.updateSettings({ supportRating: { rating: v.rating, text: v.text, status: v.status, version: v.version, sentAt: Date.now() }, supportRatingQueued: null, supportOff: true });
        this.onChange();
        return true;
      }
      // The site down or busy, or an older site without reviews yet (a 404 that is not "unknown app"): later.
      if (res.status >= 500 || (res.status === 429 && /right now/.test(body?.error ?? '')) || (res.status === 404 && body?.error !== 'unknown app')) return 'retry';
      if (res.status === 429) return 'You rated a few times already: try again in an hour.';
      const issues = (body?.issues ?? []).map((i) => i.replace(/^text: /, 'Your review: '));
      return [body?.error === 'invalid review' ? '' : body?.error, ...issues].filter(Boolean).join('; ') || `The site answered HTTP ${res.status}`;
    } catch {
      return 'retry';
    }
  }
}
