import { type ConfirmAnswer, McatzpHost } from '@catzoid/mcatzp-host';
import { randomUUID } from 'node:crypto';
import { app } from 'electron';
import type { HerdApi, McatzpAsk } from '@shared/types';
import { setBridgeMcatzp } from '../bridge';
import { type ChangeAction, changeActions, readActions } from './actions';

/** Unanswered questions lapse before MCatzP stops waiting (3 and 10 minutes), so a late Allow never runs for nobody. */
const PAIR_WAIT_MS = 150_000;
const CHANGE_WAIT_MS = 9 * 60_000;

/**
 * DevCatz's end of MCatzP: the local channel from the shared host, open only while Settings → AI → MCatzP is on.
 * For now a client's approval lasts until DevCatz quits, and a change is asked in the same dialog (TODO §33).
 */
export class Mcatzp {
  private readonly paired = new Set<string>();
  private readonly host: McatzpHost;
  private readonly changes: ChangeAction[];
  /** start() / stop() run one after the other: the switch can flip while the socket is still opening. */
  private queue: Promise<unknown> = Promise.resolve();
  /** Questions waiting for the dialog, the oldest first; it shows one at a time. */
  private asks: { ask: McatzpAsk; done(answer: ConfirmAnswer): void; timer: ReturnType<typeof setTimeout> }[] = [];

  constructor(
    api: HerdApi,
    private readonly show: (ask: McatzpAsk | null) => void,
  ) {
    this.changes = changeActions(api);
    this.host = new McatzpHost({
      app: { id: 'devcatz', name: 'DevCatz', version: app.getVersion() },
      dataDir: app.getPath('userData'),
      actions: () => [...readActions(api), ...this.changes],
      isPaired: (name) => this.paired.has(name),
      onPaired: (name) => this.paired.add(name),
      pair: (client) => this.ask({ id: randomUUID(), kind: 'pair', client: client.name, version: client.version ?? null }, PAIR_WAIT_MS).then((a) => a !== 'deny'),
      confirm: async (req) => {
        const change = this.changes.find((c) => c.name === req.action.name);
        if (!change) return 'deny';
        let preview: Awaited<ReturnType<typeof change.preview>>;
        try {
          preview = await change.preview(req.args);
        } catch {
          // The site or service does not exist: nothing to ask, and run() answers with the same error, changing nothing.
          return 'once';
        }
        return this.ask({ id: randomUUID(), kind: 'change', client: req.client, allowSession: req.allowSession, ...preview }, CHANGE_WAIT_MS);
      },
      log: (e) => console.log(`mcatzp: ${e.client} ${e.action ?? e.method} ${e.outcome}${e.reason ? ` (${e.reason})` : ''}`),
    });
    setBridgeMcatzp(this.host.entry());
  }

  /** The switch: opens or closes the channel and tells bridge.json. A closed channel forgets the approved clients. */
  set(on: boolean): Promise<void> {
    const next = this.queue.then(async () => {
      if (on === this.host.running) return;
      if (!on) {
        this.paired.clear();
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

  private ask(ask: McatzpAsk, waitMs: number): Promise<ConfirmAnswer> {
    return new Promise((done) => {
      const timer = setTimeout(() => this.answer(ask.id, 'deny'), waitMs);
      this.asks.push({ ask, done, timer });
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
