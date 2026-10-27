import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { request } from 'node:https';
import { run } from './env';
import { isWin } from './platform';
import { PING_PATH } from './proxy';

/**
 * URLs without a port ("clean URLs").
 *
 * Laravel Herd's nginx listens on 127.0.0.1:80/443 only. macOS (and Chromium,
 * Safari, curl) resolve `*.localhost` to ::1 first, so DevCatz takes the
 * IPv6 loopback instead and never touches Herd's IPv4 sockets.
 *
 * An unprivileged process cannot bind [::1]:443, so launchd does it: a
 * LaunchDaemon declares the listening socket and, inetd-style, starts
 * `/usr/bin/nc ::1 <proxy port>` for every accepted connection, running as
 * `nobody`. nc only relays bytes (TLS stays end-to-end with the proxy), and
 * everything involved is a root-owned system binary or plist.
 *
 * (pf `rdr` rules were tried first: on macOS 26 they are not applied to
 * loopback traffic, even for plain IPv4.)
 */
const LABEL = 'com.mrcatz.herd.forward';
const daemonFile = (scheme: 'https' | 'http') => `/Library/LaunchDaemons/${LABEL}-${scheme}.plist`;

// Leftovers of the earlier pf-based version, removed on install/uninstall.
const LEGACY = {
  anchor: 'com.apple/mrcatz-herd',
  files: ['/etc/pf.anchors/com.mrcatz.herd', '/Library/LaunchDaemons/com.mrcatz.herd.pf.plist'],
  label: 'com.mrcatz.herd.pf',
};

function plist(scheme: 'https' | 'http', listenPort: number, targetPort: number, ipv4: boolean): string {
  // IPv4 only once nothing else (Laravel Herd's nginx) owns 127.0.0.1:<port>; launchd fails the job otherwise.
  const v4 = ipv4
    ? `
    <key>ListenersV4</key>
    <dict>
      <key>SockNodeName</key><string>127.0.0.1</string>
      <key>SockServiceName</key><string>${listenPort}</string>
      <key>SockFamily</key><string>IPv4</string>
    </dict>`
    : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}-${scheme}</string>
  <key>ProgramArguments</key>
  <array><string>/usr/bin/nc</string><string>::1</string><string>${targetPort}</string></array>
  <key>UserName</key><string>nobody</string>
  <key>inetdCompatibility</key><dict><key>Wait</key><false/></dict>
  <key>Sockets</key>
  <dict>
    <key>Listeners</key>
    <dict>
      <key>SockNodeName</key><string>::1</string>
      <key>SockServiceName</key><string>${listenPort}</string>
      <key>SockFamily</key><string>IPv6</string>
    </dict>${v4}
  </dict>
