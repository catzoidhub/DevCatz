import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { app } from 'electron';
import { isLinux } from './platform';

/**
 * Open at login. macOS and Windows: Electron's login item. Linux has none in Electron, so DevCatz writes an XDG
 * autostart entry (~/.config/autostart/devcatz.desktop) that starts it with --hidden (tray only); an AppImage
 * points it at the AppImage file, not the folder it mounts.
 */
const autostartFile = () => join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'autostart', 'devcatz.desktop');
const quote = (s: string) => (/[\s"'\\$`]/.test(s) ? `"${s.replace(/(["\\$`])/g, '\\$1')}"` : s);

export function openAtLogin(): boolean {
  if (!isLinux) return app.getLoginItemSettings().openAtLogin;
  try {
    const txt = readFileSync(autostartFile(), 'utf8');
    return !/^X-GNOME-Autostart-enabled=false$/m.test(txt) && !/^Hidden=true$/m.test(txt);
  } catch {
    return false;
  }
}

export function setOpenAtLogin(on: boolean): void {
  if (!isLinux) {
    app.setLoginItemSettings({ openAtLogin: on });
    return;
  }
  const file = autostartFile();
  if (!on) {
    rmSync(file, { force: true });
    return;
  }
  const exe = process.env.APPIMAGE || process.execPath;
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(
    file,
    ['[Desktop Entry]', 'Type=Application', `Name=${app.getName()}`, `Exec=${quote(exe)} --hidden`, 'Icon=devcatz', 'Terminal=false', 'X-GNOME-Autostart-enabled=true', ''].join('\n'),
  );
}

/** Started by the login item (macOS), or with --hidden (the Linux autostart entry). */
export function openedAtLogin(): boolean {
  return app.getLoginItemSettings().wasOpenedAtLogin || process.argv.includes('--hidden');
}

