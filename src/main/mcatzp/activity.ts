import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { LogEntry } from '@catzoid/mcatzp-host';
import { maskText } from '../ai/devcatz';

const KEEP = 1000;

/**
 * The activity log (TODO §33): every call a client made and how it ended, one JSON object per line, owner-only. Holds
 * action names and outcomes, never arguments or results; a failure's message is masked like everything else.
 */
export class ActivityLog {
  private entries: LogEntry[] = [];

  constructor(private readonly file: string) {
    try {
      if (existsSync(file)) this.entries = readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as LogEntry).slice(-KEEP);
    } catch (e) {
      console.warn('MCatzP activity log:', (e as Error).message);
    }
  }

  add(entry: LogEntry): void {
    const e = entry.reason ? { ...entry, reason: maskText(entry.reason).slice(0, 300) } : entry;
    this.entries.push(e);
    try {
      if (this.entries.length > KEEP * 1.2) {
        this.entries = this.entries.slice(-KEEP);
        writeFileSync(this.file, this.entries.map((x) => JSON.stringify(x)).join('\n') + '\n', { mode: 0o600 });
      } else {
        appendFileSync(this.file, `${JSON.stringify(e)}\n`, { mode: 0o600 });
      }
    } catch (err) {
      console.warn('MCatzP activity log:', (err as Error).message);
    }
  }

  /** The newest first. */
  list(limit = 100): LogEntry[] {
    return this.entries.slice(-limit).reverse();
  }

  clear(): void {
    this.entries = [];
    try {
      writeFileSync(this.file, '', { mode: 0o600 });
    } catch (e) {
      console.warn('MCatzP activity log:', (e as Error).message);
    }
  }
}
