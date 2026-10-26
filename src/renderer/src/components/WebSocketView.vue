<script setup lang="ts">
import { WS_LOGO } from '../logos';
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import type { ProjectState, StorageAction, WsKind, WsState, WsStats } from '@shared/types';
import StatusDot from './StatusDot.vue';
import LogView from './LogView.vue';
import TaskStepper from './TaskStepper.vue';
import ServiceUninstall from './ServiceUninstall.vue';
import WsForm from './WsForm.vue';
import WsEnvWriter from './WsEnvWriter.vue';
import WsTestClient from './WsTestClient.vue';
import Sparkline from './Sparkline.vue';
import PopMenu, { type MenuItem } from './PopMenu.vue';
import { attempt, herd, notify, state, uninstallRequest } from '../store';
import CatMood from './CatMood.vue';

/**
 * WebSocket servers (rail): Laravel Reverb and Sockudo (Pusher protocol),
 * Centrifugo, Mercure and NATS, one shared instance each; a live inspector, a
 * test client, .env lines for sites, logs. Below them, the sites that run
 * their own server (Reverb with the site, Socket.IO, ws, Channels …).
 */
const props = defineProps<{ focus?: string | null }>();
const emit = defineEmits<{ openSite: [id: string] }>();

const services = computed(() => state.value?.websockets ?? []);
const selectedKind = ref<WsKind | null>(null);
/** A site server (Site servers list) instead of a shared server. */
const selectedSiteId = ref<string | null>(null);
function pick(k: WsKind) {
  selectedSiteId.value = null;
  selectedKind.value = k;
}
const selected = computed(() => (selectedSiteId.value ? null : (services.value.find((s) => s.kind === selectedKind.value) ?? null)));
const installed = computed(() => services.value.filter((s) => s.installed));
// First installed server, else the first kind (its install page).
watch(
  services,
  (list) => {
    if (!selectedKind.value) selectedKind.value = list.find((s) => s.installed)?.kind ?? list[0]?.kind ?? null;
  },
  { immediate: true },
);
watch(
  () => props.focus,
  (k) => k && services.value.some((s) => s.kind === k) && pick(k as WsKind),
  { immediate: true },
);
const runningCount = computed(() => services.value.filter((s) => active(s)).length);
/** Header "More" menu of the selected server. */
const moreItems = computed<MenuItem[]>(() => {
  const s = selected.value;
  if (!s?.installed) return [];
  return [
    { label: 'Open data folder', action: () => herd.wsOpenData(s.kind) },
    { label: 'Check for updates', action: checkUpdates },
    { label: 'Settings…', action: () => (form.value = { service: s, mode: 'edit' }) },
    { label: 'Uninstall…', action: () => (removing.value = s) },
  ];
});

const LOGO = WS_LOGO;
const PROTOCOL: Record<WsState['protocol'], string> = { pusher: 'Pusher protocol', centrifugo: 'Centrifugo protocol', mercure: 'Mercure (SSE)', nats: 'NATS' };
type Tab = 'inspector' | 'client' | 'connection' | 'sites' | 'logs';
const tab = ref<Tab>('inspector');
const form = ref<{ service: WsState; mode: 'install' | 'edit' } | null>(null);
const busy = ref<string | null>(null);
const active = (s: WsState) => s.status === 'running' || s.status === 'starting';

/** Newer release: download, swap the binary, restart (data and settings stay). */
async function upgrade(s: WsState) {
  busy.value = `${s.kind}:update`;
  await attempt(() => herd.wsUpgrade(s.kind).then(() => true), `${s.name} updated`);
  busy.value = null;
}
async function checkUpdates() {
  const failed = await attempt(() => herd.servicesCheckUpdates());
  if (!failed) return;
  const s = selected.value;
  if (s && failed.includes(s.name)) notify('error', `Could not check ${s.name} for updates (offline, or GitHub's hourly limit; try again later)`);
  else notify('info', s?.update ? `${s.name} ${s.update} is available` : `${s?.name ?? 'Everything'} is up to date`);
}
const updating = (s: WsState) => s.task?.kind === 'update' && !s.task.done && !s.task.error;
async function act(s: WsState, action: StorageAction) {
  busy.value = `${s.kind}:${action}`;
  await attempt(() => herd.wsAction(s.kind, action));
  busy.value = null;
}

