<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import type { CaughtSms, GwKind, GwSendResult, GwState } from '@shared/types';
import { GW_CATEGORY_LABEL, GW_LOGO } from '../gateways';
import StatusDot from './StatusDot.vue';
import LogView from './LogView.vue';
import TaskStepper from './TaskStepper.vue';
import ServiceUninstall from './ServiceUninstall.vue';
import GwForm from './GwForm.vue';
import GwEnvWriter from './GwEnvWriter.vue';
import ConfirmDialog from './ConfirmDialog.vue';
import PopMenu, { type MenuItem } from './PopMenu.vue';
import { attempt, herd, navRequest, notify, state, uninstallRequest } from '../store';
import CatMood from './CatMood.vue';

/**
 * One email / push / SMS gateway on the Gateways page: install, start / stop,
 * connection details, a test sender (email, notification, SMS) showing the
 * request it made, the SMS catcher (Jasmin), Write to .env and logs.
 */
const props = defineProps<{ kind: GwKind }>();
const H = herd;
const tld = computed(() => state.value?.settings.tld ?? 'localhost');
const g = computed<GwState | null>(() => state.value?.gateways.find((x) => x.kind === props.kind) ?? null);
const active = (s: GwState) => s.status === 'running' || s.status === 'starting';
type Tab = 'overview' | 'send' | 'sms' | 'logs';
const tab = ref<Tab>('overview');
watch(
  () => props.kind,
  () => {
    tab.value = 'overview';
    sent.value = null;
    send.value = defaultsFor(props.kind);
  },
);
const form = ref<{ service: GwState; mode: 'install' | 'edit' } | null>(null);
const removing = ref<GwState | null>(null);

// Ask DevCatz's "Uninstall …" opens this page's own dialog (with its typed confirmation); nothing is removed without it.
watch(
  uninstallRequest,
  (r) => {
    if (r?.scope !== 'gateway') return;
    uninstallRequest.value = null;
    const s = r.id === props.kind && g.value?.installed ? g.value : null;
    if (s) {
      removing.value = s;
    }
  },
  { immediate: true },
);
const busy = ref<string | null>(null);
async function act(s: GwState, action: 'start' | 'stop' | 'restart') {
  busy.value = action;
  await attempt(() => herd.gwAction(s.kind, action).then(() => true));
  busy.value = null;
}
const uninstallRun = (deleteData: boolean, typed: string) => herd.gwUninstall(removing.value!.kind, deleteData, typed);
const updating = (s: GwState) => s.task?.kind === 'update' && !s.task.done && !s.task.error;
const checking = ref(false);
async function checkUpdates() {
  checking.value = true;
  const failed = await attempt(() => herd.gwCheckUpdates());
  checking.value = false;
  if (!failed || !g.value) return;
  if (failed.includes(g.value.name)) notify('error', `Could not check ${g.value.name} for updates (offline or rate-limited; try again later)`);
  else notify('info', g.value.update ? `${g.value.name} ${g.value.update} is available` : `${g.value.name} is up to date`);
}
const moreItems = computed<MenuItem[]>(() => {
  const s = g.value;
  if (!s?.installed) return [];
  return [
    ...(s.webPath ? [{ label: 'Open web UI', action: () => herd.openUrl(s.url! + s.webPath) }] : []),
    { label: 'Open data folder', action: () => herd.gwOpenData(s.kind) },
    { label: 'Check for updates', action: checkUpdates },
    { label: 'Settings…', action: () => (form.value = { service: s, mode: 'edit' }) },
    { label: 'Uninstall…', action: () => (removing.value = s) },
  ];
});
const shown = ref<Set<string>>(new Set());
const toggleShow = (label: string) => {
  const next = new Set(shown.value);
  if (next.has(label)) next.delete(label);
  else next.add(label);
  shown.value = next;
};
async function copy(v: string, what = 'Copied') {
  await navigator.clipboard.writeText(v).catch(() => undefined);
  notify('info', what);
}

