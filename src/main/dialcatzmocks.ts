import { app } from 'electron';
import { readFileSync, unwatchFile, watchFile } from 'node:fs';
import { join } from 'node:path';

/**
 * DialCatz's mock servers (DialCatz #94 "Mock from the spec"): DialCatz lists the ones running in its bridge.json
 * (`mocks: [{ name, slug, workspaceId, collectionId, url, port, startedAt }]`, rewritten at every start / stop, emptied
 * when it quits). Each gets a local name here, `<slug>.dialcatz.<default domain>` (user, 2026-11-20: like DoCatz's
 * `<service>.<project>.docatz.<tld>`, and a site named "mock" keeps mock.<tld>), served by DevCatz's proxy over HTTP
 * and HTTPS to 127.0.0.1:<port>. Started and stopped in DialCatz only. DIALCATZ_BRIDGE points elsewhere, for tests.
 */
export interface DialcatzMock {
  /** `<workspaceId>/<collectionId>`: the same mock across restarts (its own domain is kept under it). */
  key: string;
  name: string;
  /** A DNS label, unique among the mocks (a second "shop-api" becomes "shop-api-2"); the user's own when set. */
  slug: string;
  /** DialCatz's own slug for it, before the user's name or a -2. */
  defaultSlug: string;
  port: number;
  workspaceId: string;
  collectionId: string;
  startedAt: number | null;
  /** Started from a DevCatz site's spec (DevCatz's API tab → Create mock server): that site, and the spec's path in it. */
  siteId: string | null;
  specFile: string | null;
}

const bridgeFile = () => process.env.DIALCATZ_BRIDGE || join(app.getPath('appData'), 'DialCatz', 'bridge.json');

/** A DNS label from DialCatz's slug (or name): lowercase letters, digits and hyphens, at most 50. */
export function label(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 50)
    .replace(/-$/, '');
}

export function parseMocks(text: string, own: Record<string, string> = {}): DialcatzMock[] {
  let doc: { mocks?: unknown };
  try {
    doc = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch {
    return [];
  }
  if (!Array.isArray(doc?.mocks)) return [];
  const out: (DialcatzMock & { i: number })[] = [];
  const str = (v: unknown) => (typeof v === 'string' ? v.slice(0, 200) : '');
  // The user's own names first, so a DialCatz slug that collides gets the -2, not the name the user picked.
  const rows = (doc.mocks as Record<string, unknown>[]).map((m, i) => {
    const workspaceId = str(m?.workspaceId);
    const collectionId = str(m?.collectionId);
    const key = `${workspaceId}/${collectionId}`;
    return { i, m, key, workspaceId, collectionId, mine: label(own[key] ?? '') };
  });
  for (const r of [...rows.filter((x) => x.mine), ...rows.filter((x) => !x.mine)]) {
    const { m } = r;
    const port = Number(m?.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) continue;
    const name = typeof m.name === 'string' && m.name.trim() ? m.name.trim().slice(0, 80) : 'Mock server';
    const defaultSlug = label(str(m.slug)) || label(name) || 'mock';
    const base = r.mine || defaultSlug;
    let slug = base;
    for (let n = 2; out.some((x) => x.slug === slug); n++) slug = `${base}-${n}`;
    const startedAt = Number(m.startedAt);
    const siteId = /^[\w-]{1,64}$/.test(str(m.siteId)) ? str(m.siteId) : null;
    const specFile = str(m.specFile).replace(/\\/g, '/') || null;
    out.push({ siteId, specFile, i: r.i, key: r.key, name, slug, defaultSlug, port, workspaceId: r.workspaceId, collectionId: r.collectionId, startedAt: Number.isFinite(startedAt) && startedAt > 0 ? startedAt : null });
  }
  // Back in DialCatz's order.
  return out.sort((a, b) => a.i - b.i).map(({ i: _, ...m }) => m);
}

export class DialcatzMocks {
  private mocks: DialcatzMock[] = [];
  private key = '[]';
  private timer: ReturnType<typeof setTimeout> | null = null;
  private file = '';
  private text = '';
  /** Called when the list changed (routes and the window follow). */
  onChange: () => void = () => undefined;
  /** The user's own names (settings.mockDomains), by key. */
  own: () => Record<string, string> = () => ({});

  list(): DialcatzMock[] {
    return this.mocks;
  }

  /**
   * watchFile, not watch: it survives DialCatz's atomic rename and a folder that does not exist yet (DialCatz not
   * installed). Polled every 2 s; a change is read once things settle.
   */
  start(): void {
    this.file = bridgeFile();
    this.read();
    watchFile(this.file, { interval: 2000 }, () => {
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(() => this.read(), 300);
    });
  }

  stop(): void {
    if (this.file) unwatchFile(this.file);
    if (this.timer) clearTimeout(this.timer);
  }

  private read(): void {
    let text = '';
    try {
      text = readFileSync(this.file, 'utf8');
    } catch {
      /* DialCatz not installed, or not started yet */
    }
    this.text = text;
    this.apply();
  }

  /** The user named one: the list again from the last file. */
  apply(): void {
    const mocks = parseMocks(this.text, this.own());
    const key = JSON.stringify(mocks);
    if (key === this.key) return;
    this.key = key;
    this.mocks = mocks;
    this.onChange();
  }
}