// ---- uninstall
const removing = ref<WsState | null>(null);

// Ask DevCatz's "Uninstall …" opens this page's own dialog (with its typed confirmation); nothing is removed without it.
watch(
  uninstallRequest,
  (r) => {
    if (r?.scope !== 'ws') return;
    uninstallRequest.value = null;
    const s = services.value.find((x) => x.kind === r.id && x.installed);
    if (s) {
      pick(s.kind);
      removing.value = s;
    }
  },
  { immediate: true },
);

// ---- live inspector (every 2 s while the tab shows)
const stats = ref<WsStats | null>(null);
const clientsSeries = ref<number[]>([]);
const rateSeries = ref<number[]>([]);
let timer: ReturnType<typeof setInterval> | null = null;
async function poll() {
  const s = selected.value;
  if (!s?.installed) return;
  const r = await herd.wsStats(s.kind).catch(() => null);
  if (!r || selected.value?.kind !== s.kind) return;
  stats.value = r;
  clientsSeries.value = [...clientsSeries.value, r.clients].slice(-90);
  rateSeries.value = [...rateSeries.value, r.messagesPerSec ?? 0].slice(-90);
}
watch(
  () => [selectedKind.value, tab.value] as const,
  ([, t]) => {
    if (timer) clearInterval(timer);
    timer = null;
    stats.value = null;
    clientsSeries.value = [];
    rateSeries.value = [];
    if (t === 'inspector') {
      void poll();
      timer = setInterval(poll, 2000);
    }
  },
  { immediate: true },
);
onBeforeUnmount(() => timer && clearInterval(timer));
const channels = computed(() => [...(stats.value?.channels ?? [])].sort((a, b) => b.clients - a.clients || a.name.localeCompare(b.name)));
const channelKind = (n: string) => (n.startsWith('presence-') ? 'presence' : n.startsWith('private-') ? 'private' : 'public');

// ---- sites using real-time libraries
const rtSites = computed(() => (state.value?.projects ?? []).filter((p) => p.realtime.libs.length || p.reverb));

// ---- site servers: sites that run their own WebSocket server (Reverb with the site, Socket.IO, ws, Channels …)
const ownServer = (p: ProjectState) => p.realtime.libs.filter((l) => l.role === 'server' && l.protocol !== 'reverb');
const siteServers = computed(() => (state.value?.projects ?? []).filter((p) => p.reverb || ownServer(p).length));
const site = computed(() => siteServers.value.find((p) => p.id === selectedSiteId.value) ?? null);
const siteUp = (p: ProjectState) => p.status === 'running' || p.status === 'starting';
const siteStatus = (p: ProjectState) => (p.reverb || p.stack.runtime !== 'php' ? p.status : p.served ? 'running' : p.status);
const siteKind = (p: ProjectState) => (p.reverb ? 'Laravel Reverb' : ownServer(p).map((l) => l.name).join(' + '));
const socketioSite = (p: ProjectState) => p.realtime.libs.some((l) => l.protocol === 'socketio');
const sitePath = (p: ProjectState) => p.wsPath || (socketioSite(p) ? '/socket.io/' : p.realtime.libs.some((l) => l.protocol === 'channels') ? '/ws/' : '/');
const suffix = (p: ProjectState) => (p.secure === false ? (state.value?.httpUrlSuffix ?? '') : (state.value?.urlSuffix ?? ''));
const siteEndpoint = (p: ProjectState) =>
  p.reverb && p.reverbEndpoint ? `wss://${p.reverbEndpoint.domain}${suffix(p)}/app/<key>` : `${p.secure === false ? 'ws' : 'wss'}://${p.domain}${suffix(p)}${sitePath(p)}`;
