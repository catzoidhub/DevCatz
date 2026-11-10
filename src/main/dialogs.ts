import { dialog, type BrowserWindow, type OpenDialogOptions, type OpenDialogReturnValue, type SaveDialogOptions, type SaveDialogReturnValue } from 'electron';
import { isLinux } from './platform';

/**
 * File dialogs (open / save) attached to DevCatz's window — the same as DBCatz's dialogs.ts (464a976).
 *
 * Linux (Wayland, GNOME 50 on Ubuntu 26.04): a dialog for a window that is not the active one crashes the app —
 * Chromium exports the window for the dialog (xdg-foreign), mutter refuses ("zxdg_exporter_v2: exported surface had an
 * invalid role"), drops the connection and the app dies (SIGTRAP) with no dialog shown. It happens when the dialog
 * comes while another app is in front: an MCatzP client, a link, a shortcut right after switching apps. So on Linux
 * the window comes to the front first; when the desktop will not give it the focus, the dialog opens on its own.
 */
async function parent(w: BrowserWindow | null | undefined): Promise<BrowserWindow | undefined> {
  if (!w || w.isDestroyed()) return undefined;
  if (!isLinux || w.isFocused()) return w;
  if (w.isMinimized()) w.restore();
  w.show();
  w.focus();
  const focused = await new Promise<boolean>((resolve) => {
    if (w.isFocused()) return resolve(true);
    const done = (v: boolean) => {
      clearTimeout(timer);
      w.off('focus', onFocus);
      resolve(v);
    };
    const onFocus = () => done(true);
    const timer = setTimeout(() => done(w.isFocused()), 1500);
    w.on('focus', onFocus);
  });
  return focused && !w.isDestroyed() ? w : undefined;
}

export async function openDialog(w: BrowserWindow | null | undefined, options: OpenDialogOptions): Promise<OpenDialogReturnValue> {
  const p = await parent(w);
  return p ? dialog.showOpenDialog(p, options) : dialog.showOpenDialog(options);
}

export async function saveDialog(w: BrowserWindow | null | undefined, options: SaveDialogOptions): Promise<SaveDialogReturnValue> {
  const p = await parent(w);
  return p ? dialog.showSaveDialog(p, options) : dialog.showSaveDialog(options);
}
