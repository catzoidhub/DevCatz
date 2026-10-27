import { execFile, spawn } from 'node:child_process';
import { connect } from 'node:net';
import { isWin, joinPath, pathKey, splitPath } from './platform';

/**
 * Apps launched from Finder get a bare PATH (/usr/bin:/bin:…), so `bun`,
 * `docker` or nvm's `node` would not be found. Read the environment of the
 * user's interactive login shell once, the way a terminal would see it.
 */
let shellEnv: NodeJS.ProcessEnv | null = null;

/**
 * Markers of an AI coding agent (Claude Code, Cursor, Codex, Gemini CLI …)
 * that DevCatz inherits when it is opened from such a session. Tools read
 * them: Astro 7 then runs `astro dev` in the background and exits, so the
 * site looks stopped. DevCatz's sites are not run by an agent: drop them.
 */
const AGENT_ENV = /^(CLAUDECODE|CLAUDE_CODE_\w+|CLAUDE_AGENT_SDK_\w+|CLAUDE_PID|CLAUDE_EFFORT|CLAUDE_PREVIEW_\w+|AI_AGENT|CURSOR_AGENT|CURSOR_TRACE_ID|CODEX_\w+|GEMINI_CLI|AIDER_\w+|REPL_ID)$/;
export function stripAgentEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  for (const k of Object.keys(env)) if (AGENT_ENV.test(k)) delete env[k];
  return env;
}
stripAgentEnv(process.env);

export async function loadShellEnv(): Promise<NodeJS.ProcessEnv> {
  if (shellEnv) return shellEnv;
  if (isWin) {
    // Windows gives a GUI app the user's full environment (Path from the registry): no login shell to ask.
    const env: NodeJS.ProcessEnv = { ...process.env };
    const key = pathKey(env);
    const home = env.USERPROFILE ?? '';
    const extra = [`${home}\\.bun\\bin`, `${env.ProgramFiles ?? 'C:\\Program Files'}\\nodejs`, `${env.ProgramFiles ?? 'C:\\Program Files'}\\Git\\cmd`];
    const parts = splitPath(env[key]);
    for (const p of extra) if (!parts.some((x) => x.toLowerCase() === p.toLowerCase())) parts.push(p);
    env[key] = joinPath(parts);
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.ELECTRON_NO_ATTACH_CONSOLE;
    shellEnv = stripAgentEnv(env);
    return shellEnv;
  }
  const shell = process.env.SHELL || '/bin/zsh';
  const marker = '__MRCATZ_HERD_ENV__';
  const output = await new Promise<string>((resolve) => {
    execFile(
      shell,
      ['-ilc', `echo ${marker}; env; echo ${marker}`],
      { timeout: 8000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, DISABLE_AUTO_UPDATE: 'true' } },
      (_err, stdout) => resolve(stdout ?? ''),
    );
  });
  const env: NodeJS.ProcessEnv = { ...process.env };
  const body = output.split(marker)[1];
  if (body) {
    for (const line of body.split('\n')) {
      const i = line.indexOf('=');
      if (i > 0) env[line.slice(0, i)] = line.slice(i + 1);
    }
  }
  // Common install locations, in case the shell profile could not be read.
  const extra = [`${env.HOME}/.bun/bin`, '/opt/homebrew/bin', '/usr/local/bin', '/opt/orbstack/bin'];
  const parts = (env.PATH ?? '').split(':').filter(Boolean);
  for (const p of extra) if (!parts.includes(p)) parts.push(p);
  env.PATH = parts.join(':');
  // Electron sets these for itself; children must not inherit them.
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_NO_ATTACH_CONSOLE;
  stripAgentEnv(env);
  shellEnv = env;
  return env;
}

export function getShellEnv(): NodeJS.ProcessEnv {
  return shellEnv ?? process.env;
}

