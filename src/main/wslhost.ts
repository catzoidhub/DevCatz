import { connect, createServer, type Server } from 'node:net';
import { networkInterfaces } from 'node:os';
import { run } from './env';
import { isWin } from './platform';

/**
 * Windows: DevCatz's listeners that gateway containers call back — the mail catcher (SMTP, Postal relays to it), the
 * SMS catcher (SMPP, Jasmin) and the WhatsApp webhook receiver (WAHA) — listen on 127.0.0.1. Containers on DoCatz's
 * engine come from WSL 2's network (NAT), where host.docker.internal is Windows' address on that network, not its
 * loopback. Each such port is also opened on that address — which only WSL's VMs reach, not the LAN — and passed
 * through to 127.0.0.1.
 */

/** Windows' address on WSL's network (the `vEthernet (WSL…)` adapter); null when WSL has not started. */
export function wslHostAddress(): string | null {
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    if (!/^vEthernet \(WSL/i.test(name)) continue;
    const a = addrs?.find((x) => x.family === 'IPv4' && !x.internal);
    if (a) return a.address;
  }
  return null;
}

const forwards = new Map<number, { addr: string; server: Server }>();

/** Opens `port` on Windows' WSL address too, passed through to 127.0.0.1:`port` (again when that address changed). */
export function forwardFromWsl(port: number): Promise<void> {
  if (!isWin || !port) return Promise.resolve();
  const addr = wslHostAddress();
  const cur = forwards.get(port);
  if (!addr || cur?.addr === addr) return Promise.resolve();
  cur?.server.close();
  forwards.delete(port);
  const server = createServer((sock) => {
    const up = connect(port, '127.0.0.1');
    const end = () => (sock.destroy(), up.destroy());
    sock.on('error', end);
    up.on('error', end);
    sock.pipe(up).pipe(sock);
  });
  return new Promise((resolve) => {
    server.once('error', (e) => {
      console.warn(`WSL pass-through ${addr}:${port}:`, e.message);
      resolve();
    });
    server.listen(port, addr, () => {
      forwards.set(port, { addr, server });
      resolve();
    });
  });
}

export function unforwardFromWsl(port: number): void {
  forwards.get(port)?.server.close();
  forwards.delete(port);
}

/**
 * Whether a container on DoCatz's engine reaches `port` on Windows (probed from DoCatz's WSL distro, as a container
 * would go); null when it cannot be told (no WSL address, the distro not there).
 */
export async function wslReaches(port: number): Promise<boolean | null> {
  const addr = wslHostAddress();
  if (!isWin || !addr) return null;
  const r = await run('wsl.exe', ['-d', 'docatz', '-e', 'nc', '-z', '-w', '3', addr, String(port)], { timeout: 15_000 });
  return r.code === 0 ? true : r.code === 1 ? false : null;
}

/** Plain words for a callback port containers cannot reach on Windows (Windows Firewall, which asks once per app). */
export const firewallWords = (what: string, port: number) =>
  `Containers in DoCatz cannot reach DevCatz's ${what} (port ${port}): Windows Firewall blocks DevCatz on WSL's network. Allow DevCatz on Public networks (Windows Security → Firewall & network protection → Allow an app through firewall), then start it again`;
