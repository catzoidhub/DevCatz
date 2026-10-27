// Platform words (Catzoid #69): the OS-specific words and shortcut labels the UI shows, so one build reads right on macOS, Windows and Linux.
// Electron menu accelerators stay `CmdOrCtrl+…`; this is only for text the user reads.

export type OS = 'mac' | 'windows' | 'linux';

/** The OS this code runs on: process.platform in the main process, the user agent in the renderer. */
export const currentOS: OS = (() => {
  if (typeof process !== 'undefined' && process.platform) {
    return process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'windows' : 'linux';
  }
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  return ua.includes('Windows') ? 'windows' : ua.includes('Mac') ? 'mac' : 'linux';
})();

/** The words for things that are called differently per OS. */
export function wordsFor(os: OS) {
  return {
    os: os === 'mac' ? 'macOS' : os === 'windows' ? 'Windows' : 'Linux',
    secretStore: os === 'mac' ? 'Keychain' : os === 'windows' ? 'Windows Credential Manager' : 'the system keyring',
    fileManager: os === 'mac' ? 'Finder' : os === 'windows' ? 'File Explorer' : 'the file manager',
    tray: os === 'mac' ? 'menu bar' : 'system tray',
    revealIn: os === 'mac' ? 'Reveal in Finder' : os === 'windows' ? 'Show in File Explorer' : 'Show in folder',
    trash: os === 'windows' ? 'Recycle Bin' : 'Trash',
    computer: os === 'mac' ? 'Mac' : os === 'windows' ? 'PC' : 'computer',
    /** Where the app keeps its data, for hints and placeholders (`<appData>/DevCatz`). */
    appData: os === 'mac' ? '~/Library/Application Support' : os === 'windows' ? '%APPDATA%' : '~/.config',
    sep: os === 'windows' ? '\\' : '/',
    installGit: os === 'mac' ? 'run xcode-select --install in Terminal' : os === 'windows' ? 'install Git for Windows from git-scm.com' : 'install git with your package manager',
  };
}

export const words = wordsFor(currentOS);

const MAC_KEYS: Record<string, string> = { mod: '⌘', shift: '⇧', alt: '⌥', ctrl: '⌃' };
const PC_KEYS: Record<string, string> = { mod: 'Ctrl', shift: 'Shift', alt: 'Alt', ctrl: 'Ctrl' };

/** A shortcut label from a combo like 'mod+K' or 'mod+shift+P': '⌘⇧P' on a Mac, 'Ctrl+Shift+P' elsewhere. */
export function keyLabel(combo: string, os: OS = currentOS): string {
  const names = os === 'mac' ? MAC_KEYS : PC_KEYS;
  // A trailing '+' is the key itself ('mod++'), so split only on separators that have a key after them.
  const parts = combo.split(/\+(?=.)/).map((p) => names[p.toLowerCase()] ?? p);
  return parts.join(os === 'mac' ? '' : '+');
}
