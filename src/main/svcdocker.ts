import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { TaskProgress } from '@shared/types';
import { gatewayCompose, gatewayDocker, gatewayEngineReady } from './docker';
import { getShellEnv, run } from './env';
import { isWin, killTree } from './platform';

/**
 * Windows: Typesense, Sonic and Sockudo publish no Windows build, so there they run as containers of their official
 * images in DoCatz's engine (`docker --context docatz`), controlled from DevCatz like the native installs elsewhere —
 * same ports, domain, keys and .env lines; DevCatz keeps `compose up` attached as the server's process. DoCatz lists
 * them read-only under "DevCatz Services" (compose project devcatz-svc-<kind>, bridge.json `services`).
 * DEVCATZ_SVC_DOCKER=1 takes this path on macOS too (testing; then on the engine compose runs on).
 */
export const svcInDocker = isWin || process.env.DEVCATZ_SVC_DOCKER === '1';
export const SVC_KINDS = ['typesense', 'sonic', 'sockudo'] as const;
export type SvcKind = (typeof SVC_KINDS)[number];
export const isSvcKind = (kind: string): kind is SvcKind => (SVC_KINDS as readonly string[]).includes(kind);
/** The compose project (how DoCatz recognises it: ^devcatz-(gw|svc)-…). */
export const svcProject = (kind: SvcKind) => `devcatz-svc-${kind}`;
export const svcComposeFile = (dir: string) => join(dir, 'docker-compose.yml');

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
/** A host path in the compose file (a Windows path as it is: DoCatz's compose maps C:\… itself). */
export const vol = (host: string, inside: string, ro = false) => JSON.stringify(`${host}:${inside}${ro ? ':ro' : ''}`);

/** DoCatz's engine answers (opened and waited for when installed but stopped), else why not. */
export const svcEngineReady = gatewayEngineReady;

export function writeSvcCompose(file: string, yaml: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, yaml, { mode: 0o600 });
}

export function svcCompose(file: string, kind: SvcKind, args: string[], timeout = 120_000) {
  const [bin, ...pre] = gatewayCompose();
  return run(bin, [...pre, '-f', file, '-p', svcProject(kind), ...args], { timeout, cwd: dirname(file) });
}

/** The server's process: `compose up`, attached, so its output is the server's log and stopping it stops the container. */
export const svcUpCommand = (file: string, kind: SvcKind) => [...gatewayCompose(), '-f', file, '-p', svcProject(kind), 'up', '--remove-orphans'].map(q).join(' ');

/** `compose pull` with its progress lines as the task's detail; cancellable. */
export function svcPull(file: string, kind: SvcKind, report: (p: Partial<TaskProgress>) => void, signal: AbortSignal): Promise<void> {
  const [bin, ...pre] = gatewayCompose();
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, [...pre, '-f', file, '-p', svcProject(kind), 'pull'], { stdio: ['ignore', 'pipe', 'pipe'], cwd: dirname(file), env: getShellEnv() as NodeJS.ProcessEnv, windowsHide: true });
    let last = '';
    const onLine = (d: Buffer) => {
      for (const line of d.toString().split(/\r?\n/)) if (line.trim()) report({ detail: (last = line.trim()).slice(0, 120) });
    };
    proc.stdout.on('data', onLine);
    proc.stderr.on('data', onLine);
    const onAbort = () => (proc.pid ? killTree(proc.pid) : proc.kill());
    signal.addEventListener('abort', onAbort, { once: true });
    proc.on('error', reject);
    proc.on('close', (code) => {
      signal.removeEventListener('abort', onAbort);
      if (signal.aborted) reject(new Error('Cancelled'));
      else if (code === 0) resolve();
      else reject(new Error(`docker compose pull failed: ${last || `exit ${code}`}`));
    });
  });
}

export async function svcRemoveImage(image: string): Promise<void> {
  const [bin, ...pre] = gatewayDocker();
  await run(bin, [...pre, 'rmi', image], { timeout: 120_000 }).catch(() => undefined);
}

/** Containers and network down, the image removed (data stays in the data folder). */
export async function svcRemove(file: string, kind: SvcKind, image: string): Promise<void> {
  await svcCompose(file, kind, ['down', '--remove-orphans'], 120_000).catch(() => undefined);
  await svcRemoveImage(image);
}
