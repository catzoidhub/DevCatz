import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { frameworkVersion } from '../src/main/runtimes/fwversion';
import { versionText, type AppInfo } from '../src/shared/types';

/** Framework versions from the project's files (TODO §41): installed first, the declared range as a fallback. */
const root = mkdtempSync(join(tmpdir(), 'devcatz-fwv-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

let n = 0;
function project(files: Record<string, string>): string {
  const dir = join(root, String(n++));
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  return dir;
}
const app = (framework: AppInfo['framework'], extra: Partial<AppInfo> = {}) => ({ dir: '.', name: 'x', framework, kind: 'web', ...extra }) as AppInfo;

describe('framework versions', () => {
  test('Laravel from composer.lock, with Livewire and Vue', () => {
    const dir = project({
      'composer.lock': JSON.stringify({ packages: [{ name: 'laravel/framework', version: 'v13.2.1' }, { name: 'livewire/livewire', version: 'v4.3.0' }], 'packages-dev': [] }),
      'package.json': JSON.stringify({ devDependencies: { vue: '^3.5.0' } }),
    });
    const v = frameworkVersion(dir, app('laravel'));
    expect(v).toMatchObject({ version: '13.2.1', exact: true });
    expect(v?.extras).toEqual([
      { label: 'Livewire', version: '4.3.0', exact: true },
      { label: 'Vue', version: '3', exact: false },
    ]);
    expect(versionText(v)).toBe('13.2');
    expect(versionText(v?.extras?.[1])).toBe('3.x');
  });

  test('a range when nothing is installed', () => {
    const dir = project({ 'composer.json': JSON.stringify({ require: { 'laravel/framework': '^13.0' } }) });
    expect(frameworkVersion(dir, app('laravel'))).toEqual({ version: '13', exact: false });
  });

  test('JS lockfiles: npm, bun, pnpm, yarn, and a workspace', () => {
    expect(frameworkVersion(project({ 'package-lock.json': JSON.stringify({ packages: { 'node_modules/next': { version: '15.1.0' } } }) }), app('next'))?.version).toBe('15.1.0');
    expect(frameworkVersion(project({ 'bun.lock': '{\n  "packages": {\n    "nuxt": ["nuxt@4.2.1", "", {}],\n  }\n}' }), app('nuxt'))?.version).toBe('4.2.1');
    expect(
      frameworkVersion(project({ 'pnpm-lock.yaml': "lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      astro:\n        specifier: ^5.0.0\n        version: 5.2.3(typescript@5.7.2)\n" }), app('astro'))?.version,
    ).toBe('5.2.3');
    expect(frameworkVersion(project({ 'yarn.lock': '\n"@angular/core@^19.0.0":\n  version "19.1.4"\n' }), app('angular'))?.version).toBe('19.1.4');
    const mono = project({ 'apps/web/node_modules/vue/package.json': JSON.stringify({ version: '3.5.13' }), 'node_modules/vue/package.json': JSON.stringify({ version: '3.4.0' }) });
    expect(frameworkVersion(mono, app('vite-vue', { dir: 'apps/web' }))?.version).toBe('3.5.13');
  });

  test('Go, Rust, Ruby, Python', () => {
    expect(frameworkVersion(project({ 'go.mod': 'module x\n\nrequire (\n\tgithub.com/gin-gonic/gin v1.10.0\n)\n' }), app('go', { library: 'gin' }))?.version).toBe('1.10.0');
    expect(frameworkVersion(project({ 'go.mod': 'module x\nrequire github.com/labstack/echo/v4 v4.12.0\n' }), app('go', { library: 'echo' }))?.version).toBe('4.12.0');
    expect(frameworkVersion(project({ 'Cargo.lock': '[[package]]\nname = "axum"\nversion = "0.7.9"\n' }), app('rust', { library: 'axum' }))?.version).toBe('0.7.9');
    expect(frameworkVersion(project({ 'Cargo.toml': '[dependencies]\naxum = "0.8"\n' }), app('rust', { library: 'axum' }))).toEqual({ version: '0.8', exact: false });
    expect(frameworkVersion(project({ 'Gemfile.lock': 'GEM\n  specs:\n    rails (8.0.1)\n' }), app('rails'))?.version).toBe('8.0.1');
    expect(frameworkVersion(project({ 'uv.lock': '[[package]]\nname = "django"\nversion = "5.1.4"\n' }), app('django'))?.version).toBe('5.1.4');
    expect(frameworkVersion(project({ 'requirements.txt': 'Flask==3.1.0\n' }), app('flask'))?.version).toBe('3.1.0');
    expect(frameworkVersion(project({ 'requirements.txt': 'fastapi>=0.115,<1\n' }), app('fastapi'))).toEqual({ version: '0.115', exact: false });
  });

  test('WordPress from its own files; nothing to read → null', () => {
    expect(frameworkVersion(project({ 'wp-includes/version.php': "<?php\n$wp_version = '6.7.1';\n" }), app('wordpress'))?.version).toBe('6.7.1');
    expect(frameworkVersion(project({ 'index.php': '<?php' }), app('php'))).toBeNull();
  });
});
