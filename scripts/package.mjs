// Builds the signed macOS app + DMG, notarized when the notary profile exists:
//   bun run package            Apple silicon (arm64), as electron-builder.yml says
//   bun run package --x64      Intel: the same DMG + zip for x64, from this (Apple silicon) Mac
//
// Notarization uses a notarytool keychain profile (default `mrcatz-notary`,
// override with NOTARY_PROFILE). Create it once on this Mac:
//   xcrun notarytool store-credentials mrcatz-notary --apple-id <Apple ID> --team-id Q5Q5KKYWU7
// (it asks for an app-specific password from account.apple.com). Without the
// profile the build is signed but not notarized, and a warning says so.
//
// With the profile: electron-builder notarizes and staples the .app before
// the DMG is made; this script then notarizes and staples the DMG itself, and
// checks both with Gatekeeper (spctl).
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const name = pkg.productName ?? pkg.name;
const profile = process.env.NOTARY_PROFILE || 'mrcatz-notary';
const args = process.argv.slice(2);
// --x64 builds the Intel DMG + zip (the yml's targets name arm64, so they are given here); dist keeps both builds
const arch = args.includes('--x64') ? 'x64' : 'arm64';
const extra = arch === 'x64' ? ['dmg', 'zip', ...args] : args;

function sh(cmd, args, opts = {}) {
  console.log(`\n$ ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { cwd: root, stdio: 'inherit', ...opts });
  if (r.status !== 0) process.exit(r.status ?? 1);
}
const quiet = (cmd, args) => spawnSync(cmd, args, { cwd: root, encoding: 'utf8' });

const hasProfile = quiet('xcrun', ['notarytool', 'history', '--keychain-profile', profile]).status === 0;
const env = { ...process.env };
if (hasProfile) {
  env.APPLE_KEYCHAIN_PROFILE = profile;
  console.log(`Notarizing with the keychain profile "${profile}".`);
} else {
  delete env.APPLE_KEYCHAIN_PROFILE;
  console.warn(
    `\n⚠ No notarytool profile "${profile}" in the keychain: building signed but NOT notarized.\n` +
      `  Create it once:  xcrun notarytool store-credentials ${profile} --apple-id <Apple ID> --team-id Q5Q5KKYWU7\n`,
  );
}

sh('node', ['scripts/licenses.mjs'], { env }); // third-party licences, shipped inside the app (Catzoid #66)
sh('electron-vite', ['build'], { env });
sh('electron-builder', ['--mac', ...extra], { env });

const dist = join(root, 'dist');
const dmgs = readdirSync(dist).filter((f) => f === `${name}-${pkg.version}-${arch}.dmg`);
const app = join(dist, arch === 'arm64' ? 'mac-arm64' : 'mac', `${name}.app`);

if (hasProfile) {
  for (const dmg of dmgs) {
    sh('xcrun', ['notarytool', 'submit', join(dist, dmg), '--keychain-profile', profile, '--wait']);
    sh('xcrun', ['stapler', 'staple', join(dist, dmg)]);
  }
  // Gatekeeper's verdict, as on another Mac: the app, and each DMG's stapled ticket
  // (plus its own signature when the DMG is signed — dmg.sign in electron-builder.yml).
  sh('spctl', ['--assess', '--type', 'execute', '-vv', app]);
  sh('xcrun', ['stapler', 'validate', app]);
  for (const dmg of dmgs) {
    sh('xcrun', ['stapler', 'validate', join(dist, dmg)]);
    if (quiet('codesign', ['--verify', join(dist, dmg)]).status === 0) sh('spctl', ['--assess', '--type', 'open', '--context', 'context:primary-signature', '-vv', join(dist, dmg)]);
  }
  console.log(`\n✓ ${name} ${pkg.version}: app and DMG notarized and stapled.`);
} else {
  console.log(`\n${name} ${pkg.version} built (signed, not notarized).`);
}
