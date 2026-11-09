/**
 * Platform in the window (Catzoid #57): Windows hides what is macOS-only so far (wording: @shared/platform's words / keyLabel).
 * Every rail section is on Windows now; the lists stay for the Mac-only parts that remain (Valkey and the like hide per page).
 */
export const isWin = window.herd.platform === 'win32';
/** Linux (TODO §35): until a page is ported it shows the macOS path, like main's `isWin ? win : mac` branches. */
export const isLinux = window.herd.platform === 'linux';
// `html.is-win`: CSS for Windows only, e.g. `.win-top` (room above a page's header for the window buttons).
if (isWin) document.documentElement.classList.add('is-win');
// `html.is-linux`: Linux has the same window buttons over the top-right corner, so `.win-top` leaves room there too.
if (isLinux) document.documentElement.classList.add('is-linux');

/** Rail sections and Settings tabs Windows has so far. */
export const WIN_SECTIONS = new Set(['projects', 'runtimes', 'database', 'storage', 'websocket', 'search', 'git', 'mail', 'whatsapp', 'expose', 'monitoring', 'settings']);
export const WIN_SETTINGS_TABS = new Set(['general', 'ai', 'mcatzp', 'project', 'database', 'storage', 'websocket', 'search', 'mail', 'whatsapp', 'expose', 'monitoring', 'updates', 'about']);
/** Site tabs that work on Windows so far. */
export const WIN_SITE_TABS = new Set(['overview', 'env', 'database', 'storage', 'api', 'git', 'mail', 'whatsapp', 'websocket', 'search', 'docker', 'logs', 'settings']);
/** Runtimes pages on Windows. */
export const WIN_RUNTIMES = new Set(['node', 'bun', 'go', 'python', 'ruby', 'php', 'rust']);

/** This computer's build id on the Catzoid site (`<site>/download/<app>/<id>`): mac-arm64, mac-x64 or win-x64. */
export const downloadPlatform = isWin ? 'win-x64' : window.herd.arch === 'arm64' ? 'mac-arm64' : 'mac-x64';
