import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { shell } from 'electron';
import { startDetached } from './editors';
import { run } from './env';
import { isLinux, isWin } from './platform';
import { dataDir } from './store';

/**
 * Open ▾ → Terminal on every platform (TODO §39): a terminal in the site's folder whose `php`, `composer`, `node`,
 * `go` … are the site's own. The user's shell starts as always (their startup files run), then the site's runtime
 * folders go first on the PATH and one line says which. A folder with no runtimes of its own just opens.
 */

export interface TerminalSetup {
  /** Folders to put first on the PATH. */
  dirs: string[];
  /** What they are, for the line the terminal prints ("PHP 8.4.27, Node 22.11.0"). */
  label: string;
  /** The project's Python venv, when it has one. */
  venv: string | null;
}

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** The POSIX lines that put the folders first (after the user's own startup files). */
function shLines(t: TerminalSetup): string {
  return [
    `export PATH=${q(t.dirs.join(':'))}":$PATH"`,
    t.venv ? `export VIRTUAL_ENV=${q(t.venv)}` : '',
    `printf '%s\\n' ${q(`DevCatz: ${t.label} first on the PATH in this terminal.`)}`,
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * The command that starts the user's shell with the site's PATH (macOS / Linux): bash with its own --rcfile, zsh with
 * a ZDOTDIR whose files source the user's own, fish with an init command. Written under DevCatz's data folder.
 */
function shellCommand(name: string, t: TerminalSetup): string[] {
  const dir = join(dataDir('terminal'), name.replace(/[^\w.-]+/g, '-'));
  mkdirSync(dir, { recursive: true });
  const home = homedir();
  const user = (process.env.SHELL ?? '').split('/').pop() || (isLinux ? 'bash' : 'zsh');
  if (user === 'fish') {
    const dirs = t.dirs.map(q).join(' ');
    return ['fish', '-C', `set -gx PATH ${dirs} $PATH; ${t.venv ? `set -gx VIRTUAL_ENV ${q(t.venv)}; ` : ''}echo ${q(`DevCatz: ${t.label} first on the PATH in this terminal.`)}`];
  }
  if (user === 'zsh') {
    // zsh reads $ZDOTDIR/.zshenv, .zprofile (login), .zshrc, .zlogin: each sources the user's own, then .zshrc adds ours.
    const src = (f: string) => `ZDOTDIR=${q(home)}; [ -f ${q(join(home, f))} ] && . ${q(join(home, f))}; ZDOTDIR=${q(dir)}`;
    writeFileSync(join(dir, '.zshenv'), `${src('.zshenv')}\n`);
    writeFileSync(join(dir, '.zprofile'), `${src('.zprofile')}\n`);
    writeFileSync(join(dir, '.zlogin'), `${src('.zlogin')}\nZDOTDIR=${q(home)}\n`);
    writeFileSync(join(dir, '.zshrc'), `${src('.zshrc')}\n${shLines(t)}\n`);
    return ['env', `ZDOTDIR=${dir}`, 'zsh', '-l'];
  }
  // bash (and any other POSIX shell DevCatz does not know: bash is on every system it runs on).
  const rc = join(dir, 'bashrc');
  // macOS: Terminal starts login shells, which read .bash_profile (that usually sources .bashrc).
  const own = !isLinux && existsSync(join(home, '.bash_profile')) ? '.bash_profile' : '.bashrc';
  writeFileSync(rc, ['[ -f /etc/bash.bashrc ] && . /etc/bash.bashrc', `[ -f ${q(join(home, own))} ] && . ${q(join(home, own))}`, shLines(t), ''].join('\n'));
  return ['bash', '--rcfile', rc, '-i'];
}

function detached(cmd: string, args: string[], cwd: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore', cwd });
    child.once('error', () => resolve(false));
    child.once('spawn', () => {
      child.unref();
      resolve(true);
    });
  });
}

/** Linux: the desktop's own terminal first (GNOME Console / Terminal, Ptyxis, Konsole …), then the Debian alternative. */
async function linuxTerminal(dir: string, cmd: string[] | null): Promise<boolean> {
  const c = cmd ?? [];
  const tries: [string, string[]][] = [
    ['ptyxis', ['--new-window', '--working-directory', dir, ...(cmd ? ['--', ...c] : [])]],
    ['gnome-terminal', [`--working-directory=${dir}`, ...(cmd ? ['--', ...c] : [])]],
    ['kgx', [`--working-directory=${dir}`, ...(cmd ? ['--', ...c] : [])]],
    ['konsole', ['--workdir', dir, ...(cmd ? ['-e', ...c] : [])]],
    ['xfce4-terminal', [`--working-directory=${dir}`, ...(cmd ? ['-x', ...c] : [])]],
    ['tilix', ['-w', dir, ...(cmd ? ['-e', c.map((w) => q(w)).join(' ')] : [])]],
    ['alacritty', ['--working-directory', dir, ...(cmd ? ['-e', ...c] : [])]],
    ['kitty', ['--directory', dir, ...c]],
    ['wezterm', ['start', '--cwd', dir, ...(cmd ? ['--', ...c] : [])]],
    ['x-terminal-emulator', cmd ? ['-e', ...c] : []],
  ];
  for (const [bin, args] of tries) {
    if ((await run('which', [bin], { timeout: 3000 })).code !== 0) continue;
    if (await detached(bin, args, dir)) return true;
  }
  return false;
}

/**
 * macOS: Terminal and iTerm run a script that starts the shell with the site's PATH. Warp and Ghostty get the folder only
 * (Warp's warp://launch links did not find a launch configuration written while it runs; TODO §39 left).
 */
async function macTerminal(dir: string, cmd: string[] | null, name: string): Promise<string | null> {
  const apps = ['Warp', 'iTerm', 'Ghostty'].filter((a) => existsSync(`/Applications/${a}.app`));
  const app = apps[0] ?? 'Terminal';
  if (cmd && (app === 'Terminal' || app === 'iTerm')) {
    const script = join(dataDir('terminal'), `${name.replace(/[^\w.-]+/g, '-')}.command`);
    writeFileSync(script, `#!/bin/sh\ncd ${q(dir)} || exit 1\nexec ${cmd.map(q).join(' ')}\n`);
    chmodSync(script, 0o755);
    if (app === 'Terminal') {
      if ((await run('open', ['-a', 'Terminal', script])).code === 0) return null;
    } else {
      const as = `tell application "iTerm" to create window with default profile command "${script.replace(/(["\\])/g, '\\$1')}"`;
      if ((await run('osascript', ['-e', as], { timeout: 10_000 })).code === 0) return null;
    }
  }
  await run('open', ['-a', app, dir]);
  return cmd ? `${app} opened in the folder with your usual PATH: the site's own versions are not set there. Use the Run box in the site's Logs, or Add to my PATH on the PHP / Node.js page.` : null;
}

/** Windows: Windows Terminal (else a Command Prompt) running a small .cmd that puts the folders first. */
async function winTerminal(dir: string, t: TerminalSetup | null, name: string): Promise<void> {
  let init = '';
  if (t) {
    init = join(dataDir('terminal'), `${name.replace(/[^\w.-]+/g, '-')}.cmd`);
    mkdirSync(dataDir('terminal'), { recursive: true });
    writeFileSync(
      init,
      ['@echo off', `set "PATH=${t.dirs.join(';')};%PATH%"`, t.venv ? `set "VIRTUAL_ENV=${t.venv}"` : '', `echo DevCatz: ${t.label} first on the PATH in this terminal.`, ''].filter(Boolean).join('\r\n'),
    );
  }
  const shellArgs = init ? ['cmd', '/K', `"${init}"`] : [];
  if ((await run('where', ['wt'])).code === 0 && (await startDetached('wt', ['-d', `"${dir}"`, ...shellArgs]))) return;
  await startDetached('start', ['""', '/D', `"${dir}"`, 'cmd', '/K', init ? `"${init}"` : `cd /d "${dir}"`]);
}

/** A terminal in `dir`; with `t`, the site's runtimes first on its PATH. `name` names the helper files (the site id). */
export async function openTerminal(dir: string, t: TerminalSetup | null = null, name = 'folder'): Promise<string | null> {
  const setup = t && t.dirs.length ? t : null;
  if (isWin) {
    await winTerminal(dir, setup, name);
    return null;
  }
  const cmd = setup ? shellCommand(name, setup) : null;
  if (isLinux) {
    if (await linuxTerminal(dir, cmd)) return null;
    await shell.openPath(dir);
    return 'No terminal app was found, so the folder opened in the file manager.';
  }
  return macTerminal(dir, cmd, name);
}
