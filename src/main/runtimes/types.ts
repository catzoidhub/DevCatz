import type { StackInfo } from '@shared/types';

/**
 * A runtime driver knows how to recognise one kind of project and describe
 * it: its apps, ports, dev command and database. Add a driver to support a new
 * language; the rest of DevCatz (process manager, proxy, tray) only sees
 * the resulting StackInfo.
 */
export interface RuntimeDriver {
  id: StackInfo['runtime'];
  /** True when `dir` is a project of this runtime (e.g. has package.json / go.mod). */
  matches(dir: string): boolean;
  detect(root: string, domain: string): StackInfo;
}
