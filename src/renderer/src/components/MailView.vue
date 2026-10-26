<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, reactive, ref, watch } from 'vue';
import type { MailMessage, MailSummary } from '@shared/types';
import StatusDot from './StatusDot.vue';
import MailEnvWriter from './MailEnvWriter.vue';
import ConfirmDialog from './ConfirmDialog.vue';
import PopMenu, { type MenuItem } from './PopMenu.vue';
import { attempt, herd, navRequest, notify, siteTabRequest, state } from '../store';
import CatMood from './CatMood.vue';

/**
 * Mail (rail): the catcher's inbox. Every mail a site sends over SMTP lands
 * here instead of a real inbox: list with site badges and search, a viewer
 * (sandboxed HTML with remote images held back, text, headers, raw source,
 * attachments, checks), forward to a real address, and the .env lines that
 * point a site at the catcher.
 */
const props = defineProps<{ focus?: string | null }>();
const emit = defineEmits<{ openSite: [id: string] }>();
const H = herd;

const mail = computed(() => state.value?.mail ?? null);
const sites = computed(() => state.value?.projects ?? []);
const query = ref('');
const siteFilter = ref('');
const list = ref<MailSummary[]>([]);
const loading = ref(false);
async function load() {
  loading.value = true;
  list.value = (await herd.mailList(query.value, siteFilter.value || null, 300).catch(() => [])) ?? [];
  loading.value = false;
  // Mails that are gone (deleted elsewhere, pruned) leave the selection.
  for (const id of [...picked]) if (!list.value.some((m) => m.id === id)) picked.delete(id);
}

// ---- bulk selection: "Select" turns the rows' avatars into checkboxes; Done / Cancel leaves it
const selecting = ref(false);
const picked = reactive(new Set<string>());
function setSelecting(on: boolean) {
  selecting.value = on;
  if (!on) picked.clear();
}
/** Sender initial and a stable hue per address for the avatar. */
const initial = (m: MailSummary) => ((m.from?.name || m.from?.address || '?').trim()[0] ?? '?').toUpperCase();
const hue = (m: MailSummary) => {
  const key = m.from?.address ?? m.subject;
  let h = 0;
  for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
};
const sender = (m: MailSummary) => m.from?.name || m.from?.address?.split('@')[0] || m.from?.address || 'Unknown sender';
const allPicked = computed(() => list.value.length > 0 && list.value.every((m) => picked.has(m.id)));
function togglePick(id: string) {
  if (picked.has(id)) picked.delete(id);
  else picked.add(id);
}
function pickAll(on: boolean) {
  if (on) for (const m of list.value) picked.add(m.id);
  else picked.clear();
}
const confirmPicked = ref(false);
async function deletePicked() {
  confirmPicked.value = false;
  const ids = [...picked];
  if (!ids.length) return;
  if (await attempt(() => herd.mailDelete(ids).then(() => true), `${ids.length} mail${ids.length === 1 ? '' : 's'} deleted`)) {
    if (selectedId.value && ids.includes(selectedId.value)) {
      msg.value = null;
      selectedId.value = null;
    }
    setSelecting(false);
    await load();
  }
}
async function markPicked(read: boolean) {
  const ids = [...picked];
  if (!ids.length) return;
  await herd.mailMarkRead(ids, read);
  setSelecting(false);
  await load();
}
let timer: ReturnType<typeof setTimeout> | null = null;
watch([query, siteFilter], () => {
  if (timer) clearTimeout(timer);
  timer = setTimeout(load, 200);
});
// New mail (or deletions elsewhere): the main process bumps lastAt / count.
watch(() => [mail.value?.lastAt, mail.value?.count], load, { immediate: true });
watch(
  () => props.focus,
  (id) => id && void open(id),
  { immediate: true },
);

