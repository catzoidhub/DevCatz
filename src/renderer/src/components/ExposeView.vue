<script setup lang="ts">
import { keyLabel, words } from '@shared/platform';
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import QRCode from 'qrcode';
import type { ExposeRequest, ExposeShare, ExposeTool } from '@shared/types';
import StatusDot from './StatusDot.vue';
import TaskStepper from './TaskStepper.vue';
import ExposeShareDialog from './ExposeShareDialog.vue';
import ConfirmDialog from './ConfirmDialog.vue';
import ExposeRequestDrawer from './ExposeRequestDrawer.vue';
import ExposeToolUninstall from './ExposeToolUninstall.vue';
import { attempt, herd, navRequest, notify, state } from '../store';
import { PROVIDER_LOGO, PROVIDER_NAME, TOOL_LOGO } from '../expose';
import { ICONS } from '../icons';
import CatMood from './CatMood.vue';

/**
 * Expose (rail): sites shared on a public URL (Cloudflare quick tunnel, a
 * named tunnel on the user's own domain, ngrok or Expose). Each share shows
 * its URL with a QR code, basic auth / expiry, and the request inspector
 * (every request through the tunnel, with headers, bodies and Replay for
 * webhooks). The overview installs and updates the tunnel tools.
 */
const props = defineProps<{ focus?: string | null }>();
const emit = defineEmits<{ openSite: [id: string] }>();
const H = herd;

const expose = computed(() => state.value?.expose ?? null);
const shares = computed(() => expose.value?.shares ?? []);
const selectedId = ref<string | null>(null);
const share = computed(() => shares.value.find((s) => s.id === selectedId.value) ?? null);
watch(
  shares,
  (list) => {
    // 'overview' = the Tunnel tools / Providers page, reachable while shares run too.
    if (selectedId.value === 'overview') return;
    if (!selectedId.value || !list.some((s) => s.id === selectedId.value)) selectedId.value = list[0]?.id ?? null;
  },
  { immediate: true },
);
watch(
  () => props.focus,
  (id) => id && (selectedId.value = shares.value.find((s) => s.siteId === id || s.id === id)?.id ?? selectedId.value),
  { immediate: true },
);

// ---- QR
const qr = ref('');
watch(
  () => share.value?.url,
  async (url) => {
    qr.value = url ? await QRCode.toDataURL(url, { margin: 1, width: 180, color: { dark: '#111111', light: '#ffffff' } }).catch(() => '') : '';
  },
  { immediate: true },
);

