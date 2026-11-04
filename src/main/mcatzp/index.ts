import { McatzpHost } from '@catzoid/mcatzp-host';
import { randomUUID } from 'node:crypto';
import { app } from 'electron';
import type { AppState, HerdApi } from '@shared/types';
import { setBridgeMcatzp } from '../bridge';
import { readActions } from './actions';

/**
 * DevCatz's end of MCatzP: the local channel from the shared host, open only while Settings → AI → MCatzP is on.
 * For now a client's approval lasts until DevCatz quits, and only the read tier exists, so nothing asks for a
 * confirmation yet; anything that did would be refused (TODO §33).
 */
export class Mcatzp {
  private readonly paired = new Set<string>();
  private readonly host: McatzpHost;
  /** start() / stop() run one after the other: the switch can flip while the socket is still opening. */
  private queue: Promise<unknown> = Promise.resolve();
  /** Clients waiting for the dialog, the oldest first; it shows one at a time. */
  private asks: { ask: NonNullable<AppState['mcatzpAsk']>; done(allow: boolean): void }[] = [];

  constructor(
    api: HerdApi,
    private readonly show: (ask: AppState['mcatzpAsk']) => void,
  ) {
    this.host = new McatzpHost({
      app: { id: 'devcatz', name: 'DevCatz', version: app.getVersion() },
      dataDir: app.getPath('userData'),
      actions: () => readActions(api),
      isPaired: (name) => this.paired.has(name),
      onPaired: (name) => this.paired.add(name),
      pair: (client) =>
        new Promise<boolean>((done) => {
          this.asks.push({ ask: { id: randomUUID(), client: client.name, version: client.version ?? null }, done });
          if (this.asks.length === 1) this.show(this.asks[0].ask);
        }),
      confirm: async () => 'deny',
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
        for (const a of this.asks.splice(0)) a.done(false);
        this.show(null);
      }
      setBridgeMcatzp(await (on ? this.host.start() : this.host.stop()));
    });
    this.queue = next.catch((e) => console.warn('MCatzP channel:', (e as Error).message));
    return next;
  }

  /** The user's answer in the dialog; then the next client waiting, if any. */
  answer(id: string, allow: boolean): void {
    const at = this.asks.findIndex((a) => a.ask.id === id);
    if (at < 0) return;
    this.asks.splice(at, 1)[0].done(allow);
    this.show(this.asks[0]?.ask ?? null);
  }
}
