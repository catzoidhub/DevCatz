/**
 * Platform in the window (Catzoid #57): Windows hides what is macOS-only so far (wording: @shared/platform's words / keyLabel).
 * Stage 1 on Windows: sites (Node.js, Bun, Go, Python), Runtimes for those, Git, the proxy and the local CA.
 */
export const isWin = window.herd.platform === 'win32';

/** Rail sections and Settings tabs Windows has so far. */
export const WIN_SECTIONS = new Set(['projects', 'runtimes', 'git', 'settings']);
export const WIN_SETTINGS_TABS = new Set(['general', 'ai', 'project', 'updates', 'about']);
/** Site tabs that work on Windows so far. */
export const WIN_SITE_TABS = new Set(['overview', 'env', 'api', 'git', 'docker', 'logs', 'settings']);
/** Runtimes pages on Windows. */
export const WIN_RUNTIMES = new Set(['node', 'bun', 'go', 'python']);
