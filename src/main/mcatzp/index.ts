import { type ConfirmAnswer, McatzpHost } from '@catzoid/mcatzp-host';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { app } from 'electron';
import type { HerdApi, McatzpAsk } from '@shared/types';
import { setBridgeMcatzp } from '../bridge';
import { store } from '../store';
import { type ChangeAction, changeActions, findSite, readActions, type Scopes } from './actions';
import { ActivityLog } from './activity';
import { moreReads } from './reads';

/** Unanswered questions lapse before MCatzP stops waiting (3 and 10 minutes), so a late Allow never runs for nobody. */
const PAIR_WAIT_MS = 150_000;
const CHANGE_WAIT_MS = 9 * 60_000;

/**
 * DevCatz's end of MCatzP: the local channel from the shared host, open only while Settings → MCatzP is on.
 * Approved clients and what is shared live in the settings, the activity log in its own file (TODO §33). All of it
 * goes through the host's hooks, so it can move into @catzoid/mcatzp-host once a second app needs the same.
 */
export class Mcatzp {
  readonly activity = new ActivityLog(join(app.getPath('userData'), 'mcatzp-activity.jsonl'));
  private readonly host: McatzpHost;
  private readonly api: HerdApi;
  /** start() / stop() run one after the other: the switch can flip while the socket is still opening. */
  private queue: Promise<unknown> = Promise.resolve();
  /** Questions waiting for the dialog, the oldest first; it shows one at a time. */
  private asks: { ask: McatzpAsk; done(answer: ConfirmAnswer): void; timer: ReturnType<typeof setTimeout> }[] = [];

  constructor(
    api: HerdApi,
    private readonly show: (ask: McatzpAsk | null) => void,
    private readonly open: (page: string) => void,
  ) {
    this.api = api;
    this.host = new McatzpHost({
      app: { id: 'devcatz', name: 'DevCatz', version: app.getVersion() },
      dataDir: app.getPath('userData'),
      actions: () => [...readActions(api, this.scopes()), ...moreReads(api, this.scopes()), ...this.changes()],
      isPaired: (name) => (store.settings.mcatzpClients ?? []).some((c) => c.name === name),
      onPaired: (name) => store.updateSettings({ mcatzpClients: [...(store.settings.mcatzpClients ?? []), { name, approvedAt: new Date().toISOString() }] }),
      // A site named in the call must be shared; one that does not exist answers with its own error in run().
      inScope: (_action, args) => {
        if (typeof args.site !== 'string') return true;
        try {
          return this.scopes().site(findSite(store.projects, args.site));
        } catch {
          return true;
        }
      },
      pair: (client) => this.ask({ id: randomUUID(), kind: 'pair', client: client.name, version: client.version ?? null }, PAIR_WAIT_MS).then((a) => a !== 'deny'),
      confirm: async (req) => {
        const change = this.changes().find((c) => c.name === req.action.name);
        if (!change) return 'deny';
        if (change.noDialog) return 'once';
        let preview: Awaited<ReturnType<typeof change.preview>>;
        try {
          preview = await change.preview(req.args);
        } catch {
          // The site or service does not exist: nothing to ask, and run() answers with the same error, changing nothing.
          return 'once';
        }
        const { page, ...question } = preview;
        const answer = await this.ask({ id: randomUUID(), kind: 'change', client: req.client, allowSession: req.allowSession, ...question }, CHANGE_WAIT_MS, req.signal);
        // The user is right here and just said yes: take them to what is happening. Not for allowed-for-the-session calls.
        if (answer !== 'deny' && !req.signal.aborted) this.open(page);
        return answer;
      },
      log: (e) => this.activity.add(e),
    });
    setBridgeMcatzp(this.host.entry());
  }

  /** The switch: opens or closes the channel and tells bridge.json. A closed channel forgets the approved clients. */
  set(on: boolean): Promise<void> {
    const next = this.queue.then(async () => {
      if (on === this.host.running) return;
      if (!on) {
        for (const a of this.asks.splice(0)) {
          clearTimeout(a.timer);
          a.done('deny');
        }
        this.show(null);
      }
      setBridgeMcatzp(await (on ? this.host.start() : this.host.stop()));
    });
    this.queue = next.catch((e) => console.warn('MCatzP channel:', (e as Error).message));
    return next;
  }

  private scopes(): Scopes {
    const s = store.settings;
    const shared = new Set(s.mcatzpSites ?? []);
    return {
      // A worktree goes with its site.
      site: (id) => s.mcatzpAllSites === true || shared.has(id) || shared.has(store.projects.find((p) => p.id === id)?.worktreeOf ?? ''),
      services: s.mcatzpServices !== false,
      changes: s.mcatzpChanges !== false,
      messages: s.mcatzpMessages === true,
      allSites: s.mcatzpAllSites === true,
    };
  }

  private changes(): ChangeAction[] {
    return changeActions(this.api, this.scopes());
  }

  /** What is shared changed: connected clients get the new list of tools. */
  scopesChanged(): void {
    this.host.notifyChanged();
  }

  /** Forgets a client and closes every connection (a new token): the others reconnect, this one asks again. */
  revoke(name: string): Promise<void> {
    store.updateSettings({ mcatzpClients: (store.settings.mcatzpClients ?? []).filter((c) => c.name !== name) });
    const next = this.queue.then(async () => {
      if (!this.host.running) return;
      await this.host.stop();
      setBridgeMcatzp(await this.host.start());
    });
    this.queue = next.catch((e) => console.warn('MCatzP channel:', (e as Error).message));
    return next;
  }

  private ask(ask: McatzpAsk, waitMs: number, gone?: AbortSignal): Promise<ConfirmAnswer> {
    return new Promise((done) => {
      const timer = setTimeout(() => this.answer(ask.id, 'deny'), waitMs);
      this.asks.push({ ask, done, timer });
      // The client gave up or left: nobody is waiting for this any more, so the question must not stay to be allowed later.
      gone?.addEventListener('abort', () => this.answer(ask.id, 'deny'), { once: true });
      if (this.asks.length === 1) this.show(ask);
    });
  }

  /** The user's answer in the dialog (or the wait running out); then the next question, if any. */
  answer(id: string, answer: ConfirmAnswer): void {
    const at = this.asks.findIndex((a) => a.ask.id === id);
    if (at < 0) return;
    const [a] = this.asks.splice(at, 1);
    clearTimeout(a.timer);
    a.done(answer);
    this.show(this.asks[0]?.ask ?? null);
  }
}
