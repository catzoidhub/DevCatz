import { app, net, Notification } from 'electron';
import electronUpdater, { CancellationToken, type ProgressInfo, type UpdateInfo } from 'electron-updater';
import type { AppUpdateState } from '@shared/types';
import { siteBase } from './shared';
import { store } from './store';
import { words } from '@shared/platform';

const { autoUpdater } = electronUpdater;

/**
 * DevCatz's own updates (Catzoid family #54), with electron-updater:
 *  · the feed is `<site>/updates/devcatz/` (generic provider): the Catzoid site serves `latest-mac.yml` (or
 *    `beta-mac.yml`) from the newest GitHub release and redirects the zip to its asset, so it works while the repo is
 *    private; `<site>` is the shared site address (Catzoid/shared.json, dev.catzoid.tech for now);
 *  · nothing downloads by itself: "Update now" in What's New downloads the zip, electron-updater checks its SHA-512
 *    and Squirrel.Mac the Developer ID signature before it swaps the app, on Restart now or when DevCatz quits;
 *  · checks 30 s after launch and every 6 h (Settings → Updates), one notification per version, none after Skip;
 *  · the notes of every version in between come from `<site>/api/devcatz/releases`.
 */

const SIX_HOURS = 6 * 60 * 60 * 1000;

const nice = (e: unknown): string => {
  const m = (e as Error)?.message ?? String(e);
  if (/ENOTFOUND|EAI_AGAIN|ENETUNREACH|ECONNREFUSED|ETIMEDOUT|net::ERR_(INTERNET_DISCONNECTED|NAME_NOT_RESOLVED|CONNECTION|TIMED_OUT)/.test(m)) return 'No connection to the update server. Check the network and try again.';
  if (/sha512 checksum mismatch|checksum/i.test(m)) return 'The download was damaged (its checksum did not match), so it was thrown away. Try again.';
  if (/code signature|signature/i.test(m)) return `The update is not signed by the same developer as this DevCatz, so ${words.os} refused it.`;
  if (/HttpError: 404|404/.test(m)) return 'The update server has no DevCatz release yet.';
  if (/cancel/i.test(m)) return 'Cancelled';
  return m.split('\n')[0];
};

export class AppUpdater {
  onChange: () => void = () => undefined;
  /** X-Catzoid-Install / -Version / -Channel on every feed request (Catzoid #65). */
  headers: () => Record<string, string> = () => ({});
  /** "click to see what's new" from the notification: the window opens the What's New dialog. */
  onShow: () => void = () => undefined;
  private st: AppUpdateState = {
    status: 'idle',
    current: app.getVersion(),
    version: null,
    date: null,
    size: null,
    notes: [],
    progress: null,
    lastChecked: null,
    error: null,
    feed: '',
    installOnQuit: true,
    dev: !app.isPackaged,
  };
  private cancel: CancellationToken | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private interval: ReturnType<typeof setInterval> | null = null;

  constructor() {
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = true;
    // A development build checks too (for tests); it cannot install.
    autoUpdater.forceDevUpdateConfig = !app.isPackaged;
    autoUpdater.logger = null;
    autoUpdater.on('download-progress', (p: ProgressInfo) =>
      this.set({ status: 'downloading', progress: { percent: p.percent, transferred: p.transferred, total: p.total, bytesPerSecond: p.bytesPerSecond } }),
    );
    autoUpdater.on('update-downloaded', () => {
      this.set({ status: 'downloaded', progress: null });
      if (store.settings.appUpdateNotify && Notification.isSupported()) {
        const n = new Notification({ title: `DevCatz ${this.st.version} is ready to install`, body: 'Restart DevCatz to finish the update.' });
        n.on('click', () => this.onShow());
        n.show();
      }
    });
  }

  state(): AppUpdateState {
    return this.st;
  }

  /** Points the updater at the feed (the shared site address and channel may have changed). */
  private configure(): void {
    const feed = `${siteBase()}/updates/devcatz/`;
    const beta = store.settings.appUpdateChannel === 'beta';
    autoUpdater.setFeedURL({ provider: 'generic', url: feed, channel: beta ? 'beta' : 'latest' });
    autoUpdater.allowPrerelease = beta;
    autoUpdater.requestHeaders = this.headers();
    // Going back from Beta to Stable must not offer an older version as an "update".
    autoUpdater.allowDowngrade = false;
    this.st.feed = feed;
  }

