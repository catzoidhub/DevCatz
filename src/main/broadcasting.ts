import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { BroadcastCheck, BroadcastEvent } from '@shared/types';

/**
 * Laravel broadcasting, read from the app's files: the events that broadcast
 * (ShouldBroadcast / ShouldBroadcastNow) with their channels and names, the
 * channel routes (routes/channels.php), and checks of the setup (connection,
 * channel routes registered, Echo, allowed origins).
 */

const read = (f: string) => {
  try {
    return readFileSync(f, 'utf8');
  } catch {
    return '';
  }
};

/** PHP files below `dir` (vendor and node_modules skipped), at most `max`. */
function phpFiles(dir: string, max = 800, out: string[] = []): string[] {
  if (!existsSync(dir) || out.length >= max) return out;
  for (const e of readdirSync(dir)) {
    if (out.length >= max) break;
    const p = join(dir, e);
    if (e === 'vendor' || e === 'node_modules' || e.startsWith('.')) continue;
    const st = statSync(p);
    if (st.isDirectory()) phpFiles(p, max, out);
    else if (e.endsWith('.php')) out.push(p);
  }
  return out;
}

const CHANNEL = /new\s+(Private|Presence|Encrypted)?(?:Private)?Channel\(\s*(['"])(.*?)\2\s*(?:\.\s*([^)]+))?\)/g;

export function scanEvents(root: string): BroadcastEvent[] {
  const out: BroadcastEvent[] = [];
  for (const f of phpFiles(join(root, 'app'))) {
    const src = read(f);
    if (!/implements[^{]*ShouldBroadcast/.test(src)) continue;
    const cls = src.match(/class\s+(\w+)/)?.[1];
    if (!cls) continue;
    const ns = src.match(/namespace\s+([\w\\]+);/)?.[1];
    const body = src.match(/function\s+broadcastOn\s*\([^)]*\)[^{]*\{([\s\S]*?)\n\s{4}\}/)?.[1] ?? '';
    const channels = [...body.matchAll(CHANNEL)].map((m) => ({
      type: (m[1] === 'Presence' ? 'presence' : m[1] === 'Private' || m[1] === 'Encrypted' ? 'private' : 'public') as BroadcastEvent['channels'][number]['type'],
      // `'orders.'.$this->order->id` → orders.{…}
      name: `${m[3]}${m[4] ? '{…}' : ''}`,
    }));
    const as = src.match(/function\s+broadcastAs\s*\([^)]*\)[^{]*\{[\s\S]*?return\s+(['"])(.*?)\1/)?.[2] ?? null;
    out.push({
      class: ns ? `${ns}\\${cls}` : cls,
      file: relative(root, f),
      channels,
      as,
      now: /ShouldBroadcastNow/.test(src),
    });
  }
  return out.sort((a, b) => a.class.localeCompare(b.class));
}

/** Broadcast::channel('orders.{id}', …) definitions. */
export function channelRoutes(root: string): { name: string; type: 'private' | 'presence' }[] {
  const src = read(join(root, 'routes', 'channels.php'));
  return [...src.matchAll(/Broadcast::channel\(\s*(['"])(.*?)\1/g)].map((m) => ({
    name: m[2],
    // Presence callbacks return an array (user info); private ones a bool. A heuristic for the label only.
    type: /return\s*\[/.test(src.slice(m.index ?? 0, (m.index ?? 0) + 400)) ? 'presence' : 'private',
  }));
}

/** Checks that only need the files. */
export function staticChecks(root: string, env: Record<string, string>, reverbOn: boolean): BroadcastCheck[] {
  const conn = env.BROADCAST_CONNECTION || env.BROADCAST_DRIVER || '';
  const boot = read(join(root, 'bootstrap', 'app.php'));
  const providers = read(join(root, 'app', 'Providers', 'BroadcastServiceProvider.php'));
  const channelsRegistered = /channels\s*:/.test(boot) || /->withBroadcasting\(/.test(boot) || /Broadcast::routes\(/.test(providers);
  const echoFile = ['resources/js/echo.js', 'resources/js/echo.ts', 'resources/js/bootstrap.js', 'resources/js/bootstrap.ts'].find((f) => /new\s+Echo\(/.test(read(join(root, f))));
  const reverbConf = read(join(root, 'config', 'reverb.php'));
  const origins = reverbConf.match(/'allowed_origins'\s*=>\s*\[([^\]]*)\]/)?.[1]?.trim() ?? null;
  const checks: BroadcastCheck[] = [
    {
      id: 'connection',
      label: 'Broadcast connection',
      ok: ['reverb', 'pusher', 'ably'].includes(conn),
      detail: conn ? `BROADCAST_CONNECTION=${conn}${['log', 'null'].includes(conn) ? ' (events are not sent anywhere)' : ''}` : 'BROADCAST_CONNECTION is not set (php artisan install:broadcasting)',
    },
    {
      id: 'channels',
      label: 'Channel routes registered',
      ok: channelsRegistered,
      detail: channelsRegistered ? 'routes/channels.php is loaded (/broadcasting/auth exists)' : 'Add channels: __DIR__.\'/../routes/channels.php\' to withRouting() in bootstrap/app.php',
    },
    {
      id: 'echo',
      label: 'Laravel Echo in the front end',
      ok: echoFile ? true : null,
      detail: echoFile ? `new Echo(…) in ${echoFile}` : 'No new Echo(…) found in resources/js (fine for API-only apps)',
    },
  ];
  if (conn === 'reverb' || reverbOn) {
    checks.push({
      id: 'origins',
      label: 'Reverb allowed origins',
      ok: origins === null ? null : /'\*'/.test(origins) || origins.length > 0,
      detail: origins === null ? 'config/reverb.php not found' : `[${origins}]${/'\*'/.test(origins) ? ' (any page)' : ' — the site’s https:// origin must be listed'}`,
    });
  }
  return checks;
}