/** Runs a command with the login-shell environment and collects its output. */
export function run(
  cmd: string,
  args: string[],
  opts: { cwd?: string; timeout?: number; env?: Record<string, string> } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { cwd: opts.cwd, env: { ...getShellEnv(), ...opts.env }, timeout: opts.timeout ?? 60_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        const code = err ? (typeof (err as NodeJS.ErrnoException & { code?: unknown }).code === 'number' ? (err as unknown as { code: number }).code : 1) : 0;
        resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
      },
    );
  });
}

/**
 * `a | b`: a's stdout into b's stdin (a database dump into its client). Rejects with the stderr of whichever
 * failed; `timeout` (default 30 min) kills both.
 */
export function pipeCommands(a: [string, string[]], b: [string, string[]], env: Record<string, string> = {}, timeout = 30 * 60_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const full = { ...getShellEnv(), ...env };
    const pa = spawn(a[0], a[1], { env: full, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const pb = spawn(b[0], b[1], { env: full, stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true });
    pa.stdout.pipe(pb.stdin);
    let errA = '';
    let errB = '';
    pa.stderr.on('data', (d) => (errA = (errA + d).slice(-4000)));
    pb.stderr.on('data', (d) => (errB = (errB + d).slice(-4000)));
    pb.stdin.on('error', () => undefined); // b died first: a's broken pipe is reported through b's exit
    const timer = setTimeout(() => {
      pa.kill();
      pb.kill();
    }, timeout);
    const closed = (p: typeof pa | typeof pb) => new Promise<number | null>((res, rej) => (p.on('error', rej), p.on('close', res)));
    const name = (p: string) => p.split(/[\\/]/).pop();
    const last = (t: string) => t.trim().split('\n').slice(-3).join(' ');
    // Both must finish: a dump that fails half-way would otherwise look like a short but successful restore.
    Promise.all([closed(pa), closed(pb)])
      .then(([codeA, codeB]) => {
        clearTimeout(timer);
        if (codeA !== 0) reject(new Error(`${name(a[0])} failed: ${last(errA)}`));
        else if (codeB !== 0) reject(new Error(`${name(b[0])} failed: ${last(errB)}`));
        else resolve();
      })
      .catch((e) => {
        clearTimeout(timer);
        reject(e);
      });
  });
}

/** True when something accepts TCP connections on localhost:port (IPv4 or IPv6). */
export function isPortOpen(port: number, timeout = 400): Promise<boolean> {
  const tryHost = (host: string) =>
    new Promise<boolean>((resolve) => {
      const socket = connect({ host, port });
      const done = (ok: boolean) => {
        socket.destroy();
        resolve(ok);
      };
      socket.setTimeout(timeout, () => done(false));
      socket.once('connect', () => done(true));
      socket.once('error', () => done(false));
    });
  return tryHost('127.0.0.1').then((ok) => ok || tryHost('::1'));
}

/** `name (pid 123)` of the process listening on a TCP port, if lsof can see it. */
export async function portOwner(port: number): Promise<string | null> {
  if (isWin) {
    // netstat -ano: the PID listening on the port, then its image name.
    const { stdout } = await run('netstat', ['-ano', '-p', 'TCP']);
    const pid = stdout.split(/\r?\n/).map((l) => l.trim().split(/\s+/)).find((c) => c[3] === 'LISTENING' && c[1]?.endsWith(`:${port}`))?.[4];
    if (!pid) return null;
    const t = await run('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH']);
    return `${t.stdout.match(/^"([^"]+)"/)?.[1] ?? 'process'} (pid ${pid})`;
  }
  const { stdout } = await run('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpc']);
  const pid = stdout.match(/^p(\d+)/m)?.[1];
  const name = stdout.match(/^c(.+)$/m)?.[1];
  return pid ? `${name ?? 'process'} (pid ${pid})` : null;
}

/** True when something listens on host:port (one address only, unlike isPortOpen). */
export function isListening(host: string, port: number, timeout = 400): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeout, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}
