import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { StackInfo } from '@shared/types';
import { DEFAULT_PORTS, detectDatabase } from '../detect';
import { detectRedis } from '../redis';
import type { RuntimeDriver } from './types';

/** How a static site runs, for the screens that show it; Start runs resources/static-server.cjs itself. */
const SERVED = 'Plain files, served by DevCatz';

/**
 * A folder of plain HTML, CSS and JS: no runtime to install, no build. It keeps the shape of a Node site with one
 * app, so the proxy, Stop and Logs work as usual; the process is DevCatz's own Electron running as Node.
 */
function detectStatic(root: string, domain: string): StackInfo {
  const port = DEFAULT_PORTS.static;
  return {
    packageManager: null,
    detectedPackageManager: null,
    monorepo: false,
    devCommand: SERVED,
    apps: [
      {
        dir: '.',
        name: basename(root),
        framework: 'static',
        library: null,
        kind: 'web',
        devScript: SERVED,
        port,
        configuredPort: port,
        portVars: ['PORT'],
        managedPort: false,
        prisma: false,
        domain,
      },
    ],
    database: detectDatabase(root),
    redis: detectRedis(root, []),
    prismaDir: null,
    node: null,
    runtime: 'node',
    depsMissing: false,
    warnings: [],
    libs: [],
  };
}

export const staticDriver: RuntimeDriver = {
  id: 'node',
  matches: (dir) => existsSync(join(dir, 'index.html')) || existsSync(join(dir, 'index.htm')),
  detect: detectStatic,
};