const selectedId = ref<string | null>(null);
const msg = ref<MailMessage | null>(null);
type Tab = 'html' | 'text' | 'headers' | 'raw';
const tab = ref<Tab>('html');
const raw = ref('');
const images = ref(false);
const width = ref<'desktop' | 'mobile'>('desktop');
async function open(id: string) {
  selectedId.value = id;
  images.value = false;
  raw.value = '';
  const m = await attempt(() => herd.mailGet(id));
  if (!m) return;
  msg.value = m;
  tab.value = m.html ? 'html' : 'text';
  if (m.unread) {
    await herd.mailMarkRead([id], true);
    const row = list.value.find((x) => x.id === id);
    if (row) row.unread = false;
  }
}
watch(tab, async (t) => {
  if (t === 'raw' && msg.value && !raw.value) raw.value = (await attempt(() => herd.mailRaw(msg.value!.id))) ?? '';
});
/** The HTML for the sandboxed frame: blocked images put back when the user asked for them. */
const frameHtml = computed(() => {
  const h = msg.value?.html ?? '';
  const body = images.value ? h.replace(/data-blocked-(src|srcset)=/g, '$1=') : h;
  return `<!doctype html><html><head><meta charset="utf-8"><base target="_blank"><style>body{margin:16px;font-family:system-ui,sans-serif;color:#111;background:#fff}img{max-width:100%}</style></head><body>${body}</body></html>`;
});
const frame = ref<HTMLIFrameElement | null>(null);
watch([frameHtml, tab], () => nextTick(() => frame.value && (frame.value.srcdoc = frameHtml.value)));

const addr = (a: { name: string; address: string } | null) => (a ? (a.name ? `${a.name} <${a.address}>` : a.address) : '');
const when = (iso: string) => {
  const d = new Date(iso);
  return Date.now() - d.getTime() < 86_400_000 ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
};
const size = (n: number) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

// ---- actions
const busy = ref(false);
async function act(action: 'start' | 'stop' | 'restart') {
  busy.value = true;
  await attempt(() => herd.mailAction(action).then(() => true), action === 'stop' ? 'Mail catcher stopped' : 'Mail catcher listening');
  busy.value = false;
}
async function sendTest(siteId: string | null) {
  if (await attempt(() => herd.mailSendTest(siteId).then(() => true))) notify('success', 'Test mail sent: it should appear in a moment');
}
const confirmAll = ref(false);
async function deleteAll() {
  confirmAll.value = false;
  if (await attempt(() => herd.mailDeleteAll().then(() => true), 'Inbox emptied')) {
    msg.value = null;
    selectedId.value = null;
  }
}
async function remove(id: string) {
  if (await attempt(() => herd.mailDelete([id]).then(() => true))) {
    if (selectedId.value === id) {
      msg.value = null;
      selectedId.value = null;
    }
    await load();
  }
}
async function markUnread(id: string) {
  await herd.mailMarkRead([id], false);
  await load();
}
const forwardTo = ref('');
const forwardOpen = ref(false);
const forwarding = ref(false);
async function forward() {
  if (!msg.value) return;
  forwarding.value = true;
  const ok = await attempt(() => herd.mailForward(msg.value!.id, forwardTo.value).then(() => true), `Forwarded to ${forwardTo.value}`);
  forwarding.value = false;
  if (ok) forwardOpen.value = false;
}
async function saveAttachment(attId: string) {
  const path = await attempt(() => herd.mailSaveAttachment(msg.value!.id, attId));
  if (path) notify('success', `Saved to ${path}`);
}
const moreItems = computed<MenuItem[]>(() => [
  { label: 'Open web inbox', hint: mail.value?.webUrl, action: () => herd.openUrl(mail.value!.webUrl) },
  { label: 'Send a test mail', action: () => sendTest(null) },
  { label: 'Open data folder', action: () => herd.mailOpenData() },
  { label: 'Settings…', action: () => (navRequest.value = { section: 'settings' as never }) },
  { label: 'Delete all mail…', action: () => (confirmAll.value = true) },
]);
const msgItems = computed<MenuItem[]>(() =>
  msg.value
    ? [
        { label: 'Mark as unread', action: () => markUnread(msg.value!.id) },
        { label: 'Open web inbox', action: () => herd.openUrl(mail.value!.webUrl) },
        { label: mail.value?.running ? 'Stop the mail catcher' : 'Start the mail catcher', hint: `127.0.0.1:${mail.value?.port}`, action: () => act(mail.value?.running ? 'stop' : 'start') },
        { label: 'Mail catcher page', hint: 'status, .env lines', action: closeMessage },
        { label: 'Delete', action: () => remove(msg.value!.id) },
      ]
    : [],
);
/** Back to the catcher overview (nothing selected). */
function closeMessage() {
  msg.value = null;
  selectedId.value = null;
}
function openSite(id: string) {
  siteTabRequest.value = { id, tab: 'mail' };
  emit('openSite', id);
}
onBeforeUnmount(() => timer && clearTimeout(timer));
</script>

