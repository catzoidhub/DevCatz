import { X509Certificate, generateKeyPairSync, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createSecureContext, type SecureContext } from 'node:tls';
import forge from 'node-forge';
import { run } from './env';
import { isLinux, isWin } from './platform';
import { runAsRootLinux, shq } from './linuxadmin';
import { dataDir } from './store';

const CA_NAME = 'DevCatz Local CA';
const KEYCHAIN = join(homedir(), 'Library/Keychains/login.keychain-db'); // macOS only

/**
 * Linux: where the CA goes in the system store — Debian / Ubuntu (update-ca-certificates) or Fedora / RHEL / Arch
 * (update-ca-trust). Chrome and Firefox keep their own NSS databases on Linux, filled per user with certutil.
 */
const LINUX_STORES = [
  { dir: '/usr/local/share/ca-certificates', update: 'update-ca-certificates', bundle: '/etc/ssl/certs/ca-certificates.crt' },
  { dir: '/etc/pki/ca-trust/source/anchors', update: 'update-ca-trust', bundle: '/etc/pki/tls/certs/ca-bundle.crt' },
];
const LINUX_CA_FILE = 'devcatz-local-ca.crt';
const linuxStore = () => LINUX_STORES.find((s) => existsSync(s.dir)) ?? LINUX_STORES[0];

/** The NSS databases (cert9.db) browsers read on Linux: Chrome / Chromium's per user, Firefox's per profile (deb, snap, flatpak). */
function nssDatabases(): string[] {
  const h = homedir();
  const dbs = [join(h, '.pki', 'nssdb'), join(h, 'snap', 'chromium', 'current', '.pki', 'nssdb')].filter((d) => d === join(h, '.pki', 'nssdb') || existsSync(d));
  for (const root of [join(h, '.mozilla', 'firefox'), join(h, 'snap', 'firefox', 'common', '.mozilla', 'firefox'), join(h, '.var', 'app', 'org.mozilla.firefox', '.mozilla', 'firefox')]) {
    try {
      for (const p of readdirSync(root)) if (existsSync(join(root, p, 'cert9.db'))) dbs.push(join(root, p));
    } catch {
      /* no such Firefox */
    }
  }
  return dbs;
}