</dict>
</plist>
`;
}

/** Runs a shell script as root through the standard macOS admin password dialog. */
async function runAsAdmin(script: string, prompt: string): Promise<{ ok: boolean; message: string }> {
  // Base64 keeps quoting out of AppleScript's string literal entirely.
  const b64 = Buffer.from(script).toString('base64');
  const apple = `do shell script "echo ${b64} | /usr/bin/base64 -D | /bin/sh" with prompt "${prompt}" with administrator privileges`;
  const { code, stdout, stderr } = await run('osascript', ['-e', apple], { timeout: 300_000 });
  return { ok: code === 0, message: (stderr || stdout).trim() };
}

// ------------------------------------------------------------- Windows

/**
 * Windows: the IP Helper service's port proxy (`netsh interface portproxy`) takes 443 / 80 on [::1] and, when nothing
 * else listens there, 127.0.0.1, and relays to the proxy. The rules live in the registry and survive restarts; adding
 * them needs administrator rights once (UAC).
 */
type WinRule = { family: 'v4tov4' | 'v6tov6'; listen: string; port: number; target: number };
let winRules: WinRule[] = [];

/** Reads DevCatz's forwards (listen port 443 / 80 on a loopback address) from `netsh … show all`. */
async function refreshWinRules(): Promise<void> {
  const out = (await run('netsh', ['interface', 'portproxy', 'show', 'all'], { timeout: 10_000 })).stdout;
  const rules: WinRule[] = [];
  for (const line of out.split(/\r?\n/)) {
    const m = line.trim().match(/^(127\.0\.0\.1|::1)\s+(\d+)\s+(127\.0\.0\.1|::1)\s+(\d+)$/);
    if (!m || !['443', '80'].includes(m[2])) continue;
    rules.push({ family: m[1] === '::1' ? 'v6tov6' : 'v4tov4', listen: m[1], port: Number(m[2]), target: Number(m[4]) });
  }
  winRules = rules;
}

/** Runs PowerShell as administrator (the UAC prompt); the script goes in base64 so no quoting reaches the shell. */
async function runAsAdminWin(script: string): Promise<{ ok: boolean; message: string }> {
  const inner = Buffer.from(`$ErrorActionPreference = 'Stop'\n${script}`, 'utf16le').toString('base64');
  const outer = `try { $p = Start-Process powershell.exe -Verb RunAs -Wait -PassThru -WindowStyle Hidden -ArgumentList '-NoProfile','-EncodedCommand','${inner}'; exit $p.ExitCode } catch { Write-Error $_.Exception.Message; exit 1223 }`;
  const { code, stdout, stderr } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', outer], { timeout: 300_000 });
  const message = (stderr || stdout).trim();
  // 1223 = ERROR_CANCELLED: the UAC prompt was declined. Reported as -128 like macOS's "User canceled".
  return { ok: code === 0, message: code === 1223 || /cancel/i.test(message) ? '-128 Cancelled' : message || `exit ${code}` };
}

const winDelete = (r: Pick<WinRule, 'family' | 'listen' | 'port'>) =>
  `netsh interface portproxy delete ${r.family} listenaddress=${r.listen} listenport=${r.port} | Out-Null`;

function installWin(httpsPort: number, httpPort: number, ipv4: { https: boolean; http: boolean }) {
  const lines = ['Set-Service iphlpsvc -StartupType Automatic', 'Start-Service iphlpsvc'];
  for (const r of winRules) lines.push(winDelete(r));
  for (const [listen, target, scheme] of [
    [443, httpsPort, 'https'],
    [80, httpPort, 'http'],
  ] as const) {
    lines.push(`netsh interface portproxy add v6tov6 listenaddress=::1 listenport=${listen} connectaddress=::1 connectport=${target} | Out-Null`);
    if (ipv4[scheme]) lines.push(`netsh interface portproxy add v4tov4 listenaddress=127.0.0.1 listenport=${listen} connectaddress=127.0.0.1 connectport=${target} | Out-Null`);
  }
  return runAsAdminWin(lines.join('\n')).finally(refreshWinRules);
}

function uninstallWin() {
  if (!winRules.length) return Promise.resolve({ ok: true, message: '' });
  return runAsAdminWin(winRules.map(winDelete).join('\n')).finally(refreshWinRules);
}

export function cleanUrlsInstalled(): boolean {
  if (isWin) return winRules.some((r) => r.port === 443);
  return existsSync(daemonFile('https'));
}

/** The installed forwarder also listens on 127.0.0.1 (after Laravel Herd is gone). */
export function cleanUrlsCoverIpv4(): boolean {
  if (isWin) return winRules.some((r) => r.port === 443 && r.family === 'v4tov4');
  try {
    return readFileSync(daemonFile('https'), 'utf8').includes('<string>127.0.0.1</string>');
  } catch {
    return false;
  }
}

/** Checks the forward end to end: https://[::1]/ must be answered by our proxy. */
export async function cleanUrlsWorking(): Promise<boolean> {
  if (isWin) await refreshWinRules();
  return new Promise((resolve) => {
    const req = request(
      { host: '::1', port: 443, path: PING_PATH, servername: 'localhost', rejectUnauthorized: false, timeout: 1500 },
      (res) => {
        res.resume();
        resolve(res.headers['x-mrcatz-herd'] === '1');
      },
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

/** Same check for the plain-HTTP forward: http://[::1]/ answered by our proxy. */
export function cleanHttpWorking(): Promise<boolean> {
  return new Promise((resolve) => {
    const req = httpRequest({ host: '::1', port: 80, path: PING_PATH, timeout: 1500 }, (res) => {
      res.resume();
      resolve(res.headers['x-mrcatz-herd'] === '1');
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

const removeLegacy = `/bin/launchctl bootout system/${LEGACY.label} 2>/dev/null || true
/sbin/pfctl -a ${LEGACY.anchor} -F all >/dev/null 2>/dev/null || true
rm -f ${LEGACY.files.join(' ')}
`;

const removeDaemons = (['https', 'http'] as const)
  .map((s) => `/bin/launchctl bootout system/${LABEL}-${s} 2>/dev/null || true\nrm -f ${daemonFile(s)}\n`)
  .join('');

export function installCleanUrls(httpsPort: number, httpPort: number, ipv4: { https: boolean; http: boolean }) {
  if (isWin) return installWin(httpsPort, httpPort, ipv4);
  const write = (scheme: 'https' | 'http', listen: number, target: number) => `cat > ${daemonFile(scheme)} <<'MRCATZ_EOF'