async function siteAct(p: ProjectState, action: 'start' | 'stop' | 'restart') {
  busy.value = `site:${p.id}:${action}`;
  await attempt(() => (action === 'start' ? herd.start(p.id) : action === 'stop' ? herd.stop(p.id) : herd.restart(p.id)));
  busy.value = null;
}
// Connection check through the proxy (Engine.IO handshake for Socket.IO, the Pusher handshake for Reverb).
const siteCheck = ref<{ state: 'idle' | 'checking' | 'ok' | 'fail'; ms?: number; detail?: string }>({ state: 'idle' });
let siteProbe: WebSocket | null = null;
function testSite(p: ProjectState) {
  siteProbe?.close();
  siteCheck.value = { state: 'checking' };
  const url = p.reverb && p.reverbEndpoint
    ? `wss://${p.reverbEndpoint.domain}${suffix(p)}/app/devcatz-probe?protocol=7&client=js&version=8.4.0`
    : socketioSite(p)
      ? `${siteEndpoint(p).replace(/\/?$/, '/')}?EIO=4&transport=websocket`
      : siteEndpoint(p);
  const t0 = performance.now();
  const ws = new WebSocket(url);
  siteProbe = ws;
  const done = (s: 'ok' | 'fail', detail: string) => {
    clearTimeout(timer);
    siteCheck.value = { state: s, ms: Math.round(performance.now() - t0), detail };
    ws.close();
  };
  const timer = setTimeout(() => done('fail', 'No answer in 5 s'), 5000);
  ws.onopen = () => !socketioSite(p) && !p.reverb && done('ok', 'Upgrade accepted');
  ws.onmessage = (e) => {
    const text = String(e.data);
    if (p.reverb) done('ok', text.includes('connection_established') ? 'pusher:connection_established' : text.slice(0, 80));
    else if (text.startsWith('0')) done('ok', 'Engine.IO handshake');
  };
  ws.onerror = () => done('fail', siteUp(p) ? 'The upgrade was refused (wrong path, or the server is not up yet)' : 'The site is not running: Start it first');
}
watch(selectedSiteId, () => {
  siteProbe?.close();
  siteCheck.value = { state: 'idle' };
});
onBeforeUnmount(() => siteProbe?.close());

async function copy(text: string) {
  await navigator.clipboard.writeText(text);
  notify('info', 'Copied');
}
/** Typed-domain uninstall (ServiceUninstall checks the domain, so does the main process). */
const uninstallRun = (deleteData: boolean, typed: string) => herd.wsUninstall(removing.value!.kind, deleteData, typed);
</script>