function certsDir(): string {
  const dir = dataDir('certs');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function newKeyPair(): { privateKey: forge.pki.rsa.PrivateKey; publicKey: forge.pki.rsa.PublicKey } {
  // Node's native keygen is far faster than forge's pure-JS one.
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  const key = forge.pki.privateKeyFromPem(privateKey) as forge.pki.rsa.PrivateKey;
  return { privateKey: key, publicKey: forge.pki.setRsaPublicKey(key.n, key.e) };
}

function serial(): string {
  // Positive 16-byte serial.
  const bytes = randomBytes(16);
  bytes[0] &= 0x7f;
  return bytes.toString('hex');
}

interface Pem {
  cert: string;
  key: string;
}

/**
 * Local certificate authority. The CA key never leaves the app's data
 * folder; leaf certificates are minted per domain on demand (SNI) and cached.
 */
export class CertManager {
  private ca: { cert: forge.pki.Certificate; key: forge.pki.rsa.PrivateKey; pem: Pem } | null = null;
  private contexts = new Map<string, SecureContext>();
  readonly caPath = join(certsDir(), 'ca.crt');
  /** The CA's key (0600, the user's only): named in Catzoid/shared.json so DoCatz can mint certificates with the same CA. */
  readonly caKeyPath = join(certsDir(), 'ca.key');

  ensureCa(): void {
    if (this.ca) return;
    if (existsSync(this.caPath) && existsSync(this.caKeyPath)) {
      const pem = { cert: readFileSync(this.caPath, 'utf8'), key: readFileSync(this.caKeyPath, 'utf8') };
      this.ca = {
        cert: forge.pki.certificateFromPem(pem.cert),
        key: forge.pki.privateKeyFromPem(pem.key) as forge.pki.rsa.PrivateKey,
        pem,
      };
      return;
    }
    const keys = newKeyPair();
    const cert = forge.pki.createCertificate();
    cert.publicKey = keys.publicKey;
    cert.serialNumber = serial();
    cert.validity.notBefore = new Date(Date.now() - 86_400_000);
    cert.validity.notAfter = new Date(Date.now() + 10 * 365 * 86_400_000);
    const attrs = [
      { name: 'commonName', value: CA_NAME },
      { name: 'organizationName', value: 'DevCatz' },
    ];
    cert.setSubject(attrs);
    cert.setIssuer(attrs);
    cert.setExtensions([
      { name: 'basicConstraints', cA: true, critical: true },
      { name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true },
      { name: 'subjectKeyIdentifier' },
    ]);
    cert.sign(keys.privateKey, forge.md.sha256.create());
    const pem = { cert: forge.pki.certificateToPem(cert), key: forge.pki.privateKeyToPem(keys.privateKey) };
    writeFileSync(this.caPath, pem.cert);
    writeFileSync(this.caKeyPath, pem.key, { mode: 0o600 });
    this.ca = { cert, key: keys.privateKey, pem };
  }

  caExists(): boolean {
    return existsSync(this.caPath);
  }

  /** Leaf certificate for one host name, reused from disk while valid. */
  private leaf(host: string): Pem {
    this.ensureCa();
    const base = join(certsDir(), host);
    if (existsSync(`${base}.crt`) && existsSync(`${base}.key`)) {
      const pem = { cert: readFileSync(`${base}.crt`, 'utf8'), key: readFileSync(`${base}.key`, 'utf8') };
      const cert = new X509Certificate(pem.cert);
      const ca = new X509Certificate(this.ca!.pem.cert);
      const fresh = new Date(cert.validTo).getTime() - Date.now() > 30 * 86_400_000;
      const sameCa = cert.checkIssued(ca) && cert.verify(ca.publicKey);
      if (fresh && sameCa) return pem;
    }
    const keys = newKeyPair();
    const cert = forge.pki.createCertificate();
    cert.publicKey = keys.publicKey;
    cert.serialNumber = serial();
    cert.validity.notBefore = new Date(Date.now() - 86_400_000);
    // Apple and Chrome reject server certificates valid for more than 398 days.
    cert.validity.notAfter = new Date(Date.now() + 397 * 86_400_000);
    cert.setSubject([{ name: 'commonName', value: host }]);
    cert.setIssuer(this.ca!.cert.subject.attributes);
    cert.setExtensions([
      { name: 'basicConstraints', cA: false },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
      { name: 'extKeyUsage', serverAuth: true },
      { name: 'subjectAltName', altNames: [{ type: 2, value: host }] },
      { name: 'subjectKeyIdentifier' },
      { name: 'authorityKeyIdentifier', keyIdentifier: this.ca!.cert.generateSubjectKeyIdentifier().getBytes() },
    ]);
    cert.sign(this.ca!.key, forge.md.sha256.create());
    const pem = { cert: forge.pki.certificateToPem(cert), key: forge.pki.privateKeyToPem(keys.privateKey) };
    writeFileSync(`${base}.crt`, pem.cert);
    writeFileSync(`${base}.key`, pem.key, { mode: 0o600 });
    return pem;
  }

  /** TLS context for SNI; `null` for names we do not serve. */
  contextFor(host: string): SecureContext {
    let ctx = this.contexts.get(host);
    if (!ctx) {
      const pem = this.leaf(host);
      ctx = createSecureContext({ cert: pem.cert + this.ca!.pem.cert, key: pem.key });
      this.contexts.set(host, ctx);
    }
    return ctx;
  }

  /** Fallback certificate for clients that send no SNI. */
  defaultPem(): Pem {
    return this.leaf('localhost');
  }

  /** SHA-1 thumbprint of the CA, as Windows' certificate store and the Keychain name it. */
  private thumbprint(): string {
    return forge.md.sha1
      .create()
      .update(forge.asn1.toDer(forge.pki.certificateToAsn1(forge.pki.certificateFromPem(readFileSync(this.caPath, 'utf8')))).getBytes())
      .digest()
      .toHex()
      .toUpperCase();
  }

  async isTrusted(): Promise<boolean> {
    if (!this.caExists()) return false;
    this.ensureCa();
    // Windows: the CA in the current user's Trusted Root store (Chrome and Edge read it).
    if (isWin) return (await run('certutil', ['-user', '-verifystore', 'Root', this.thumbprint()])).code === 0;
    if (isLinux) {
      // The system store (curl, PHP, git, Node with the system CAs …); the browsers' NSS copies are added with it.
      const probe = join(certsDir(), 'localhost.crt');
      this.leaf('localhost');
      return existsSync(join(linuxStore().dir, LINUX_CA_FILE)) && (await run('openssl', ['verify', '-CAfile', linuxStore().bundle, probe])).code === 0;
    }
    // Verify a leaf against the user's trust settings (not against the CA directly).
    const probe = join(certsDir(), 'localhost.crt');
    this.leaf('localhost');
    const { code } = await run('security', ['verify-cert', '-c', probe, '-p', 'ssl', '-s', 'localhost', '-q']);
    return code === 0;
  }

  /**
   * Adds the CA to the login keychain as a trusted root for the current
   * user. macOS shows its own password/Touch ID prompt for this.
   */
  async trust(): Promise<{ ok: boolean; message: string }> {
    this.ensureCa();
    if (isLinux) return this.trustLinux();
    if (isWin) {
      // The user's own store, no admin: Windows shows its "Install this certificate?" confirmation.
      const r = await run('certutil', ['-user', '-addstore', 'Root', this.caPath], { timeout: 120_000 });
      return { ok: r.code === 0, message: (r.stderr || r.stdout).trim() };
    }
    const { code, stderr } = await run(
      'security',
      ['add-trusted-cert', '-r', 'trustRoot', '-p', 'ssl', '-k', KEYCHAIN, this.caPath],
      { timeout: 120_000 },
    );
    return { ok: code === 0, message: stderr.trim() };
  }

  /**
   * Linux: one password (pkexec) puts the CA in the system store and, where apt can, installs certutil
   * (libnss3-tools); then, as the user, the CA goes into each browser's NSS database (Chrome's is created if missing).
   */
  private async trustLinux(): Promise<{ ok: boolean; message: string }> {
    const s = linuxStore();
    const root = await runAsRootLinux(
      [
        `mkdir -p ${shq(s.dir)}`,
        `install -m 644 ${shq(this.caPath)} ${shq(join(s.dir, LINUX_CA_FILE))}`,
        `${s.update} >/dev/null`,
        'if ! command -v certutil >/dev/null 2>&1 && command -v apt-get >/dev/null 2>&1; then DEBIAN_FRONTEND=noninteractive apt-get install -y -qq libnss3-tools >/dev/null 2>&1 || true; fi',
      ].join('\n'),
    );
    if (!root.ok) return { ok: false, message: root.message };
    const missed: string[] = [];
    if ((await run('which', ['certutil'])).code !== 0) missed.push('browsers (certutil is missing: install libnss3-tools / nss-tools)');
    else
      for (const db of nssDatabases()) {
        if (!existsSync(join(db, 'cert9.db'))) {
          mkdirSync(db, { recursive: true });
          await run('certutil', ['-d', `sql:${db}`, '-N', '--empty-password']);
        }
        await run('certutil', ['-d', `sql:${db}`, '-D', '-n', CA_NAME]);
        const r = await run('certutil', ['-d', `sql:${db}`, '-A', '-t', 'C,,', '-n', CA_NAME, '-i', this.caPath]);
        if (r.code !== 0) missed.push(db);
      }
    return { ok: true, message: missed.length ? `Not added for: ${missed.join(', ')}` : '' };
  }

  private seenNss = new Set<string>();
  private nssTimer: NodeJS.Timeout | null = null;

  /**
   * Linux: Firefox makes a profile's NSS database the first time it runs, often after Trust, and does not read the
   * system store; while the CA is in the system store, each browser database that lacks it gets it (as the user, no
   * password). Checked at start and every 30 s, certutil only for databases not seen yet.
   */
  watchBrowsersLinux(): void {
    if (!isLinux || this.nssTimer) return;
    const tick = () => void this.syncBrowsersLinux().catch((e: Error) => console.warn('browser certificates:', e.message));
    tick();
    this.nssTimer = setInterval(tick, 30_000);
    this.nssTimer.unref();
  }

  private async syncBrowsersLinux(): Promise<void> {
    const fresh = nssDatabases().filter((db) => existsSync(join(db, 'cert9.db')) && !this.seenNss.has(db));
    if (!fresh.length || !this.caExists() || !existsSync(join(linuxStore().dir, LINUX_CA_FILE))) return;
    if ((await run('which', ['certutil'])).code !== 0) return;
    for (const db of fresh) {
      this.seenNss.add(db);
      if ((await run('certutil', ['-d', `sql:${db}`, '-L', '-n', CA_NAME])).code === 0) continue;
      const r = await run('certutil', ['-d', `sql:${db}`, '-A', '-t', 'C,,', '-n', CA_NAME, '-i', this.caPath]);
      if (r.code === 0) console.log(`DevCatz Local CA added to ${db}`);
    }
  }

  async untrust(): Promise<{ ok: boolean; message: string }> {
    const fingerprint = this.thumbprint();
    if (isLinux) {
      if ((await run('which', ['certutil'])).code === 0) for (const db of nssDatabases()) await run('certutil', ['-d', `sql:${db}`, '-D', '-n', CA_NAME]);
      const s = linuxStore();
      const r = await runAsRootLinux(`rm -f ${shq(join(s.dir, LINUX_CA_FILE))}\n${s.update === 'update-ca-certificates' ? 'update-ca-certificates --fresh' : s.update} >/dev/null`);
      return { ok: r.ok, message: r.message };
    }
    if (isWin) {
      const r = await run('certutil', ['-user', '-delstore', 'Root', fingerprint], { timeout: 120_000 });
      return { ok: r.code === 0, message: (r.stderr || r.stdout).trim() };
    }
    await run('security', ['remove-trusted-cert', this.caPath], { timeout: 120_000 });
    const { code, stderr } = await run('security', ['delete-certificate', '-Z', fingerprint, KEYCHAIN], { timeout: 120_000 });
    return { ok: code === 0, message: stderr.trim() };
  }
}
