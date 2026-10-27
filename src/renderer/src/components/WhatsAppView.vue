<script setup lang="ts">
import { WA_LOGO } from '../logos';
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import type { GwKind, GwState, WaContact, WaDelivery, WaEngine, WaHook, WaMessage, WaSendResult, WaState } from '@shared/types';
import StatusDot from './StatusDot.vue';
import LogView from './LogView.vue';
import TaskStepper from './TaskStepper.vue';
import ServiceUninstall from './ServiceUninstall.vue';
import WaForm from './WaForm.vue';
import WaEnvWriter from './WaEnvWriter.vue';
import ConfirmDialog from './ConfirmDialog.vue';
import PopMenu, { type MenuItem } from './PopMenu.vue';
import GatewayEngineView from './GatewayEngineView.vue';
import { GW_CATEGORIES, GW_CATEGORY_LABEL, GW_LOGO } from '../gateways';
import { attempt, herd, notify, state, uninstallRequest } from '../store';
import CatMood from './CatMood.vue';

/**
 * Gateways (rail): the WhatsApp gateway engines (GOWA, WAHA) with their sessions (QR
 * to link a phone), a test sender, contacts and groups; the inspector with
 * every message that went through; and webhooks that forward the engines'
 * events to sites, with deliveries and Replay.
 */
const props = defineProps<{ focus?: string | null }>();
const emit = defineEmits<{ openSite: [id: string] }>();
const H = herd;

const engines = computed(() => state.value?.whatsapp ?? []);
const sites = computed(() => state.value?.projects ?? []);
const tld = computed(() => state.value?.settings.tld ?? 'localhost');
const LOGO = WA_LOGO;
type Page = WaEngine | 'inspector' | 'webhooks' | GwKind;
const page = ref<Page>('gowa');
const selected = computed(() => engines.value.find((e) => e.engine === page.value) ?? null);
const active = (s: WaState) => s.status === 'running' || s.status === 'starting';
const runningCount = computed(() => engines.value.filter((e) => e.status === 'running').length);
const gateways = computed<GwState[]>(() => state.value?.gateways ?? []);
const gwPage = computed(() => (gateways.value.some((g) => g.kind === page.value) ? (page.value as GwKind) : null));
const gwActive = (g: GwState) => g.status === 'running' || g.status === 'starting';
const gwBusy = ref<string | null>(null);
async function gwAct(g: GwState) {
  gwBusy.value = g.kind;
  await attempt(() => herd.gwAction(g.kind, gwActive(g) ? 'stop' : 'start').then(() => true));
  gwBusy.value = null;
}
watch(
  () => props.focus,
  (f) => {
    if (!f) return;
    if (['gowa', 'waha', 'inspector', 'webhooks', 'stalwart', 'postal', 'ntfy', 'gotify', 'jasmin'].includes(f)) page.value = f as Page;
    else if (sites.value.some((p) => p.id === f)) {
      page.value = 'webhooks';
      hookForm.value = { siteId: f, url: hookUrlFor(f), events: '', enabled: true };
    }
  },
  { immediate: true },
);

// ---- engine actions
type Tab = 'sessions' | 'send' | 'contacts' | 'connection' | 'logs';
const tab = ref<Tab>('sessions');
const form = ref<{ service: WaState; mode: 'install' | 'edit' } | null>(null);
const removing = ref<WaState | null>(null);

// Ask DevCatz's "Uninstall …" opens this page's own dialog (with its typed confirmation); nothing is removed without it.
watch(
  uninstallRequest,
  (r) => {
    if (r?.scope !== 'whatsapp') return;
    uninstallRequest.value = null;
    const s = engines.value.find((x) => x.engine === r.id && x.installed);
    if (s) {
      page.value = s.engine;
      removing.value = s;
    }
  },
  { immediate: true },
);
const busy = ref<string | null>(null);
async function act(s: WaState, action: 'start' | 'stop' | 'restart') {
  busy.value = `${s.engine}:${action}`;
  await attempt(() => herd.waAction(s.engine, action).then(() => true));
  busy.value = null;
}
const uninstallRun = (deleteData: boolean, typed: string) => herd.waUninstall(removing.value!.engine, deleteData, typed);
const updating = (s: WaState) => s.task?.kind === 'update' && !s.task.done && !s.task.error;
async function upgrade(s: WaState) {
  await attempt(() => herd.waUpgrade(s.engine).then(() => true), `${s.name} updated`);
}
const moreItems = computed<MenuItem[]>(() => {
  const s = selected.value;
  if (!s?.installed) return [];
  return [
    { label: s.engine === 'gowa' ? 'Open web UI' : 'Open dashboard', action: () => herd.openUrl(s.url! + s.dashboardPath) },
    { label: 'Open data folder', action: () => herd.waOpenData(s.engine) },
    { label: 'Check for updates', action: checkUpdates },
    { label: 'Settings…', action: () => (form.value = { service: s, mode: 'edit' }) },
    { label: 'Uninstall…', action: () => (removing.value = s) },
  ];
});
const checking = ref(false);
async function checkUpdates() {
  checking.value = true;
  const failed = await attempt(() => herd.waCheckUpdates());
  checking.value = false;
  if (!failed) return;
  const s = selected.value;
  if (s && failed.includes(s.name)) notify('error', `Could not check ${s.name} for updates (offline, or GitHub's hourly limit; try again later)`);
  else notify('info', s?.update ? `${s.name} ${s.update} is available` : `${s?.name ?? 'Everything'} is up to date`);
}
async function copy(t: string, what = 'Copied') {
  await navigator.clipboard.writeText(t).catch(() => undefined);
  notify('info', what);
}
const showKey = ref(false);

