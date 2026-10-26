import type { StackInfo } from '@shared/types';
import { goDriver } from './go';
import { phpDriver } from './php';
import { nodeDriver } from './node';
import { pythonDriver } from './python';
import type { RuntimeDriver } from './types';
import { withDataLibs } from './datalibs';
import { detectFolders, projectFolders } from './folders';

/**
 * First match wins: PHP (composer.json + artisan/public/index.php) before Node, since Laravel apps also have a
 * package.json for Vite; Python (manage.py, pyproject, requirements) before Node for the same reason (Tailwind
 * in a Django app); a Go module with a package.json (frontend tooling) is treated as a Node project.
 */
export const DRIVERS: RuntimeDriver[] = [phpDriver, pythonDriver, nodeDriver, goDriver];

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
  if (!base || (!base.apps.length && !base.monorepo)) {
    const folders = detectFolders(root, domain, base);
    if (folders) return withDataLibs(root, folders);
  }
  return withDataLibs(root, base ?? nodeDriver.detect(root, domain));
}
