<script setup lang="ts">
import { confirmCleanUrls, confirmResolver, confirmTrustCa } from '../confirms';
import { currentOS, words } from '@shared/platform';
import PageHeader from './PageHeader.vue';
import AiSettings from './AiSettings.vue';
import AboutCard from './AboutCard.vue';
import ParkDialog from './ParkDialog.vue';
import UpdatesCard from './UpdatesCard.vue';
import { ICONS } from '../icons';
import UpdateButton from './UpdateButton.vue';
import { computed, ref, watch } from 'vue';
import type { GwKind, DbEngine, DbEngineInfo, DbServiceState, MailForwardConfig, SearchKind, Settings, StorageAction, StorageKind, StorageState, ThemeMode, TldChange, WsKind } from '@shared/types';
import StorageForm from './StorageForm.vue';
import DbServiceForm from './DbServiceForm.vue';
import { DB_LOGO } from '../db';
import { attempt, herd, navRequest, notify, state } from '../store';
import { navVisit } from '../nav';
import { isWin, WIN_SETTINGS_TABS } from '../platform';

const s = computed(() => state.value!);
const setUpdateNotifications = (on: boolean) => attempt(() => herd.updateSettings({ updateNotifications: on }));
const checkUpdates = () => attempt(() => herd.checkUpdates());
const RUNTIME_NAMES = { node: 'Node.js', bun: 'Bun', go: 'Go', php: 'PHP' } as const;
const ports = ref({ httpsPort: 0, httpPort: 0 });
watch(
  () => s.value.settings,
  (v) => (ports.value = { httpsPort: v.httpsPort, httpPort: v.httpPort }),
  { immediate: true },
);

async function savePorts() {
  await attempt(() => herd.updateSettings({ httpsPort: Number(ports.value.httpsPort), httpPort: Number(ports.value.httpPort) }), 'Proxy restarted');
}

/** The folder being parked: the same dialog as Create New Site (park as a group). */
const parking = ref<string | null>(null);
async function park() {
  const dir = await herd.pickFolder();
  if (dir) parking.value = dir;
}

async function trust() {
  if (!(await confirmTrustCa())) return;
  const ok = await attempt(() => herd.trustCa());
  if (ok) await attempt(async () => undefined, 'Certificate authority trusted. Reload your browser tabs.');
}

