import type { RemoteBun, RemoteGo, RemoteNode, RemotePhp, RuntimeKind, RuntimeUpdate } from '@shared/types';
import { compare } from './node';

interface Installed {
  version: string;
  source: string;
}

export interface RemoteLists {
  node?: RemoteNode[];
  bun?: RemoteBun[];
  go?: RemoteGo[];
  php?: RemotePhp[];
}

export interface InstalledLists {
  node: Installed[];
  bun: Installed[];
  go: Installed[];
  php: Installed[];
}

export interface Defaults {
  node: string | null;
  bun: string | null;
  go: string | null;
  php: string | null;
}

const minorOf = (v: string) => v.replace(/^v/, '').split('.').slice(0, 2).join('.');

/** The release that replaces `v` without changing what the project relies on (same major for Node, same minor for Go/PHP, newest Bun). */
function successor(kind: RuntimeKind, v: string, remote: RemoteLists): string | null {
  switch (kind) {
    case 'node':
      return remote.node?.find((r) => r.major === Number(v.replace(/^v/, '').split('.')[0]))?.version ?? null;
    case 'bun':
      return remote.bun?.[0]?.version ?? null;
    case 'go':
      return remote.go?.find((r) => r.minor === minorOf(v))?.version ?? null;
    case 'php':
      return remote.php?.find((r) => r.minor === minorOf(v))?.version ?? null;
  }
}

/**
 * Newer patch releases for installed runtimes. Laravel Herd's read-only
 * copies get a DevCatz copy of the newer release.
 */
export function findUpdates(installed: InstalledLists, remote: RemoteLists, defaults: Defaults): RuntimeUpdate[] {
  const out: RuntimeUpdate[] = [];
  for (const kind of ['php', 'go', 'bun', 'node'] as RuntimeKind[]) {
    const list = installed[kind];
    const have = new Set(list.map((i) => i.version));
    const seen = new Set<string>();
    for (const i of list) {
      // The user's own installs (Homebrew, ~/.bun) are updated by their own tool.
      if (i.source === 'system' || i.source === 'homebrew') continue;
      const to = successor(kind, i.version, remote);
      if (!to || have.has(to) || seen.has(to) || compare(to, i.version) <= 0) continue;
      // Only the newest installed copy of a line gets the offer (8.4.21 and 8.4.22 → one update).
      if (list.some((o) => o !== i && successor(kind, o.version, remote) === to && compare(o.version, i.version) > 0)) continue;
      seen.add(to);
      out.push({ runtime: kind, from: i.version, to, isDefault: defaults[kind] === i.version });
    }
  }
  return out;
}