// ---- test sender
const defaultsFor = (kind: GwKind) =>
  kind === 'stalwart' || kind === 'postal'
    ? { to: 'someone@example.com', subject: 'Hello from DevCatz', text: 'This mail went through the gateway and landed in the DevCatz mail catcher.', from: '' }
    : kind === 'jasmin'
      ? { to: '6281234567890', subject: '', text: 'DevCatz: your code is 123456', from: 'DevCatz' }
      : kind === 'telegram'
        ? { to: '', subject: '', text: 'Hello from DevCatz 👋', from: '' }
        : kind === 'gotify'
        ? { to: '5', subject: 'DevCatz', text: 'Hello from DevCatz 👋', from: '' }
        : { to: 'devcatz', subject: 'DevCatz', text: 'Hello from DevCatz 👋', from: '' };
const send = ref(defaultsFor(props.kind));
const sent = ref<GwSendResult | null>(null);
const sending = ref(false);
async function doSend() {
  sending.value = true;
  const r = await attempt(() => herd.gwSend(props.kind, { ...send.value }));
  sending.value = false;
  if (!r) return;
  sent.value = r;
  const ok = r.status >= 200 && r.status < 300;
  notify(ok ? 'success' : 'error', ok ? (props.kind === 'jasmin' ? 'Sent: it shows in the SMS catcher' : g.value?.category === 'email' ? 'Sent: it shows in Mail in a moment' : 'Sent') : `The gateway answered ${r.status}`);
  if (ok && props.kind === 'jasmin') setTimeout(() => void loadSms(), 1500);
}
const toLabel = computed(() => ({ stalwart: 'To (email)', postal: 'To (email)', ntfy: 'Topic', gotify: 'Priority (0–10)', jasmin: 'To (phone number)', telegram: 'Chat ID (or @channel)' })[props.kind]);
const pretty = (raw: string) => {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
};

// ---- SMS catcher
const sms = ref<CaughtSms[]>([]);
const openSms = ref<CaughtSms | null>(null);
async function loadSms() {
  sms.value = (await herd.gwSms(300).catch(() => [])) ?? [];
}
let smsTimer: ReturnType<typeof setInterval> | null = null;
watch(
  [() => props.kind, tab],
  () => {
    if (smsTimer) clearInterval(smsTimer);
    smsTimer = null;
    if (props.kind === 'jasmin') {
      void loadSms();
      smsTimer = setInterval(() => void loadSms(), 3000);
    }
  },
  { immediate: true },
);
onBeforeUnmount(() => smsTimer && clearInterval(smsTimer));
const clearing = ref(false);
async function clearSms() {
  clearing.value = false;
  await attempt(() => herd.gwClearSms().then(() => true), 'SMS catcher cleared');
  await loadSms();
}
const when = (iso: string) => new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
const openMail = () => (navRequest.value = { section: 'mail' });
</script>

