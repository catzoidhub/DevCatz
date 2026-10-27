/**
 * Platform in the window (Catzoid #57): Windows hides what is macOS-only so far (wording: @shared/platform's words / keyLabel).
 * On Windows so far: sites (Node.js, Bun, Go, Python, PHP), Runtimes for those, Git, the proxy and the local CA; stage 3 adds Database.
 */
export const isWin = window.herd.platform === 'win32';
// `html.is-win`: CSS for Windows only, e.g. `.win-top` (room above a page's header for the window buttons).
if (isWin) document.documentElement.classList.add('is-win');

/** Rail sections and Settings tabs Windows has so far. */
export const WIN_SECTIONS = new Set(['projects', 'runtimes', 'database', 'git', 'settings']);
export const WIN_SETTINGS_TABS = new Set(['general', 'ai', 'project', 'database', 'updates', 'about']);
/** Site tabs that work on Windows so far. */
export const WIN_SITE_TABS = new Set(['overview', 'env', 'database', 'api', 'git', 'docker', 'logs', 'settings']);
/** Runtimes pages on Windows. */
export const WIN_RUNTIMES = new Set(['node', 'bun', 'go', 'python', 'php']);

/** This computer's build id on the Catzoid site (`<site>/download/<app>/<id>`): mac-arm64, mac-x64 or win-x64. */
export const downloadPlatform = isWin ? 'win-x64' : window.herd.arch === 'arm64' ? 'mac-arm64' : 'mac-x64';