// ---- requests
const requests = ref<ExposeRequest[]>([]);
const openReq = ref<ExposeRequest | null>(null);
async function loadRequests() {
  if (!share.value) return void (requests.value = []);
  requests.value = (await herd.exposeRequests(share.value.id, 300).catch(() => [])) ?? [];
  if (openReq.value) openReq.value = requests.value.find((r) => r.id === openReq.value!.id) ?? openReq.value;
}
watch(() => [selectedId.value, share.value?.requests], loadRequests, { immediate: true });
watch(selectedId, () => {
  openReq.value = null;
  page.value = 1;
});
async function replay(r: ExposeRequest) {
  const e = await attempt(() => herd.exposeReplay(share.value!.id, r.id));
  if (e) {
    notify('success', `Replayed ${r.method} ${r.path} → ${e.status}`);
    openReq.value = e;
  }
}
// Filters: text on path / method / status, a status class, and "hide assets" (images, fonts, Vite chunks, HMR) to keep webhooks and pages in view.
const filter = ref({ q: '', status: 'all' as 'all' | '2xx' | '3xx' | '4xx' | '5xx' | 'error', hideAssets: true });
const ASSET = /\.(css|js|mjs|map|png|jpe?g|gif|svg|webp|avif|ico|woff2?|ttf|otf|eot|mp4|webm|mp3)(\?|$)|^\/(@vite|@id|@fs|@react-refresh|node_modules|resources\/|__vite|_nuxt|_next|build\/assets)/i;
const isAsset = (r: ExposeRequest) => ASSET.test(r.path) || /^(text\/css|application\/javascript|text\/javascript|image\/|font\/)/i.test(r.responseHeaders['content-type'] ?? '');
const filtered = computed(() => {
  const q = filter.value.q.trim().toLowerCase();
  const st = filter.value.status;
  return requests.value.filter((r) => {
    if (filter.value.hideAssets && isAsset(r)) return false;
    if (st === 'error' ? r.status !== null : st !== 'all' && (r.status === null || Math.floor(r.status / 100) !== Number(st[0]))) return false;
    return !q || r.path.toLowerCase().includes(q) || r.method.toLowerCase() === q || String(r.status ?? '').startsWith(q);
  });
});
const hiddenAssets = computed(() => (filter.value.hideAssets ? requests.value.filter(isAsset).length : 0));
// Paging: 25 rows a page; a new request on page 1 shows up live, later pages stay where they are.
const PAGE = 25;
const page = ref(1);
const pages = computed(() => Math.max(1, Math.ceil(filtered.value.length / PAGE)));
watch([filtered, pages], () => page.value > pages.value && (page.value = pages.value));
watch(() => [filter.value.q, filter.value.status, filter.value.hideAssets], () => (page.value = 1));
const pageRows = computed(() => filtered.value.slice((page.value - 1) * PAGE, page.value * PAGE));
const METHOD_CLASS: Record<string, string> = { GET: 'badge-info', POST: 'badge-success', PUT: 'badge-warning', PATCH: 'badge-warning', DELETE: 'badge-error' };
const statusClass = (s: number | null) => (s === null ? 'badge-ghost' : s < 300 ? 'badge-success' : s < 400 ? 'badge-info' : s < 500 ? 'badge-warning' : 'badge-error');
const STATUS = (s: number | null) => (s === null ? 'opacity-50' : s < 300 ? 'text-success' : s < 400 ? 'text-info' : s < 500 ? 'text-warning' : 'text-error');
const when = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const left = ref('');
let tick: ReturnType<typeof setInterval> | null = setInterval(() => {
  const e = share.value?.expiresAt;
  if (!e) return void (left.value = '');
  const ms = new Date(e).getTime() - Date.now();
  left.value = ms <= 0 ? 'expiring…' : ms < 3_600_000 ? `${Math.ceil(ms / 60_000)} min left` : `${(ms / 3_600_000).toFixed(1)} h left`;
}, 1000);
onBeforeUnmount(() => tick && clearInterval(tick));

// ---- actions
const dialog = ref(false);
const stopping = ref<ExposeShare | null>(null);
async function stop(s: ExposeShare) {
  stopping.value = null;
  await attempt(() => herd.exposeStop(s.id).then(() => true), `${s.siteName} is no longer shared`);
}
async function copy(t: string) {
  await navigator.clipboard.writeText(t).catch(() => undefined);
  notify('info', 'Public URL copied');
}
const TOOLS: { tool: ExposeTool; name: string; source: string; providers: string }[] = [
  { tool: 'cloudflared', name: 'cloudflared', source: 'GitHub (cloudflare/cloudflared), SHA-256 checked', providers: 'Cloudflare quick tunnels · your Cloudflare domain' },
  { tool: 'ngrok', name: 'ngrok', source: "ngrok's download server, URL and SHA-256 from the Homebrew cask", providers: 'ngrok (authtoken in Settings)' },
  { tool: 'expose', name: 'Expose', source: 'GitHub (exposedev/expose), the phar build; runs on the PHP of the Runtimes page', providers: 'Expose · expose.dev (token in Settings)' },
];
const task = computed(() => expose.value?.installing ?? null);
const installing = computed(() => task.value && !task.value.task.done && !task.value.task.error);
async function install(tool: ExposeTool) {
  await attempt(() => herd.exposeInstall(tool).then(() => true), `${TOOLS.find((t) => t.tool === tool)!.name} installed`);
}
async function upgrade(tool: ExposeTool) {
  await attempt(() => herd.exposeUpgrade(tool).then(() => true), `${TOOLS.find((t) => t.tool === tool)!.name} updated`);
}
const removingTool = ref<ExposeTool | null>(null);
/** Shares running on a tool: its Uninstall is off until they are stopped. */
const sharesOn = (tool: ExposeTool) => shares.value.filter((s) => (s.provider === 'ngrok' ? 'ngrok' : s.provider === 'expose' ? 'expose' : 'cloudflared') === tool && s.status !== 'crashed').length;
const checking = ref(false);
async function checkUpdates() {
  checking.value = true;
  const failed = await attempt(() => herd.exposeCheckUpdates());
  checking.value = false;
  if (!failed) return;
  const found = Object.entries(expose.value?.updates ?? {}).map(([t, v]) => `${TOOLS.find((x) => x.tool === t)?.name} ${v}`);
  if (failed.length) notify('error', `Could not check ${failed.join(', ')} for updates (offline, or GitHub's hourly limit; try again later)`);
  else notify('info', found.length ? `${found.join(', ')} available` : 'All tunnel tools are up to date');
}
const cfBusy = ref(false);
async function cloudflareLogin() {
  cfBusy.value = true;
  notify('info', 'Your browser opens: pick the zone (domain) DevCatz may create tunnels on');
  await attempt(() => herd.exposeCloudflareLogin().then(() => true), 'Cloudflare: logged in, named tunnels on your domain are ready');
  cfBusy.value = false;
}
const installedTools = computed(() => TOOLS.filter((t) => expose.value?.tools[t.tool]).map((t) => `${t.name} ${expose.value!.tools[t.tool]}`));
</script>