const THEMES: { value: ThemeMode; label: string }[] = [
  { value: 'system', label: 'Auto' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];
const tldInput = ref('');
watch(
  () => s.value.domain.tld,
  (v) => (tldInput.value = v),
  { immediate: true },
);
const tldPreview = ref<TldChange | null>(null);
async function previewTld() {
  tldPreview.value = (await attempt(() => herd.setTld(tldInput.value, true))) ?? null;
}
async function applyTld() {
  if (!tldPreview.value) return;
  const r = await attempt(() => herd.setTld(tldPreview.value!.to));
  if (r) notify('success', `Default domain is now .${r.to}${r.renamed.length ? `; renamed ${r.renamed.length} site(s)` : ''}`);
  tldPreview.value = null;
}
const installResolver = async () => (await confirmResolver()) && attempt(() => herd.installResolver());
const uninstallResolver = () => attempt(() => herd.uninstallResolver(), 'Resolver removed');

const setStartAll = (startAllOnLaunch: boolean) => attempt(() => herd.updateSettings({ startAllOnLaunch }));
const setTheme = (theme: ThemeMode) => attempt(() => herd.updateSettings({ theme }));
const quitApp = () => attempt(() => herd.quitApp());
const setLogin = (on: boolean) => attempt(() => herd.setLaunchAtLogin(on));
/** A path under DevCatz's data folder, as this OS writes it (placeholders only). */
const appDataPath = (...parts: string[]) => [words.appData, 'DevCatz', ...parts].join(words.sep);
const untrust = () => attempt(() => herd.untrustCa(), isWin ? 'Removed from your Trusted Root certificates' : 'Removed from keychain');
const unpark = (dir: string) => attempt(() => herd.unparkFolder(dir));
const setEditor = (editor: string) => attempt(() => herd.updateSettings({ editor }));
const setBrowser = (browser: string) => attempt(() => herd.updateSettings({ browser }));
const chosenBrowser = computed(() => (state.value?.settings.browser ? (state.value.browsers.list.find((b) => b.path === state.value!.settings.browser) ?? null) : (state.value?.browsers.systemDefault ?? null)));
/** The editor links open with: the chosen one, or the first installed (Auto). */
const chosenEditor = computed(() => state.value?.settings.editor || state.value?.editors[0] || null);
function pickEditor(name: string) {
  void setEditor(name);
  (document.activeElement as HTMLElement | null)?.blur();
}
function pickBrowser(path: string) {
  void setBrowser(path);
  (document.activeElement as HTMLElement | null)?.blur();
}

async function cleanUrls(on: boolean) {
  if (on && !(await confirmCleanUrls())) return;
  const ok = on ? await attempt(() => herd.installCleanUrls()) : await attempt(() => herd.uninstallCleanUrls());
  if (ok) await attempt(async () => undefined, on ? 'Clean URLs enabled' : 'Clean URLs disabled');
}
const emit = defineEmits<{ close: [] }>();

// ---- Object Storage tab
const storageForm = ref<{ service: StorageState; mode: 'install' | 'edit' } | null>(null);
const setS3 = (patch: Partial<Settings>) => attempt(() => herd.updateSettings(patch));
async function pickStorageRoot() {
  const dir = await herd.pickFolder();
  if (dir) await setS3({ storageRoot: dir });
}
async function pickStorageBinRoot() {
  const dir = await herd.pickFolder();
  if (dir) await setS3({ storageBinRoot: dir });
}
async function setAutoStart(kind: StorageKind, on: boolean) {
  await attempt(() => herd.serviceSetAutoStart('storage', kind, on));
}
/** Settings → WebSocket / Search Engine → Services: autostart and start / stop without leaving Settings. */
const svcBusy = ref<string | null>(null);
async function svcAction(scope: 'ws' | 'search', kind: string, action: StorageAction) {
  svcBusy.value = `${scope}:${kind}`;
  await attempt(() => (scope === 'ws' ? herd.wsAction(kind as WsKind, action) : herd.searchAction(kind as SearchKind, action)).then(() => true));
  svcBusy.value = null;
}
const svcAutoStart = (scope: 'ws' | 'search', kind: string, on: boolean) => attempt(() => herd.serviceSetAutoStart(scope, kind, on));
const gwAction = async (kind: GwKind, action: StorageAction) => {
  svcBusy.value = `gw:${kind}`;
  await attempt(() => herd.gwAction(kind, action).then(() => true));
  svcBusy.value = null;
};
const gwAutoStart = (kind: GwKind, on: boolean) => attempt(() => herd.gwSetAutoStart(kind, on));
const openGateway = (id: string) => (navRequest.value = { section: 'whatsapp', id });
const svcActive = (st: string) => st === 'running' || st === 'starting';
const openSection = (section: 'websocket' | 'search', id: string) => (navRequest.value = { section, id });
const ALL_TABS = [
  { id: 'general', label: 'General' },
  { id: 'ai', label: 'AI' },
  { id: 'project', label: 'Project' },
  { id: 'database', label: 'Database' },
  { id: 'storage', label: 'Object Storage' },
  { id: 'websocket', label: 'WebSocket' },
  { id: 'search', label: 'Search Engine' },
  { id: 'mail', label: 'Mail' },
  { id: 'whatsapp', label: 'Gateways' },
  { id: 'expose', label: 'Expose' },
  { id: 'monitoring', label: 'Monitoring' },
  { id: 'updates', label: 'Updates' },
  { id: 'about', label: 'About' },
] as const;
// Windows, stage 1: tabs for macOS-only services stay hidden (Catzoid #57).
const TABS = ALL_TABS.filter((t) => !isWin || WIN_SETTINGS_TABS.has(t.id));

// ---- Mail: forwarding account (password kept encrypted in the main process)
const fwd = ref<MailForwardConfig & { password: string }>({ host: '', port: 587, security: 'starttls', username: '', password: '', from: '' });
const fwdSaved = ref(false);
const fwdHasPassword = ref(false);
async function loadForward() {
  const c = await herd.mailForwardConfig().catch(() => null);
  fwdSaved.value = Boolean(c?.host);
  fwdHasPassword.value = c?.password === '';
  if (c) fwd.value = { ...c, password: '' };
}
void loadForward();
async function saveForward() {
  const ok = await attempt(() => herd.mailSetForwardConfig({ ...fwd.value, password: fwd.value.password || (fwdHasPassword.value ? '' : null) }).then(() => true), 'Forwarding account saved');
  if (ok) await loadForward();
}
async function removeForward() {
  if (await attempt(() => herd.mailSetForwardConfig(null).then(() => true), 'Forwarding account removed')) {
    fwd.value = { host: '', port: 587, security: 'starttls', username: '', password: '', from: '' };
    await loadForward();
  }
}
async function mailTest() {
  if (await attempt(() => herd.mailSendTest(null).then(() => true))) notify('success', 'Test mail sent to the catcher');
}
/** Number settings: kept within sane bounds. */
const setNum = (key: 'monitorCpuAlert' | 'monitorMemAlertMb' | 'monitorAlertMinutes' | 'monitorDiskAlertGb' | 'wsTestEvents' | 'searchOpenSearchHeapMb' | 'mailPort' | 'mailKeep' | 'waKeep' | 'exposeExpiryMinutes', v: string, min: number, max: number) => {
  const n = Math.round(Number(v));
  if (Number.isFinite(n)) void setS3({ [key]: Math.min(max, Math.max(min, n)) });
};
// The rail's warning dot means the HTTPS certificate is not trusted: open where that is fixed.
const tab = ref<(typeof TABS)[number]['id']>(state.value?.cert.caTrusted === false ? 'project' : 'general');

// ---- Database tab
const dbForm = ref<DbServiceState | null>(null);
async function pickDb(key: 'dbDataRoot' | 'dbBinRoot') {
  const dir = await herd.pickFolder();
  if (dir) await setS3({ [key]: dir });
}
async function setDbAutoStart(d: DbServiceState, on: boolean) {
  const { engine, version, name, port, socket, dataDir, configFile, disableBinLog, user, password } = d;
  await attempt(() => herd.dbUpdate(d.id, { engine, version, name, port, socket, dataDir, configFile, disableBinLog, autoStart: on, user, password }));
}
/** Installed builds with the services using them. */
const dbEngines = ref<DbEngineInfo[]>([]);
const loadDbEngines = async () => (dbEngines.value = (await herd.dbEngines().catch(() => [])) ?? []);
watch(
  () => [tab.value, s.value.databases.length],
  () => tab.value === 'database' && void loadDbEngines(),
);
const dbBuilds = computed(() =>
  dbEngines.value
    .filter((e) => e.engine !== 'sqlite')
    .flatMap((e) =>
      e.installed.map((b) => ({ ...b, name: e.name, users: s.value.databases.filter((d) => d.engine === b.engine && d.version === b.version).map((d) => d.name) })),
    ),
);
const revealBuild = (b: { engine: DbEngine; version: string }) => attempt(() => herd.dbBuildAction(b.engine, b.version, 'reveal'));
async function removeBuild(b: { engine: DbEngine; version: string; name: string }) {
  if (!confirm(`Remove ${b.name} ${b.version}?`)) return;
  if (await attempt(() => herd.dbBuildAction(b.engine, b.version, 'remove').then(() => true))) await loadDbEngines();
}
const props = withDefaults(defineProps<{ closable?: boolean; focus?: string | null }>(), { closable: true, focus: null });
// Back / forward history: each Settings tab is a step.
watch(tab, (t) => navVisit({ section: 'settings', tab: t }), { immediate: true });
watch(
  () => props.focus,
  (id) => id && TABS.some((t) => t.id === id) && (tab.value = id as (typeof TABS)[number]['id']),
  { immediate: true },
);

// ---- Expose: provider accounts (tokens kept encrypted in the main process)
const ngrokForm = ref({ token: '', domain: '' });
const exposeForm = ref({ token: '', server: '', domain: '' });
watch(
  () => s.value.expose.accounts,
  (a) => {
    ngrokForm.value = { token: '', domain: a.ngrok.domain };
    exposeForm.value = { token: '', server: a.expose.server, domain: a.expose.domain };
  },
  { immediate: true },
);
const saveNgrok = () => attempt(() => herd.exposeSetAccount('ngrok', { token: ngrokForm.value.token, domain: ngrokForm.value.domain }).then(() => true), 'ngrok account saved');
const saveExpose = () => attempt(() => herd.exposeSetAccount('expose', { token: exposeForm.value.token, server: exposeForm.value.server, domain: exposeForm.value.domain }).then(() => true), 'Expose account saved');
const forget = (p: 'ngrok' | 'expose') => attempt(() => herd.exposeSetAccount(p, { token: null }).then(() => true), `${p === 'ngrok' ? 'ngrok' : 'Expose'} account removed`);
</script>

<template>
  <PageHeader title="Settings" :icon="ICONS.cog" tint="settings" :closable="closable" @close="emit('close')">
  </PageHeader>
  <div class="no-drag border-b border-base-300/60 px-6 py-3">
    <!-- A narrow window wraps the tabs onto a second row instead of running past the edge. -->
    <div role="tablist" class="seg max-w-full flex-wrap">
      <a v-for="t in TABS" :key="t.id" role="tab" class="seg-item" :class="{ 'is-active': tab === t.id }" @click="tab = t.id">{{ t.label }}</a>
    </div>
  </div>
  <section class="site-tab">
    <!-- About (the app menu's About DevCatz opens it) -->
    <AboutCard v-if="tab === 'about'" />
    <!-- Updates (Catzoid #54) -->
    <UpdatesCard v-if="tab === 'updates'" />

    <!-- General -->
    <div v-if="tab === 'general'" class="card">
      <div class="card-body">
        <h2 class="font-semibold">App</h2>
        <div class="flex items-center gap-3">
          <span class="w-28">Appearance</span>
          <div class="join">
            <button
              v-for="m in THEMES"
              :key="m.value"
              class="btn btn-sm join-item"
              :class="{ 'btn-active btn-primary': s.settings.theme === m.value }"
              @click="setTheme(m.value)"
            >
              {{ m.label }}
            </button>
          </div>
          <span class="badge badge-ghost badge-sm" title="Change it here and every Catzoid app follows">Shared with Catzoid apps</span>
        </div>
        <label class="flex cursor-pointer items-center gap-3">
          <input type="checkbox" class="toggle toggle-primary toggle-sm" :checked="s.launchAtLogin" @change="setLogin(($event.target as HTMLInputElement).checked)" />
          <span>
            Launch at login
            <span class="block text-xs opacity-60">Starts in the {{ words.tray }} without a window.</span>
          </span>
        </label>
        <label class="flex cursor-pointer items-center gap-3">
          <input type="checkbox" class="toggle toggle-primary toggle-sm" :checked="s.settings.crashReports" @change="herd.setCrashReports(($event.target as HTMLInputElement).checked)" />
          <span>
            Send crash reports
            <span class="block text-xs opacity-60">
              When DevCatz crashes or hits an error, a report goes to {{ s.reports.site.replace('https://', '') }} — version, {{ words.os }}, the error and where it
              happened; never projects, .env values, keys, hosts or paths. Off until you turn it on.
            </span>
          </span>
        </label>
                <div>
          <button class="btn btn-sm btn-outline btn-error" @click="quitApp">Quit DevCatz</button>
          <span class="ml-2 text-xs opacity-60">Stops all dev servers. Closing the window keeps the app in the {{ words.tray }}.</span>
        </div>
        <p v-if="!s.packaged" class="text-xs text-warning">
          Development build: the login item would point at the dev Electron binary. Use the packaged app (<code>bun run package</code>) for this.
        </p>
      </div>
    </div>

    <!-- Sites -->
    <div v-if="tab === 'project'" class="card">
      <div class="card-body">
        <h2 class="font-semibold">Sites</h2>
        <label class="flex cursor-pointer items-center gap-3">
          <input
            type="checkbox"
            class="toggle toggle-primary toggle-sm"
            :checked="s.settings.startAllOnLaunch"
            @change="setStartAll(($event.target as HTMLInputElement).checked)"
          />
          <span>
            Start all sites on launch
            <span class="block text-xs opacity-60">When off, only sites with "Start automatically" (site settings) start.</span>
          </span>
        </label>
      </div>
    </div>

    <!-- Default domain (used by sites and storage domains); other suffixes need macOS's /etc/resolver so far -->
    <div v-if="tab === 'general' && !isWin" class="card">
      <div class="card-body">
        <h2 class="font-semibold">Default domain</h2>
        <p class="text-xs opacity-70">
          Sites and object storage are served on <code>&lt;name&gt;.{{ s.domain.tld }}</code>. <code>.localhost</code> needs no setup; any other suffix
          (e.g. <code>.test</code> or <code>.devcatz</code>) uses DevCatz's own DNS through <code>/etc/resolver</code>.
        </p>
        <div class="flex items-end gap-2">
          <label>
            <span class="block text-xs opacity-60">Suffix</span>
            <div class="join">
              <span class="join-item flex items-center rounded-l-field border border-base-300 bg-base-200 px-3 font-mono text-xs">*.</span>
              <input v-model="tldInput" class="input input-sm join-item w-40 font-mono" placeholder="localhost" />
            </div>
          </label>
          <button class="btn btn-sm" :disabled="!tldInput.trim() || tldInput.trim() === s.domain.tld" @click="previewTld">Change…</button>
        </div>

        <div v-if="tldPreview" class="rounded-box border border-base-300 p-3 text-sm">
          <div class="font-medium">.{{ tldPreview.from }} → .{{ tldPreview.to }}</div>
          <ul v-if="tldPreview.renamed.length" class="mt-1 max-h-40 overflow-y-auto font-mono text-xs">
            <li v-for="r in tldPreview.renamed" :key="r.from">{{ r.from }} → {{ r.to }}</li>
          </ul>
          <p v-else class="mt-1 text-xs opacity-60">No site uses .{{ tldPreview.from }} right now.</p>
          <p class="mt-2 text-xs opacity-70">
            Domains you set by hand with another suffix stay as they are. Update <code>APP_URL</code> / <code>CORS_ORIGIN</code> in
            each project's .env afterwards; the site page lists the values that still point at the old domain.
          </p>
          <div class="mt-2 flex gap-2">
            <button class="btn btn-primary btn-sm" @click="applyTld">Rename {{ tldPreview.renamed.length }} site(s)</button>
            <button class="btn btn-ghost btn-sm" @click="tldPreview = null">Cancel</button>
          </div>
        </div>

        <div v-if="s.domain.needsResolver" class="text-sm">
          <div class="flex items-center gap-2">
            <span class="badge badge-sm" :class="s.domain.resolves ? 'badge-success' : 'badge-warning'">
              {{ s.domain.resolves ? `*.${s.domain.tld} resolves` : `*.${s.domain.tld} does not resolve yet` }}
            </span>
            <span v-if="s.domain.dnsError" class="text-xs text-error">{{ s.domain.dnsError }}</span>
          </div>
          <p v-if="s.domain.resolver === 'foreign'" class="mt-1 text-xs text-warning">
            <code>/etc/resolver/{{ s.domain.tld }}</code> belongs to another tool. Remove it there first.
          </p>
          <div v-else class="mt-2 flex gap-2">
            <button v-if="s.domain.resolver !== 'ours'" class="btn btn-sm btn-primary" @click="installResolver">Install resolver for .{{ s.domain.tld }}…</button>
            <button v-else class="btn btn-sm btn-outline" @click="uninstallResolver">Remove resolver</button>
          </div>
        </div>
      </div>
    </div>

    <!-- HTTPS -->
    <div v-if="tab === 'project'" class="card">
      <div class="card-body">
        <h2 class="font-semibold">
          HTTPS certificates
          <span class="badge badge-sm ml-1" :class="s.cert.caTrusted ? 'badge-success' : 'badge-warning'">
            {{ s.cert.caTrusted ? 'trusted' : 'not trusted' }}
          </span>
        </h2>
        <p class="text-xs opacity-70">
          A local certificate authority signs a certificate for every <code>*.{{ s.domain.tld }}</code> site. Add it to {{ isWin ? 'your Trusted Root certificates' : 'your login keychain' }} once
          so browsers show no warning (Firefox uses its own store: import <code>ca.crt</code> there, or set
          <code>security.enterprise_roots.enabled</code>).
        </p>
        <div class="flex gap-2">
          <button v-if="!s.cert.caTrusted" class="btn btn-primary btn-sm" @click="trust">Trust certificate authority…</button>
          <button v-else class="btn btn-sm btn-outline" @click="untrust">{{ isWin ? 'Remove from Windows' : 'Remove from keychain' }}</button>
          <button class="btn btn-ghost btn-sm" @click="herd.revealCa()">Show ca.crt</button>
        </div>
      </div>
    </div>

    <!-- Proxy / clean URLs -->
    <div v-if="tab === 'project'" class="card">
      <div class="card-body">
        <h2 class="font-semibold">
          Proxy
          <span class="badge badge-sm ml-1" :class="s.proxy.https ? 'badge-success' : 'badge-error'">{{ s.proxy.https ? 'listening' : 'down' }}</span>
        </h2>
        <p v-if="s.proxy.error" class="text-xs text-error">{{ s.proxy.error }}</p>
        <div class="flex items-end gap-2">
          <label>
            <span class="block text-xs opacity-60">HTTPS port</span>
            <input v-model="ports.httpsPort" type="number" class="input input-sm w-28" />
          </label>
          <label>
            <span class="block text-xs opacity-60">HTTP port</span>
            <input v-model="ports.httpPort" type="number" class="input input-sm w-28" />
          </label>
          <button class="btn btn-sm" @click="savePorts">Apply</button>
        </div>

        <p v-if="isWin" class="text-xs opacity-70">
          Chrome, Edge and Firefox send every <code>*.localhost</code> name to this PC by themselves.
        </p>
        <div class="divider my-0" />
        <h3 class="font-medium">
          URLs without a port
          <span class="badge badge-sm ml-1" :class="s.cleanUrls.installed ? 'badge-success' : 'badge-ghost'">{{ s.cleanUrls.installed ? 'on' : 'off' }}</span>
        </h3>
        <p v-if="isWin" class="text-xs opacity-70">
          Windows' port proxy (the IP Helper service) takes <code>[::1]:443</code> / <code>[::1]:80</code> and relays to the proxy on
          {{ s.settings.httpsPort }} / {{ s.settings.httpPort }}, and on <code>127.0.0.1</code> too when no other app uses those ports. Needs
          administrator approval once.
        </p>
        <p v-else class="text-xs opacity-70">
          Browsers resolve <code>*.{{ s.domain.tld }}</code> to <code>::1</code> first, so DevCatz listens on the IPv6 loopback: launchd takes
          <code>[::1]:443</code> / <code>[::1]:80</code> and relays to the proxy on {{ s.settings.httpsPort }} / {{ s.settings.httpPort }}, and on
          <code>127.0.0.1</code> too when no other app uses those ports. Needs your admin password once.
        </p>
        <p v-if="s.cleanUrls.installed" class="text-xs opacity-70">
          Covers <code>[::1]</code>{{ s.cleanUrls.ipv4 ? ' and 127.0.0.1' : '' }}.
          <template v-if="!s.cleanUrls.ipv4 && s.cleanUrls.ipv4Available">127.0.0.1:443 is free now: disable and enable again to cover IPv4 too.</template>
        </p>
        <p v-if="s.cleanUrls.configured && !s.cleanUrls.installed" class="text-xs text-warning">
          The forwarder is installed but not answering. Make sure the proxy is listening; after changing the proxy ports, disable and enable it again.
        </p>
        <div class="flex gap-2">
          <button v-if="!s.cleanUrls.installed" class="btn btn-sm btn-primary" @click="cleanUrls(true)">Enable clean URLs…</button>
          <button v-if="s.cleanUrls.installed || s.cleanUrls.configured" class="btn btn-sm btn-outline" @click="cleanUrls(false)">Disable</button>
        </div>
      </div>
    </div>

    <!-- Runtime updates -->
    <div v-if="tab === 'project'" class="card">
      <div class="card-body">
        <div class="flex items-center gap-3">
          <h2 class="flex-1 font-semibold">Runtime updates</h2>
          <label class="flex cursor-pointer items-center gap-2 text-xs">
            Notify me
            <input
              type="checkbox"
              class="toggle toggle-sm toggle-primary"
              :checked="s.settings.updateNotifications"
              @change="setUpdateNotifications(($event.target as HTMLInputElement).checked)"
            />
          </label>
        </div>
        <p class="text-xs opacity-70">
          Checks every 6 hours for newer patch releases of installed PHP, Go, Bun and Node.js (same minor / major line) and shows a {{ words.os }}
          notification once per release. Updating installs the new version next to the old one and moves the default over.
        </p>
        <ul v-if="s.updates.list.length" class="space-y-1">
          <li v-for="u in s.updates.list" :key="u.runtime + u.from" class="flex items-center gap-2">
            <span class="w-16 text-xs font-medium">{{ RUNTIME_NAMES[u.runtime] }}</span>
            <code class="text-xs">{{ u.from }} → {{ u.to }}</code>
            <span v-if="u.isDefault" class="badge badge-primary badge-xs">default</span>
            <span class="flex-1" />
            <UpdateButton :runtime="u.runtime" :version="u.from" />
          </li>
        </ul>
        <div class="flex items-center gap-3 text-xs">
          <button class="btn btn-sm" :disabled="s.updates.checking" @click="checkUpdates">
            <span v-if="s.updates.checking" class="loading loading-spinner loading-xs" />
            Check now
          </button>
          <span class="opacity-60">
            {{ s.updates.checkedAt ? `Last checked ${new Date(s.updates.checkedAt).toLocaleString()}` : 'Not checked yet' }}
            <template v-if="s.updates.checkedAt && !s.updates.list.length"> · everything is up to date</template>
          </span>
        </div>
        <div v-if="s.updates.error" class="text-xs text-error">{{ s.updates.error }}</div>
      </div>
    </div>

    <!-- Parked folders -->
    <div v-if="tab === 'project'" class="card">
      <div class="card-body">
        <h2 class="font-semibold">Parked folders</h2>
        <p class="text-xs opacity-70">
          Every sub-folder with a <code>package.json</code>, <code>composer.json</code>, <code>go.mod</code>, <code>Cargo.toml</code> or a Python project becomes
          <code>&lt;folder&gt;.{{ s.domain.tld }}</code>. A folder parked as a group keeps its sites (and new ones) in that sidebar group.
        </p>
        <ul class="space-y-1">
          <li v-for="dir in s.settings.parkedDirs" :key="dir" class="flex items-center gap-2">
            <code class="flex-1 truncate">{{ dir }}</code>
            <span v-if="s.settings.parkGroups?.[dir]" class="badge badge-ghost badge-sm" title="Its sites, and new ones, go into this sidebar group">group: {{ s.settings.parkGroups[dir].group }}</span>
            <button class="btn btn-ghost btn-xs" @click="unpark(dir)">Unpark</button>
          </li>
        </ul>
        <div><button class="btn btn-sm" @click="park">Park a folder…</button></div>
      </div>
    </div>

    <!-- Open with: editor and browser -->
    <div v-if="tab === 'general'" class="card">
      <div class="card-body gap-3">
        <h2 class="font-semibold">Open with</h2>
        <div class="grid grid-cols-[6rem_1fr] items-center gap-x-4 gap-y-3">
          <span class="text-sm opacity-70">Editor</span>
          <div class="dropdown">
            <button type="button" tabindex="0" class="select select-sm flex w-64 items-center gap-2 text-left">
              <img v-if="s.editorIcons[chosenEditor ?? '']" :src="s.editorIcons[chosenEditor ?? '']" alt="" class="size-4 shrink-0" draggable="false" />
              <span class="min-w-0 flex-1 truncate">{{ s.settings.editor ? s.settings.editor : `Auto (${s.editors[0] ?? words.fileManager})` }}</span>
            </button>
            <ul tabindex="0" class="dropdown-content menu z-30 mt-1 w-64 rounded-box border border-base-300/70 bg-base-100 p-1.5 shadow-xl">
              <li>
                <button type="button" class="flex items-center gap-2" :class="{ 'menu-active': !s.settings.editor }" @click="pickEditor('')">
                  <img v-if="s.editorIcons[s.editors[0] ?? '']" :src="s.editorIcons[s.editors[0] ?? '']" alt="" class="size-4 shrink-0" draggable="false" />
                  <span class="flex-1 truncate">Auto</span>
                  <span class="text-xs opacity-50">{{ s.editors[0] ?? words.fileManager }}</span>
                </button>
              </li>
              <li v-for="e in s.editors" :key="e">
                <button type="button" class="flex items-center gap-2" :class="{ 'menu-active': s.settings.editor === e }" @click="pickEditor(e)">
                  <img v-if="s.editorIcons[e]" :src="s.editorIcons[e]" alt="" class="size-4 shrink-0" draggable="false" />
                  <span class="flex-1 truncate">{{ e }}</span>
                </button>
              </li>
            </ul>
          </div>

          <span class="text-sm opacity-70" :title="`Sites and service pages: Open in Browser, the ${words.tray}, links in DevCatz`">Browser</span>
          <div class="dropdown">
            <button type="button" tabindex="0" class="select select-sm flex w-64 items-center gap-2 text-left">
              <img v-if="chosenBrowser?.icon" :src="chosenBrowser.icon" alt="" class="size-4 shrink-0" draggable="false" />
              <span class="min-w-0 flex-1 truncate">{{ s.settings.browser ? (chosenBrowser?.name ?? 'Not installed') : `System default (${s.browsers.systemDefault?.name ?? words.os})` }}</span>
            </button>
            <ul tabindex="0" class="dropdown-content menu z-30 mt-1 w-64 rounded-box border border-base-300/70 bg-base-100 p-1.5 shadow-xl">
              <li>
                <button type="button" class="flex items-center gap-2" :class="{ 'menu-active': !s.settings.browser }" @click="pickBrowser('')">
                  <img v-if="s.browsers.systemDefault?.icon" :src="s.browsers.systemDefault.icon" alt="" class="size-4 shrink-0" draggable="false" />
                  <span class="flex-1 truncate">System default</span>
                  <span class="text-xs opacity-50">{{ s.browsers.systemDefault?.name ?? '' }}</span>
                </button>
              </li>
              <li v-for="b in s.browsers.list" :key="b.path">
                <button type="button" class="flex items-center gap-2" :class="{ 'menu-active': s.settings.browser === b.path }" :title="b.path" @click="pickBrowser(b.path)">
                  <img v-if="b.icon" :src="b.icon" alt="" class="size-4 shrink-0" draggable="false" />
                  <span class="flex-1 truncate">{{ b.name }}</span>
                </button>
              </li>
            </ul>
          </div>
        </div>
        <p v-if="s.settings.browser && !chosenBrowser" class="text-xs text-warning">The chosen browser is no longer installed; links open in the system default.</p>
      </div>
    </div>
    <!-- Database: services -->
    <div v-if="tab === 'database'" class="card">
      <div class="card-body">
        <h2 class="font-semibold">Services</h2>
        <div v-if="s.databases.some((d) => !d.pending)" class="overflow-x-auto rounded-box border border-base-300/60">
          <table class="table table-sm">
            <thead>
              <tr><th>Service</th><th>Status</th><th>Address</th><th>Starts with DevCatz</th><th class="text-right"></th></tr>
            </thead>
            <tbody>
              <tr v-for="d in s.databases.filter((x) => !x.pending)" :key="d.id">
                <td class="whitespace-nowrap">
                  <div class="flex items-center gap-2">
                    <img :src="DB_LOGO[d.engine]" alt="" class="size-6 rounded-md bg-white p-0.5" draggable="false" />
                    <div>
                      <div class="font-medium">{{ d.name }}</div>
                      <div class="font-mono text-xs opacity-50">{{ d.engineName }} {{ d.version }}</div>
                    </div>
                  </div>
                </td>
                <td>
                  <span v-if="d.engine === 'sqlite'" class="badge badge-ghost badge-sm">files</span>
                  <span v-else class="badge badge-soft badge-sm" :class="d.status === 'running' ? 'badge-success' : d.status === 'crashed' ? 'badge-error' : 'badge-ghost'">{{ d.status }}</span>
                </td>
                <td class="font-mono text-xs">{{ d.engine === 'sqlite' ? '—' : `${d.host ?? '127.0.0.1'}:${d.port}` }}</td>
                <td>
                  <input
                    v-if="d.engine !== 'sqlite'"
                    type="checkbox"
                    class="toggle toggle-sm toggle-primary"
                    :checked="d.autoStart"
                    @change="setDbAutoStart(d, ($event.target as HTMLInputElement).checked)"
                  />
                </td>
                <td class="text-right"><button class="btn btn-ghost btn-xs" @click="dbForm = d">Settings…</button></td>
              </tr>
            </tbody>
          </table>
        </div>
        <p v-else class="text-xs opacity-60">No database services yet; create them on the Database page (rail).</p>
      </div>
    </div>

    <!-- Database: builds -->
    <div v-if="tab === 'database'" class="card">
      <div class="card-body">
        <h2 class="font-semibold">Installed server builds</h2>
        <div v-if="dbBuilds.length" class="overflow-x-auto rounded-box border border-base-300/60">
          <table class="table table-sm">
            <thead>
              <tr><th>Engine</th><th>Version</th><th>From</th><th>Used by</th><th class="text-right"></th></tr>
            </thead>
            <tbody>
              <tr v-for="b in dbBuilds" :key="b.engine + b.version">
                <td class="whitespace-nowrap"><img :src="DB_LOGO[b.engine]" alt="" class="mr-1.5 inline size-4 rounded bg-white p-px" draggable="false" />{{ b.name }}</td>
                <td class="font-mono text-xs">{{ b.version }}</td>
                <td class="text-xs">{{ b.source === 'homebrew' ? 'Homebrew' : b.source === 'source' ? 'Compiled' : 'Download' }}</td>
                <td class="text-xs">{{ b.users.join(', ') || '—' }}</td>
                <td class="text-right whitespace-nowrap">
                  <button class="btn btn-ghost btn-xs" :title="b.root" @click="revealBuild(b)">Show</button>
                  <button
                    class="btn btn-ghost btn-xs text-error"
                    :disabled="b.users.length > 0"
                    :title="b.users.length ? 'In use' : b.source === 'homebrew' ? 'Forget it here (brew uninstall removes it)' : 'Delete the build'"
                    @click="removeBuild(b)"
                  >
                    Remove
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p v-else class="text-xs opacity-60">None yet: builds are installed when you create a service with a version that is not on this Mac.</p>
      </div>
    </div>

    <!-- Database: defaults -->
    <div v-if="tab === 'database'" class="card">
      <div class="card-body gap-4">
        <h2 class="font-semibold">Defaults</h2>
        <div class="grid gap-4 sm:grid-cols-2">
          <label class="block sm:col-span-2">
            <span class="label-caps mb-1 block">Data folders of new services</span>
            <div class="join w-full">
              <input class="input input-sm join-item w-full font-mono text-xs" :value="s.settings.dbDataRoot" :placeholder="`DevCatz's data folder (${appDataPath('db-services', 'data')})`" readonly />
              <button class="btn btn-sm join-item" @click="pickDb('dbDataRoot')">Choose…</button>
              <button v-if="s.settings.dbDataRoot" class="btn btn-sm join-item" @click="setS3({ dbDataRoot: '' })">Reset</button>
            </div>
            <span class="mt-1 block text-xs opacity-60">A service whose Data path is left empty gets <code>&lt;folder&gt;/&lt;service id&gt;</code>. Existing services keep their folders.</span>
          </label>
          <label class="block sm:col-span-2">
            <span class="label-caps mb-1 block">Server builds</span>
            <div class="join w-full">
              <input class="input input-sm join-item w-full font-mono text-xs" :value="s.settings.dbBinRoot" :placeholder="`DevCatz's data folder (${appDataPath('db-services', 'bin')})`" readonly />
              <button class="btn btn-sm join-item" @click="pickDb('dbBinRoot')">Choose…</button>
              <button v-if="s.settings.dbBinRoot" class="btn btn-sm join-item" @click="setS3({ dbBinRoot: '' })">Reset</button>
            </div>
            <span class="mt-1 block text-xs opacity-60">{{ isWin ? 'Downloads go to' : 'Downloads and compiled builds go to' }} <code>&lt;folder&gt;/&lt;engine&gt;/&lt;version&gt;</code>; installed ones stay where they are.<template v-if="!isWin"> MariaDB lives in Homebrew.</template></span>
          </label>
          <div>
            <span class="label-caps mb-1 block">Host in .env lines</span>
            <div class="seg">
              <a class="seg-item" :class="{ 'is-active': s.settings.dbEnvHost === 'local' }" @click="setS3({ dbEnvHost: 'local' })">This {{ words.computer }}</a>
              <a class="seg-item" :class="{ 'is-active': s.settings.dbEnvHost === 'docker' }" @click="setS3({ dbEnvHost: 'docker' })">Docker</a>
            </div>
            <span class="mt-1 block text-xs opacity-60">What the Connection tab starts with (each copy can still switch).</span>
          </div>
          <label class="block">
            <span class="label-caps mb-1 block">DB domain <span class="normal-case opacity-60">(optional)</span></span>
            <div class="join w-full">
              <input
                class="input input-sm join-item w-full font-mono"
                :value="s.settings.dbDomain"
                placeholder="e.g. db"
                spellcheck="false"
                @change="setS3({ dbDomain: ($event.target as HTMLInputElement).value })"
              />
              <span class="join-item flex items-center border border-base-300 bg-base-200 px-2 font-mono text-xs opacity-70">.{{ s.settings.tld }}</span>
            </div>
            <span class="mt-1 block text-xs opacity-60">
              <template v-if="s.settings.dbDomain">
                Every service answers on <code>{{ s.settings.dbDomain }}.{{ s.settings.tld }}</code>, told apart by port (e.g.
                <code>{{ s.settings.dbDomain }}.{{ s.settings.tld }}:3306</code>); .env lines use it. Empty it to go back to 127.0.0.1.
              </template>
              <template v-else>Empty = no domain; clients use 127.0.0.1. {{ isWin ? 'Names end in .localhost.' : 'The suffix follows Settings → General → Default domain.' }}</template>
            </span>
          </label>
        </div>
        <div><button class="btn btn-sm" @click="herd.openLogsFolder()">Open logs folder</button> <span class="ml-1 text-xs opacity-60">Each service also logs to <code>logs/db-&lt;id&gt;.log</code>.</span></div>
      </div>
    </div>

    <!-- WebSocket -->
    <div v-if="tab === 'websocket'" class="card">
      <div class="card-body">
        <h2 class="font-semibold">Services</h2>
        <div class="overflow-x-auto rounded-box border border-base-300/60">
          <table class="table table-sm">
            <thead>
              <tr><th>Engine</th><th>Status</th><th>WebSocket</th><th>Starts with DevCatz</th><th class="text-right"></th></tr>
            </thead>
            <tbody>
              <tr v-for="sv in s.websockets" :key="sv.kind">
                <td class="font-medium whitespace-nowrap">{{ sv.name }}<div class="font-mono text-xs font-normal opacity-50">{{ sv.config?.version ?? '' }}</div></td>
                <td class="whitespace-nowrap">
                  <span v-if="!sv.installed" class="badge badge-ghost badge-sm">not installed</span>
                  <span v-else class="badge badge-soft badge-sm" :class="sv.status === 'running' ? 'badge-success' : sv.status === 'starting' || sv.status === 'stopping' ? 'badge-warning' : sv.status === 'crashed' ? 'badge-error' : 'badge-ghost'">{{ sv.status }}</span>
                </td>
                <td class="text-xs">
                  <template v-if="sv.config && sv.urls">
                    <div class="font-mono">{{ sv.urls.ws.replace(/^(wss|https):\/\//, '').split('/')[0] }}</div>
                    <div class="font-mono opacity-50">127.0.0.1:{{ sv.config.port }}</div>
                  </template>
                  <span v-else class="opacity-40">—</span>
                </td>
                <td>
                  <input
                    v-if="sv.config"
                    type="checkbox"
                    class="toggle toggle-sm toggle-primary"
                    :checked="sv.config.autoStart"
                    @change="svcAutoStart('ws', sv.kind, ($event.target as HTMLInputElement).checked)"
                  />
                </td>
                <td class="text-right whitespace-nowrap">
                  <template v-if="sv.installed">
                    <button class="btn btn-ghost btn-xs" :disabled="svcBusy === `ws:${sv.kind}` || sv.status === 'stopping'" @click="svcAction('ws', sv.kind, svcActive(sv.status) ? 'stop' : 'start')">
                      <span v-if="svcBusy === `ws:${sv.kind}`" class="loading loading-spinner loading-xs" />{{ svcActive(sv.status) ? 'Stop' : 'Start' }}
                    </button>
                    <button class="btn btn-ghost btn-xs" :disabled="!!svcBusy || !svcActive(sv.status)" @click="svcAction('ws', sv.kind, 'restart')">Restart</button>
                  </template>
                  <button class="btn btn-ghost btn-xs" @click="openSection('websocket', sv.kind)">{{ sv.installed ? 'Settings…' : 'Install…' }}</button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p class="text-xs opacity-60">Details, logs and installs are on the WebSocket page (rail). Services are stopped when DevCatz quits.</p>
      </div>
    </div>

    <div v-if="tab === 'websocket'" class="card">
      <div class="card-body gap-4">
        <h2 class="font-semibold">Defaults</h2>
        <div class="grid gap-4 sm:grid-cols-2">
          <label class="block">
            <span class="label-caps mb-1 block">Allowed origins for new servers</span>
            <input
              class="input input-sm w-full font-mono"
              :value="s.settings.wsAllowedOrigins"
              placeholder="*"
              spellcheck="false"
              @change="setS3({ wsAllowedOrigins: ($event.target as HTMLInputElement).value.trim() || '*' })"
            />
            <span class="mt-1 block text-xs opacity-60">
              <code>*</code> = any page may connect (fine on this Mac), or a list like <code>https://*.{{ s.settings.tld }}</code>. Each server's own setting wins.
            </span>
          </label>
          <label class="block">
            <span class="label-caps mb-1 block">Test client: events kept</span>
            <input type="number" min="50" max="5000" class="input input-sm w-full font-mono" :value="s.settings.wsTestEvents" @change="setNum('wsTestEvents', ($event.target as HTMLInputElement).value, 50, 5000)" />
            <span class="mt-1 block text-xs opacity-60">The newest are kept in the WebSocket page's test client log.</span>
          </label>
        </div>
        <p class="text-xs opacity-60">
          Servers (Sockudo, Centrifugo, Mercure, NATS) are installed, configured and started on the WebSocket page (rail). Laravel Reverb is turned on per site
          (site → WebSocket tab) and runs with the site on <code>wss://reverb.&lt;site&gt;.{{ s.settings.tld }}</code>. Logs:
          <code>logs/websocket-&lt;server&gt;.log</code>.
        </p>
      </div>
    </div>

    <!-- Search Engine -->
    <div v-if="tab === 'search'" class="card">
      <div class="card-body">
        <h2 class="font-semibold">Services</h2>
        <div class="overflow-x-auto rounded-box border border-base-300/60">
          <table class="table table-sm">
            <thead>
              <tr><th>Engine</th><th>Status</th><th>Address</th><th>Starts with DevCatz</th><th class="text-right"></th></tr>
            </thead>
            <tbody>
              <tr v-for="sv in s.searchEngines" :key="sv.kind">
                <td class="font-medium whitespace-nowrap">{{ sv.name }}<div class="font-mono text-xs font-normal opacity-50">{{ sv.config?.version ?? '' }}</div></td>
                <td class="whitespace-nowrap">
                  <span v-if="!sv.installed" class="badge badge-ghost badge-sm">not installed</span>
                  <span v-else class="badge badge-soft badge-sm" :class="sv.status === 'running' ? 'badge-success' : sv.status === 'starting' || sv.status === 'stopping' ? 'badge-warning' : sv.status === 'crashed' ? 'badge-error' : 'badge-ghost'">{{ sv.status }}</span>
                </td>
                <td class="text-xs">
                  <template v-if="sv.config && sv.urls">
                    <div v-if="sv.urls.http.startsWith('https://')" class="font-mono">{{ sv.urls.http.replace(/^https:\/\//, '').split('/')[0] }}</div>
                    <div class="font-mono opacity-50">127.0.0.1:{{ sv.config.port }}</div>
                  </template>
                  <span v-else class="opacity-40">—</span>
                </td>
                <td>
                  <input
                    v-if="sv.config"
                    type="checkbox"
                    class="toggle toggle-sm toggle-primary"
                    :checked="sv.config.autoStart"
                    @change="svcAutoStart('search', sv.kind, ($event.target as HTMLInputElement).checked)"
                  />
                </td>
                <td class="text-right whitespace-nowrap">
                  <template v-if="sv.installed">
                    <button class="btn btn-ghost btn-xs" :disabled="svcBusy === `search:${sv.kind}` || sv.status === 'stopping'" @click="svcAction('search', sv.kind, svcActive(sv.status) ? 'stop' : 'start')">
                      <span v-if="svcBusy === `search:${sv.kind}`" class="loading loading-spinner loading-xs" />{{ svcActive(sv.status) ? 'Stop' : 'Start' }}
                    </button>
                    <button class="btn btn-ghost btn-xs" :disabled="!!svcBusy || !svcActive(sv.status)" @click="svcAction('search', sv.kind, 'restart')">Restart</button>
                  </template>
                  <button class="btn btn-ghost btn-xs" @click="openSection('search', sv.kind)">{{ sv.installed ? 'Settings…' : 'Install…' }}</button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p class="text-xs opacity-60">Details, logs and installs are on the Search page (rail). Services are stopped when DevCatz quits.</p>
      </div>
    </div>

    <div v-if="tab === 'search'" class="card">
      <div class="card-body gap-4">
        <h2 class="font-semibold">Defaults for new engines</h2>
        <div class="grid gap-4 sm:grid-cols-2">
          <label class="block">
            <span class="label-caps mb-1 block">Allowed origins (CORS)</span>
            <input
              class="input input-sm w-full font-mono"
              :value="s.settings.searchAllowedOrigins"
              placeholder="*"
              spellcheck="false"
              @change="setS3({ searchAllowedOrigins: ($event.target as HTMLInputElement).value.trim() || '*' })"
            />
            <span class="mt-1 block text-xs opacity-60">Pages allowed to call an engine from the browser; <code>*</code> = any. Each engine's own setting wins.</span>
          </label>
          <label class="block">
            <span class="label-caps mb-1 block">OpenSearch heap (MB)</span>
            <input type="number" min="256" max="32768" step="128" class="input input-sm w-full font-mono" :value="s.settings.searchOpenSearchHeapMb" @change="setNum('searchOpenSearchHeapMb', ($event.target as HTMLInputElement).value, 256, 32768)" />
            <span class="mt-1 block text-xs opacity-60">512 MB is plenty for local development.</span>
          </label>
        </div>
        <p class="text-xs opacity-60">
          Meilisearch, Typesense, OpenSearch and Manticore are installed, configured and started on the Search page (rail); a site's Search Engine tab writes
          its .env (SCOUT_DRIVER, hosts, keys). Logs: <code>logs/search-&lt;engine&gt;.log</code>.
        </p>
      </div>
    </div>

    <!-- Monitoring -->
    <AiSettings v-if="tab === 'ai'" />
    <div v-if="tab === 'monitoring'" class="card">
      <div class="card-body gap-4">
        <h2 class="font-semibold">Sampling</h2>
        <div class="grid gap-4 sm:grid-cols-2">
          <div>
            <span class="label-caps mb-1 block">Sample every … while the Monitoring page is open</span>
            <div class="seg">
              <a v-for="n in [1, 2, 3, 5]" :key="n" class="seg-item" :class="{ 'is-active': s.settings.monitorLiveInterval === n }" @click="setS3({ monitorLiveInterval: n })"><span class="normal-case">{{ n }} s</span></a>
            </div>
            <span class="mt-1 block text-xs opacity-60">One sample costs a few milliseconds of `ps`, `nettop` and a disk-I/O helper.</span>
          </div>
          <label class="flex cursor-pointer items-start gap-3">
            <input type="checkbox" class="toggle toggle-sm toggle-primary mt-0.5" :checked="s.settings.monitorBackground" @change="setS3({ monitorBackground: ($event.target as HTMLInputElement).checked })" />
            <span>
              <span class="block text-sm">Keep sampling in the background</span>
              <span class="block text-xs opacity-60">Every 15 s while the page is closed: the charts open with an hour of history, and alerts work.</span>
            </span>
          </label>
          <label class="flex cursor-pointer items-start gap-3">
            <input type="checkbox" class="toggle toggle-sm toggle-primary mt-0.5" :checked="s.settings.monitorMenuBar" @change="setS3({ monitorMenuBar: ($event.target as HTMLInputElement).checked })" />
            <span>
              <span class="block text-sm">Show usage in the {{ words.tray }} menu</span>
              <span class="block text-xs opacity-60">“Monitor · CPU · memory for sites & services” under the sites line.</span>
            </span>
          </label>
        </div>
      </div>
    </div>
    <div v-if="tab === 'monitoring'" class="card">
      <div class="card-body gap-4">
        <div class="flex items-center gap-3">
          <h2 class="flex-1 font-semibold">Alerts</h2>
          <input type="checkbox" class="toggle toggle-sm toggle-primary" :checked="s.settings.monitorAlerts" @change="setS3({ monitorAlerts: ($event.target as HTMLInputElement).checked })" />
        </div>
        <p class="-mt-2 text-xs opacity-60">A {{ words.os }} notification when a site or service stays above a limit, or the disk runs low. Each alert at most once an hour.</p>
        <div class="grid gap-4 sm:grid-cols-2" :class="{ 'pointer-events-none opacity-50': !s.settings.monitorAlerts }">
          <label class="block">
            <span class="label-caps mb-1 block">CPU above (%)</span>
            <input type="number" min="10" max="1600" class="input input-sm w-full font-mono" :value="s.settings.monitorCpuAlert" @change="setNum('monitorCpuAlert', ($event.target as HTMLInputElement).value, 10, 1600)" />
            <span class="mt-1 block text-xs opacity-60">Per core: 100 = one core fully busy.</span>
          </label>
          <label class="block">
            <span class="label-caps mb-1 block">Memory above (MB)</span>
            <input type="number" min="64" max="262144" class="input input-sm w-full font-mono" :value="s.settings.monitorMemAlertMb" @change="setNum('monitorMemAlertMb', ($event.target as HTMLInputElement).value, 64, 262144)" />
          </label>
          <label class="block">
            <span class="label-caps mb-1 block">For at least (minutes)</span>
            <input type="number" min="1" max="60" class="input input-sm w-full font-mono" :value="s.settings.monitorAlertMinutes" @change="setNum('monitorAlertMinutes', ($event.target as HTMLInputElement).value, 1, 60)" />
          </label>
          <label class="block">
            <span class="label-caps mb-1 block">Disk free below (GB)</span>
            <input type="number" min="1" max="2000" class="input input-sm w-full font-mono" :value="s.settings.monitorDiskAlertGb" @change="setNum('monitorDiskAlertGb', ($event.target as HTMLInputElement).value, 1, 2000)" />
          </label>
        </div>
        <p v-if="s.settings.monitorAlerts && !s.settings.monitorBackground" class="text-xs text-warning">Alerts need background sampling (above) to see sustained use while the page is closed.</p>
      </div>
    </div>

    <!-- Object Storage: services -->
    <div v-if="tab === 'storage'" class="card">
      <div class="card-body">
        <h2 class="font-semibold">Services</h2>
        <div class="overflow-x-auto rounded-box border border-base-300/60">
          <table class="table table-sm">
            <thead>
              <tr><th>Engine</th><th>Status</th><th>API / Console</th><th>Starts with DevCatz</th><th class="text-right"></th></tr>
            </thead>
            <tbody>
              <tr v-for="sv in s.storage" :key="sv.kind">
                <td class="font-medium whitespace-nowrap">{{ sv.name }}<div class="font-mono text-xs font-normal opacity-50">{{ sv.config?.version ?? '' }}</div></td>
                <td class="whitespace-nowrap">
                  <span v-if="!sv.installed" class="badge badge-ghost badge-sm">not installed</span>
                  <span v-else class="badge badge-soft badge-sm" :class="sv.status === 'running' ? 'badge-success' : sv.status === 'crashed' ? 'badge-error' : 'badge-ghost'">{{ sv.status }}</span>
                </td>
                <td class="text-xs">
                  <template v-if="sv.config && sv.urls">
                    <div class="font-mono">{{ sv.urls.api.replace('https://', '') }} <span class="opacity-50">:{{ sv.config.apiPort }}</span></div>
                    <div class="font-mono">{{ sv.urls.console.replace('https://', '').split('/')[0] }} <span class="opacity-50">:{{ sv.config.consolePort }}</span></div>
                  </template>
                  <span v-else class="opacity-40">—</span>
                </td>
                <td>
                  <input
                    v-if="sv.config"
                    type="checkbox"
                    class="toggle toggle-sm toggle-primary"
                    :checked="sv.config.autoStart"
                    @change="setAutoStart(sv.kind, ($event.target as HTMLInputElement).checked)"
                  />
                </td>
                <td class="text-right whitespace-nowrap">
                  <button class="btn btn-ghost btn-xs" @click="storageForm = { service: sv, mode: sv.installed ? 'edit' : 'install' }">
                    {{ sv.installed ? 'Settings…' : 'Install…' }}
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p class="text-xs opacity-60">Buckets, files and connection details are on the Storage page (rail). Services are stopped when DevCatz quits.</p>
      </div>
    </div>

    <!-- Object Storage: defaults -->
    <div v-if="tab === 'storage'" class="card">
      <div class="card-body gap-4">
        <h2 class="font-semibold">Defaults</h2>
        <div class="grid gap-4 sm:grid-cols-2">
          <label class="block">
            <span class="label-caps mb-1 block">Default region</span>
            <input
              class="input input-sm w-full font-mono"
              :value="s.settings.s3Region"
              spellcheck="false"
              @change="setS3({ s3Region: ($event.target as HTMLInputElement).value.trim() || 'us-east-1' })"
            />
            <span class="mt-1 block text-xs opacity-60">Preset for new installs; each service has its own region in its settings.</span>
          </label>
          <div>
            <span class="label-caps mb-1 block">Endpoint in .env lines</span>
            <div class="seg">
              <a class="seg-item" :class="{ 'is-active': s.settings.s3EnvEndpoint === 'domain' }" @click="setS3({ s3EnvEndpoint: 'domain' })">HTTPS domain</a>
              <a class="seg-item" :class="{ 'is-active': s.settings.s3EnvEndpoint === 'local' }" @click="setS3({ s3EnvEndpoint: 'local' })">127.0.0.1</a>
              <a class="seg-item" :class="{ 'is-active': s.settings.s3EnvEndpoint === 'docker' }" @click="setS3({ s3EnvEndpoint: 'docker' })">Docker</a>
            </div>
            <span class="mt-1 block text-xs opacity-60">What Storage → Connection starts with (each copy can still switch).</span>
          </div>
          <label class="block sm:col-span-2">
            <span class="label-caps mb-1 block">Data folders of new installs</span>
            <div class="join w-full">
              <input class="input input-sm join-item w-full font-mono text-xs" :value="s.settings.storageRoot" placeholder="DevCatz's data folder (~/Library/Application Support/DevCatz/storage/<engine>/data)" readonly />
              <button class="btn btn-sm join-item" @click="pickStorageRoot">Choose…</button>
              <button v-if="s.settings.storageRoot" class="btn btn-sm join-item" @click="setS3({ storageRoot: '' })">Reset</button>
            </div>
            <span class="mt-1 block text-xs opacity-60">New installs put their data in <code>&lt;folder&gt;/&lt;engine&gt;</code>. Installed services keep theirs (change it in each service's settings).</span>
          </label>
          <label class="block sm:col-span-2">
            <span class="label-caps mb-1 block">Binary folders of new installs</span>
            <div class="join w-full">
              <input class="input input-sm join-item w-full font-mono text-xs" :value="s.settings.storageBinRoot" placeholder="DevCatz's data folder (~/Library/Application Support/DevCatz/storage/<engine>/bin)" readonly />
              <button class="btn btn-sm join-item" @click="pickStorageBinRoot">Choose…</button>
              <button v-if="s.settings.storageBinRoot" class="btn btn-sm join-item" @click="setS3({ storageBinRoot: '' })">Reset</button>
            </div>
            <span class="mt-1 block text-xs opacity-60">Downloaded servers go to <code>&lt;folder&gt;/&lt;engine&gt;/</code>; each service's settings can move its own.</span>
          </label>
        </div>
        <div><button class="btn btn-sm" @click="herd.openLogsFolder()">Open logs folder</button></div>
      </div>
    </div>
    <!-- Mail -->
    <template v-if="tab === 'mail'">
      <div class="card">
        <div class="card-body gap-4">
          <div class="flex items-center gap-2">
            <h2 class="flex-1">Mail catcher</h2>
            <span class="badge badge-soft badge-sm" :class="s.mail.running ? 'badge-success' : 'badge-ghost'">{{ s.mail.running ? `listening on 127.0.0.1:${s.mail.port}` : 'stopped' }}</span>
          </div>
          <div class="grid gap-4 sm:grid-cols-2">
            <label class="block">
              <span class="label-caps mb-1 block">SMTP port</span>
              <input type="number" min="1024" max="65535" class="input input-sm w-full font-mono" :value="s.settings.mailPort" @change="setNum('mailPort', ($event.target as HTMLInputElement).value, 1024, 65535)" />
              <span class="mt-1 block text-xs opacity-60">Default 2525. Sites use <code>MAIL_HOST=127.0.0.1</code> and this port; the catcher restarts when it changes.</span>
            </label>
            <label class="block">
              <span class="label-caps mb-1 block">Web inbox domain</span>
              <div class="join w-full">
                <input class="input input-sm join-item w-full font-mono" :value="s.settings.mailDomain" placeholder="mail" spellcheck="false" @change="setS3({ mailDomain: ($event.target as HTMLInputElement).value })" />
                <span class="join-item flex items-center border border-base-300 bg-base-200 px-2 font-mono text-xs opacity-70">.{{ s.settings.tld }}</span>
              </div>
              <span class="mt-1 block text-xs opacity-60">The inbox in a browser: <a class="link" @click="herd.openUrl(s.mail.webUrl)">{{ s.mail.webUrl }}</a>. The same name works as <code>MAIL_HOST</code>.</span>
            </label>
            <label class="block">
              <span class="label-caps mb-1 block">Mails kept</span>
              <input type="number" min="10" max="10000" class="input input-sm w-full font-mono" :value="s.settings.mailKeep" @change="setNum('mailKeep', ($event.target as HTMLInputElement).value, 10, 10000)" />
              <span class="mt-1 block text-xs opacity-60">The oldest are deleted beyond this (and beyond 200 MB).</span>
            </label>
            <div class="space-y-2 pt-5">
              <label class="flex cursor-pointer items-center gap-3 text-sm">
                <input type="checkbox" class="toggle toggle-sm toggle-primary" :checked="s.settings.mailAutoStart" @change="setS3({ mailAutoStart: ($event.target as HTMLInputElement).checked })" />
                <span>Start the mail server when DevCatz launches <span class="block text-xs opacity-60">Off = start it by hand on the Mail page.</span></span>
              </label>
              <label class="flex cursor-pointer items-center gap-3 text-sm">
                <input type="checkbox" class="toggle toggle-sm toggle-primary" :checked="s.settings.mailNotify" @change="setS3({ mailNotify: ($event.target as HTMLInputElement).checked })" />
                <span>Notification when a mail arrives</span>
              </label>
            </div>
          </div>
          <div class="flex flex-wrap items-center gap-2">
            <button class="btn btn-sm" :disabled="!s.mail.running" @click="mailTest">Send a test mail</button>
            <button class="btn btn-ghost btn-sm" @click="herd.mailOpenData()">Open data folder</button>
            <span class="text-xs opacity-60">{{ s.mail.count }} mail{{ s.mail.count === 1 ? '' : 's' }} kept.</span>
          </div>
        </div>
      </div>
      <form class="card" @submit.prevent="saveForward">
        <div class="card-body gap-4">
          <div class="flex items-center gap-2">
            <h2 class="flex-1">Forwarding account</h2>
            <span v-if="fwdSaved" class="badge badge-success badge-soft badge-sm">set up</span>
          </div>
          <p class="text-xs opacity-60">
            Your own SMTP account (Gmail app password, Mailgun, Resend, Postmark …) so one caught mail can be forwarded to a real inbox and looked at in a real client.
            The password is encrypted with {{ currentOS === 'mac' ? 'the macOS Keychain' : words.secretStore }}.
          </p>
          <div class="grid gap-4 sm:grid-cols-3">
            <label class="block sm:col-span-2">
              <span class="label-caps mb-1 block">SMTP host</span>
              <input v-model="fwd.host" class="input input-sm w-full font-mono" placeholder="smtp.gmail.com" spellcheck="false" />
            </label>
            <label class="block">
              <span class="label-caps mb-1 block">Port</span>
              <input v-model.number="fwd.port" type="number" min="1" max="65535" class="input input-sm w-full font-mono" />
            </label>
            <div class="block">
              <span class="label-caps mb-1 block">Security</span>
              <div role="tablist" class="seg">
                <a class="seg-item" :class="{ 'is-active': fwd.security === 'starttls' }" @click="fwd.security = 'starttls'">STARTTLS (587)</a>
                <a class="seg-item" :class="{ 'is-active': fwd.security === 'tls' }" @click="fwd.security = 'tls'">TLS (465)</a>
                <a class="seg-item" :class="{ 'is-active': fwd.security === 'none' }" @click="fwd.security = 'none'">None</a>
              </div>
            </div>
            <label class="block">
              <span class="label-caps mb-1 block">Username</span>
              <input v-model="fwd.username" class="input input-sm w-full" autocomplete="off" spellcheck="false" />
            </label>
            <label class="block">
              <span class="label-caps mb-1 block">Password</span>
              <input v-model="fwd.password" type="password" class="input input-sm w-full" :placeholder="fwdHasPassword ? '•••••••• (unchanged)' : ''" autocomplete="new-password" />
            </label>
            <label class="block sm:col-span-3">
              <span class="label-caps mb-1 block">Send as (From)</span>
              <input v-model="fwd.from" type="email" class="input input-sm w-full" placeholder="you@example.com" />
              <span class="mt-1 block text-xs opacity-60">An address the account may send from; the original sender becomes Reply-To.</span>
            </label>
          </div>
          <div class="flex gap-2">
            <button class="btn btn-primary btn-sm" :disabled="!fwd.host || !fwd.from">Save</button>
            <button v-if="fwdSaved" type="button" class="btn btn-ghost btn-sm text-error" @click="removeForward">Remove</button>
          </div>
        </div>
      </form>
    </template>

    <!-- Expose -->
    <div v-if="tab === 'whatsapp'" class="card">
      <div class="card-body">
        <h2 class="font-semibold">Services</h2>
        <div class="overflow-x-auto rounded-box border border-base-300/60">
          <table class="table table-sm">
            <thead>
              <tr><th>Gateway</th><th>Status</th><th>Address</th><th>Starts with DevCatz</th><th class="text-right"></th></tr>
            </thead>
            <tbody>
              <tr v-for="w in s.whatsapp" :key="w.engine">
                <td class="font-medium whitespace-nowrap">{{ w.name }}<div class="text-xs font-normal opacity-50">WhatsApp<template v-if="w.config"> · {{ w.config.version }}</template></div></td>
                <td class="whitespace-nowrap">
                  <span v-if="!w.installed" class="badge badge-ghost badge-sm">not installed</span>
                  <span v-else class="badge badge-soft badge-sm" :class="w.status === 'running' ? 'badge-success' : w.status === 'crashed' ? 'badge-error' : 'badge-ghost'">{{ w.status }}</span>
                </td>
                <td class="text-xs"><template v-if="w.config"><div class="font-mono">{{ w.config.domain }}.{{ s.settings.tld }}</div><div class="font-mono opacity-50">127.0.0.1:{{ w.config.port }}</div></template><span v-else class="opacity-40">—</span></td>
                <td><span v-if="w.config" class="text-xs opacity-60">{{ w.config.autoStart ? 'yes' : 'no' }} (engine settings)</span></td>
                <td class="text-right whitespace-nowrap"><button class="btn btn-ghost btn-xs" @click="openGateway(w.engine)">{{ w.installed ? 'Open' : 'Install…' }}</button></td>
              </tr>
              <tr v-for="g in s.gateways" :key="g.kind">
                <td class="font-medium whitespace-nowrap">{{ g.name }}<div class="text-xs font-normal opacity-50">{{ g.category === 'email' ? 'Email' : g.category === 'push' ? 'Push' : g.category === 'sms' ? 'SMS' : 'Telegram' }}<template v-if="g.config"> · {{ g.config.version }}</template></div></td>
                <td class="whitespace-nowrap">
                  <span v-if="!g.installed" class="badge badge-ghost badge-sm">not installed</span>
                  <span v-else class="badge badge-soft badge-sm" :class="g.status === 'running' ? 'badge-success' : g.status === 'starting' || g.status === 'stopping' ? 'badge-warning' : g.status === 'crashed' ? 'badge-error' : 'badge-ghost'">{{ g.status }}</span>
                </td>
                <td class="text-xs"><template v-if="g.config"><div class="font-mono">{{ g.config.domain }}.{{ s.settings.tld }}</div><div class="font-mono opacity-50">127.0.0.1:{{ g.config.port }}</div></template><span v-else class="opacity-40">—</span></td>
                <td><input v-if="g.config" type="checkbox" class="toggle toggle-sm toggle-primary" :checked="g.config.autoStart" @change="gwAutoStart(g.kind, ($event.target as HTMLInputElement).checked)" /></td>
                <td class="text-right whitespace-nowrap">
                  <template v-if="g.installed">
                    <button class="btn btn-ghost btn-xs" :disabled="svcBusy === `gw:${g.kind}` || g.status === 'stopping'" @click="gwAction(g.kind, svcActive(g.status) ? 'stop' : 'start')">
                      <span v-if="svcBusy === `gw:${g.kind}`" class="loading loading-spinner loading-xs" />{{ svcActive(g.status) ? 'Stop' : 'Start' }}
                    </button>
                    <button class="btn btn-ghost btn-xs" :disabled="!!svcBusy || !svcActive(g.status)" @click="gwAction(g.kind, 'restart')">Restart</button>
                  </template>
                  <button class="btn btn-ghost btn-xs" @click="openGateway(g.kind)">{{ g.installed ? 'Open' : 'Install…' }}</button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p class="text-xs opacity-60">Email gateways send into the DevCatz mail catcher and Jasmin into the SMS catcher, so nothing leaves this Mac. Details and installs are on the Gateways page.</p>
      </div>
    </div>
    <div v-if="tab === 'whatsapp'" class="card">
      <div class="card-body">
        <h2>WhatsApp (GOWA, WAHA)</h2>
        <p class="text-sm opacity-70">
          GOWA and WAHA are installed, started and updated on the Gateways page; each has its own port, domain, API key and autostart switch there (Connection → Settings…).
        </p>
        <div class="grid gap-4 sm:grid-cols-2">
          <label class="block">
            <span class="label-caps mb-1 block">Messages kept in the inspector</span>
            <input type="number" min="50" max="10000" class="input input-sm w-full font-mono" :value="s.settings.waKeep" @change="setNum('waKeep', ($event.target as HTMLInputElement).value, 50, 10000)" />
            <span class="mt-1 block text-xs opacity-60">The oldest are dropped beyond this.</span>
          </label>
          <div class="space-y-2 pt-5">
            <label class="flex cursor-pointer items-center gap-3 text-sm">
              <input type="checkbox" class="toggle toggle-sm toggle-primary" :checked="s.settings.waNotify" @change="setS3({ waNotify: ($event.target as HTMLInputElement).checked })" />
              <span>Notification when a message arrives</span>
            </label>
            <div v-for="w in s.whatsapp.filter((x) => x.installed)" :key="w.engine" class="text-xs opacity-60">{{ w.name }} {{ w.config?.version }} · {{ w.config?.autoStart ? 'starts with DevCatz' : 'manual start' }} · 127.0.0.1:{{ w.config?.port }}</div>
          </div>
        </div>
        <p class="text-xs opacity-60">Both engines speak the WhatsApp Web protocol (unofficial): use a test number in development.</p>
      </div>
    </div>
    <div v-if="tab === 'expose'" class="card">
      <div class="card-body gap-4">
        <h2>Sharing defaults</h2>
        <div class="grid gap-4 sm:grid-cols-2">
          <label class="block">
            <span class="label-caps mb-1 block">New shares stop by themselves after</span>
            <select class="select select-sm w-full" :value="s.settings.exposeExpiryMinutes" @change="setS3({ exposeExpiryMinutes: Number(($event.target as HTMLSelectElement).value) })">
              <option :value="0">Never (until stopped)</option>
              <option :value="30">30 minutes</option>
              <option :value="60">1 hour</option>
              <option :value="240">4 hours</option>
              <option :value="1440">24 hours</option>
            </select>
            <span class="mt-1 block text-xs opacity-60">Each share can still pick its own time.</span>
          </label>
          <div class="pt-5 text-xs opacity-60">
            <template v-if="s.expose.tools.cloudflared">cloudflared {{ s.expose.tools.cloudflared }} is installed (updates on the Expose page).</template>
            <template v-else>cloudflared is installed from the Expose page when you first share a site.</template>
          </div>
        </div>
        <p class="text-xs opacity-60">Cloudflare quick tunnels need no account. The providers below need one; their tokens are stored encrypted in {{ currentOS === 'mac' ? 'the macOS Keychain' : words.secretStore }}.</p>
      </div>
    </div>
    <div v-if="tab === 'expose'" class="card">
      <div class="card-body">
        <div class="flex items-center gap-2">
          <h2 class="flex-1">Your Cloudflare domain</h2>
          <span class="badge badge-sm badge-soft" :class="s.expose.accounts.cloudflare ? 'badge-success' : 'badge-ghost'">{{ s.expose.accounts.cloudflare ? 'logged in' : 'not logged in' }}</span>
        </div>
        <p class="text-sm opacity-70">
          Named tunnels with a fixed hostname on a zone of your Cloudflare account. Log in on the Expose page (your browser opens; pick the zone), then share a site with
          "Your Cloudflare domain" and a hostname like <code>demo.example.com</code>. DevCatz creates the tunnel and its DNS record (the certificate lives in <code>~/.cloudflared</code>).
        </p>
      </div>
    </div>
    <div v-if="tab === 'expose'" class="card">
      <div class="card-body">
        <div class="flex items-center gap-2">
          <h2 class="flex-1">ngrok</h2>
          <span class="badge badge-sm badge-soft" :class="s.expose.accounts.ngrok.token ? 'badge-success' : 'badge-ghost'">{{ s.expose.accounts.ngrok.token ? 'authtoken set' : 'no authtoken' }}</span>
        </div>
        <p class="text-sm opacity-70">
          The authtoken from <a class="link" @click="herd.openUrl('https://dashboard.ngrok.com/get-started/your-authtoken')">dashboard.ngrok.com</a>. The free plan runs one agent at a time and gives a
          random <code>….ngrok-free.app</code> URL; a reserved domain of your account gives a fixed one.
        </p>
        <form class="grid gap-4 sm:grid-cols-2" @submit.prevent="saveNgrok">
          <label class="block">
            <span class="label-caps mb-1 block">Authtoken</span>
            <input v-model="ngrokForm.token" type="password" class="input input-sm w-full font-mono" :placeholder="s.expose.accounts.ngrok.token ? '•••••••• (kept)' : '2abc…'" autocomplete="new-password" spellcheck="false" />
          </label>
          <label class="block">
            <span class="label-caps mb-1 block">Reserved domain (optional)</span>
            <input v-model="ngrokForm.domain" class="input input-sm w-full font-mono" placeholder="myapp.ngrok-free.app" spellcheck="false" />
          </label>
          <div class="flex gap-2 sm:col-span-2">
            <button class="btn btn-primary btn-sm" :disabled="!ngrokForm.token && !s.expose.accounts.ngrok.token">Save</button>
            <button v-if="s.expose.accounts.ngrok.token" type="button" class="btn btn-ghost btn-sm" @click="forget('ngrok')">Forget account</button>
          </div>
        </form>
      </div>
    </div>
    <div v-if="tab === 'expose'" class="card">
      <div class="card-body">
        <div class="flex items-center gap-2">
          <h2 class="flex-1">Expose (expose.dev)</h2>
          <span class="badge badge-sm badge-soft" :class="s.expose.accounts.expose.token ? 'badge-success' : 'badge-ghost'">{{ s.expose.accounts.expose.token ? 'token set' : 'no token' }}</span>
        </div>
        <p class="text-sm opacity-70">
          The token from <a class="link" @click="herd.openUrl('https://expose.dev/dashboard')">expose.dev</a> (a subdomain on <code>sharedwithexpose.com</code>, or your own Expose server). Needs PHP 8.2+ from the Runtimes page.
        </p>
        <form class="grid gap-4 sm:grid-cols-3" @submit.prevent="saveExpose">
          <label class="block">
            <span class="label-caps mb-1 block">Token</span>
            <input v-model="exposeForm.token" type="password" class="input input-sm w-full font-mono" :placeholder="s.expose.accounts.expose.token ? '•••••••• (kept)' : 'xxxxxxxx-xxxx-…'" autocomplete="new-password" spellcheck="false" />
          </label>
          <label class="block">
            <span class="label-caps mb-1 block">Server (optional)</span>
            <input v-model="exposeForm.server" class="input input-sm w-full font-mono" placeholder="eu-1 or expose.example.com" spellcheck="false" />
          </label>
          <label class="block">
            <span class="label-caps mb-1 block">Subdomain (optional)</span>
            <input v-model="exposeForm.domain" class="input input-sm w-full font-mono" placeholder="myapp" spellcheck="false" />
          </label>
          <div class="flex gap-2 sm:col-span-3">
            <button class="btn btn-primary btn-sm" :disabled="!exposeForm.token && !s.expose.accounts.expose.token">Save</button>
            <button v-if="s.expose.accounts.expose.token" type="button" class="btn btn-ghost btn-sm" @click="forget('expose')">Forget account</button>
          </div>
        </form>
      </div>
    </div>
  </section>
  <DbServiceForm v-if="dbForm" :service="s.databases.find((d) => d.id === dbForm!.id)" @close="dbForm = null" @done="dbForm = null" />
  <StorageForm v-if="storageForm" :service="s.storage.find((x) => x.kind === storageForm!.service.kind) ?? storageForm.service" :mode="storageForm.mode" @close="storageForm = null" @done="storageForm = null" />
  <ParkDialog v-if="parking" :dir="parking" @close="parking = null" />
</template>

