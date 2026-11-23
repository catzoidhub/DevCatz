import { randomBytes } from 'node:crypto';
import { connect } from 'node:net';
import type { ProxyEntry, ProxyInput, ProxyState } from '@shared/types';
import type { Route } from './proxy';
import { store, tld } from './store';

/**
 * Proxies and redirects (TODO §49): friendly names under the default domain for servers elsewhere, so their addresses
 * need no remembering.
 * - proxy: `proxmox-prod.<tld>` stays in the address bar; DevCatz's proxy forwards to protocol + host + port (HTTP and
 *   WebSocket). The target may use its own (self-signed) certificate; the Host header is the target's unless told
 *   otherwise.
 * - redirect: `dokploy-prod.<tld>` sends the browser to the real address (path kept), so logins and cookies stay there.
 * Nothing is opened on the target that this computer could not reach already.
 */

const NAME_RE = /^[a-z0-9]([a-z0-9-]{0,48}[a-z0-9])?$/;
// A hostname or an IPv4 / bracketless IPv6 address; no scheme, path or port.
const HOST_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$|^[0-9a-f:]{2,39}$/i;

export interface RemotesDeps {
  /** Who else answers on this host (a site, a service, a web tool), or null. */
  domainOwner(host: string): string | null;
  urlOf(host: string): string;
  /** DevCatz's own proxy ports: a proxy to them would loop. */
  ownPorts(): number[];
}

export class Remotes {
  private reach = new Map<string, boolean>();
  onChange: () => void = () => undefined;

  constructor(private deps: RemotesDeps) {}

  list(): ProxyEntry[] {
    return store.settings.proxies ?? [];
  }
  private save(list: ProxyEntry[]): void {
    store.updateSettings({ proxies: list });
    this.onChange();
  }
  private hostOf(e: { name: string }): string {
    return `${e.name}.${tld()}`;
  }
  /** `https://10.10.10.10:8443` (proxy) or the redirect's address. */
  private targetOf(e: ProxyEntry): string {
    if (e.mode === 'redirect') return e.url ?? '';
    const host = e.host?.includes(':') ? `[${e.host}]` : (e.host ?? '');
    const std = (e.protocol === 'https' && e.port === 443) || (e.protocol === 'http' && e.port === 80);
    return `${e.protocol ?? 'https'}://${host}${std ? '' : `:${e.port}`}`;
  }

  /** The entry that owns this host, as words for a message; null when none does. */
  ownerOf(host: string, except?: string): string | null {
    const e = this.list().find((x) => x.id !== except && this.hostOf(x) === host.trim().toLowerCase());
    return e ? `the ${e.mode} ${e.name}` : null;
  }

  /** A message per field for the form, null when fine. */
  validate(input: ProxyInput, id?: string): { name: string | null; target: string | null } {
    const name = String(input.name ?? '').trim().toLowerCase();
    let nameMsg: string | null = null;
    if (!NAME_RE.test(name)) nameMsg = 'Lowercase letters, digits and hyphens';
    else {
      const host = `${name}.${tld()}`;
      const owner = this.deps.domainOwner(host) ?? this.ownerOf(host, id);
      if (owner) nameMsg = `${host} is already ${owner}`;
    }
    let target: string | null = null;
    if (input.mode === 'redirect') {
      try {
        const u = new URL(String(input.url ?? '').trim());
        if (u.protocol !== 'https:' && u.protocol !== 'http:') target = 'An address that starts with https:// or http://';
        else if (u.username || u.password) target = 'No user or password in the address';
        else if (u.hostname === `${name}.${tld()}`) target = 'It would redirect to itself';
      } catch {
        target = 'A full address, such as https://dokploy.example.com';
      }
    } else {
      const host = String(input.host ?? '').trim();
      const port = Number(input.port);
      if (!HOST_RE.test(host)) target = 'An IP address or host name, without https:// or a port';
      else if (!Number.isInteger(port) || port < 1 || port > 65535) target = 'A port from 1 to 65535';
      else if (['127.0.0.1', 'localhost', '::1'].includes(host.toLowerCase()) && this.deps.ownPorts().includes(port)) target = "That is DevCatz's own proxy: it would loop";
      else if (host.toLowerCase().endsWith(`.${tld()}`)) target = `A name under .${tld()} is on this computer already: give the real address`;
    }
    return { name: nameMsg, target };
  }