<template>
  <div class="flex min-h-0 min-w-0 flex-1">
    <aside class="flex w-64 shrink-0 flex-col border-r border-base-300/60 bg-base-200/80">
      <div class="drag title-strip h-14 shrink-0"><span class="nav-hole" aria-hidden="true" /></div>
      <div class="flex items-center gap-2 px-4 pb-1">
        <span class="label-caps">WebSocket servers</span>
        <span v-if="runningCount" class="badge badge-success badge-soft badge-xs">{{ runningCount }} running</span>
      </div>
      <ul class="menu w-full flex-1 flex-nowrap overflow-y-auto px-2">
        <li v-for="s in services" :key="s.kind">
          <a :class="{ 'menu-active': !selectedSiteId && s.kind === selectedKind }" @click="pick(s.kind)">
            <img :src="LOGO[s.kind]" alt="" class="size-7 shrink-0 rounded-lg bg-white p-0.5 ring-1 ring-base-content/10" draggable="false" />
            <div class="min-w-0 flex-1">
              <div class="truncate font-medium">{{ s.name }}</div>
              <div class="truncate font-mono text-[11px] opacity-60">
                <template v-if="s.installed">{{ s.config?.version }} · :{{ s.config?.port }}<span v-if="s.update" class="ml-1 font-sans text-warning" :title="`${s.update} available`">· update</span></template>
                <template v-else>{{ PROTOCOL[s.protocol] }}</template>
              </div>
              <div v-if="s.task && !s.task.done" class="mt-1">
                <progress class="progress h-1 w-full" :class="s.task.error ? 'progress-error' : 'progress-primary'" :value="s.task.error ? 100 : s.task.step" :max="s.task.steps.length" />
                <div class="truncate text-[10px]" :class="s.task.error ? 'text-error' : 'opacity-60'">{{ s.task.error ?? s.task.steps[s.task.step] }}</div>
              </div>
            </div>
            <template v-if="s.installed">
              <StatusDot :status="s.status" />
              <button class="btn btn-ghost btn-xs btn-square" :title="active(s) ? 'Stop' : 'Start'" :disabled="!!busy || s.status === 'stopping'" @click.stop="act(s, active(s) ? 'stop' : 'start')">
                <svg v-if="active(s)" class="size-3.5" viewBox="0 0 20 20" fill="currentColor"><rect x="5" y="5" width="10" height="10" rx="1.5" /></svg>
                <svg v-else class="size-3.5" viewBox="0 0 20 20" fill="currentColor"><path d="M6.3 4.2A1 1 0 0 0 5 5.1v9.8a1 1 0 0 0 1.5.9l8-4.9a1 1 0 0 0 0-1.8l-8-4.9Z" /></svg>
              </button>
            </template>
            <span v-else class="badge badge-ghost badge-xs">install</span>
          </a>
        </li>
        <li class="menu-title mt-3 flex-row items-center gap-2 px-2">
          <span class="label-caps">Site servers</span>
          <span v-if="siteServers.filter(siteUp).length" class="badge badge-success badge-soft badge-xs">{{ siteServers.filter(siteUp).length }} running</span>
        </li>
        <li v-for="p in siteServers" :key="p.id">
          <a :class="{ 'menu-active': selectedSiteId === p.id }" @click="selectedSiteId = p.id">
            <img v-if="p.reverb" :src="WS_LOGO.reverb" alt="" class="size-7 shrink-0 rounded-lg bg-white p-0.5 ring-1 ring-base-content/10" draggable="false" />
            <span v-else class="grid size-7 shrink-0 place-items-center rounded-lg bg-base-300/70 font-mono text-[10px] font-semibold">{{ socketioSite(p) ? 'IO' : 'WS' }}</span>
            <div class="min-w-0 flex-1">
              <div class="truncate font-medium">{{ p.name }}</div>
              <div class="truncate text-[11px] opacity-60">{{ siteKind(p) }}</div>
            </div>
            <StatusDot :status="siteStatus(p)" />
            <button class="btn btn-ghost btn-xs btn-square" :title="siteUp(p) ? 'Stop the site' : 'Start the site'" :disabled="!!busy || p.status === 'stopping'" @click.stop="siteAct(p, siteUp(p) ? 'stop' : 'start')">
              <svg v-if="siteUp(p)" class="size-3.5" viewBox="0 0 20 20" fill="currentColor"><rect x="5" y="5" width="10" height="10" rx="1.5" /></svg>
              <svg v-else class="size-3.5" viewBox="0 0 20 20" fill="currentColor"><path d="M6.3 4.2A1 1 0 0 0 5 5.1v9.8a1 1 0 0 0 1.5.9l8-4.9a1 1 0 0 0 0-1.8l-8-4.9Z" /></svg>
            </button>
          </a>
        </li>
        <li v-if="!siteServers.length" class="px-3 py-1 text-[11px] opacity-50">Sites running Reverb, Socket.IO, ws or Channels show here.</li>
      </ul>
      <div class="border-t border-base-300/60 p-3 text-xs">
        <span class="label-caps">Sites using real-time</span>
        <p class="mt-1 opacity-60">{{ rtSites.length ? rtSites.map((p) => p.name).join(', ') : 'none yet' }}</p>
      </div>
    </aside>

    <main class="flex min-w-0 flex-1 flex-col bg-base-100">
      <template v-if="site">
        <header class="drag border-b border-base-300/60 px-6 pt-5 pb-4">
          <div class="flex flex-wrap items-center gap-3">
            <img v-if="site.reverb" :src="WS_LOGO.reverb" alt="" class="size-11 rounded-xl bg-white p-1 ring-1 ring-base-content/10" draggable="false" />
            <span v-else class="grid size-11 place-items-center rounded-xl bg-base-300/70 font-mono text-sm font-semibold">{{ socketioSite(site) ? 'IO' : 'WS' }}</span>
            <div class="min-w-0 flex-1">
              <h2 class="flex items-center gap-2 text-lg font-semibold tracking-tight">
                {{ site.name }}
                <StatusDot :status="siteStatus(site)" />
                <span class="badge badge-soft badge-sm" :class="site.status === 'running' ? 'badge-success' : site.status === 'starting' ? 'badge-warning' : site.status === 'crashed' ? 'badge-error' : 'badge-ghost'">{{ site.status }}</span>
              </h2>
              <div class="text-xs opacity-60">{{ siteKind(site) }} · runs with the site<template v-if="site.reverb && site.reverbEndpoint"> · 127.0.0.1:{{ site.reverbEndpoint.port }}</template></div>
            </div>
            <div class="flex shrink-0 flex-wrap items-center gap-2">
              <button v-if="!siteUp(site)" class="btn btn-primary btn-sm" :disabled="!!busy" @click="siteAct(site, 'start')">
                <span v-if="busy === `site:${site.id}:start`" class="loading loading-spinner loading-xs" />Start
              </button>
              <button v-else class="btn btn-sm" :disabled="!!busy || site.status === 'stopping'" @click="siteAct(site, 'stop')">Stop</button>
              <button class="btn btn-sm" :disabled="!!busy || !siteUp(site)" @click="siteAct(site, 'restart')">Restart</button>
              <button class="btn btn-sm" @click="emit('openSite', site.id)">Open site</button>
            </div>
          </div>
        </header>
        <div class="flex min-h-0 flex-1 flex-col space-y-4 overflow-y-auto p-6">
          <a class="url-chip w-full" title="Click to copy" @click="copy(siteEndpoint(site))">
            <span class="badge badge-ghost badge-xs font-sans">WS</span>
            <span class="truncate">{{ siteEndpoint(site).replace(/^wss?:\/\//, '') }}</span>
          </a>
          <div class="flex flex-wrap items-center gap-2">
            <button class="btn btn-sm" :disabled="siteCheck.state === 'checking'" @click="testSite(site)">Test connection</button>
            <span v-if="siteCheck.state === 'ok'" class="badge badge-success badge-soft badge-sm">connected · {{ siteCheck.ms }} ms</span>
            <span v-else-if="siteCheck.state === 'fail'" class="badge badge-error badge-soft badge-sm">not reachable</span>
            <span v-else-if="siteCheck.state === 'checking'" class="loading loading-spinner loading-xs" />
            <span v-if="siteCheck.detail" class="text-xs" :class="siteCheck.state === 'fail' ? 'text-error' : 'opacity-60'">{{ siteCheck.detail }}</span>
          </div>
          <p class="text-xs opacity-60">
            <template v-if="site.reverb">
              <code>php artisan reverb:start</code> runs next to Vite / queue when the site starts; Laravel publishes to 127.0.0.1, browsers connect through
              <code>wss://{{ site.reverbEndpoint?.domain }}</code>. To share one Reverb between sites instead, install Laravel Reverb above.
            </template>
            <template v-else>The site's own server handles the WebSocket; DevCatz's proxy passes the upgrade on <code>{{ site.domain }}</code> (TLS at the proxy).</template>
            Settings and .env lines are in the site's WebSocket tab.
          </p>
          <div class="min-h-[24rem] flex-1">
            <LogView :key="site.id" :project-id="site.id" />
          </div>
        </div>
      </template>

      <template v-else-if="selected && !selected.installed">
        <header class="drag border-b border-base-300/60 px-6 pt-5 pb-4">
          <div class="flex items-center gap-3">
            <img :src="LOGO[selected.kind]" alt="" class="size-11 rounded-xl bg-white p-1 ring-1 ring-base-content/10" draggable="false" />
            <div class="min-w-0">
              <h2 class="text-lg font-semibold tracking-tight">{{ selected.name }}</h2>
              <div class="text-xs opacity-60">Not installed · {{ PROTOCOL[selected.protocol] }}</div>
            </div>
          </div>
        </header>
        <div class="flex-1 overflow-y-auto p-6">
          <div class="mx-auto max-w-xl space-y-4 pt-6">
            <p class="text-sm opacity-70">{{ selected.description }}</p>
            <TaskStepper v-if="selected.task && !form" :task="selected.task" :cancellable="selected.task.kind === 'install'" dismissable @dismiss="herd.taskDismiss('ws', selected.kind)" @cancel="herd.wsCancelInstall(selected.kind)" />
            <button class="btn btn-primary" :disabled="!!selected.task && !selected.task.done && !selected.task.error" @click="form = { service: selected, mode: 'install' }">
              <span v-if="selected.task && !selected.task.done && !selected.task.error" class="loading loading-spinner loading-xs" />Install {{ selected.name }}…
            </button>
            <p class="text-xs opacity-60">
              Sites with their own WebSocket server (Socket.IO, ws, Django Channels …) need nothing here: DevCatz passes the upgrade on the site's domain. Install a
              server for client libraries (Laravel Echo / pusher-js → Laravel Reverb or Sockudo, Centrifuge, Mercure, NATS).
            </p>
          </div>
        </div>
      </template>

      <template v-else-if="selected?.installed && selected.config && selected.urls">
        <header class="drag border-b border-base-300/60 px-6 pt-5 pb-3">
          <div class="flex flex-wrap items-center gap-3">
            <img :src="LOGO[selected.kind]" alt="" class="size-11 rounded-xl bg-white p-1 ring-1 ring-base-content/10" draggable="false" />
            <div class="min-w-0 flex-1">
              <h2 class="flex items-center gap-2 text-lg font-semibold tracking-tight">
                {{ selected.name }}
                <StatusDot :status="selected.status" />
                <span class="badge badge-soft badge-sm" :class="selected.status === 'running' ? 'badge-success' : selected.status === 'starting' ? 'badge-warning' : selected.status === 'crashed' ? 'badge-error' : 'badge-ghost'">{{ selected.status }}</span>
              </h2>
              <div class="font-mono text-xs opacity-60">{{ selected.config.version }} · {{ PROTOCOL[selected.protocol] }} · 127.0.0.1:{{ selected.config.port }}<template v-if="selected.config.autoStart"> · starts with DevCatz</template></div>
            </div>
            <div class="flex shrink-0 flex-wrap items-center gap-2">
            <button v-if="selected.update" class="btn btn-warning btn-soft btn-sm" :disabled="!!busy || updating(selected)" :title="`${selected.config.version} → ${selected.update}: the data folder and settings stay`" @click="upgrade(selected)">
              <span v-if="updating(selected) || busy === `${selected.kind}:update`" class="loading loading-spinner loading-xs" />Update to {{ selected.update }}
            </button>
            <button v-if="!active(selected)" class="btn btn-primary btn-sm" :disabled="!!busy" @click="act(selected, 'start')">
              <span v-if="busy === `${selected.kind}:start`" class="loading loading-spinner loading-xs" />Start
            </button>
            <button v-else class="btn btn-sm" :disabled="!!busy || selected.status === 'stopping'" @click="act(selected, 'stop')">Stop</button>
            <button class="btn btn-sm" :disabled="!!busy || !active(selected)" @click="act(selected, 'restart')">Restart</button>
            <button v-if="selected.urls.admin" class="btn btn-sm" :disabled="!active(selected)" @click="herd.openUrl(selected.urls.admin)">Admin</button>
            <PopMenu :items="moreItems" align="end" :width="220">
              <button class="btn btn-sm">More ▾</button>
            </PopMenu>
            </div>
          </div>
          <div role="tablist" class="seg no-drag mt-3">
            <a v-for="t in ['inspector', 'client', 'connection', 'sites', 'logs'] as Tab[]" :key="t" role="tab" class="seg-item" :class="{ 'is-active': tab === t }" @click="tab = t">
              {{ t === 'client' ? 'test client' : t }}
            </a>
          </div>
        </header>

        <div class="flex min-h-0 flex-1 flex-col space-y-4 overflow-y-auto p-6">
          <div v-if="selected.error" role="alert" class="alert alert-error alert-soft text-sm"><CatMood mood="error" class="size-7 shrink-0 -my-0.5" />{{ selected.error }}</div>
          <TaskStepper v-if="selected.task && !form" :task="selected.task" compact dismissable @dismiss="herd.taskDismiss('ws', selected.kind)" />
          <a class="url-chip w-full" :title="`127.0.0.1:${selected.config.port} · click to copy`" @click="copy(selected.urls.ws)">
            <span class="badge badge-ghost badge-xs font-sans">{{ selected.protocol === 'mercure' ? 'Hub' : 'WS' }}</span>
            <span class="truncate">{{ selected.urls.ws.replace(/^(wss|https):\/\//, '') }}</span>
            <span class="ml-auto font-sans text-[10px] opacity-60">:{{ selected.config.port }}</span>
          </a>

          <!-- Inspector -->
          <div v-if="tab === 'inspector'" class="space-y-4">
            <div v-if="selected.status !== 'running'" class="alert alert-soft text-sm">{{ selected.name }} is {{ selected.status }}. Start it to see clients and channels.</div>
            <template v-else>
              <div class="grid gap-3 sm:grid-cols-3">
                <div class="rounded-box border border-base-300/60 p-3">
                  <span class="label-caps">Clients</span>
                  <div class="font-mono text-2xl font-semibold tabular-nums">{{ stats?.clients ?? '…' }}</div>
                  <Sparkline :values="clientsSeries" :floor="2" color="var(--c-websocket)" :height="28" />
                </div>
                <div class="rounded-box border border-base-300/60 p-3">
                  <span class="label-caps">Channels</span>
                  <div class="font-mono text-2xl font-semibold tabular-nums">{{ stats ? stats.channels.length : '…' }}</div>
                  <div class="text-xs opacity-60">with at least one subscriber</div>
                </div>
                <div class="rounded-box border border-base-300/60 p-3">
                  <span class="label-caps">Messages / s</span>
                  <div class="font-mono text-2xl font-semibold tabular-nums">{{ stats?.messagesPerSec == null ? '—' : stats.messagesPerSec.toFixed(1) }}</div>
                  <Sparkline :values="rateSeries" :floor="2" color="var(--c-search)" :height="28" />
                </div>
              </div>
              <div v-if="stats?.error" class="text-xs text-error">{{ stats.error }}</div>
              <div class="overflow-x-auto rounded-box border border-base-300/60">
                <table class="table table-sm">
                  <thead>
                    <tr><th>{{ selected.protocol === 'mercure' ? 'Topic' : selected.protocol === 'nats' ? 'Subject' : 'Channel' }}</th><th v-if="selected.protocol === 'pusher'">Type</th><th class="text-right">Subscribers</th><th v-if="selected.protocol === 'pusher'" class="text-right">Members</th></tr>
                  </thead>
                  <tbody>
                    <tr v-for="c in channels" :key="c.name">
                      <td class="font-mono">{{ c.name }}</td>
                      <td v-if="selected.protocol === 'pusher'"><span class="badge badge-ghost badge-xs">{{ channelKind(c.name) }}</span></td>
                      <td class="text-right font-mono tabular-nums">{{ c.clients }}</td>
                      <td v-if="selected.protocol === 'pusher'" class="text-right font-mono tabular-nums">{{ c.members ?? '—' }}</td>
                    </tr>
                    <tr v-if="!channels.length">
                      <td colspan="4" class="py-5 text-center text-xs opacity-60">No subscriptions right now. Open the test client or a site that connects.</td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <p class="text-xs opacity-60">Refreshed every 2 seconds from {{ selected.name }}’s own API{{ selected.protocol === 'centrifugo' ? ' (client totals update once a minute; channels live)' : '' }}.</p>
            </template>
          </div>

          <div v-else-if="tab === 'connection'" class="space-y-3">
            <div class="grid gap-2 text-sm sm:grid-cols-2">
              <div><span class="label-caps block">{{ selected.protocol === 'mercure' ? 'Hub (HTTPS)' : 'WebSocket (TLS)' }}</span><code class="selectable">{{ selected.urls.ws }}</code></div>
              <div><span class="label-caps block">Local</span><code class="selectable">{{ selected.urls.wsLocal }}</code></div>
              <div v-if="selected.fields.appId"><span class="label-caps block">{{ selected.fields.appId }}</span><code class="selectable">{{ selected.config.appId }}</code></div>
              <div v-if="selected.fields.key && selected.config.key"><span class="label-caps block">{{ selected.fields.key }}</span><code class="selectable">{{ selected.config.key }}</code></div>
              <div v-if="selected.fields.secret"><span class="label-caps block">{{ selected.fields.secret }}</span><code class="selectable">{{ selected.config.secret }}</code></div>
              <div v-if="selected.kind === 'nats'"><span class="label-caps block">Client (TCP)</span><code class="selectable">nats://127.0.0.1:{{ selected.config.extraPort }}</code></div>
              <div v-if="selected.urls.admin"><span class="label-caps block">Admin</span><code class="selectable">{{ selected.urls.admin }}</code></div>
              <div><span class="label-caps block">Data folder</span><code class="selectable break-all">{{ selected.config.dataDir }}</code></div>
            </div>
            <div class="rounded-box border border-base-300/60 p-3">
              <div class="mb-2 text-sm font-medium">.env lines for a site</div>
              <WsEnvWriter :key="selected.kind" :source="selected.kind" :label="selected.name" />
            </div>
            <p v-if="selected.kind === 'reverb'" class="text-xs opacity-60">
              Laravel: <code>BROADCAST_CONNECTION=reverb</code> (config/broadcasting.php from <code>php artisan install:broadcasting</code>, or
              <code>composer require pusher/pusher-php-server</code> with the reverb connection); Echo uses the <code>VITE_REVERB_*</code> lines. The site does not run its
              own <code>reverb:start</code>. Other stacks get the Pusher-style lines.
            </p>
            <p v-else-if="selected.protocol === 'pusher'" class="text-xs opacity-60">
              Laravel: <code>BROADCAST_CONNECTION=pusher</code> with <code>composer require pusher/pusher-php-server</code>; Echo uses the <code>VITE_PUSHER_*</code> lines
              (<code>wsHost</code>, <code>wsPort: 443</code>, <code>forceTLS: true</code>).
            </p>
          </div>

          <!-- Sites -->
          <div v-else-if="tab === 'sites'" class="space-y-3">
            <div v-if="rtSites.length" class="overflow-x-auto rounded-box border border-base-300/60">
              <table class="table table-sm">
                <thead>
                  <tr><th>Site</th><th>Libraries</th><th>Endpoint</th><th></th></tr>
                </thead>
                <tbody>
                  <tr v-for="p in rtSites" :key="p.id">
                    <td><div class="flex items-center gap-2"><StatusDot :status="p.served ? 'running' : p.status" /><span class="font-medium">{{ p.name }}</span></div></td>
                    <td>
                      <div class="flex flex-wrap gap-1">
                        <span v-for="l in p.realtime.libs" :key="l.name" class="badge badge-sm" :class="l.role === 'server' ? 'badge-primary badge-soft' : 'badge-ghost'" :title="`${l.role} · ${l.source}`">{{ l.name }}</span>
                      </div>
                    </td>
                    <td class="font-mono text-xs">
                      <template v-if="p.reverbEndpoint">wss://{{ p.reverbEndpoint.domain }}</template>
                      <template v-else-if="p.realtime.libs.some((l) => l.role === 'server')">wss://{{ p.domain }}</template>
                      <template v-else-if="p.wsServer">{{ services.find((s) => s.kind === p.wsServer)?.name }}</template>
                      <span v-else class="opacity-50">—</span>
                    </td>
                    <td class="text-right"><button class="btn btn-ghost btn-xs" @click="emit('openSite', p.id)">Open site</button></td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p v-else class="text-xs opacity-60">No site uses Socket.IO, ws, Laravel Echo, Reverb, Django Channels, Centrifugo, Mercure or NATS yet.</p>
            <p class="text-xs opacity-60">Each site's WebSocket tab tests its own server, runs Reverb, or points it at one of these servers (Write to .env).</p>
          </div>

          <div v-else-if="tab === 'logs'" class="min-h-[28rem] flex-1">
            <LogView :key="selected.kind" :project-id="`ws:${selected.kind}`" />
          </div>
          <!-- Stays connected while other tabs show (its subscriptions appear in the inspector). -->
          <WsTestClient v-show="tab === 'client'" :key="selected.kind" :service="selected" />
        </div>
      </template>
    </main>
  </div>

  <WsForm v-if="form" :service="services.find((x) => x.kind === form!.service.kind) ?? form.service" :mode="form.mode" @close="form = null" @done="form = null" />

  <ServiceUninstall
    v-if="removing?.config"
    :name="removing.name"
    :host="`${removing.config.domain}.${state?.settings.tld ?? 'localhost'}`"
    :data-dir="removing.config.dataDir"
    data-what="Its config (and NATS JetStream data)"
    impact="Sites pointing at it lose their real-time connection until it is installed again."
    :run="uninstallRun"
    @close="removing = null"
  />
</template>