<template>
  <div class="flex min-h-0 min-w-0 flex-1">
    <aside class="flex w-80 shrink-0 flex-col border-r border-base-300/60 bg-base-200/80">
      <div class="drag title-strip h-14 shrink-0"><span class="nav-hole" aria-hidden="true" /></div>
      <div class="flex items-center gap-2 px-4 pb-1">
        <span class="label-caps">Inbox</span>
        <span v-if="mail?.unread" class="badge badge-primary badge-soft badge-xs">{{ mail.unread }} new</span>
        <span class="flex-1" />
        <button class="btn btn-ghost btn-xs" :class="{ 'btn-active': selecting }" :disabled="!list.length && !selecting" :title="selecting ? 'Leave selection' : 'Select mails to delete or mark'" @click="setSelecting(!selecting)">
          {{ selecting ? 'Done' : 'Select' }}
        </button>
        <button class="flex items-center gap-1 rounded-md px-1 py-0.5 text-[11px] opacity-70 hover:bg-base-content/10 hover:opacity-100" :title="mail?.running ? `Catcher listening on 127.0.0.1:${mail.port} · click for the catcher page` : 'Catcher stopped · click for the catcher page'" @click="closeMessage">
          <StatusDot :status="mail?.running ? 'running' : 'stopped'" />
          {{ mail?.running ? `:${mail.port}` : 'off' }}
        </button>
      </div>
      <label class="search-box mx-3 mb-1">
        <svg class="size-3.5 shrink-0 opacity-50" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M9 3.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11ZM2 9a7 7 0 1 1 12.452 4.391l3.328 3.329a.75.75 0 1 1-1.06 1.06l-3.329-3.328A7 7 0 0 1 2 9Z" clip-rule="evenodd" /></svg>
        <input v-model="query" type="text" placeholder="Search mail" spellcheck="false" />
        <button v-if="query" class="btn btn-ghost btn-xs btn-circle" @click="query = ''">×</button>
      </label>
      <select v-model="siteFilter" class="select select-xs mx-3 mb-1 w-[calc(100%-1.5rem)]">
        <option value="">All sites</option>
        <option v-for="p in sites" :key="p.id" :value="p.id">{{ p.name }}</option>
      </select>
      <ul class="min-h-0 flex-1 overflow-y-auto px-2 py-1">
        <li
          v-for="m in list"
          :key="m.id"
          class="mail-row"
          :class="{ 'is-active': selectedId === m.id, 'is-unread': m.unread, 'is-picked': picked.has(m.id) }"
          @click="selecting ? togglePick(m.id) : open(m.id)"
        >
          <!-- Avatar (sender initial), or the checkbox while selecting -->
          <div class="mail-lead">
            <input v-if="selecting" type="checkbox" class="checkbox checkbox-sm" :checked="picked.has(m.id)" @click.stop @change="togglePick(m.id)" />
            <span v-else class="mail-avatar" :style="{ '--h': hue(m) }">{{ initial(m) }}<span v-if="m.unread" class="mail-unread" /></span>
          </div>
          <div class="min-w-0 flex-1">
            <div class="flex items-baseline gap-2">
              <span class="min-w-0 flex-1 truncate text-[13px]" :class="m.unread ? 'font-semibold' : 'font-medium opacity-90'">{{ sender(m) }}</span>
              <svg v-if="m.attachments" class="size-3 shrink-0 opacity-50" viewBox="0 0 20 20" fill="currentColor" title="Has attachments"><path fill-rule="evenodd" d="M15.621 4.379a3 3 0 0 0-4.242 0l-7 7a3 3 0 0 0 4.241 4.243h.001l.497-.5a.75.75 0 0 1 1.064 1.057l-.498.501-.002.002a4.5 4.5 0 0 1-6.364-6.364l7-7a4.5 4.5 0 0 1 6.368 6.36l-3.455 3.553A2.625 2.625 0 1 1 9.52 9.52l3.45-3.451a.75.75 0 1 1 1.061 1.06l-3.45 3.451a1.125 1.125 0 0 0 1.587 1.595l3.454-3.553a3 3 0 0 0 0-4.242Z" clip-rule="evenodd" /></svg>
              <span class="shrink-0 text-[11px] tabular-nums opacity-50">{{ when(m.receivedAt) }}</span>
            </div>
            <div class="truncate text-[12.5px]" :class="m.unread ? 'font-medium' : 'opacity-80'">{{ m.subject || '(no subject)' }}</div>
            <div class="mt-0.5 flex items-center gap-1.5">
              <span class="min-w-0 flex-1 truncate text-[11px] opacity-50">{{ m.snippet || `to ${m.to.map((t) => t.address).join(', ')}` }}</span>
              <span v-if="m.siteName" class="mail-site">{{ m.siteName }}</span>
            </div>
          </div>
        </li>
        <li v-if="!list.length" class="px-3 py-10 text-center text-xs opacity-60">
          {{ loading ? 'Loading…' : query || siteFilter ? 'No mail matches.' : 'No mail caught yet.' }}
        </li>
      </ul>
      <div class="flex h-10 items-center gap-2 border-t border-base-300/60 px-3 text-xs">
        <template v-if="selecting">
          <input type="checkbox" class="checkbox checkbox-xs" :checked="allPicked" :indeterminate="picked.size > 0 && !allPicked" :disabled="!list.length" title="Select all shown" @change="pickAll(($event.target as HTMLInputElement).checked)" />
          <span class="font-medium">{{ picked.size ? `${picked.size} selected` : 'Select mails' }}</span>
          <span class="flex-1" />
          <button class="btn btn-ghost btn-xs" :disabled="!picked.size" title="Mark as read" @click="markPicked(true)">Read</button>
          <button class="btn btn-ghost btn-xs" :disabled="!picked.size" title="Mark as unread" @click="markPicked(false)">Unread</button>
          <button class="btn btn-error btn-soft btn-xs" :disabled="!picked.size" @click="confirmPicked = true">Delete{{ picked.size ? ` ${picked.size}` : '' }}</button>
        </template>
        <span v-else class="opacity-60">{{ mail?.count ?? 0 }} mail{{ mail?.count === 1 ? '' : 's' }} kept · newest {{ list.length ? when(list[0].receivedAt) : '—' }}</span>
      </div>
    </aside>

    <main class="flex min-w-0 flex-1 flex-col bg-base-100">
      <!-- Message -->
      <template v-if="msg">
        <header class="drag border-b border-base-300/60 px-6 pt-5 pb-3">
          <div class="flex items-start gap-3">
            <div class="min-w-0 flex-1">
              <h2 class="truncate text-lg font-semibold tracking-tight">{{ msg.subject || '(no subject)' }}</h2>
              <div class="mt-1 grid gap-x-4 gap-y-0.5 text-xs opacity-70 sm:grid-cols-[auto_1fr]">
                <span class="label-caps">From</span><span class="selectable truncate">{{ addr(msg.from) || msg.envelope.from }}</span>
                <span class="label-caps">To</span><span class="selectable truncate">{{ msg.to.map(addr).join(', ') }}</span>
                <template v-if="msg.cc.length"><span class="label-caps">Cc</span><span class="selectable truncate">{{ msg.cc.map(addr).join(', ') }}</span></template>
                <span class="label-caps">When</span>
                <span>
                  {{ new Date(msg.receivedAt).toLocaleString() }} · {{ size(msg.size) }}
                  <template v-if="msg.siteName"> · from <a class="link" @click="openSite(msg.siteId!)">{{ msg.siteName }}</a></template>
                  <template v-else-if="msg.envelope.username"> · SMTP user <code>{{ msg.envelope.username }}</code></template>
                </span>
              </div>
            </div>
            <div class="no-drag flex shrink-0 flex-wrap items-center gap-2">
              <button class="btn btn-sm" :disabled="!mail?.forwardReady" :title="mail?.forwardReady ? 'Send it to a real inbox through your SMTP account' : 'Set up a forwarding account in Settings → Mail first'" @click="forwardOpen = true">Forward…</button>
              <button class="btn btn-ghost btn-sm text-error" @click="remove(msg.id)">Delete</button>
              <PopMenu :items="msgItems" align="end" :width="220"><button class="btn btn-sm">More ▾</button></PopMenu>
              <button class="btn btn-ghost btn-sm btn-square" title="Close: back to the mail catcher (start / stop, settings)" @click="closeMessage">✕</button>
            </div>
          </div>
          <div class="no-drag mt-3 flex flex-wrap items-center gap-2">
            <div role="tablist" class="seg">
              <a v-if="msg.html" role="tab" class="seg-item" :class="{ 'is-active': tab === 'html' }" @click="tab = 'html'">HTML</a>
              <a role="tab" class="seg-item" :class="{ 'is-active': tab === 'text' }" @click="tab = 'text'">Text</a>
              <a role="tab" class="seg-item" :class="{ 'is-active': tab === 'headers' }" @click="tab = 'headers'">Headers</a>
              <a role="tab" class="seg-item" :class="{ 'is-active': tab === 'raw' }" @click="tab = 'raw'">Source</a>
            </div>
            <template v-if="tab === 'html'">
              <div role="tablist" class="seg">
                <a role="tab" class="seg-item" :class="{ 'is-active': width === 'desktop' }" title="Full width" @click="width = 'desktop'">Desktop</a>
                <a role="tab" class="seg-item" :class="{ 'is-active': width === 'mobile' }" title="375 px, like a phone" @click="width = 'mobile'">Mobile</a>
              </div>
              <button v-if="msg.remoteImages && !images" class="btn btn-xs" @click="images = true">Load {{ msg.remoteImages }} remote image{{ msg.remoteImages === 1 ? '' : 's' }}</button>
            </template>
            <span class="flex-1" />
            <span v-for="a in msg.attachmentList" :key="a.id" class="badge badge-ghost gap-1 cursor-pointer" :title="`${a.contentType} · ${size(a.size)} · click to save`" @click="saveAttachment(a.id)">📎 {{ a.filename }}</span>
          </div>
        </header>
        <div class="flex min-h-0 flex-1 flex-col">
          <div v-if="msg.hints.length && tab !== 'raw'" class="border-b border-base-300/60 bg-warning/8 px-6 py-2 text-xs">
            <span class="font-medium">Checks:</span> {{ msg.hints.join(' · ') }}
          </div>
          <div v-if="tab === 'html'" class="flex min-h-0 flex-1 justify-center overflow-auto bg-base-200/60 p-4">
            <iframe ref="frame" class="h-full rounded-box bg-white shadow-sm" :class="width === 'mobile' ? 'w-[375px]' : 'w-full'" sandbox="allow-popups allow-popups-to-escape-sandbox" title="Mail preview" />
          </div>
          <pre v-else-if="tab === 'text'" class="selectable min-h-0 flex-1 overflow-auto p-6 font-mono text-xs leading-relaxed whitespace-pre-wrap">{{ msg.text ?? '(no text part)' }}</pre>
          <div v-else-if="tab === 'headers'" class="min-h-0 flex-1 overflow-auto p-6">
            <table class="table table-xs">
              <tbody>
                <tr v-for="(h, i) in msg.headers" :key="i">
                  <td class="w-48 align-top font-mono text-xs font-semibold opacity-70">{{ h.name }}</td>
                  <td class="selectable font-mono text-xs break-all">{{ h.value }}</td>
                </tr>
              </tbody>
            </table>
            <div class="mt-4 text-xs opacity-60">Envelope: MAIL FROM {{ msg.envelope.from || '(empty)' }} · RCPT TO {{ msg.envelope.to.join(', ') }}<template v-if="msg.envelope.username"> · AUTH {{ msg.envelope.username }}</template></div>
          </div>
          <pre v-else class="selectable min-h-0 flex-1 overflow-auto bg-neutral p-6 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-neutral-content">{{ raw || 'Loading…' }}</pre>
        </div>
      </template>

      <!-- Nothing selected: the catcher itself -->
      <template v-else>
        <header class="drag border-b border-base-300/60 px-6 pt-5 pb-4">
          <div class="flex flex-wrap items-center gap-3">
            <div class="min-w-0 flex-1">
              <h2 class="flex items-center gap-2 text-lg font-semibold tracking-tight">
                Mail catcher
                <StatusDot :status="mail?.running ? 'running' : 'stopped'" />
                <span class="badge badge-soft badge-sm" :class="mail?.running ? 'badge-success' : 'badge-ghost'">{{ mail?.running ? 'listening' : 'stopped' }}</span>
              </h2>
              <div class="font-mono text-xs opacity-60">SMTP 127.0.0.1:{{ mail?.port }} · {{ mail?.webUrl }}</div>
            </div>
            <div class="no-drag flex shrink-0 flex-wrap items-center gap-2">
              <button v-if="!mail?.running" class="btn btn-primary btn-sm" :disabled="busy" @click="act('start')">Start</button>
              <button v-else class="btn btn-sm" :disabled="busy" @click="act('stop')">Stop</button>
              <button class="btn btn-sm" :disabled="!mail?.running" @click="H.openUrl(mail!.webUrl)">Web inbox</button>
              <PopMenu :items="moreItems" align="end" :width="220"><button class="btn btn-sm">More ▾</button></PopMenu>
            </div>
          </div>
        </header>
        <div class="site-tab">
          <div v-if="mail?.error" role="alert" class="alert alert-error alert-soft text-sm"><CatMood mood="error" class="size-7 shrink-0 -my-0.5" />{{ mail.error }}</div>
          <div class="card">
            <div class="card-body">
              <h2>How it works</h2>
              <p class="text-sm opacity-70">
                Sites send mail over SMTP to <code>127.0.0.1:{{ mail?.port }}</code> (any username and password are accepted; the username names the site). Nothing is
                delivered: every mail is kept here, as HTML, text, headers and attachments. The same inbox opens in a browser at
                <a class="link" @click="H.openUrl(mail!.webUrl)">{{ mail?.webUrl }}</a>, also on a phone through Expose.
              </p>
              <div class="flex flex-wrap gap-2">
                <button class="btn btn-sm" :disabled="!mail?.running" @click="sendTest(null)">Send a test mail</button>
                <span class="self-center text-xs opacity-60">Port, domain, notifications and forwarding: Settings → Mail.</span>
              </div>
            </div>
          </div>
          <div class="card">
            <div class="card-body">
              <h2>Point a site at the catcher</h2>
              <MailEnvWriter />
            </div>
          </div>
        </div>
      </template>
    </main>

    <dialog v-if="forwardOpen" open class="modal modal-open" @keydown.esc="forwardOpen = false">
      <form class="modal-box w-[26rem] space-y-3" @submit.prevent="forward">
        <h3 class="text-lg font-semibold">Forward to a real inbox</h3>
        <p class="text-xs opacity-70">Sent through your SMTP account (Settings → Mail) with the original sender as Reply-To.</p>
        <input v-model="forwardTo" type="email" class="input input-sm w-full" placeholder="you@example.com" autofocus />
        <div class="modal-action">
          <button type="button" class="btn btn-ghost btn-sm" @click="forwardOpen = false">Cancel</button>
          <button class="btn btn-primary btn-sm" :disabled="forwarding || !forwardTo"><span v-if="forwarding" class="loading loading-spinner loading-xs" />Forward</button>
        </div>
      </form>
      <div class="modal-backdrop" @click="forwardOpen = false" />
    </dialog>
    <ConfirmDialog
      v-if="confirmPicked"
      :title="`Delete ${picked.size} selected mail${picked.size === 1 ? '' : 's'}?`"
      text="They are removed from the catcher. This cannot be undone."
      :confirm="`Delete ${picked.size}`"
      tone="error"
      @cancel="confirmPicked = false"
      @ok="deletePicked"
    />
    <ConfirmDialog v-if="confirmAll" title="Delete all mail?" :text="`${mail?.count ?? 0} mails are removed from the catcher. This cannot be undone.`" confirm="Delete all" tone="error" @cancel="confirmAll = false" @ok="deleteAll" />
  </div>
