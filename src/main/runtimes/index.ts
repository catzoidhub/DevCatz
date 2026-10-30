import type { StackInfo } from '@shared/types';
import { goDriver } from './go';
import { phpDriver } from './php';
import { nodeDriver } from './node';
import { pythonDriver } from './python';
import { rustDriver } from './rust';
import type { RuntimeDriver } from './types';
import { withDataLibs } from './datalibs';
import { detectFolders, projectFolders, siblingApps } from './folders';

/**
 * First match wins: PHP (composer.json + artisan/public/index.php) before Node, since Laravel apps also have a
 * package.json for Vite; Python (manage.py, pyproject, requirements) before Node for the same reason (Tailwind
 * in a Django app); Rust (Cargo.toml) before Node too, since Leptos / Yew / Anchor projects keep a package.json for
 * Tailwind or tests; a Go module with a package.json (frontend tooling) is treated as a Node project.
 */
export const DRIVERS: RuntimeDriver[] = [phpDriver, pythonDriver, rustDriver, nodeDriver, goDriver];

export function isProjectDir(dir: string): boolean {
  return DRIVERS.some((d) => d.matches(dir));
}

/**
 * For linking a folder by hand: a project, or a folder of sibling projects (frontend/ + backend/). Parked folders
 * keep using isProjectDir, so a folder that only collects separate sites (each linked on its own) never becomes one.
 */
export function isLinkableDir(dir: string): boolean {
  return isProjectDir(dir) || projectFolders(dir).length > 0;
}

export function detectStack(root: string, domain: string): StackInfo {
  const driver = DRIVERS.find((d) => d.matches(root));
  const base = driver ? driver.detect(root, domain) : null;
  // A root that runs nothing itself (no manifest, a tooling-only package.json) but holds sibling projects
  // (frontend/ + backend/ …): every folder becomes an app. A JS workspace keeps its own detection.
  if (!base || (!base.apps.length && !base.monorepo) || ((base.runtime === 'go' || base.runtime === 'rust') && !base.monorepo)) {
    const folders = detectFolders(root, domain, base);
    if (folders) return withDataLibs(root, folders);
  }
  // A PHP or Python site with projects of other runtimes in its folders (Laravel + frontend/ with Vite, Django +
  // frontend/, FastAPI + api/ with NestJS): the root keeps the site's domain (PHP-FPM, or its own dev server), each
  // folder runs as an app on its own subdomain and port.
  if (base?.runtime === 'php' || base?.runtime === 'python') {
    const extra = siblingApps(root, domain, base.runtime);
    if (extra.apps.length) {
      base.apps.push(...extra.apps);
      base.layout = 'folders';
      base.subRuntimes = extra.runtimes;
      base.warnings.push(...extra.warnings);
    }
  }
  return withDataLibs(root, base ?? nodeDriver.detect(root, domain));
}
