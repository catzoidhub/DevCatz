import { app } from 'electron';
import { existsSync, lstatSync, mkdirSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * MrCatz Herd → DevCatz. The app data folder follows the product name, so
 * the first launch under the new name moves `~/Library/Application Support/
 * MrCatz Herd` to `…/DevCatz` and leaves a symlink behind: a PATH line that
 * points at the old shims folder keeps working. Must run before anything
 * reads userData, so index.ts imports this module first.
 */
const OLD_NAME = 'MrCatz Herd';
/** Left in the new folder until the post-launch steps (php.ini paths, login item) ran. */
export const MIGRATION_FLAG = 'migrated-from-mrcatz-herd';

export function migrateUserData(): boolean {
  // Dev/test profiles pass their own folder.
  if (process.argv.some((a) => a.startsWith('--user-data-dir'))) return false;
  const dir = app.getPath('userData');
  const old = join(dirname(dir), OLD_NAME);
  if (existsSync(join(dir, 'config.json')) || !existsSync(join(old, 'config.json'))) return false;
  try {
    if (lstatSync(old).isSymbolicLink()) return false;
  } catch {
    return false;
  }
  try {
    // Electron may already have created the new folder (Chromium state): merge, old data wins.
    mkdirSync(dir, { recursive: true });
    for (const entry of readdirSync(old)) {
      const to = join(dir, entry);
      rmSync(to, { recursive: true, force: true });
      renameSync(join(old, entry), to);
    }
    rmSync(old, { recursive: true, force: true });
    symlinkSync(dir, old);
    writeFileSync(join(dir, MIGRATION_FLAG), new Date().toISOString());
    console.log(`Moved ${old} → ${dir}`);
    return true;
  } catch (err) {
    console.error('Could not move the MrCatz Herd data folder:', err);
    return false;
  }
}

migrateUserData();