<template>
  <div class="flex min-h-0 min-w-0 flex-1">
    <aside class="flex w-64 shrink-0 flex-col border-r border-base-300/60 bg-base-200/80">
      <div class="drag title-strip flex h-14 shrink-0 items-end justify-end px-3 pb-2">
        <span class="nav-hole" aria-hidden="true" />
        <button class="btn btn-ghost btn-sm btn-square" title="Share a site" @click="dialog = true">
          <svg class="size-4" viewBox="0 0 20 20" fill="currentColor"><path d="M10 4a1 1 0 0 1 1 1v4h4a1 1 0 1 1 0 2h-4v4a1 1 0 1 1-2 0v-4H5a1 1 0 1 1 0-2h4V5a1 1 0 0 1 1-1Z" /></svg>
        </button>
      </div>
      <ul class="menu w-full px-2 pb-1">
        <li>
          <a :class="{ 'menu-active': selectedId === 'overview' || !share }" @click="selectedId = 'overview'">
            <span class="grid size-7 shrink-0 place-items-center rounded-lg bg-base-300/70"><svg class="size-4" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" clip-rule="evenodd" :d="ICONS.expose" /></svg></span>
            <div class="min-w-0 flex-1">
              <div class="truncate font-medium">Tunnel tools</div>
              <div class="truncate text-[11px] opacity-60">{{ installedTools.length ? installedTools.join(' · ') : 'nothing installed yet' }}</div>
            </div>
          </a>
        </li>
      </ul>
      <div class="flex items-center gap-2 px-4 pb-1">
        <span class="label-caps">Shared sites</span>
        <span v-if="shares.filter((s) => s.status === 'running').length" class="badge badge-success badge-soft badge-xs">{{ shares.filter((s) => s.status === 'running').length }} live</span>
      </div>
      <ul class="menu w-full flex-1 flex-nowrap overflow-y-auto px-2">
        <li v-for="s in shares" :key="s.id">
          <a :class="{ 'menu-active': selectedId === s.id }" @click="selectedId = s.id">
            <img :src="PROVIDER_LOGO[s.provider]" alt="" class="size-7 shrink-0 rounded-lg bg-white p-0.5 ring-1 ring-base-content/10" draggable="false" :title="PROVIDER_NAME[s.provider]" />
            <div class="min-w-0 flex-1">
              <div class="truncate font-medium">{{ s.siteName }}</div>
              <div class="truncate font-mono text-[11px] opacity-60">{{ s.url?.replace(/^https:\/\//, '') ?? s.status }}</div>
            </div>
            <span v-if="s.requests" class="badge badge-ghost badge-xs">{{ s.requests }}</span>
            <StatusDot :status="s.status" />
          </a>
        </li>
        <li v-if="!shares.length" class="px-3 py-6 text-center text-xs opacity-50">Nothing shared. Click + or a site's Share button.</li>
      </ul>
      <div class="border-t border-base-300/60 p-3 text-xs opacity-60">
        <template v-if="installedTools.length">{{ installedTools.join(' · ') }}</template>
        <template v-else>No tunnel tool installed yet</template>
      </div>
    </aside>

    <main class="flex min-w-0 flex-1 flex-col bg-base-100">
      <template v-if="share">
        <header class="drag win-top border-b border-base-300/60 px-6 pt-5 pb-4">
          <div class="flex flex-wrap items-center gap-3">
            <img :src="PROVIDER_LOGO[share.provider]" alt="" class="size-11 rounded-xl bg-white p-1 ring-1 ring-base-content/10" draggable="false" />
            <div class="min-w-0 flex-1">
              <h2 class="flex items-center gap-2 text-lg font-semibold tracking-tight">
                {{ share.siteName }}
                <StatusDot :status="share.status" />
                <span class="badge badge-soft badge-sm" :class="share.status === 'running' ? 'badge-success' : share.status === 'starting' ? 'badge-warning' : share.status === 'crashed' ? 'badge-error' : 'badge-ghost'">{{ share.status }}</span>
              </h2>
              <div class="font-mono text-xs opacity-60">
                {{ share.domain }} → {{ PROVIDER_NAME[share.provider] }} · since {{ new Date(share.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }}
                <template v-if="share.auth"> · basic auth ({{ share.auth }})</template>
                <template v-if="left"> · {{ left }}</template>
              </div>
            </div>
            <div class="no-drag flex shrink-0 flex-wrap items-center gap-2">
              <button class="btn btn-sm" :disabled="!share.url || share.status !== 'running'" @click="copy(share.url!)">Copy URL</button>
              <button class="btn btn-sm" :disabled="!share.url || share.status !== 'running'" @click="H.openUrl(share.url!)">Open</button>
              <button class="btn btn-sm" @click="emit('openSite', share.siteId)">Open site</button>
              <button class="btn btn-error btn-outline btn-sm" @click="stopping = share">Stop sharing</button>
            </div>
          </div>
        </header>
        <div class="site-tab">
          <div v-if="share.error" role="alert" class="alert alert-error alert-soft text-sm"><CatMood mood="error" class="size-7 shrink-0 -my-0.5" />{{ share.error }}</div>
          <div class="card">
            <div class="card-body flex-row flex-wrap items-center gap-5">
              <img v-if="qr && share.status === 'running'" :src="qr" alt="QR code of the public URL" class="size-44 rounded-box bg-white p-1 ring-1 ring-base-content/10" draggable="false" />
              <div v-else class="grid size-44 place-items-center rounded-box bg-base-200 text-xs opacity-60">{{ share.status === 'starting' ? (share.url ? 'Checking the URL…' : 'Starting the tunnel…') : 'No URL' }}</div>
              <div class="min-w-0 flex-1 space-y-2">
                <div class="label-caps">Public URL</div>
                <span v-if="share.url && share.status === 'starting'" class="flex items-center gap-2 text-sm opacity-70"><span class="loading loading-spinner loading-xs" />{{ share.url }} — waiting until it resolves and answers…</span>
                <a v-else-if="share.url" class="url-chip w-full" :title="`Open ${share.url}`" @click="H.openUrl(share.url)">
                  <span class="truncate text-base">{{ share.url }}</span>
                </a>
                <p class="text-xs opacity-60">
                  Scan the code on a phone to open it. The tunnel forwards to <code>{{ share.domain }}</code> on this Mac with its Host header, through DevCatz's proxy;
                  requests show below. Webhooks (Stripe, GitHub, Midtrans …) can call this URL, and Replay sends one again after a code change.
                </p>
              </div>
            </div>
          </div>

          <!-- Request inspector -->
          <div class="card">
            <div class="card-body card-table">
              <div class="card-head flex-wrap gap-y-2">
                <h2>Requests</h2>
                <span class="badge badge-ghost badge-sm">{{ filtered.length }}<template v-if="filtered.length !== requests.length"> of {{ requests.length }}</template></span>
                <span class="text-xs opacity-60">newest first · live</span>
                <span class="flex-1" />
                <label class="search-box w-56">
                  <svg class="size-3.5 shrink-0 opacity-50" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M9 3.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11ZM2 9a7 7 0 1 1 12.452 4.391l3.328 3.329a.75.75 0 1 1-1.06 1.06l-3.329-3.328A7 7 0 0 1 2 9Z" clip-rule="evenodd" /></svg>
                  <input v-model="filter.q" placeholder="Path, method or status…" spellcheck="false" />
                  <button v-if="filter.q" class="btn btn-ghost btn-xs btn-circle" @click="filter.q = ''">×</button>
                </label>
                <button class="btn btn-ghost btn-xs" :disabled="!requests.length" @click="attempt(() => H.exposeClearRequests(share!.id)).then(loadRequests)">Clear</button>
              </div>
              <div class="flex flex-wrap items-center gap-2 border-t border-base-300/60 px-5 py-2">
                <div role="tablist" class="seg seg-xs">
                  <a v-for="st in (['all', '2xx', '3xx', '4xx', '5xx', 'error'] as const)" :key="st" role="tab" class="seg-item" :class="{ 'is-active': filter.status === st }" @click="filter.status = st">{{ st === 'all' ? 'All' : st === 'error' ? 'No answer' : st }}</a>
                </div>
                <label class="ml-auto flex cursor-pointer items-center gap-2 text-xs">
                  <input v-model="filter.hideAssets" type="checkbox" class="toggle toggle-xs toggle-primary" />
                  <span>Hide assets<span v-if="hiddenAssets" class="opacity-60"> ({{ hiddenAssets }})</span></span>
                </label>
              </div>
              <div class="overflow-x-auto">
                <table class="table table-sm">
                  <thead>
                    <tr><th class="w-20">Method</th><th class="w-16">Status</th><th>Path</th><th class="w-20 text-right">Time</th><th class="w-28 text-right whitespace-nowrap">At</th></tr>
                  </thead>
                  <tbody>
                    <tr v-for="r in pageRows" :key="r.id" class="cursor-pointer hover:bg-base-200/50" :class="{ 'bg-base-200/60': openReq?.id === r.id }" @click="openReq = r">
                      <td><span class="badge badge-soft badge-xs font-mono font-semibold" :class="METHOD_CLASS[r.method] ?? 'badge-ghost'">{{ r.method }}</span></td>
                      <td><span class="badge badge-soft badge-xs font-mono" :class="statusClass(r.status)">{{ r.status ?? '—' }}</span></td>
                      <td class="max-w-0">
                        <div class="flex items-center gap-1.5">
                          <span class="truncate font-mono text-xs" :title="r.path">{{ r.path }}</span>
                          <span v-if="r.replay" class="badge badge-ghost badge-xs shrink-0">replay</span>
                          <span v-if="r.requestBody && !r.requestBody.startsWith('(')" class="badge badge-ghost badge-xs shrink-0" title="Has a request body">body</span>
                        </div>
                      </td>
                      <td class="text-right font-mono text-xs tabular-nums opacity-70">{{ r.ms === null ? '—' : `${r.ms} ms` }}</td>
                      <td class="text-right font-mono text-xs whitespace-nowrap tabular-nums opacity-50">{{ when(r.at) }}</td>
                    </tr>
                    <tr v-if="!pageRows.length">
                      <td colspan="5" class="py-10 text-center text-xs opacity-60">
                        <template v-if="!requests.length">No requests yet. Open the public URL on a phone or point a webhook at it.</template>
                        <template v-else>Nothing matches the filters{{ hiddenAssets ? ` (${hiddenAssets} asset requests hidden)` : '' }}.</template>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <div v-if="pages > 1" class="card-foot flex items-center gap-2">
                <span class="text-xs opacity-60">{{ (page - 1) * PAGE + 1 }}–{{ Math.min(page * PAGE, filtered.length) }} of {{ filtered.length }}</span>
                <span class="flex-1" />
                <div class="join">
                  <button class="btn btn-xs join-item" :disabled="page === 1" @click="page = 1">«</button>
                  <button class="btn btn-xs join-item" :disabled="page === 1" @click="page--">‹</button>
                  <span class="btn btn-xs join-item pointer-events-none font-mono">{{ page }} / {{ pages }}</span>
                  <button class="btn btn-xs join-item" :disabled="page === pages" @click="page++">›</button>
                  <button class="btn btn-xs join-item" :disabled="page === pages" @click="page = pages">»</button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </template>

      <!-- Nothing shared yet -->
      <template v-else>
        <header class="drag win-top border-b border-base-300/60 px-6 pt-5 pb-4">
          <h2 class="text-lg font-semibold tracking-tight">Expose</h2>
          <div class="text-xs opacity-60">Share a local site on a public URL for a client demo, a webhook or a phone test.</div>
        </header>
        <div class="site-tab">
          <div class="card">
            <div class="card-body card-table">
              <div class="card-head">
                <h2>Tunnel tools</h2>
                <button class="btn btn-ghost btn-xs ml-auto" :disabled="checking || !!installing" @click="checkUpdates"><span v-if="checking" class="loading loading-spinner loading-xs" />Check for updates</button>
              </div>
              <div v-if="task" class="px-5 pt-4"><TaskStepper :task="task.task" :cancellable="!!installing" dismissable @cancel="H.exposeCancelInstall()" @dismiss="H.taskDismiss('expose', task.tool)" /></div>
              <div class="overflow-x-auto">
                <table class="table table-sm">
                  <tbody>
                    <tr v-for="t in TOOLS" :key="t.tool">
                      <td class="w-48">
                        <div class="flex items-center gap-3">
                          <img :src="TOOL_LOGO[t.tool]" alt="" class="size-7 shrink-0 rounded-lg bg-white p-0.5 ring-1 ring-base-content/10" draggable="false" />
                          <div>
                            <div class="font-medium">{{ t.name }}</div>
                            <div class="text-xs opacity-60">{{ expose?.tools[t.tool] ? `version ${expose.tools[t.tool]}` : 'not installed' }}</div>
                          </div>
                        </div>
                      </td>
                      <td>
                        <div class="text-sm">{{ t.providers }}</div>
                        <div class="text-xs opacity-60">{{ t.source }}</div>
                      </td>
                      <td class="text-right whitespace-nowrap">
                        <template v-if="expose?.tools[t.tool]">
                          <button v-if="expose.updates[t.tool]" class="btn btn-primary btn-xs" :disabled="!!installing" @click="upgrade(t.tool)">Update to {{ expose.updates[t.tool] }}</button>
                          <span v-else class="badge badge-success badge-soft badge-sm">installed</span>
                          <!-- A disabled button gets no native tooltip, so the wrapper carries it. -->
                          <span class="tooltip tooltip-left" :data-tip="sharesOn(t.tool) ? `In use by ${sharesOn(t.tool)} share${sharesOn(t.tool) === 1 ? '' : 's'} — stop ${sharesOn(t.tool) === 1 ? 'it' : 'them'} first` : 'Delete the binary; tokens and logins stay'">
                            <button class="btn btn-ghost btn-xs text-error" :disabled="!!installing || sharesOn(t.tool) > 0" @click="removingTool = t.tool">Uninstall…</button>
                          </span>
                          <div v-if="sharesOn(t.tool)" class="mt-0.5 flex items-center justify-end gap-1 text-[10px] opacity-60"><span class="status status-success status-xs" />in use by {{ sharesOn(t.tool) }} share{{ sharesOn(t.tool) === 1 ? '' : 's' }}</div>
                        </template>
                        <button v-else class="btn btn-sm" :disabled="!!installing" @click="install(t.tool)">Install</button>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <div class="card-foot flex flex-wrap items-center gap-x-6 gap-y-3">
                <button class="btn btn-primary btn-sm" :disabled="!installedTools.length" @click="dialog = true">Share a site…</button>
                <p class="min-w-0 flex-1 text-xs leading-relaxed opacity-60">Updates are checked every six hours. A tool is swapped in place; shares running on it stop first.</p>
              </div>
            </div>
          </div>
          <div class="card">
            <div class="card-body">
              <h2>Providers</h2>
              <div class="grid gap-3 sm:grid-cols-2">
                <div class="rounded-box border border-base-300/60 p-4">
                  <div class="flex items-center gap-2.5">
                    <img :src="PROVIDER_LOGO.cloudflare" alt="" class="size-7 shrink-0 rounded-lg bg-white p-0.5 ring-1 ring-base-content/10" draggable="false" />
                    <span class="font-medium">Cloudflare quick tunnel</span>
                  </div>
                  <p class="mt-2 text-xs leading-relaxed opacity-70">No account: a random <code>https://….trycloudflare.com</code> URL per share, meant for short-lived sharing.</p>
                </div>
                <div class="rounded-box border border-base-300/60 p-4">
                  <div class="flex items-center gap-2.5">
                    <img :src="PROVIDER_LOGO['cloudflare-domain']" alt="" class="size-7 shrink-0 rounded-lg bg-white p-0.5 ring-1 ring-base-content/10" draggable="false" />
                    <span class="font-medium">Your Cloudflare domain</span>
                    <span class="badge badge-sm badge-soft" :class="expose?.accounts.cloudflare ? 'badge-success' : 'badge-ghost'">{{ expose?.accounts.cloudflare ? 'logged in' : 'not logged in' }}</span>
                  </div>
                  <p class="mt-2 text-xs leading-relaxed opacity-70">A named tunnel with a fixed hostname on a zone of your Cloudflare account (<code>demo.example.com</code>), DNS set for you.</p>
                  <div class="mt-3 flex gap-2">
                    <button v-if="!expose?.accounts.cloudflare" class="btn btn-xs" :disabled="!expose?.tools.cloudflared || cfBusy" @click="cloudflareLogin"><span v-if="cfBusy" class="loading loading-spinner loading-xs" />Log in to Cloudflare</button>
                    <button v-else class="btn btn-ghost btn-xs" @click="attempt(() => H.exposeCloudflareLogout().then(() => true), 'Cloudflare: logged out')">Log out</button>
                  </div>
                </div>
                <div class="rounded-box border border-base-300/60 p-4">
                  <div class="flex items-center gap-2.5">
                    <img :src="PROVIDER_LOGO.ngrok" alt="" class="size-7 shrink-0 rounded-lg bg-white p-0.5 ring-1 ring-base-content/10" draggable="false" />
                    <span class="font-medium">ngrok</span>
                    <span class="badge badge-sm badge-soft" :class="expose?.accounts.ngrok.token ? 'badge-success' : 'badge-ghost'">{{ expose?.accounts.ngrok.token ? 'authtoken set' : 'no authtoken' }}</span>
                  </div>
                  <p class="mt-2 text-xs leading-relaxed opacity-70">Your ngrok account's URL (random, or a reserved domain). One agent at a time on the free plan.</p>
                  <button class="btn btn-ghost btn-xs mt-3" @click="navRequest = { section: 'settings', id: 'expose' }">Settings → Expose</button>
                </div>
                <div class="rounded-box border border-base-300/60 p-4">
                  <div class="flex items-center gap-2.5">
                    <img :src="PROVIDER_LOGO.expose" alt="" class="size-7 shrink-0 rounded-lg bg-white p-0.5 ring-1 ring-base-content/10" draggable="false" />
                    <span class="font-medium">Expose</span>
                    <span class="badge badge-sm badge-soft" :class="expose?.accounts.expose.token ? 'badge-success' : 'badge-ghost'">{{ expose?.accounts.expose.token ? 'token set' : 'no token' }}</span>
                  </div>
                  <p class="mt-2 text-xs leading-relaxed opacity-70">expose.dev (by Beyond Code): a subdomain on sharedwithexpose.com or your own Expose server; needs PHP 8.2+.</p>
                  <button class="btn btn-ghost btn-xs mt-3" @click="navRequest = { section: 'settings', id: 'expose' }">Settings → Expose</button>
                </div>
              </div>
            </div>
          </div>
          <div class="card">
            <div class="card-body">
              <h2>What a share does</h2>
              <ul class="list-inside list-disc space-y-1 text-sm opacity-70">
                <li>Requests reach the site with its own Host header, so routing, cookies and Vite HMR work as on this Mac.</li>
                <li>Optional basic auth in front of it, and an expiry so a forgotten share stops by itself.</li>
                <li>Every request is listed with headers and bodies; Replay sends a webhook again after you changed the code.</li>
                <li>Several sites can be shared at once; the {{ words.tray }} lists them with their URLs.</li>
              </ul>
            </div>
          </div>
        </div>
      </template>
    </main>

    <ExposeRequestDrawer v-if="openReq && share" :request="openReq" :can-replay="share.status === 'running'" :share-id="share.id" @close="openReq = null" @replay="replay" />
    <ExposeShareDialog v-if="dialog" @close="dialog = false" @started="(s) => { dialog = false; selectedId = s.id; }" />
    <ExposeToolUninstall v-if="removingTool" :tool="removingTool" :name="TOOLS.find((t) => t.tool === removingTool)!.name" :version="expose?.tools[removingTool] ?? ''" :logo="TOOL_LOGO[removingTool]" @close="removingTool = null" />
    <ConfirmDialog v-if="stopping" :title="`Stop sharing ${stopping.siteName}?`" :text="`${stopping.url ?? 'The public URL'} stops working right away; a new share gets a new URL.`" confirm="Stop sharing" tone="warning" @cancel="stopping = null" @ok="stop(stopping!)" />
  </div>
</template>
