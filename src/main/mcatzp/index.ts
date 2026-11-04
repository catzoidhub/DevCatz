import { McatzpHost } from '@catzoid/mcatzp-host';
import { app, dialog } from 'electron';
import type { HerdApi } from '@shared/types';
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

  constructor(api: HerdApi) {
    this.host = new McatzpHost({
      app: { id: 'devcatz', name: 'DevCatz', version: app.getVersion() },
      dataDir: app.getPath('userData'),
      actions: () => readActions(api),
      isPaired: (name) => this.paired.has(name),
      onPaired: (name) => this.paired.add(name),
      pair: async (client) => {
        const name = `${client.name}${client.version ? ` ${client.version}` : ''}`;
        const { response } = await dialog.showMessageBox({
          type: 'question',
          message: `Let ${name} read DevCatz through MCatzP?`,
          detail: `It can read your sites, services, runtimes, Git status and logs (secrets masked). What it reads goes to that assistant's model provider. It cannot change anything.\n\nThe name is what the client says about itself. If you did not just start it, choose Don't Allow.`,
          buttons: ['Allow', "Don't Allow"],
          defaultId: 1,
          cancelId: 1,
        });
        return response === 0;
      },
      confirm: async () => 'deny',
      log: (e) => console.log(`mcatzp: ${e.client} ${e.action ?? e.method} ${e.outcome}${e.reason ? ` (${e.reason})` : ''}`),
    });
    setBridgeMcatzp(this.host.entry());
  }

  /** The switch: opens or closes the channel and tells bridge.json. A closed channel forgets the approved clients. */
  set(on: boolean): Promise<void> {
    const next = this.queue.then(async () => {
      if (on === this.host.running) return;
      if (!on) this.paired.clear();
      setBridgeMcatzp(await (on ? this.host.start() : this.host.stop()));
    });
    this.queue = next.catch((e) => console.warn('MCatzP channel:', (e as Error).message));
    return next;
  }
}