  private clean(input: ProxyInput, id?: string): Omit<ProxyEntry, 'id'> {
    const v = this.validate(input, id);
    if (v.name || v.target) throw new Error([v.name, v.target].filter(Boolean).join('. '));
    const base = { name: input.name.trim().toLowerCase(), group: String(input.group ?? '').trim().slice(0, 40), favorite: input.favorite === true };
    if (input.mode === 'redirect') return { ...base, mode: 'redirect', url: new URL(String(input.url).trim()).toString() };
    const port = Number(input.port);
    // The usual TLS ports mean HTTPS unless told otherwise.
    const protocol = input.protocol === 'http' || input.protocol === 'https' ? input.protocol : port === 80 || port === 8080 ? 'http' : 'https';
    return { ...base, mode: 'proxy', protocol, host: String(input.host).trim().toLowerCase(), port, insecure: input.insecure !== false, ownHost: input.ownHost === true };
  }

  add(input: ProxyInput): string {
    const id = `px-${randomBytes(4).toString('hex')}`;
    this.save([...this.list(), { id, ...this.clean(input) }]);
    void this.check();
    return id;
  }
  update(id: string, input: ProxyInput): void {
    if (!this.list().some((e) => e.id === id)) throw new Error('No such proxy');
    const next = { id, ...this.clean(input, id) };
    this.reach.delete(id);
    this.save(this.list().map((e) => (e.id === id ? next : e)));
    void this.check();
  }
  remove(id: string): void {
    this.reach.delete(id);
    this.save(this.list().filter((e) => e.id !== id));
  }

  /** The list's own order (drag and drop); ids it does not name keep their place at the end. */
  reorder(ids: string[]): void {
    const at = new Map(ids.map((id, i) => [id, i]));
    this.save([...this.list()].sort((a, b) => (at.get(a.id) ?? 1e6) - (at.get(b.id) ?? 1e6)));
  }

  /** Whether each proxy's target accepts a TCP connection (every 30 s; redirects are not checked). */
  async check(): Promise<void> {
    let dirty = false;
    await Promise.all(
      this.list()
        .filter((e) => e.mode === 'proxy')
        .map(async (e) => {
          const ok = await new Promise<boolean>((resolve) => {
            const s = connect({ host: e.host!, port: e.port!, timeout: 2500 });
            const done = (v: boolean) => {
              s.destroy();
              resolve(v);
            };
            s.once('connect', () => done(true));
            s.once('timeout', () => done(false));
            s.once('error', () => done(false));
          });
          if (this.reach.get(e.id) !== ok) dirty = true;
          this.reach.set(e.id, ok);
        }),
    );
    if (dirty) this.onChange();
  }

  state(): ProxyState[] {
    return this.list().map((e) => ({ ...e, domain: this.hostOf(e), address: this.deps.urlOf(this.hostOf(e)), target: this.targetOf(e), reachable: e.mode === 'proxy' ? (this.reach.get(e.id) ?? null) : null }));
  }

  routes(): Route[] {
    return this.list().map((e) =>
      e.mode === 'redirect'
        ? { domain: this.hostOf(e), port: null, projectName: e.name, running: true, secure: true, anyScheme: true, redirect: e.url! }
        : { domain: this.hostOf(e), port: null, projectName: e.name, running: true, secure: true, remote: { target: this.targetOf(e), insecure: e.insecure !== false, ownHost: e.ownHost === true } },
    );
  }
}