<template>
  <template v-if="g && !g.installed">
    <header class="drag win-top border-b border-base-300/60 px-6 pt-5 pb-4">
      <div class="flex items-center gap-3">
        <img :src="GW_LOGO[g.kind]" alt="" class="size-11 rounded-xl bg-white p-1 ring-1 ring-base-content/10" draggable="false" />
        <div class="min-w-0">
          <h2 class="text-lg font-semibold tracking-tight">{{ g.name }}</h2>
          <div class="text-xs opacity-60">Not installed · {{ GW_CATEGORY_LABEL[g.category] }} · {{ g.docker ? 'Docker' : 'a single binary' }}</div>
        </div>
      </div>
    </header>
    <div class="flex-1 overflow-y-auto p-6">
      <div class="mx-auto max-w-xl space-y-4 pt-6">
        <p class="text-sm opacity-70">{{ g.description }}</p>
        <TaskStepper v-if="g.task && !form" :task="g.task" :cancellable="g.task.kind === 'install' && !g.task.done && !g.task.error" dismissable @cancel="H.gwCancelInstall(g.kind)" @dismiss="H.taskDismiss('gateway', g.kind)" />
        <button class="btn btn-primary" :disabled="!!g.task && !g.task.done && !g.task.error" @click="form = { service: g, mode: 'install' }">
          <span v-if="g.task && !g.task.done && !g.task.error" class="loading loading-spinner loading-xs" />Install {{ g.name }}…
        </button>
        <p class="text-xs opacity-60">
          <template v-if="g.category === 'email'">Everything it sends goes to the DevCatz mail catcher (Mail page), so real inboxes are never reached.</template>
          <template v-else-if="g.kind === 'jasmin'">Every SMS goes to the DevCatz SMS catcher, shown on this page; no operator account is needed.</template>
          <template v-else>Phones and browsers on this Mac's network can subscribe through the domain (Expose it for devices outside).</template>
        </p>
      </div>
    </div>
  </template>

  <template v-else-if="g?.installed && g.config">
    <header class="drag win-top border-b border-base-300/60 px-6 pt-5 pb-3">
      <div class="flex flex-wrap items-center gap-3">
        <img :src="GW_LOGO[g.kind]" alt="" class="size-11 rounded-xl bg-white p-1 ring-1 ring-base-content/10" draggable="false" />
        <div class="min-w-0 flex-1">
          <h2 class="flex items-center gap-2 text-lg font-semibold tracking-tight">
            {{ g.name }}
            <StatusDot :status="g.status" />
            <span class="badge badge-soft badge-sm" :class="g.status === 'running' ? 'badge-success' : g.status === 'starting' ? 'badge-warning' : g.status === 'crashed' ? 'badge-error' : 'badge-ghost'">{{ g.status }}</span>
            <span class="badge badge-ghost badge-sm font-mono">{{ g.config.version }}</span>
            <button v-if="g.update" class="btn btn-primary btn-xs" :disabled="!!g.task && !g.task.done && !g.task.error" @click="attempt(() => H.gwUpgrade(g!.kind).then(() => true), `${g!.name} updated`)">
              <span v-if="updating(g)" class="loading loading-spinner loading-xs" />Update to {{ g.update }}
            </button>
          </h2>
          <div class="text-xs opacity-60">{{ GW_CATEGORY_LABEL[g.category] }} · 127.0.0.1:{{ g.config.port }}{{ g.docker ? ' · Docker' : '' }}{{ g.config.autoStart ? ' · starts with DevCatz' : '' }}</div>
        </div>
        <div class="flex shrink-0 flex-wrap items-center gap-2">
          <button v-if="!active(g)" class="btn btn-primary btn-sm" :disabled="!!busy" @click="act(g, 'start')"><span v-if="busy === 'start'" class="loading loading-spinner loading-xs" />Start</button>
          <button v-else class="btn btn-sm" :disabled="!!busy || g.status === 'stopping'" @click="act(g, 'stop')">Stop</button>
          <button class="btn btn-sm" :disabled="!!busy || !active(g)" @click="act(g, 'restart')">Restart</button>
          <PopMenu :items="moreItems" align="end" :width="220">
            <button class="btn btn-sm">More ▾</button>
          </PopMenu>
        </div>
      </div>
      <div role="tablist" class="seg no-drag mt-3">
        <a role="tab" class="seg-item" :class="{ 'is-active': tab === 'overview' }" @click="tab = 'overview'">Overview</a>
        <a role="tab" class="seg-item" :class="{ 'is-active': tab === 'send' }" @click="tab = 'send'">Test sender</a>
        <a v-if="g.kind === 'jasmin'" role="tab" class="seg-item" :class="{ 'is-active': tab === 'sms' }" @click="tab = 'sms'">SMS catcher <span v-if="sms.length" class="badge badge-ghost badge-xs">{{ sms.length }}</span></a>
        <a role="tab" class="seg-item" :class="{ 'is-active': tab === 'logs' }" @click="tab = 'logs'">Logs</a>
      </div>
    </header>

    <div class="flex min-h-0 flex-1 flex-col space-y-4 overflow-y-auto p-6">
      <div v-if="g.error" role="alert" class="alert alert-error alert-soft text-sm"><CatMood mood="error" class="size-7 shrink-0 -my-0.5" />{{ g.error }}</div>
      <TaskStepper v-if="g.task && !form" :task="g.task" compact dismissable @dismiss="H.taskDismiss('gateway', g.kind)" />
      <div v-if="g.status === 'starting' && !g.config.setupDone" class="alert alert-soft text-sm">
        <span class="loading loading-spinner loading-xs" />First start: {{ g.name }} is being set up (users, keys{{ g.kind === 'postal' ? ', database' : '' }}). This can take a minute{{ g.kind === 'postal' || g.kind === 'jasmin' ? ' or two (Intel image under emulation)' : '' }}; the Logs tab shows the progress.
      </div>

      <template v-if="tab === 'overview'">
        <a class="url-chip w-full" :title="`127.0.0.1:${g.config.port} · click to copy`" @click="copy(g.url!, 'URL copied')">
          <span class="badge badge-ghost badge-xs font-sans">{{ g.kind === 'jasmin' || g.kind === 'telegram' ? 'API' : 'Web' }}</span>
          <span class="truncate">{{ g.url!.replace(/^https:\/\//, '') }}</span>
          <span class="ml-auto font-sans text-[10px] opacity-60">:{{ g.config.port }}</span>
        </a>
        <div class="card">
          <div class="card-body">
            <div class="flex items-center gap-2">
              <h2 class="flex-1">Connection</h2>
              <button v-if="g.webPath" class="btn btn-sm" :disabled="g.status !== 'running'" @click="H.openUrl(g.url! + g.webPath)">Open web UI</button>
            </div>
            <div class="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
              <div v-for="c in g.connection" :key="c.label" class="min-w-0">
                <span class="label-caps block">{{ c.label }}</span>
                <div class="flex items-center gap-1">
                  <code class="selectable truncate">{{ c.secret && !shown.has(c.label) ? '••••••••' : c.value }}</code>
                  <button v-if="c.secret" class="btn btn-ghost btn-xs" @click="toggleShow(c.label)">{{ shown.has(c.label) ? 'Hide' : 'Show' }}</button>
                  <button class="btn btn-ghost btn-xs" @click="copy(c.value, `${c.label} copied`)">Copy</button>
                </div>
              </div>
            </div>
            <p v-if="!g.config.setupDone" class="text-xs opacity-60">Keys and tokens appear after the first start.</p>
          </div>
        </div>
        <div class="card">
          <div class="card-body">
            <h2>Write to .env</h2>
            <p class="text-xs opacity-60">Point a site at {{ g.name }}; its Gateways tab shows the same lines.</p>
            <GwEnvWriter :key="g.kind" :kind="g.kind" />
          </div>
        </div>
        <div class="card">
          <div class="card-body">
            <h2>How sites use it</h2>
            <ul class="list-inside list-disc space-y-1 text-sm opacity-70">
              <template v-if="g.kind === 'stalwart'">
                <li>Send through SMTP submission <code>127.0.0.1:{{ g.config.ports.submission }}</code> as <code>devcatz</code> (no TLS on this Mac); mail to other domains lands in the DevCatz mail catcher.</li>
                <li>Mail to <code>…@devcatz.test</code> stays in Stalwart: read it over IMAP <code>127.0.0.1:{{ g.config.ports.imap }}</code> (reply-by-email and inbound flows).</li>
                <li>Accounts, domains and filters are managed in the web admin.</li>
              </template>
              <template v-else-if="g.kind === 'postal'">
                <li>HTTP API: <code>POST {{ g.url }}/api/v1/send/message</code> with <code>X-Server-API-Key</code>; or SMTP <code>127.0.0.1:{{ g.config.ports.smtp }}</code>.</li>
                <li>Sending domains are verified for you: devcatz.test and every site's domain (Write to .env adds a new site's).</li>
                <li>Webhooks, message history and tracking are in the web UI (organisation DevCatz, server Dev). Delivery goes to the mail catcher.</li>
              </template>
              <template v-else-if="g.kind === 'ntfy'">
                <li><code>POST {{ g.url }}/&lt;topic&gt;</code> with <code>Authorization: Bearer &lt;token&gt;</code>; the body is the message, <code>Title</code> / <code>Priority</code> / <code>Tags</code> headers add more.</li>
                <li>Phones: the ntfy app (Android / iOS), add server {{ g.url }} and log in; for devices outside this Mac, Expose the domain.</li>
              </template>
              <template v-else-if="g.kind === 'gotify'">
                <li><code>POST {{ g.url }}/message?token=&lt;app token&gt;</code> with JSON <code>{ title, message, priority }</code>.</li>
                <li>Receive in the web UI, the Gotify Android app, or over its WebSocket stream (<code>/stream</code>, client token).</li>
              </template>
              <template v-else-if="g.kind === 'telegram'">
                <li>Point your bot library at <code>http://127.0.0.1:{{ g.config.port }}</code> instead of <code>https://api.telegram.org</code>; methods are the same (<code>/bot&lt;token&gt;/sendMessage</code> …).</li>
                <li>Before a bot's first request here, call <code>logOut</code> once on api.telegram.org to move it to this server (it can move back after 10 minutes).</li>
                <li>Webhooks may use any local URL (<code>http://host.docker.internal:3000/…</code> reaches a site's dev server); files up to 2 GB.</li>
              </template>
              <template v-else>
                <li><code>GET http://127.0.0.1:{{ g.config.port }}/send?username=…&amp;password=…&amp;to=62812…&amp;content=…</code> (also POST); add <code>coding=8</code> for unicode.</li>
                <li>Messages go over SMPP to the DevCatz SMS catcher (<code>127.0.0.1:{{ g.config.ports.smpp }}</code>) and show in the SMS catcher tab.</li>
                <li>jCli (<code>telnet 127.0.0.1 {{ g.config.ports.jcli }}</code>, jcliadmin / jclipwd) manages users, routes and filters.</li>
              </template>
            </ul>
          </div>
        </div>
      </template>

      <template v-else-if="tab === 'send'">
        <div v-if="g.status !== 'running'" class="alert alert-soft text-sm">{{ g.name }} is {{ g.status }}. Start it to send.</div>
        <form class="card" @submit.prevent="doSend">
          <div class="card-body">
            <h2>{{ g.category === 'email' ? 'Send an email' : g.kind === 'jasmin' ? 'Send an SMS' : g.kind === 'telegram' ? 'Send a Telegram message' : 'Send a notification' }}</h2>
            <p v-if="g.kind === 'telegram'" class="text-xs opacity-60">
              Sent by your bot through this server. The chat ID is yours (message the bot first, then read it from <code>getUpdates</code>) or a group / channel the bot is in.
              <template v-if="!g.config.secrets.botToken"> Add the bot token in Settings… first.</template>
            </p>
            <div class="grid gap-3 sm:grid-cols-2">
              <label class="block">
                <span class="label-caps mb-1 block">{{ toLabel }}</span>
                <input v-model="send.to" class="input input-sm w-full font-mono" required spellcheck="false" />
              </label>
              <label v-if="g.category === 'email' || g.kind === 'jasmin'" class="block">
                <span class="label-caps mb-1 block">From {{ g.kind === 'jasmin' ? '(sender ID)' : '(optional)' }}</span>
                <input v-model="send.from" class="input input-sm w-full font-mono" :placeholder="g.kind === 'stalwart' ? 'devcatz@devcatz.test' : g.kind === 'postal' ? 'hello@devcatz.test' : 'DevCatz'" spellcheck="false" />
              </label>
              <label v-if="g.kind !== 'jasmin'" class="block" :class="{ 'sm:col-span-2': g.category === 'email' || g.kind === 'telegram' }">
                <span class="label-caps mb-1 block">{{ g.category === 'email' ? 'Subject' : 'Title' }}</span>
                <input v-model="send.subject" class="input input-sm w-full" />
              </label>
              <label class="block sm:col-span-2">
                <span class="label-caps mb-1 block">Message</span>
                <textarea v-model="send.text" rows="4" class="textarea textarea-sm w-full" />
                <span v-if="g.kind === 'jasmin'" class="mt-1 block text-xs opacity-60">{{ send.text.length }} characters · {{ /[^\x00-\x7f]/.test(send.text) ? 'unicode (70 per part)' : 'GSM (160 per part)' }}</span>
              </label>
            </div>
            <div class="flex flex-wrap items-center gap-2">
              <button class="btn btn-primary btn-sm" :disabled="sending || g.status !== 'running'"><span v-if="sending" class="loading loading-spinner loading-xs" />Send</button>
              <button v-if="g.category === 'email'" type="button" class="btn btn-ghost btn-sm" @click="openMail">Open Mail</button>
              <button v-if="g.kind === 'jasmin'" type="button" class="btn btn-ghost btn-sm" @click="tab = 'sms'">Open SMS catcher</button>
              <button v-if="g.webPath && g.category === 'push'" type="button" class="btn btn-ghost btn-sm" :disabled="g.status !== 'running'" @click="H.openUrl(g.url! + g.webPath)">Open web UI</button>
            </div>
          </div>
        </form>
        <div v-if="sent" class="card">
          <div class="card-body">
            <div class="flex items-center gap-2">
              <h2 class="flex-1">The request it made</h2>
              <span class="badge badge-soft badge-sm" :class="sent.status < 300 ? 'badge-success' : 'badge-error'">{{ sent.request.method === 'SMTP' ? `SMTP ${sent.status}` : `HTTP ${sent.status}` }}</span>
            </div>
            <pre class="selectable overflow-x-auto rounded-box bg-base-200/70 p-3 font-mono text-xs leading-5 whitespace-pre-wrap">{{ sent.request.method }} {{ sent.request.url }}{{ sent.request.body ? `\n\n${sent.request.body}` : '' }}</pre>
            <span class="label-caps">Response</span>
            <pre class="selectable max-h-64 overflow-auto rounded-box bg-base-200/70 p-3 font-mono text-xs leading-5 whitespace-pre-wrap">{{ pretty(sent.response) }}</pre>
          </div>
        </div>
      </template>

      <template v-else-if="tab === 'sms'">
        <div class="card">
          <div class="card-body card-table">
            <div class="card-head">
              <h2>SMS catcher</h2>
              <span class="badge badge-ghost badge-sm">{{ sms.length }}</span>
              <span class="text-xs opacity-60">newest first · live · SMPP 127.0.0.1:{{ g.config.ports.smpp }}</span>
              <span class="flex-1" />
              <button class="btn btn-ghost btn-xs" :disabled="!sms.length" @click="clearing = true">Clear</button>
            </div>
            <div class="overflow-x-auto">
              <table class="table table-sm">
                <thead><tr><th class="w-44">To</th><th class="w-32">From</th><th>Message</th><th class="w-36 text-right">At</th></tr></thead>
                <tbody>
                  <tr v-for="m in sms" :key="m.id" class="cursor-pointer hover:bg-base-200/50" @click="openSms = m">
                    <td class="font-mono text-xs">{{ m.to }}</td>
                    <td class="font-mono text-xs opacity-70">{{ m.from || '—' }}</td>
                    <td class="max-w-0"><div class="truncate">{{ m.text }}</div></td>
                    <td class="text-right font-mono text-xs whitespace-nowrap opacity-60">{{ when(m.at) }}</td>
                  </tr>
                  <tr v-if="!sms.length"><td colspan="4" class="py-10 text-center text-xs opacity-60">No SMS yet. Send one from the Test sender or from a site through Jasmin's HTTP API.</td></tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </template>

      <div v-else-if="tab === 'logs'" class="min-h-[24rem] flex-1">
        <LogView :key="g.kind" :project-id="`gw:${g.kind}`" />
      </div>
    </div>
  </template>

  <GwForm v-if="form" :service="state?.gateways.find((x) => x.kind === form!.service.kind) ?? form.service" :mode="form.mode" @close="form = null" @done="form = null" />
  <ServiceUninstall
    v-if="removing?.config"
    :name="removing.name"
    :host="`${removing.config.domain}.${tld}`"
    :data-dir="removing.config.dataDir"
    :data-what="removing.category === 'email' ? 'Its mailboxes, messages and settings' : removing.kind === 'jasmin' ? 'Its users, routes and queues' : 'Its users, tokens and messages'"
    impact="Sites pointing at it stop sending until it is installed again."
    :run="uninstallRun"
    @close="removing = null"
  />
  <ConfirmDialog v-if="clearing" title="Clear the SMS catcher?" text="Every caught SMS is removed from DevCatz." confirm="Clear" tone="warning" @cancel="clearing = false" @ok="clearSms" />
  <dialog v-if="openSms" open class="modal modal-open" @keydown.esc="openSms = null">
    <div class="modal-box w-[30rem] max-w-[95vw] space-y-3">
      <div class="flex items-center gap-2">
        <h3 class="flex-1 text-lg font-semibold tracking-tight">SMS to {{ openSms.to }}</h3>
        <button class="btn btn-ghost btn-xs btn-square" @click="openSms = null">✕</button>
      </div>
      <div class="text-xs opacity-60">{{ when(openSms.at) }} · from {{ openSms.from || '—' }} · {{ openSms.parts }} part{{ openSms.parts === 1 ? '' : 's' }} · data_coding {{ openSms.dataCoding }} · client {{ openSms.systemId }}</div>
      <div class="selectable rounded-box bg-base-200/70 p-4 text-sm whitespace-pre-wrap">{{ openSms.text }}</div>
      <div class="modal-action mt-1">
        <button class="btn btn-ghost btn-sm" @click="copy(openSms.text, 'Message copied')">Copy text</button>
        <button class="btn btn-sm" @click="openSms = null">Close</button>
      </div>
    </div>
    <div class="modal-backdrop" @click="openSms = null" />
  </dialog>
</template>