</template>

<style scoped>
.mail-row {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  padding: 9px 10px 9px 8px;
  border-radius: 12px;
  cursor: pointer;
  margin-bottom: 2px;
  transition: background-color 100ms ease;
}
.mail-row:hover {
  background: oklch(from var(--color-base-content) l c h / 0.05);
}
.mail-row.is-active {
  background: var(--surface-raised);
  box-shadow: var(--shadow-card);
}
.mail-row.is-picked {
  background: oklch(from var(--c-mail) l c h / 0.14);
}
/* Avatar / checkbox column: centred on the three text lines. */
.mail-lead {
  display: grid;
  place-items: center;
  width: 34px;
  height: 52px;
  flex-shrink: 0;
}
.mail-avatar {
  position: relative;
  display: grid;
  place-items: center;
  width: 34px;
  height: 34px;
  border-radius: 999px;
  font-size: 13px;
  font-weight: 600;
  color: oklch(45% 0.12 var(--h));
  background: oklch(90% 0.06 var(--h));
}
/* Dark mode, the same way main.css decides it. */
[data-theme='dark'] .mail-avatar {
  color: oklch(85% 0.1 var(--h));
  background: oklch(35% 0.07 var(--h));
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme='light']) .mail-avatar {
    color: oklch(85% 0.1 var(--h));
    background: oklch(35% 0.07 var(--h));
  }
}
.mail-unread {
  position: absolute;
  right: -1px;
  top: -1px;
  width: 10px;
  height: 10px;
  border-radius: 999px;
  background: var(--c-mail);
  box-shadow: 0 0 0 2px var(--color-base-200);
}
.mail-site {
  flex-shrink: 0;
  max-width: 7rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding: 0 6px;
  border-radius: 999px;
  font-size: 10px;
  font-weight: 600;
  line-height: 1.6;
  color: var(--c-mail);
  background: oklch(from var(--c-mail) l c h / 0.14);
}
</style>
