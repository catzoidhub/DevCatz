// In `electron-vite dev` macOS takes the app name (menu bar, Dock, Cmd-Tab)
// from node_modules' Electron.app/Info.plist. Rename that dev bundle so it
// shows "DevCatz" too. Packaged builds get the name from electron-builder.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const NAME = 'DevCatz';
const plist = 'node_modules/electron/dist/Electron.app/Contents/Info.plist';
if (process.platform === 'darwin' && existsSync(plist)) {
  for (const key of ['CFBundleName', 'CFBundleDisplayName']) {
    execFileSync('plutil', ['-replace', key, '-string', NAME, plist]);
  }
  // Make Launch Services pick up the new name.
  execFileSync('touch', ['node_modules/electron/dist/Electron.app']);
}
