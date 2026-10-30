import { AsyncLocalStorage } from 'node:async_hooks';
import type { ChildProcess } from 'node:child_process';
import { killTree } from './platform';

/**
 * Cancel for long installs (runtimes, tools): the install runs inside `cancellable(signal, fn)`, and every download
 * (downloadVerified) and child process (run / stream / streamLines) started under it picks the signal up by itself, so
 * no installer has to pass it along. Abort → the download stops, the processes are killed, the install throws Cancelled.
 */
const scope = new AsyncLocalStorage<AbortSignal>();

export class Cancelled extends Error {
  constructor() {
    super('Cancelled');
  }
}

export const cancellable = <T>(signal: AbortSignal, fn: () => Promise<T>): Promise<T> =>
  scope.run(signal, async () => {
    try {
      return await fn();
    } catch (e) {
      throw signal.aborted ? new Cancelled() : e;
    }
  });

/** The signal of the install this code runs in, if any. */
export const currentSignal = (): AbortSignal | undefined => scope.getStore();

/** Kills `child` (and what it started) when the current install is cancelled. */
export function killOnCancel(child: ChildProcess): void {
  const signal = currentSignal();
  if (!signal) return;
  const kill = () => child.pid && killTree(child.pid, 'SIGTERM');
  if (signal.aborted) kill();
  else {
    signal.addEventListener('abort', kill, { once: true });
    child.once('exit', () => signal.removeEventListener('abort', kill));
  }
}
