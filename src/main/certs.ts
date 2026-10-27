import { X509Certificate, generateKeyPairSync, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createSecureContext, type SecureContext } from 'node:tls';
import forge from 'node-forge';
import { run } from './env';
import { isWin } from './platform';
import { dataDir } from './store';

const CA_NAME = 'DevCatz Local CA';
const KEYCHAIN = join(homedir(), 'Library/Keychains/login.keychain-db'); // macOS only

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
  private caKeyPath = join(certsDir(), 'ca.key');

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

  async untrust(): Promise<{ ok: boolean; message: string }> {
    const fingerprint = this.thumbprint();
    if (isWin) {
      const r = await run('certutil', ['-user', '-delstore', 'Root', fingerprint], { timeout: 120_000 });
      return { ok: r.code === 0, message: (r.stderr || r.stdout).trim() };
    }
    await run('security', ['remove-trusted-cert', this.caPath], { timeout: 120_000 });
    const { code, stderr } = await run('security', ['delete-certificate', '-Z', fingerprint, KEYCHAIN], { timeout: 120_000 });
    return { ok: code === 0, message: stderr.trim() };
  }
}