// ---- sessions + QR
const newSession = ref('');
const qr = ref<{ engine: WaEngine; name: string; image: string; at: number } | null>(null);
let qrTimer: ReturnType<typeof setInterval> | null = null;
async function refreshQr() {
  if (!qr.value) return;
  const img = await herd.waSessionQr(qr.value.engine, qr.value.name).catch(() => '');
  if (!qr.value) return;
  qr.value = { ...qr.value, image: img, at: Date.now() };
}
async function link(s: WaState, name: string) {
  if (!(s.sessions.some((x) => x.name === name) && s.sessions.find((x) => x.name === name)!.status !== 'disconnected')) {
    if (!(await attempt(() => herd.waSessionStart(s.engine, name).then(() => true)))) return;
  }
  qr.value = { engine: s.engine, name, image: '', at: 0 };
  await refreshQr();
  if (qrTimer) clearInterval(qrTimer);
  qrTimer = setInterval(() => void refreshQr(), s.engine === 'gowa' ? 25_000 : 15_000);
}
function closeQr() {
  qr.value = null;
  if (qrTimer) clearInterval(qrTimer);
  qrTimer = null;
}
watch(
  () => selected.value?.sessions.find((x) => x.name === qr.value?.name)?.status,
  (st) => {
    if (qr.value && st === 'connected') {
      notify('success', `${qr.value.name}: phone linked`);
      closeQr();
    }
  },
);
onBeforeUnmount(closeQr);
async function addSession(s: WaState) {
  const name = newSession.value.trim();
  if (!name) return;
  if (await attempt(() => herd.waSessionStart(s.engine, name).then(() => true))) {
    newSession.value = '';
    await link(s, name);
  }
}
const confirmLogout = ref<{ s: WaState; name: string; remove: boolean } | null>(null);
async function logoutSession() {
  const c = confirmLogout.value!;
  confirmLogout.value = null;
  if (c.remove) await attempt(() => herd.waSessionRemove(c.s.engine, c.name).then(() => true), `${c.name} removed`);
  else await attempt(() => herd.waSessionLogout(c.s.engine, c.name).then(() => true), `${c.name} logged out`);
}
const SESSION_BADGE: Record<string, string> = { connected: 'badge-success', scanning: 'badge-warning', starting: 'badge-info', failed: 'badge-error', disconnected: 'badge-ghost' };

// ---- send
const send = ref({ session: '', to: '', kind: 'text' as 'text' | 'image' | 'document', text: 'Hello from DevCatz 👋', file: '' });
const sent = ref<WaSendResult | null>(null);
const sending = ref(false);
async function pickFile() {
  const f = await herd.pickFile(send.value.kind === 'image' ? 'Choose an image' : 'Choose a document');
  if (f) send.value.file = f;
}
async function doSend(s: WaState) {
  sending.value = true;
  const r = await attempt(() => herd.waSend(s.engine, { ...send.value, session: send.value.session || s.sessions[0]?.name || 'default' }));
  sending.value = false;
  if (r) {
    sent.value = r;
    notify(r.status < 300 ? 'success' : 'error', r.status < 300 ? 'Sent' : `The engine answered ${r.status}`);
  }
}

// ---- contacts
const contacts = ref<WaContact[]>([]);
const groups = ref<WaContact[]>([]);
const contactsLoaded = ref(false);
const contactFilter = ref('');
async function loadContacts(s: WaState) {
  const session = send.value.session || s.sessions[0]?.name || 'default';
  const [c, g] = await Promise.all([attempt(() => herd.waContacts(s.engine, session)), attempt(() => herd.waGroups(s.engine, session))]);
  contacts.value = c ?? [];
  groups.value = g ?? [];
  contactsLoaded.value = true;
}
const filteredContacts = computed(() => {
  const q = contactFilter.value.trim().toLowerCase();
  return contacts.value.filter((c) => !q || c.name.toLowerCase().includes(q) || c.id.includes(q)).slice(0, 300);
});
function useContact(c: WaContact) {
  send.value.to = c.id;
  tab.value = 'send';
}

// ---- inspector
const messages = ref<WaMessage[]>([]);
const openMsg = ref<WaMessage | null>(null);
const msgFilter = ref('');
async function loadMessages() {
  messages.value = (await herd.waMessages(300).catch(() => [])) ?? [];
}
let msgTimer: ReturnType<typeof setInterval> | null = null;
watch(
  page,
  (p) => {
    if (msgTimer) clearInterval(msgTimer);
    msgTimer = null;
    if (p === 'inspector') {
      void loadMessages();
      msgTimer = setInterval(() => void loadMessages(), 3000);
    }
  },
  { immediate: true },
);
onBeforeUnmount(() => msgTimer && clearInterval(msgTimer));
const filteredMessages = computed(() => {
  const q = msgFilter.value.trim().toLowerCase();
  return messages.value.filter((m) => !q || [m.body, m.from, m.fromName, m.to, m.session, m.event].some((s) => s?.toLowerCase().includes(q)));
});
const pretty = (raw: string) => {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
};
const when = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const whenFull = (iso: string) => new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const clearing = ref(false);
async function clearMessages() {
  clearing.value = false;
  await attempt(() => herd.waClearMessages().then(() => true), 'Inspector cleared');
  await loadMessages();
}

// ---- webhooks
const hooks = ref<WaHook[]>([]);
const hookSel = ref<string | null>(null);
const hook = computed(() => hooks.value.find((h) => h.id === hookSel.value) ?? null);
const deliveries = ref<WaDelivery[]>([]);
const openDelivery = ref<WaDelivery | null>(null);
const hookForm = ref<{ id?: string; siteId: string; url: string; events: string; enabled: boolean } | null>(null);
const hookUrlFor = (siteId: string) => {
  const p = sites.value.find((x) => x.id === siteId);
  return p ? `https://${p.domain}/webhooks/whatsapp` : '';
};
async function loadHooks() {
  hooks.value = (await herd.waHooks().catch(() => [])) ?? [];
  if (!hookSel.value || !hooks.value.some((h) => h.id === hookSel.value)) hookSel.value = hooks.value[0]?.id ?? null;
}
async function loadDeliveries() {
  deliveries.value = hookSel.value ? ((await herd.waDeliveries(hookSel.value, 200).catch(() => [])) ?? []) : [];
}
watch(page, (p) => p === 'webhooks' && void loadHooks().then(loadDeliveries), { immediate: true });
watch(hookSel, loadDeliveries);
watch(
  () => JSON.stringify(state.value?.whatsapp.map((w) => w.status)),
  () => page.value === 'webhooks' && void loadHooks().then(loadDeliveries),
);
let hookTimer: ReturnType<typeof setInterval> | null = setInterval(() => page.value === 'webhooks' && void loadHooks().then(loadDeliveries), 4000);
onBeforeUnmount(() => hookTimer && clearInterval(hookTimer));
async function saveHook() {
  const f = hookForm.value!;
  const h = await attempt(() => herd.waSetHook({ id: f.id, siteId: f.siteId, url: f.url, events: f.events.split(/[\s,]+/).filter(Boolean), enabled: f.enabled }));
  if (!h) return;
  hookForm.value = null;
  await loadHooks();
  hookSel.value = h.id;
  notify('success', `Webhook to ${h.siteName} saved`);
}
const removingHook = ref<WaHook | null>(null);
async function removeHook() {
  const h = removingHook.value!;
  removingHook.value = null;
  await attempt(() => herd.waRemoveHook(h.id).then(() => true), 'Webhook removed');
  await loadHooks();
}
async function toggleHook(h: WaHook) {
  await attempt(() => herd.waSetHook({ id: h.id, siteId: h.siteId, url: h.url, events: h.events, enabled: !h.enabled }));
  await loadHooks();
}
async function replay(d: WaDelivery) {
  const r = await attempt(() => herd.waReplay(d.id));
  if (r) {
    notify(r.status && r.status < 300 ? 'success' : 'error', `Replayed ${d.event} → ${r.status ?? r.error}`);
    await loadDeliveries();
    openDelivery.value = r;
  }
}
const STATUS = (s: number | null) => (s === null ? 'text-error' : s < 300 ? 'text-success' : s < 400 ? 'text-info' : s < 500 ? 'text-warning' : 'text-error');
</script>

