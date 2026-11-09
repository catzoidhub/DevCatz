import { app, shell } from 'electron';
import { chmodSync, copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { AiProvider, TaskProgress, UninstallPlan } from '@shared/types';
import { spawn } from 'node:child_process';
import { removeSystemLeftovers, systemLeftovers } from './cleanurls';
import { isLinux, isWin } from './platform';
import { runAsRootLinux } from './linuxadmin';
import { setOpenAtLogin } from './loginitem';
import { setUserPath, userPathHas } from './env';
import { shimDir } from './node';
import { run } from './env';
import { otherDomainUsers, readShared, setSharedKey, sharedDomains, SHARED_DIR, writeShared } from './shared';

/**
 * Uninstall DevCatz (Catzoid family #55, DevCatz TODO §24). Removes what DevCatz put on the Mac, never the user's
 * own files (projects, exports, backups, database / storage folders placed outside DevCatz's data folder):
 *  1. stops every site and service;
 *  2. one admin prompt: the clean-URL LaunchDaemons and DevCatz's /etc/resolver files;
 *  3. the local certificate authority from the login keychain (macOS asks to confirm);
 *  4. the login item;
 *  5. optionally the data folder (sites list, runtimes, database and storage services with their data, logs) and
 *     its keychain item, plus caches and preferences;
 *  6. the shared Catzoid settings and the "Catzoid AI" keys when asked (the switch is on by default only when no
 *     other Catzoid app is installed);
 *  7. the app: moved to the Trash (a Homebrew install: `brew uninstall --cask devcatz`), then DevCatz quits.
 * The same list is the Homebrew cask's `zap` (Catzoid #20) and catzoid.com/docs/uninstall.
 */

const OTHER_APPS = ['DBCatz', 'DialCatz', 'DoCatz'];

/** The .app bundle this DevCatz runs from (null in a development build). */
function appBundle(): string | null {
  if (!app.isPackaged) return null;
  // Windows: the NSIS uninstaller next to DevCatz.exe removes the app (it runs once DevCatz has quit).
  if (isWin) {
    const u = join(dirname(process.execPath), `Uninstall ${app.getName()}.exe`);
    return existsSync(u) ? u : null;
  }
  // Linux: the AppImage file itself (APPIMAGE), or the folder a .deb installed (removed with dpkg, see linuxPackage).
  if (isLinux) return process.env.APPIMAGE || (process.execPath.startsWith('/opt/') ? dirname(process.execPath) : null);
  const m = process.execPath.match(/^(.*?\.app)\//);
  return m ? m[1] : null;
}

/** Linux: the .deb package this DevCatz came from (null for an AppImage or a copied folder). */
async function linuxPackage(): Promise<string | null> {
  if (!isLinux || process.env.APPIMAGE) return null;
  const r = await run('dpkg', ['-S', process.execPath], { timeout: 10_000 }).catch(() => null);
  return r?.code === 0 ? (r.stdout.split(':')[0]?.trim() || null) : null;
}

function caskroom(): string | null {
  return ['/opt/homebrew/Caskroom/devcatz', '/usr/local/Caskroom/devcatz'].find((p) => existsSync(p)) ?? null;
}

/** Caches and preferences macOS / Electron keep for DevCatz outside its data folder. */
function smallLeftovers(): string[] {
  if (isLinux) {
    const cache = process.env.XDG_CACHE_HOME || join(homedir(), '.cache');
    const apps = join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'applications');
    return [join(cache, 'DevCatz'), join(cache, 'devcatz-updater'), join(apps, 'devcatz.desktop')].filter((p) => existsSync(p));
  }
  const lib = join(homedir(), 'Library');
  return [
    join(lib, 'Caches', 'DevCatz'),
    join(lib, 'Caches', 'com.mrcatz.devcatz'),
    join(lib, 'Caches', 'com.mrcatz.devcatz.ShipIt'),
    join(lib, 'HTTPStorages', 'com.mrcatz.devcatz'),
    join(lib, 'Preferences', 'com.mrcatz.devcatz.plist'),
    join(lib, 'Saved Application State', 'com.mrcatz.devcatz.savedState'),
    join(lib, 'Logs', 'DevCatz'),
  ].filter((p) => existsSync(p));
}

/** Windows: what electron-updater keeps for DevCatz outside the data folder. */
function winLeftovers(): string[] {
  const local = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local');
  return [join(local, 'devcatz-updater')].filter((p) => existsSync(p));
}

/**
 * Windows: a detached PowerShell that finishes what cannot be done while DevCatz runs, in a small window of its own so
 * the user sees it happen (DevCatz's own dialog is gone by then): waits for DevCatz to quit, stops programs still
 * running from its data folder (a runtime it installed holds its files), runs the NSIS uninstaller silently (the app,
 * its desktop / Start menu shortcuts, its entry in Installed apps), removes the devcatz:// link, moves the folders to
 * the Recycle Bin, then says it is done and removes itself.
 */
async function afterQuitWin(uninstaller: string | null, dataDir: string, folders: string[]): Promise<void> {
  const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
  const task = `DevCatz uninstall ${Date.now()}`;
  const script = String.raw`$ErrorActionPreference = 'SilentlyContinue'
$exe = ${q(process.execPath)}
Add-Type -AssemblyName System.Windows.Forms, System.Drawing, Microsoft.VisualBasic
Add-Type -Namespace Win -Name Dpi -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();'
[Win.Dpi]::SetProcessDPIAware() | Out-Null
[Windows.Forms.Application]::EnableVisualStyles()
$f = New-Object Windows.Forms.Form
$f.Text = 'Uninstalling DevCatz'; $f.FormBorderStyle = 'FixedDialog'; $f.MaximizeBox = $false; $f.MinimizeBox = $false
$f.StartPosition = 'CenterScreen'; $f.ClientSize = New-Object Drawing.Size(460, 250); $f.Font = New-Object Drawing.Font('Segoe UI', 9.5); $f.TopMost = $true
$f.Icon = [Drawing.Icon]::ExtractAssociatedIcon($exe)
$title = New-Object Windows.Forms.Label; $title.Text = 'Removing DevCatz from this PC'; $title.Font = New-Object Drawing.Font('Segoe UI Semibold', 11)
$title.SetBounds(20, 16, 420, 26); $f.Controls.Add($title)
$names = @('Waiting for DevCatz to close', 'Stopping programs it started', 'Removing the app, its shortcuts and its entry in Installed apps', 'Moving its data and settings to the Recycle Bin')
$rows = @(); $y = 52
foreach ($n in $names) { $l = New-Object Windows.Forms.Label; $l.Text = "○  $n"; $l.ForeColor = [Drawing.Color]::Gray; $l.SetBounds(20, $y, 420, 22); $f.Controls.Add($l); $rows += $l; $y += 26 }
$bar = New-Object Windows.Forms.ProgressBar; $bar.SetBounds(20, 162, 420, 14); $bar.Maximum = $names.Count; $f.Controls.Add($bar)
$note = New-Object Windows.Forms.Label; $note.Text = 'Your projects and their files are not touched.'; $note.ForeColor = [Drawing.Color]::Gray; $note.SetBounds(20, 184, 300, 40); $f.Controls.Add($note)
$ok = New-Object Windows.Forms.Button; $ok.Text = 'Close'; $ok.SetBounds(350, 206, 90, 30); $ok.Enabled = $false; $ok.Add_Click({ $f.Close() }); $f.Controls.Add($ok)
$f.Show(); [Windows.Forms.Application]::DoEvents()
function Step($i) { if ($i -gt 0) { $rows[$i - 1].Text = '✓  ' + $names[$i - 1]; $rows[$i - 1].ForeColor = [Drawing.Color]::FromArgb(22, 128, 61) }; if ($i -lt $rows.Count) { $rows[$i].Text = '●  ' + $names[$i]; $rows[$i].ForeColor = [Drawing.SystemColors]::ControlText }; $bar.Value = $i; [Windows.Forms.Application]::DoEvents() }
function Wait($cond) { for ($i = 0; $i -lt 240 -and (& $cond); $i++) { Start-Sleep -Milliseconds 250; [Windows.Forms.Application]::DoEvents() } }
Step 0; Wait { Get-Process | Where-Object { $_.Path -eq $exe } }
Step 1; Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -like ${q(`${dataDir}\\*`)} } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Step 2
${uninstaller ? `$u = Start-Process -FilePath ${q(uninstaller)} -ArgumentList '/S' -PassThru; Wait { -not $u.HasExited }
# The uninstaller hands over to a copy of itself in the temp folder and returns at once: wait for the app to go.
Wait { Test-Path $exe }` : ''}
# The devcatz:// link Electron registered for this user (the uninstaller leaves it), when it still points here.
$link = 'HKCU:\Software\Classes\devcatz'; if ((Get-ItemProperty "$link\shell\open\command").'(default)' -like "*$exe*") { Remove-Item -Recurse -Force $link }
Step 3
foreach ($p in @(${folders.map(q).join(', ')})) { if (Test-Path $p) { try { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($p, 'OnlyErrorDialogs', 'SendToRecycleBin') } catch { Remove-Item -Recurse -Force $p } }; [Windows.Forms.Application]::DoEvents() }
Step 4
$title.Text = 'DevCatz has been removed'
$note.Text = 'Your projects and their files are not touched. Its data is in the Recycle Bin until you empty it.'
$ok.Enabled = $true; $ok.Focus() | Out-Null
Remove-Item -Force $MyInvocation.MyCommand.Path
schtasks.exe /delete /tn ${q(task)} /f | Out-Null
$t = New-Object Windows.Forms.Timer; $t.Interval = 30000; $t.Add_Tick({ $f.Close() }); $t.Start()
while ($f.Visible) { [Windows.Forms.Application]::DoEvents(); Start-Sleep -Milliseconds 50 }
`;
  const file = join(tmpdir(), `devcatz-uninstall-${Date.now()}.ps1`);
  // UTF-8 with a byte-order mark: Windows PowerShell 5 reads a file without one as the ANSI code page (✓ ● ○).
  writeFileSync(file, `﻿${script.replace(/\r?\n/g, '\r\n')}`);
  // Started by Task Scheduler as a task of this user (no administrator rights needed), not as DevCatz's child: a child
  // went with DevCatz when it quit, so the window never showed. The task removes itself at the end.
  const ps = `powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${file}"`;
  const made = await run('schtasks.exe', ['/create', '/tn', task, '/tr', ps, '/sc', 'once', '/st', '00:00', '/it', '/f'], { timeout: 20_000 });
  if (made.code === 0 && (await run('schtasks.exe', ['/run', '/tn', task], { timeout: 20_000 })).code === 0) return;
  console.warn('uninstall: schtasks', made.stderr.trim());
  spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', file], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}

export function uninstallPlan(): UninstallPlan {
  // Windows: each Catzoid app installs per user into %LOCALAPPDATA%\Programs\<App>\<App>.exe.
  const local = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local');
  const others = OTHER_APPS.filter((n) =>
    isWin
      ? existsSync(join(local, 'Programs', n, `${n}.exe`))
      : isLinux
        ? [join(homedir(), 'Applications', `${n}.AppImage`), `/opt/${n}`].some((p) => existsSync(p))
        : ['/Applications', join(homedir(), 'Applications')].some((d) => existsSync(join(d, `${n}.app`))),
  );
  // DoCatz (or another app) still relies on the resolver, the port forwarding and the CA: those stay (DoCatz #61).
  const keptFor = otherDomainUsers().filter((a) => others.some((o) => o.toLowerCase() === a));
  return {
    app: appBundle(),
    homebrew: caskroom() !== null,
    dataDir: app.getPath('userData'),
    systemFiles: keptFor.length ? [] : systemLeftovers(),
    sharedSetupKeptFor: keptFor.map((a) => others.find((o) => o.toLowerCase() === a)!),
    otherCatzoidApps: others,
    sharedDir: SHARED_DIR,
    sharedKeys: readShared().ai?.keys ?? [],
  };
}

/** Copies DevCatz's CA into Catzoid/ca (folder 0700, key 0600) for the apps that still use it. */
function keepCa(ca: { cert: string; key: string; trusted: boolean }): { cert: string; key: string; trusted: boolean; by: string } {
  const dir = join(SHARED_DIR, 'ca');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const cert = join(dir, 'ca.crt');
  const key = join(dir, 'ca.key');
  copyFileSync(ca.cert, cert);
  copyFileSync(ca.key, key);
  if (!isWin) chmodSync(key, 0o600);
  return { cert, key, trusted: ca.trusted, by: 'catzoid' };
}

export interface UninstallHooks {
  stopAll(): Promise<void>;
  untrustCa(): Promise<void>;
}

/** Runs the uninstall; `set` reports progress. Quits DevCatz at the end (unless it fails before the app step). */
export async function uninstall(opts: { removeData: boolean; removeShared: boolean }, hooks: UninstallHooks, set: (p: Partial<TaskProgress>) => void): Promise<void> {
  const plan = uninstallPlan();
  const removeShared = opts.removeShared;
  set({ step: 0, detail: 'Sites, databases, storage, mail and the other services' });
  await hooks.stopAll();

  set({ step: 1, detail: plan.systemFiles.join(', ') || 'Nothing to remove' });
  if (plan.systemFiles.length) {
    const r = await removeSystemLeftovers();
    if (!r.ok) throw new Error(r.message.includes('-128') ? `Cancelled at the ${isWin ? 'administrator' : 'password'} prompt: nothing was removed after stopping the services.` : r.message);
  }

  // Windows: the shim folder in the user's Path would point at a folder that is about to go.
  if (isWin && userPathHas(shimDir())) await setUserPath(shimDir(), false).catch((e: Error) => console.warn('uninstall: Path', e.message));

  const kept = plan.sharedSetupKeptFor;
  // DevCatz no longer uses the shared setup; the next app's uninstaller removes it when it is the last one. A CA that
  // lives in DevCatz's data folder moves to the shared folder first, so the other app keeps minting with it.
  const ca = sharedDomains().ca;
  const caMoved = kept.length && ca?.by === 'devcatz' && existsSync(ca.cert) && existsSync(ca.key) ? keepCa(ca) : null;
  writeShared({ domains: { usedBy: (sharedDomains().usedBy ?? []).filter((a) => a !== 'devcatz'), ...(caMoved ? { ca: caMoved } : {}) } });
  set({ step: 2, detail: kept.length ? `Kept: still used by ${kept.join(', ')}` : isWin ? 'DevCatz Local CA, from your Trusted Root certificates' : isLinux ? 'DevCatz Local CA, from the system and browser certificate stores' : 'DevCatz Local CA, from the login keychain' });
  if (!kept.length) await hooks.untrustCa().catch((e: Error) => console.warn('uninstall: CA', e.message));
  setOpenAtLogin(false);

  set({ step: 3, detail: opts.removeData ? plan.dataDir : 'Kept: the data folder' });
  if (isWin) {
    // The data folder is also this running app's own profile, which Windows keeps locked: the folders go to the
    // Recycle Bin from a helper that waits until DevCatz has quit (with the app's own uninstaller, step 4).
    if (removeShared) for (const k of plan.sharedKeys) await setSharedKey(k as AiProvider, '').catch(() => undefined);
    const folders = [...(opts.removeData ? [plan.dataDir, ...winLeftovers()] : []), ...(removeShared && existsSync(plan.sharedDir) ? [plan.sharedDir] : [])];
    set({ step: 4, detail: plan.app ?? 'A development build: the app stays' });
    await afterQuitWin(plan.app, plan.dataDir, folders);
    set({ step: 5, done: true, detail: '' });
    return;
  }
  if (opts.removeData) {
    if (!isLinux) await run('/usr/bin/security', ['delete-generic-password', '-s', 'DevCatz Safe Storage'], { timeout: 15_000 }).catch(() => undefined);
    for (const p of [...smallLeftovers(), plan.dataDir]) await shell.trashItem(p).catch(() => rmSync(p, { recursive: true, force: true }));
  }
  if (removeShared) {
    for (const k of plan.sharedKeys) await setSharedKey(k as AiProvider, '').catch(() => undefined);
    if (existsSync(plan.sharedDir)) await shell.trashItem(plan.sharedDir).catch(() => undefined);
  }

  const pkg = await linuxPackage();
  set({ step: 4, detail: plan.homebrew ? 'brew uninstall --cask devcatz' : pkg ? `dpkg -r ${pkg}` : (plan.app ?? 'A development build: the app stays') });
  if (pkg) {
    // The package's files are root's: dpkg removes them (and the menu entry) behind the password prompt. A running
    // program keeps its open files, so DevCatz can still finish and quit.
    const r = await runAsRootLinux(`dpkg -r ${pkg}\n`);
    if (!r.ok) throw new Error(r.cancelled ? `Cancelled at the password prompt: DevCatz stays installed (remove it with: sudo apt remove ${pkg}).` : r.message);
  } else if (plan.homebrew) {
    const brew = ['/opt/homebrew/bin/brew', '/usr/local/bin/brew'].find((b) => existsSync(b));
    if (brew) await run(brew, ['uninstall', '--cask', 'devcatz'], { timeout: 300_000 });
  } else if (plan.app && (!isLinux || process.env.APPIMAGE)) {
    // (Linux: a folder that is no package's, e.g. an unpacked build, is root's and stays; the user removes it.)
    await shell.trashItem(plan.app);
  }
  set({ step: 5, done: true, detail: '' });
}

export const UNINSTALL_STEPS = isWin
  ? ['Stop everything', 'Remove port forwarding and the Path entry', 'Remove the local certificate authority', 'Remove data and settings (once DevCatz has quit)', 'Remove DevCatz with its uninstaller']
  : isLinux
    ? ['Stop everything', 'Remove port forwarding and DNS files', 'Remove the local certificate authority', 'Remove data and settings', 'Remove DevCatz']
    : ['Stop everything', 'Remove port forwarding and DNS files', 'Remove the local certificate authority', 'Remove data and settings', 'Move DevCatz to the Trash'];