  /** Starts the automatic checks (30 s after launch, then every 6 h) when they are on. */
  schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    if (this.interval) clearInterval(this.interval);
    this.timer = this.interval = null;
    if (!store.settings.appUpdateAuto) return;
    this.timer = setTimeout(() => void this.check(false), 30_000);
    this.interval = setInterval(() => void this.check(false), SIX_HOURS);
  }

  /** Looks for a newer version. `manual`: the user asked (no notification; "You're up to date" shows in the UI). */
  async check(manual: boolean): Promise<AppUpdateState> {
    if (this.st.status === 'checking' || this.st.status === 'downloading') return this.st;
    if (this.st.status === 'downloaded') return this.st;
    this.configure();
    this.set({ status: 'checking', error: null });
    try {
      const r = await autoUpdater.checkForUpdates();
      const info = r?.updateInfo;
      const newer = !!info && !!r?.isUpdateAvailable;
      if (!newer || !info) {
        this.set({ status: 'none', version: null, date: null, size: null, notes: [], lastChecked: Date.now() });
        return this.st;
      }
      this.set({
        status: 'available',
        version: info.version,
        date: info.releaseDate ?? null,
        size: info.files?.find((f) => f.url.endsWith('.zip'))?.size ?? info.files?.[0]?.size ?? null,
        notes: await this.notesSince(info),
        lastChecked: Date.now(),
      });
      const s = store.settings;
      if (!manual && s.appUpdateNotify && s.appUpdateSkip !== info.version && s.appUpdateNotified !== info.version && Notification.isSupported()) {
        store.updateSettings({ appUpdateNotified: info.version });
        const n = new Notification({ title: `DevCatz ${info.version} is available`, body: "Click to see what's new." });
        n.on('click', () => this.onShow());
        n.show();
      }
    } catch (e) {
      this.set({ status: 'error', error: nice(e), lastChecked: Date.now() });
    }
    return this.st;
  }

  /** Release notes of every version after the installed one (the site's API), else the feed's own notes. */
  private async notesSince(info: UpdateInfo): Promise<AppUpdateState['notes']> {
    const newer = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true }) > 0;
    try {
      const res = await net.fetch(`${siteBase()}/api/devcatz/releases`, { headers: this.headers(), signal: AbortSignal.timeout(10_000) });
      if (res.ok) {
        const list = (await res.json()) as { version: string; date: string | null; notes: string }[];
        const beta = store.settings.appUpdateChannel === 'beta';
        const out = list
          .filter((r) => newer(r.version, this.st.current) && !newer(r.version, info.version) && (beta || !r.version.includes('-')))
          .map((r) => ({ version: r.version, date: r.date, notes: r.notes ?? '' }));
        if (out.length) return out;
      }
    } catch {
      /* the feed's notes below */
    }
    const own = Array.isArray(info.releaseNotes) ? info.releaseNotes.map((n) => n.note ?? '').join('\n\n') : (info.releaseNotes ?? '');
    return [{ version: info.version, date: info.releaseDate ?? null, notes: own }];
  }

  /** Downloads the update (the zip; SHA-512 checked); progress in the state. */
  async download(): Promise<void> {
    if (this.st.status !== 'available' && !(this.st.status === 'error' && this.st.version)) return;
    if (!app.isPackaged) {
      this.set({ status: 'error', error: 'A development build cannot install updates: use the packaged DevCatz.' });
      return;
    }
    this.cancel = new CancellationToken();
    this.set({ status: 'downloading', error: null, progress: { percent: 0, transferred: 0, total: this.st.size ?? 0, bytesPerSecond: 0 } });
    try {
      await autoUpdater.downloadUpdate(this.cancel);
    } catch (e) {
      const cancelled = this.cancel?.cancelled;
      this.set(cancelled ? { status: 'available', progress: null } : { status: 'error', error: nice(e), progress: null });
    } finally {
      this.cancel = null;
    }
  }

  cancelDownload(): void {
    this.cancel?.cancel();
  }

  /** "Skip this version": no notification or dot for it. */
  skip(): void {
    if (this.st.version) store.updateSettings({ appUpdateSkip: this.st.version });
    this.onChange();
  }

  /** Install when DevCatz quits (default) or not. */
  setInstallOnQuit(on: boolean): void {
    autoUpdater.autoInstallOnAppQuit = on;
    this.set({ installOnQuit: on });
  }

  /** Swaps the app and starts the new version (the caller has stopped everything first). */
  quitAndInstall(): void {
    autoUpdater.quitAndInstall(false, true);
  }

  /** An update the user has not skipped: the app menu says "Update Available…" and the Settings gear has a dot. */
  pending(): boolean {
    const s = this.st;
    return (s.status === 'available' || s.status === 'downloading' || s.status === 'downloaded') && s.version !== store.settings.appUpdateSkip;
  }

  private set(p: Partial<AppUpdateState>): void {
    this.st = { ...this.st, ...p };
    this.onChange();
  }
}