<template>
  <div class="flex min-h-0 min-w-0 flex-1">
    <aside class="flex w-64 shrink-0 flex-col border-r border-base-300/60 bg-base-200/80">
      <div class="drag title-strip h-14 shrink-0"><span class="nav-hole" aria-hidden="true" /></div>
      <div class="flex items-center gap-2 px-4 pb-1">
        <span class="label-caps">WhatsApp</span>
        <span v-if="runningCount" class="badge badge-success badge-soft badge-xs">{{ runningCount }} running</span>
      </div>
      <ul class="menu w-full flex-1 flex-nowrap overflow-y-auto px-2">
        <li v-for="s in engines" :key="s.engine">
          <a :class="{ 'menu-active': page === s.engine }" @click="page = s.engine">
            <img :src="LOGO[s.engine]" alt="" class="size-7 shrink-0 rounded-lg bg-white p-0.5 ring-1 ring-base-content/10" draggable="false" />
            <div class="min-w-0 flex-1">
              <div class="truncate font-medium">{{ s.name }}</div>
              <div class="truncate font-mono text-[11px] opacity-60">
                <template v-if="s.installed">{{ s.config?.version }} · :{{ s.config?.port }}<span v-if="s.update" class="ml-1 font-sans text-warning" :title="`${s.update} available`">· update</span></template>
                <template v-else>{{ s.docker ? 'Docker image' : 'Go binary' }}</template>
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
        <li class="menu-title mt-3 px-2"><span class="label-caps">Traffic</span></li>
        <li>
          <a :class="{ 'menu-active': page === 'inspector' }" @click="page = 'inspector'">
            <span class="grid size-7 shrink-0 place-items-center rounded-lg bg-base-300/70 font-mono text-[10px] font-semibold">MSG</span>
            <div class="min-w-0 flex-1">
              <div class="truncate font-medium">Inspector</div>
              <div class="truncate text-[11px] opacity-60">messages in and out, raw events</div>
            </div>
          </a>
        </li>
        <li>
          <a :class="{ 'menu-active': page === 'webhooks' }" @click="page = 'webhooks'">
            <span class="grid size-7 shrink-0 place-items-center rounded-lg bg-base-300/70 font-mono text-[10px] font-semibold">WH</span>
            <div class="min-w-0 flex-1">
              <div class="truncate font-medium">Webhooks</div>
              <div class="truncate text-[11px] opacity-60">events forwarded to sites, Replay</div>
            </div>
            <span v-if="hooks.length" class="badge badge-ghost badge-xs">{{ hooks.length }}</span>
          </a>
        </li>
        <template v-for="cat in GW_CATEGORIES" :key="cat">
          <li class="menu-title mt-3 px-2"><span class="label-caps">{{ GW_CATEGORY_LABEL[cat] }}</span></li>
          <li v-for="g in gateways.filter((x) => x.category === cat)" :key="g.kind">
            <a :class="{ 'menu-active': page === g.kind }" @click="page = g.kind">
              <img :src="GW_LOGO[g.kind]" alt="" class="size-7 shrink-0 rounded-lg bg-white p-0.5 ring-1 ring-base-content/10" draggable="false" />
              <div class="min-w-0 flex-1">
                <div class="truncate font-medium">{{ g.name }}</div>
                <div class="truncate font-mono text-[11px] opacity-60">
                  <template v-if="g.installed">{{ g.config?.version }} · :{{ g.config?.port }}<span v-if="g.update" class="ml-1 font-sans text-warning">· update</span></template>
                  <template v-else>{{ g.docker ? 'Docker' : 'binary' }}</template>
                </div>
                <div v-if="g.task && !g.task.done" class="mt-1">
                  <progress class="progress h-1 w-full" :class="g.task.error ? 'progress-error' : 'progress-primary'" :value="g.task.error ? 100 : g.task.step" :max="g.task.steps.length" />
                  <div class="truncate text-[10px]" :class="g.task.error ? 'text-error' : 'opacity-60'">{{ g.task.error ?? g.task.steps[g.task.step] }}</div>
                </div>
              </div>
              <template v-if="g.installed">
                <StatusDot :status="g.status" />
                <button class="btn btn-ghost btn-xs btn-square" :title="gwActive(g) ? 'Stop' : 'Start'" :disabled="gwBusy === g.kind || g.status === 'stopping'" @click.stop="gwAct(g)">
                  <span v-if="gwBusy === g.kind" class="loading loading-spinner loading-xs" />
                  <svg v-else-if="gwActive(g)" class="size-3.5" viewBox="0 0 20 20" fill="currentColor"><rect x="5" y="5" width="10" height="10" rx="1.5" /></svg>
                  <svg v-else class="size-3.5" viewBox="0 0 20 20" fill="currentColor"><path d="M6.3 4.2A1 1 0 0 0 5 5.1v9.8a1 1 0 0 0 1.5.9l8-4.9a1 1 0 0 0 0-1.8l-8-4.9Z" /></svg>
                </button>
              </template>
              <span v-else class="badge badge-ghost badge-xs">install</span>
            </a>
          </li>
        </template>
      </ul>
      <div class="border-t border-base-300/60 p-3 text-xs">
        <span class="label-caps">Sites using gateways</span>
        <p class="mt-1 opacity-60">{{ sites.filter((p) => p.waInfo || p.gwInfo).length ? sites.filter((p) => p.waInfo || p.gwInfo).map((p) => p.name).join(', ') : 'none yet' }}</p>
      </div>
    </aside>

    <main class="flex min-w-0 flex-1 flex-col bg-base-100">
      <GatewayEngineView v-if="gwPage" :kind="gwPage" />
      <!-- Engine, not installed -->
      <template v-else-if="selected && !selected.installed">
        <header class="drag win-top border-b border-base-300/60 px-6 pt-5 pb-4">
          <div class="flex items-center gap-3">
            <img :src="LOGO[selected.engine]" alt="" class="size-11 rounded-xl bg-white p-1 ring-1 ring-base-content/10" draggable="false" />
            <div class="min-w-0">
              <h2 class="text-lg font-semibold tracking-tight">{{ selected.name }}</h2>
              <div class="text-xs opacity-60">Not installed · {{ selected.docker ? 'runs in Docker (OrbStack / Docker Desktop)' : 'a single Go binary' }}</div>
            </div>
          </div>
        </header>
        <div class="flex-1 overflow-y-auto p-6">
          <div class="mx-auto max-w-xl space-y-4 pt-6">
            <p class="text-sm opacity-70">{{ selected.description }}</p>
            <TaskStepper v-if="selected.task && !form" :task="selected.task" :cancellable="selected.task.kind === 'install'" dismissable @dismiss="herd.taskDismiss('whatsapp', selected.engine)" @cancel="H.waCancelInstall(selected.engine)" />
            <button class="btn btn-primary" :disabled="!!selected.task && !selected.task.done && !selected.task.error" @click="form = { service: selected, mode: 'install' }">
              <span v-if="selected.task && !selected.task.done && !selected.task.error" class="loading loading-spinner loading-xs" />Install {{ selected.name }}…
            </button>
            <div class="alert alert-warning alert-soft text-xs"><CatMood mood="warning" class="size-7 shrink-0 -my-0.5" />
              Both engines use the WhatsApp Web protocol, which WhatsApp does not sanction: a number can be banned. Link a test number, keep volumes low, and use the
              official Cloud API in production.
            </div>
          </div>
        </div>
      </template>

      <!-- Engine, installed -->
      <template v-else-if="selected?.installed && selected.config">
        <header class="drag win-top border-b border-base-300/60 px-6 pt-5 pb-3">
          <div class="flex flex-wrap items-center gap-3">
            <img :src="LOGO[selected.engine]" alt="" class="size-11 rounded-xl bg-white p-1 ring-1 ring-base-content/10" draggable="false" />
            <div class="min-w-0 flex-1">
              <h2 class="flex items-center gap-2 text-lg font-semibold tracking-tight">
                {{ selected.name }}
                <StatusDot :status="selected.status" />
                <span class="badge badge-soft badge-sm" :class="selected.status === 'running' ? 'badge-success' : selected.status === 'starting' ? 'badge-warning' : selected.status === 'crashed' ? 'badge-error' : 'badge-ghost'">{{ selected.status }}</span>
                <span class="badge badge-ghost badge-sm font-mono">{{ selected.config.version }}</span>
                <button v-if="selected.update" class="btn btn-primary btn-xs" :disabled="!!selected.task && !selected.task.done && !selected.task.error" :title="`Download ${selected.update}, swap it in, restart if running`" @click="upgrade(selected)">
                  <span v-if="updating(selected)" class="loading loading-spinner loading-xs" />Update to {{ selected.update }}
                </button>
              </h2>
              <div class="text-xs opacity-60">{{ selected.sessions.filter((x) => x.status === 'connected').length }} linked · {{ selected.sessions.length }} session{{ selected.sessions.length === 1 ? '' : 's' }} · 127.0.0.1:{{ selected.config.port }}</div>
            </div>
            <div class="flex shrink-0 flex-wrap items-center gap-2">
              <button v-if="!active(selected)" class="btn btn-primary btn-sm" :disabled="!!busy" @click="act(selected, 'start')"><span v-if="busy === `${selected.engine}:start`" class="loading loading-spinner loading-xs" />Start</button>
              <button v-else class="btn btn-sm" :disabled="!!busy || selected.status === 'stopping'" @click="act(selected, 'stop')">Stop</button>
              <button class="btn btn-sm" :disabled="!!busy || !active(selected)" @click="act(selected, 'restart')">Restart</button>
              <PopMenu :items="moreItems" align="end" :width="220">
                <button class="btn btn-sm">More ▾</button>
              </PopMenu>
            </div>
          </div>
          <div role="tablist" class="seg no-drag mt-3">
            <a v-for="t in (['sessions', 'send', 'contacts', 'connection', 'logs'] as Tab[])" :key="t" role="tab" class="seg-item" :class="{ 'is-active': tab === t }" @click="tab = t">{{ t === 'send' ? 'test sender' : t }}</a>
          </div>
        </header>

        <div class="flex min-h-0 flex-1 flex-col space-y-4 overflow-y-auto p-6">
          <div v-if="selected.error" role="alert" class="alert alert-error alert-soft text-sm"><CatMood mood="error" class="size-7 shrink-0 -my-0.5" />{{ selected.error }}</div>
          <TaskStepper v-if="selected.task && !form" :task="selected.task" compact dismissable @dismiss="herd.taskDismiss('whatsapp', selected.engine)" />
          <a class="url-chip w-full" :title="`127.0.0.1:${selected.config.port} · click to copy`" @click="copy(selected.url!, 'URL copied')">
            <span class="badge badge-ghost badge-xs font-sans">API</span>
            <span class="truncate">{{ selected.url!.replace(/^https:\/\//, '') }}</span>
            <span class="ml-auto font-sans text-[10px] opacity-60">:{{ selected.config.port }}</span>
          </a>

          <!-- Sessions -->
          <div v-if="tab === 'sessions'" class="space-y-4">
            <div v-if="selected.status !== 'running'" class="alert alert-soft text-sm">{{ selected.name }} is {{ selected.status }}. Start it to link a phone.</div>
            <template v-else>
              <div class="overflow-x-auto rounded-box border border-base-300/60">
                <table class="table table-sm">
                  <thead><tr><th>Session</th><th>Status</th><th>Number</th><th class="text-right">Actions</th></tr></thead>
                  <tbody>
                    <tr v-for="s in selected.sessions" :key="s.name">
                      <td class="font-mono">{{ s.name }}</td>
                      <td><span class="badge badge-soft badge-sm" :class="SESSION_BADGE[s.status]">{{ s.status }}</span></td>
                      <td class="font-mono text-xs">{{ s.jid ? s.jid.split('@')[0] : '—' }}<span v-if="s.pushName" class="ml-1 font-sans opacity-60">{{ s.pushName }}</span></td>
                      <td class="text-right whitespace-nowrap">
                        <button v-if="s.status !== 'connected'" class="btn btn-primary btn-xs" @click="link(selected, s.name)">Link a phone (QR)</button>
                        <button v-else class="btn btn-ghost btn-xs" @click="confirmLogout = { s: selected, name: s.name, remove: false }">Log out</button>
                        <button class="btn btn-ghost btn-xs" title="Remove the session" @click="confirmLogout = { s: selected, name: s.name, remove: true }">Remove</button>
                      </td>
                    </tr>
                    <tr v-if="!selected.sessions.length">
                      <td colspan="4" class="py-5 text-center text-xs opacity-60">No session yet. Add one below and scan the QR with WhatsApp → Linked devices.</td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <form class="flex flex-wrap items-center gap-2" @submit.prevent="addSession(selected)">
                <input v-model="newSession" class="input input-sm w-48 font-mono" placeholder="default" pattern="[A-Za-z0-9_-]+" spellcheck="false" />
                <button class="btn btn-sm" :disabled="!newSession.trim()">Add session</button>
                <span class="text-xs opacity-60">One session = one linked phone. Sites pick it with <code>WHATSAPP_SESSION</code>.</span>
              </form>
              <div v-if="qr" class="card">
                <div class="card-body items-center text-center">
                  <h2>Scan with WhatsApp</h2>
                  <p class="text-xs opacity-60">WhatsApp → Settings → Linked devices → Link a device. The code refreshes by itself; session <code>{{ qr.name }}</code>.</p>
                  <img v-if="qr.image" :src="qr.image" alt="QR code" class="size-56 rounded-box bg-white p-2 ring-1 ring-base-content/10" />
                  <div v-else class="grid size-56 place-items-center rounded-box bg-base-200 text-xs opacity-60">
                    <span v-if="selected.sessions.find((x) => x.name === qr!.name)?.status === 'starting'" class="loading loading-spinner" />
                    <span v-else>No QR right now (the session may be starting, or already linked). It retries in a moment.</span>
                  </div>
                  <div class="flex gap-2">
                    <button class="btn btn-sm" @click="refreshQr">Refresh</button>
                    <button class="btn btn-ghost btn-sm" @click="closeQr">Close</button>
                  </div>
                </div>
              </div>
              <div class="alert alert-warning alert-soft text-xs"><CatMood mood="warning" class="size-7 shrink-0 -my-0.5" />Unofficial gateway: link a test number you can afford to lose; WhatsApp may ban numbers that automate messages.</div>
            </template>
          </div>

          <!-- Test sender -->
          <div v-else-if="tab === 'send'" class="space-y-4">
            <div v-if="!selected.sessions.some((x) => x.status === 'connected')" class="alert alert-soft text-sm">Link a phone on the Sessions tab first.</div>
            <form class="card" @submit.prevent="doSend(selected)">
              <div class="card-body">
                <h2>Send a message</h2>
                <div class="grid gap-3 sm:grid-cols-3">
                  <label class="block">
                    <span class="label-caps mb-1 block">Session</span>
                    <select v-model="send.session" class="select select-sm w-full font-mono">
                      <option value="">{{ selected.sessions[0]?.name ?? 'default' }}</option>
                      <option v-for="s in selected.sessions.slice(1)" :key="s.name" :value="s.name">{{ s.name }}</option>
                    </select>
                  </label>
                  <label class="block sm:col-span-2">
                    <span class="label-caps mb-1 block">To</span>
                    <input v-model="send.to" class="input input-sm w-full font-mono" placeholder="6281234567890 or a group id (…@g.us)" required spellcheck="false" />
                  </label>
                  <label class="block">
                    <span class="label-caps mb-1 block">Kind</span>
                    <select v-model="send.kind" class="select select-sm w-full">
                      <option value="text">Text</option>
                      <option value="image">Image</option>
                      <option value="document">Document</option>
                    </select>
                  </label>
                  <label v-if="send.kind !== 'text'" class="block sm:col-span-2">
                    <span class="label-caps mb-1 block">File</span>
                    <div class="join w-full">
                      <input v-model="send.file" class="input input-sm join-item w-full font-mono text-xs" placeholder="/path/to/file" spellcheck="false" />
                      <button type="button" class="btn btn-sm join-item" @click="pickFile">Choose…</button>
                    </div>
                  </label>
                  <label class="block sm:col-span-3">
                    <span class="label-caps mb-1 block">{{ send.kind === 'text' ? 'Message' : 'Caption' }}</span>
                    <textarea v-model="send.text" rows="3" class="textarea textarea-sm w-full" />
                  </label>
                </div>
                <div class="flex items-center gap-2">
                  <button class="btn btn-primary btn-sm" :disabled="sending || selected.status !== 'running'"><span v-if="sending" class="loading loading-spinner loading-xs" />Send</button>
                  <span class="text-xs opacity-60">Goes through {{ selected.name }}'s API exactly as a site would send it.</span>
                </div>
              </div>
            </form>
            <div v-if="sent" class="card">
              <div class="card-body">
                <div class="flex items-center gap-2">
                  <h2 class="flex-1">The API request it made</h2>
                  <span class="badge badge-soft badge-sm" :class="sent.status < 300 ? 'badge-success' : 'badge-error'">HTTP {{ sent.status }}</span>
                </div>
                <pre class="selectable overflow-x-auto rounded-box bg-base-200/70 p-3 font-mono text-xs leading-5">{{ sent.request.method }} {{ sent.request.url }}
{{ selected.engine === 'gowa' ? `Authorization: Basic ${selected.config.apiUser || 'devcatz'}:••••` : 'X-Api-Key: ••••' }}

{{ sent.request.body }}</pre>
                <span class="label-caps">Response</span>
                <pre class="selectable max-h-64 overflow-auto rounded-box bg-base-200/70 p-3 font-mono text-xs leading-5">{{ pretty(sent.response) }}</pre>
              </div>
            </div>
          </div>

          <!-- Contacts -->
          <div v-else-if="tab === 'contacts'" class="space-y-4">
            <div class="flex flex-wrap items-center gap-2">
              <button class="btn btn-sm" :disabled="selected.status !== 'running'" @click="loadContacts(selected)">{{ contactsLoaded ? 'Reload' : 'Load contacts and groups' }}</button>
              <input v-model="contactFilter" class="input input-sm w-56" placeholder="Filter…" />
              <span class="text-xs opacity-60">From the linked phone ({{ send.session || selected.sessions[0]?.name || 'default' }}). Click one to use it in the test sender.</span>
            </div>
            <div class="grid gap-4 lg:grid-cols-2">
              <div class="card">
                <div class="card-body card-table">
                  <div class="card-head"><h2>Contacts</h2><span class="ml-auto text-xs opacity-60">{{ contacts.length }}</span></div>
                  <div class="max-h-[28rem] overflow-auto">
                    <table class="table table-sm">
                      <tbody>
                        <tr v-for="c in filteredContacts" :key="c.id" class="cursor-pointer hover:bg-base-200/50" @click="useContact(c)">
                          <td>{{ c.name }}</td>
                          <td class="text-right font-mono text-xs opacity-60">{{ c.id.split('@')[0] }}</td>
                        </tr>
                        <tr v-if="!contacts.length"><td colspan="2" class="py-5 text-center text-xs opacity-60">{{ contactsLoaded ? 'No contacts' : 'Not loaded yet' }}</td></tr>
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
              <div class="card">
                <div class="card-body card-table">
                  <div class="card-head"><h2>Groups</h2><span class="ml-auto text-xs opacity-60">{{ groups.length }}</span></div>
                  <div class="max-h-[28rem] overflow-auto">
                    <table class="table table-sm">
                      <tbody>
                        <tr v-for="g in groups" :key="g.id" class="cursor-pointer hover:bg-base-200/50" @click="useContact(g)">
                          <td>{{ g.name }}<span v-if="g.members" class="ml-1 text-xs opacity-60">· {{ g.members }} members</span></td>
                          <td class="text-right font-mono text-xs opacity-60">{{ g.id }}</td>
                        </tr>
                        <tr v-if="!groups.length"><td colspan="2" class="py-5 text-center text-xs opacity-60">{{ contactsLoaded ? 'No groups' : 'Not loaded yet' }}</td></tr>
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <!-- Connection / settings -->
          <div v-else-if="tab === 'connection'" class="space-y-4">
            <div class="card">
              <div class="card-body">
                <h2>Connection</h2>
                <div class="grid gap-2 text-sm sm:grid-cols-2">
                  <div><span class="label-caps block">API (HTTPS)</span><code class="selectable">{{ selected.url }}</code></div>
                  <div><span class="label-caps block">Local</span><code class="selectable">{{ selected.apiLocal }}</code></div>
                  <div>
                    <span class="label-caps block">{{ selected.engine === 'gowa' ? 'Basic auth' : 'X-Api-Key' }}</span>
                    <code class="selectable">{{ selected.engine === 'gowa' ? `${selected.config.apiUser || 'devcatz'}:` : '' }}{{ showKey ? selected.config.apiKey : '••••••••' }}</code>
                    <button class="btn btn-ghost btn-xs ml-1" @click="showKey = !showKey">{{ showKey ? 'Hide' : 'Show' }}</button>
                    <button class="btn btn-ghost btn-xs" @click="copy(selected.config.apiKey, 'API key copied')">Copy</button>
                  </div>
                  <div v-if="selected.engine === 'waha'"><span class="label-caps block">Dashboard / Swagger user</span><code class="selectable">{{ selected.config.apiUser || 'devcatz' }}</code></div>
                  <div><span class="label-caps block">Default session</span><code class="selectable">{{ selected.sessions[0]?.name ?? 'default' }}</code></div>
                  <div><span class="label-caps block">Data folder</span><code class="selectable text-xs">{{ selected.config.dataDir }}</code></div>
                  <div><span class="label-caps block">Autostart</span>{{ selected.config.autoStart ? 'with DevCatz' : 'off' }}</div>
                </div>
                <div class="flex flex-wrap gap-2">
                  <button class="btn btn-sm" @click="form = { service: selected, mode: 'edit' }">Settings…</button>
                  <button class="btn btn-ghost btn-sm" @click="H.waOpenData(selected.engine)">Open data folder</button>
                  <button class="btn btn-ghost btn-sm" :disabled="checking" @click="checkUpdates"><span v-if="checking" class="loading loading-spinner loading-xs" />Check for updates</button>
                  <button class="btn btn-ghost btn-sm text-error" @click="removing = selected">Uninstall…</button>
                </div>
              </div>
            </div>
            <div class="card">
              <div class="card-body">
                <h2>Write to .env</h2>
                <p class="text-xs opacity-60">Point a site at {{ selected.name }}: its API on 127.0.0.1, the key, the session, and the site's webhook secret.</p>
                <WaEnvWriter :key="selected.engine" :engine="selected.engine" />
              </div>
            </div>
            <div class="card">
              <div class="card-body">
                <h2>API notes</h2>
                <ul class="list-inside list-disc space-y-1 text-sm opacity-70">
                  <template v-if="selected.engine === 'gowa'">
                    <li><code>POST /send/message</code> {phone, message} with header <code>X-Device-Id: &lt;session&gt;</code>; <code>/send/image</code> and <code>/send/file</code> take multipart form data.</li>
                    <li>Numbers as <code>6281234567890@s.whatsapp.net</code>, groups as <code>…@g.us</code>. Full reference in the web UI (OpenAPI).</li>
                    <li>Webhooks: DevCatz receives every event (signed with the API key) and forwards it to the sites on the Webhooks page.</li>
                  </template>
                  <template v-else>
                    <li><code>POST /api/sendText</code> {session, chatId, text}; <code>/api/sendImage</code> and <code>/api/sendFile</code> take {file: {mimetype, filename, data}}.</li>
                    <li>Numbers as <code>6281234567890@c.us</code>, groups as <code>…@g.us</code>. Swagger at <code>{{ selected.url }}/</code> (user {{ selected.config.apiUser || 'devcatz' }}, the API key as password).</li>
                    <li>Webhooks: WAHA posts <code>message.any</code>, acks, reactions and session status to DevCatz, which forwards them to the sites on the Webhooks page.</li>
                  </template>
                </ul>
              </div>
            </div>
          </div>

          <div v-else-if="tab === 'logs'" class="min-h-[24rem] flex-1">
            <LogView :key="selected.engine" :project-id="`wa:${selected.engine}`" />
          </div>
        </div>
      </template>

      <!-- Inspector -->
      <template v-else-if="page === 'inspector'">
        <header class="drag win-top border-b border-base-300/60 px-6 pt-5 pb-4">
          <div class="flex flex-wrap items-center gap-3">
            <div class="min-w-0 flex-1">
              <h2 class="text-lg font-semibold tracking-tight">Inspector</h2>
              <div class="text-xs opacity-60">Every message the engines reported (webhook) and every test message sent · {{ messages.length }} kept</div>
            </div>
            <input v-model="msgFilter" class="input input-sm no-drag w-56" placeholder="Filter…" />
            <button class="btn btn-ghost btn-sm no-drag" :disabled="!messages.length" @click="clearing = true">Clear</button>
          </div>
        </header>
        <div class="flex min-h-0 flex-1">
          <div class="min-w-0 flex-1 overflow-auto">
            <table class="table table-sm table-pin-rows">
              <thead><tr><th>Time</th><th>Dir</th><th>Engine · session</th><th>From / to</th><th>Message</th><th>Event</th></tr></thead>
              <tbody>
                <tr v-for="m in filteredMessages" :key="m.id" class="cursor-pointer hover:bg-base-200/50" :class="{ 'bg-base-200/70': openMsg?.id === m.id }" @click="openMsg = m">
                  <td class="font-mono text-xs whitespace-nowrap opacity-70" :title="m.at">{{ when(m.at) }}</td>
                  <td><span class="badge badge-soft badge-xs" :class="m.direction === 'in' ? 'badge-success' : 'badge-info'">{{ m.direction }}</span></td>
                  <td class="text-xs whitespace-nowrap">{{ m.engine }} · <span class="font-mono">{{ m.session }}</span></td>
                  <td class="max-w-48 truncate font-mono text-xs" :title="(m.direction === 'in' ? m.from : m.to) ?? ''">{{ m.fromName ?? '' }} <span class="opacity-60">{{ (m.direction === 'in' ? m.from : m.to)?.split('@')[0] ?? '' }}</span></td>
                  <td class="max-w-md truncate" :title="m.body">{{ m.body }}</td>
                  <td class="text-xs whitespace-nowrap opacity-60">{{ m.event }}<span v-if="m.kind !== 'text'" class="ml-1 badge badge-ghost badge-xs">{{ m.kind }}</span></td>
                </tr>
                <tr v-if="!filteredMessages.length">
                  <td colspan="6" class="py-10 text-center text-xs opacity-60">Nothing yet. Messages received by a linked phone, and ones sent through the engines, appear here live.</td>
                </tr>
              </tbody>
            </table>
          </div>
          <aside v-if="openMsg" class="flex w-[26rem] shrink-0 flex-col border-l border-base-300/60 bg-base-200/40">
            <div class="flex items-center gap-2 border-b border-base-300/60 px-4 py-2">
              <span class="label-caps flex-1">{{ openMsg.event }} · {{ whenFull(openMsg.at) }}</span>
              <button class="btn btn-ghost btn-xs" @click="copy(pretty(openMsg.raw), 'JSON copied')">Copy JSON</button>
              <button class="btn btn-ghost btn-xs btn-square" @click="openMsg = null">✕</button>
            </div>
            <pre class="selectable min-h-0 flex-1 overflow-auto p-4 font-mono text-xs leading-5">{{ pretty(openMsg.raw) }}</pre>
          </aside>
        </div>
      </template>

      <!-- Webhooks -->
      <template v-else-if="page === 'webhooks'">
        <header class="drag win-top border-b border-base-300/60 px-6 pt-5 pb-4">
          <div class="flex flex-wrap items-center gap-3">
            <div class="min-w-0 flex-1">
              <h2 class="text-lg font-semibold tracking-tight">Webhooks to sites</h2>
              <div class="text-xs opacity-60">The engines' events, forwarded to a site's URL with an HMAC signature · deliveries logged, Replay after a code change</div>
            </div>
            <button class="btn btn-primary btn-sm no-drag" :disabled="!sites.length" @click="hookForm = { siteId: sites[0]?.id ?? '', url: hookUrlFor(sites[0]?.id ?? ''), events: '', enabled: true }">Add webhook…</button>
          </div>
        </header>
        <div class="flex min-h-0 flex-1 flex-col space-y-4 overflow-y-auto p-6">
          <form v-if="hookForm" class="card" @submit.prevent="saveHook">
            <div class="card-body">
              <h2>{{ hookForm.id ? 'Edit webhook' : 'New webhook' }}</h2>
              <div class="grid gap-3 sm:grid-cols-2">
                <label class="block">
                  <span class="label-caps mb-1 block">Site</span>
                  <select v-model="hookForm.siteId" class="select select-sm w-full" @change="hookForm!.url = hookUrlFor(hookForm!.siteId)">
                    <option v-for="p in sites" :key="p.id" :value="p.id">{{ p.name }} · {{ p.domain }}</option>
                  </select>
                </label>
                <label class="block">
                  <span class="label-caps mb-1 block">Events (empty = all)</span>
                  <input v-model="hookForm.events" class="input input-sm w-full font-mono" placeholder="message, message.any, session.status" spellcheck="false" />
                </label>
                <label class="block sm:col-span-2">
                  <span class="label-caps mb-1 block">URL</span>
                  <input v-model="hookForm.url" class="input input-sm w-full font-mono" required spellcheck="false" />
                </label>
                <label class="flex cursor-pointer items-center gap-3"><input v-model="hookForm.enabled" type="checkbox" class="toggle toggle-sm" /><span class="text-sm">Enabled</span></label>
              </div>
              <div class="flex gap-2">
                <button class="btn btn-primary btn-sm">Save</button>
                <button type="button" class="btn btn-ghost btn-sm" @click="hookForm = null">Cancel</button>
              </div>
            </div>
          </form>
          <div class="card">
            <div class="card-body card-table">
              <div class="card-head"><h2>Webhooks</h2><span class="ml-auto text-xs opacity-60">{{ hooks.length }}</span></div>
              <div class="overflow-x-auto">
                <table class="table table-sm">
                  <thead><tr><th>Site</th><th>URL</th><th>Events</th><th class="text-right">Deliveries</th><th>Last</th><th></th></tr></thead>
                  <tbody>
                    <tr v-for="h in hooks" :key="h.id" class="cursor-pointer hover:bg-base-200/50" :class="{ 'bg-base-200/70': hookSel === h.id, 'opacity-50': !h.enabled }" @click="hookSel = h.id">
                      <td class="font-medium whitespace-nowrap">{{ h.siteName }}</td>
                      <td class="max-w-xs truncate font-mono text-xs" :title="h.url">{{ h.url }}</td>
                      <td class="font-mono text-xs">{{ h.events.length ? h.events.join(', ') : 'all' }}</td>
                      <td class="text-right font-mono text-xs tabular-nums">{{ h.deliveries }}</td>
                      <td class="font-mono text-xs" :class="h.lastStatus === null ? '' : STATUS(h.lastStatus)">{{ h.lastAt ? `${h.lastStatus ?? 'error'} · ${when(h.lastAt)}` : '—' }}</td>
                      <td class="text-right whitespace-nowrap">
                        <button class="btn btn-ghost btn-xs" @click.stop="toggleHook(h)">{{ h.enabled ? 'Disable' : 'Enable' }}</button>
                        <button class="btn btn-ghost btn-xs" @click.stop="hookForm = { id: h.id, siteId: h.siteId, url: h.url, events: h.events.join(', '), enabled: h.enabled }">Edit</button>
                        <button class="btn btn-ghost btn-xs" @click.stop="copy(h.secret, 'Secret copied')">Secret</button>
                        <button class="btn btn-ghost btn-xs" @click.stop="emit('openSite', h.siteId)">Site</button>
                        <button class="btn btn-ghost btn-xs text-error" @click.stop="removingHook = h">Remove</button>
                      </td>
                    </tr>
                    <tr v-if="!hooks.length"><td colspan="6" class="py-6 text-center text-xs opacity-60">No webhook yet. Add one: the site gets every event as JSON (POST) with <code>X-DevCatz-Signature: sha256=HMAC(secret, body)</code>.</td></tr>
                  </tbody>
                </table>
              </div>
            </div>
          </div>
          <div v-if="hook" class="card">
            <div class="card-body card-table">
              <div class="card-head">
                <h2>Deliveries to {{ hook.siteName }}</h2>
                <span class="ml-auto text-xs opacity-60">last {{ deliveries.length }}</span>
              </div>
              <div class="flex min-h-0">
                <div class="min-w-0 flex-1 overflow-x-auto">
                  <table class="table table-sm">
                    <thead><tr><th>Time</th><th>Event</th><th>Status</th><th class="text-right">ms</th><th></th></tr></thead>
                    <tbody>
                      <tr v-for="d in deliveries" :key="d.id" class="cursor-pointer hover:bg-base-200/50" :class="{ 'bg-base-200/70': openDelivery?.id === d.id }" @click="openDelivery = d">
                        <td class="font-mono text-xs whitespace-nowrap opacity-70">{{ when(d.at) }}<span v-if="d.replay" class="ml-1 badge badge-ghost badge-xs">replay</span></td>
                        <td class="font-mono text-xs">{{ d.engine }} · {{ d.event }}</td>
                        <td class="font-mono text-xs" :class="STATUS(d.status)">{{ d.status ?? d.error }}</td>
                        <td class="text-right font-mono text-xs tabular-nums">{{ d.ms }}</td>
                        <td class="text-right"><button class="btn btn-ghost btn-xs" @click.stop="replay(d)">Replay</button></td>
                      </tr>
                      <tr v-if="!deliveries.length"><td colspan="5" class="py-6 text-center text-xs opacity-60">Nothing delivered yet.</td></tr>
                    </tbody>
                  </table>
                </div>
                <aside v-if="openDelivery" class="w-[24rem] shrink-0 border-l border-base-300/60">
                  <div class="flex items-center gap-2 border-b border-base-300/60 px-3 py-2">
                    <span class="label-caps flex-1">{{ openDelivery.event }} → {{ openDelivery.status ?? openDelivery.error }}</span>
                    <button class="btn btn-ghost btn-xs btn-square" @click="openDelivery = null">✕</button>
                  </div>
                  <div class="px-3 pt-2 label-caps">Body sent</div>
                  <pre class="selectable max-h-64 overflow-auto px-3 py-2 font-mono text-xs leading-5">{{ pretty(openDelivery.body) }}</pre>
                  <div class="px-3 pt-2 label-caps">Response</div>
                  <pre class="selectable max-h-40 overflow-auto px-3 py-2 font-mono text-xs leading-5">{{ openDelivery.response ?? openDelivery.error ?? '(none)' }}</pre>
                </aside>
              </div>
            </div>
          </div>
          <p class="text-xs opacity-60">
            Headers on every delivery: <code>X-DevCatz-Engine</code>, <code>X-DevCatz-Event</code>, <code>X-DevCatz-Delivery</code> and <code>X-DevCatz-Signature</code>. The site's own
            HTTPS certificate (DevCatz's CA) is accepted. The secret is also written as <code>WHATSAPP_WEBHOOK_SECRET</code> by Write to .env.
          </p>
        </div>
      </template>
    </main>

    <WaForm v-if="form" :service="engines.find((x) => x.engine === form!.service.engine) ?? form.service" :mode="form.mode" @close="form = null" @done="form = null" />
    <ServiceUninstall
      v-if="removing?.config"
      :name="removing.name"
      :host="`${removing.config.domain}.${tld}`"
      :data-dir="removing.config.dataDir"
      data-what="Its sessions (linked phones) and received media"
      impact="Sites pointing at it cannot send WhatsApp messages until it is installed again."
      :run="uninstallRun"
      @close="removing = null"
    />
    <ConfirmDialog v-if="confirmLogout" :title="confirmLogout.remove ? `Remove session ${confirmLogout.name}?` : `Log out ${confirmLogout.name}?`" :text="confirmLogout.remove ? 'The phone is unlinked and the session is deleted from the engine.' : 'The phone is unlinked; scan a QR again to reconnect.'" :confirm="confirmLogout.remove ? 'Remove' : 'Log out'" tone="warning" @cancel="confirmLogout = null" @ok="logoutSession" />
    <ConfirmDialog v-if="clearing" title="Clear the inspector?" text="Every kept message is removed from DevCatz (the engines keep their own history)." confirm="Clear" tone="warning" @cancel="clearing = false" @ok="clearMessages" />
    <ConfirmDialog v-if="removingHook" :title="`Remove the webhook to ${removingHook.siteName}?`" :text="`${removingHook.url} stops receiving events; its deliveries are forgotten.`" confirm="Remove" tone="warning" @cancel="removingHook = null" @ok="removeHook" />
  </div>
</template>