${plist(scheme, listen, target, ipv4[scheme])}MRCATZ_EOF
chown root:wheel ${daemonFile(scheme)}
chmod 644 ${daemonFile(scheme)}
`;
  const script = `set -e
${removeLegacy}${removeDaemons}${write('https', 443, httpsPort)}/bin/launchctl bootstrap system ${daemonFile('https')}
${write('http', 80, httpPort)}# Port 80 is best effort: another server (e.g. macOS Apache on *:80) may block it.
/bin/launchctl bootstrap system ${daemonFile('http')} 2>/dev/null || { /bin/launchctl bootout system/${LABEL}-http 2>/dev/null; rm -f ${daemonFile('http')}; echo "http forward skipped"; }
`;
  return runAsAdmin(script, 'DevCatz wants to forward [::1]:443 and :80 to its local proxy so URLs work without a port.');
}

export function uninstallCleanUrls() {
  if (isWin) return uninstallWin();
  return runAsAdmin(`${removeDaemons}${removeLegacy}`, 'DevCatz wants to remove its port forwarding.');
}

// ------------------------------------------------------------- DNS resolver

const RESOLVER_MARK = '# Managed by DevCatz';
/** Files written before the rename are ours too. */
const RESOLVER_MARKS = [RESOLVER_MARK, '# Managed by MrCatz Herd'];
const resolverFile = (tld: string) => `/etc/resolver/${tld}`;

/** `ours` = our file, `foreign` = someone else's (e.g. Laravel Herd's dnsmasq for .test), `none` = absent. */
export function resolverStatus(tld: string): 'ours' | 'foreign' | 'none' {
  try {
    return RESOLVER_MARKS.some((m) => readFileSync(resolverFile(tld), 'utf8').includes(m)) ? 'ours' : 'foreign';
  } catch {
    return 'none';
  }
}

/** /etc/resolver/<tld> → DevCatz's DNS on 127.0.0.1:<port>; refuses to replace a file it does not own. */
export function installResolver(tld: string, port: number) {
  if (!/^[a-z][a-z0-9-]{0,30}$/.test(tld)) throw new Error(`Invalid TLD ${tld}`);
  if (resolverStatus(tld) === 'foreign') throw new Error(`/etc/resolver/${tld} belongs to another tool. Remove that tool's resolver first.`);
  const script = `set -e
mkdir -p /etc/resolver
cat > ${resolverFile(tld)} <<'MRCATZ_EOF'
${RESOLVER_MARK}
nameserver 127.0.0.1
port ${port}
MRCATZ_EOF
chmod 644 ${resolverFile(tld)}
/usr/bin/killall -HUP mDNSResponder 2>/dev/null || true
`;
  return runAsAdmin(script, `DevCatz wants to resolve *.${tld} to this Mac.`);
}

export function uninstallResolver(tld: string) {
  if (resolverStatus(tld) !== 'ours') return Promise.resolve({ ok: true, message: '' });
  return runAsAdmin(`rm -f ${resolverFile(tld)}\n/usr/bin/killall -HUP mDNSResponder 2>/dev/null || true\n`, `DevCatz wants to stop resolving *.${tld}.`);
}

/**
 * Uninstall DevCatz (Catzoid #55): what DevCatz put in system folders — the clean-URL LaunchDaemons (and the older
 * pf leftovers) and every /etc/resolver file it manages — in one admin prompt. Null when there is nothing to remove.
 */
export function systemLeftovers(): string[] {
  if (isWin) return winRules.map((r) => `Port forward ${r.listen.includes(':') ? `[${r.listen}]` : r.listen}:${r.port} → ${r.target}`);
  const out: string[] = [];
  for (const s of ['https', 'http'] as const) if (existsSync(daemonFile(s))) out.push(daemonFile(s));
  for (const f of LEGACY.files) if (existsSync(f)) out.push(f);
  try {
    for (const t of readdirSync('/etc/resolver')) if (resolverStatus(t) === 'ours') out.push(resolverFile(t));
  } catch {
    /* no /etc/resolver */
  }
  return out;
}

export function removeSystemLeftovers() {
  if (isWin) return uninstallWin();
  const resolvers = systemLeftovers().filter((f) => f.startsWith('/etc/resolver/'));
  const script = `${removeDaemons}${removeLegacy}${resolvers.map((f) => `rm -f ${f}\n`).join('')}/usr/bin/killall -HUP mDNSResponder 2>/dev/null || true\n`;
  return runAsAdmin(script, 'DevCatz wants to remove its port forwarding and DNS resolver files before it is uninstalled.');
}

