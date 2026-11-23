<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { ProxyState } from '@shared/types';
import { words } from '@shared/platform';
import { attempt, herd, notify, proxyRequest, state } from '../store';
import { ICONS } from '../icons';
import ProxyDialog from './ProxyDialog.vue';
import PopMenu, { type MenuItem } from './PopMenu.vue';
import FoldAllButton from './FoldAllButton.vue';

/**
 * Proxies (TODO §49): friendly names under the default domain for servers elsewhere. A proxy forwards to an IP and
 * port; a redirect sends the browser on to the real address. Listed by group, favourites first.
 */
const proxies = computed(() => state.value?.proxies ?? []);
const selectedId = ref<string | null>(null);
const selected = computed(() => proxies.value.find((p) => p.id === selectedId.value) ?? null);
watch(
  proxies,
  (list) => {
    if (!selected.value) selectedId.value = list[0]?.id ?? null;
  },
  { immediate: true },
);
const dialog = ref<{ entry?: ProxyState } | null>(null);
const removing = ref(false);
watch(selectedId, () => (removing.value = false));

// ---- sort, group by, fold: remembered per window, like the sites and database lists
type Sort = 'default' | 'name';
type Group = 'default' | 'kind';
const view = ref<{ sort: Sort; group: Group; collapsed: string[] }>({ sort: 'default', group: 'default', collapsed: [] });
try {
  const v = JSON.parse(localStorage.getItem('mrcatz-herd.proxies.view') ?? '') as Partial<typeof view.value>;
  if (v.sort === 'name') view.value.sort = 'name';
  if (v.group === 'kind') view.value.group = 'kind';
  if (Array.isArray(v.collapsed)) view.value.collapsed = v.collapsed.filter((x) => typeof x === 'string');
} catch {
  /* first run */
}
watch(view, (v) => localStorage.setItem('mrcatz-herd.proxies.view', JSON.stringify(v)), { deep: true });
const menu = computed<MenuItem[]>(() => [
  { label: 'Sort by default (drag & drop order)', checked: view.value.sort === 'default', action: () => (view.value.sort = 'default') },
  { label: 'Sort by name', checked: view.value.sort === 'name', action: () => (view.value.sort = 'name') },
  { label: 'Group by default (your groups)', separator: true, checked: view.value.group === 'default', action: () => (view.value.group = 'default') },
  { label: 'Group by kind (proxy, redirect)', checked: view.value.group === 'kind', action: () => (view.value.group = 'kind') },
]);
const custom = computed(() => view.value.sort !== 'default' || view.value.group !== 'default');

/** `fav`, `g:<group>`, `k:proxy|redirect` or `rest`: what a drop on the section does follows from it. */
interface Section {
  key: string;
  title: string;
  items: ProxyState[];
  collapsed: boolean;
}
const sections = computed<Section[]>(() => {
  const sort = (l: ProxyState[]) => (view.value.sort === 'name' ? [...l].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })) : l);
  const mk = (key: string, title: string, items: ProxyState[]): Section => ({ key, title, items: sort(items), collapsed: view.value.collapsed.includes(key) });
  const out: Section[] = [];
  const favs = proxies.value.filter((p) => p.favorite);
  if (favs.length) out.push(mk('fav', '★ Favorites', favs));
  const rest = proxies.value.filter((p) => !p.favorite);
  if (view.value.group === 'kind') {
    for (const [k, title] of [['proxy', 'Proxies'], ['redirect', 'Redirects']] as const) {
      const items = rest.filter((p) => p.mode === k);
      if (items.length) out.push(mk(`k:${k}`, title, items));
    }
    return out;
  }
  // Groups in the order they first appear in the list.
  for (const g of [...new Set(rest.map((p) => p.group).filter(Boolean))]) out.push(mk(`g:${g}`, g, rest.filter((p) => p.group === g)));
  const loose = rest.filter((p) => !p.group);
  if (loose.length) out.push(mk('rest', out.length ? 'Others' : '', loose));
  return out;
});
const toggle = (key: string) => (view.value.collapsed = view.value.collapsed.includes(key) ? view.value.collapsed.filter((k) => k !== key) : [...view.value.collapsed, key]);
const foldable = computed(() => sections.value.filter((x) => x.title));
const anyOpen = computed(() => foldable.value.some((x) => !x.collapsed));
function setAll(open: boolean) {
  view.value.collapsed = open ? [] : foldable.value.map((x) => x.key);
}

// ---- drag and drop: onto a heading (into Favorites / a group / out of them), onto a row (before it, into its section)
const dragId = ref<string | null>(null);
const dropSection = ref<string | null>(null);
const dropRow = ref<string | null>(null);
/** What being in a section means for an entry; null where a drop changes nothing (grouped by kind). */
function membership(key: string, p: ProxyState): { favorite: boolean; group: string } | null {
  if (key === 'fav') return { favorite: true, group: p.group };
  if (key.startsWith('g:')) return { favorite: false, group: key.slice(2) };
  if (key === 'rest') return { favorite: false, group: '' };
  return null;
}
async function onDrop(sec: Section, before?: ProxyState) {
  const id = dragId.value;
  dragId.value = dropSection.value = dropRow.value = null;
  const p = proxies.value.find((x) => x.id === id);
  if (!p || before?.id === p.id) return;
  const m = membership(sec.key, p);
  if (m && (m.favorite !== p.favorite || m.group !== p.group)) await attempt(() => herd.proxySetMeta(p.id, m));
  if (before && view.value.sort === 'default') {
    const ids = proxies.value.map((x) => x.id).filter((x) => x !== p.id);
    ids.splice(ids.indexOf(before.id), 0, p.id);
    await attempt(() => herd.proxyReorder(ids));
  }
}

// ---- right-click menus (native, as on the sites list): what needs this page comes back through proxyRequest
const groupDialog = ref<{ mode: 'new' | 'rename'; id?: string; from?: string; name: string } | null>(null);
watch(
  proxyRequest,
  (r) => {
    if (!r) return;
    proxyRequest.value = null;
    const p = proxies.value.find((x) => x.id === r.key);
    if (r.action === 'edit' && p) dialog.value = { entry: p };
    else if (r.action === 'remove' && p) {
      selectedId.value = p.id;
      setTimeout(() => (removing.value = true));
    } else if (r.action === 'new-group' && p) groupDialog.value = { mode: 'new', id: p.id, name: '' };
    else if (r.action === 'rename-group') groupDialog.value = { mode: 'rename', from: r.key, name: r.key };
  },
  { immediate: true },
);
async function saveGroup() {
  const d = groupDialog.value;
  const name = d?.name.trim();
  if (!d || !name) return;
  const ok = await attempt(() => (d.mode === 'new' ? herd.proxySetMeta(d.id!, { group: name }) : herd.proxyGroupAction(d.from!, 'rename', name)).then(() => true));
  if (ok) groupDialog.value = null;
}

async function toggleFavorite(p: ProxyState) {
  await attempt(() => herd.proxySetMeta(p.id, { favorite: !p.favorite }));
}
async function copy(v: string) {
  await navigator.clipboard.writeText(v).catch(() => undefined);
  notify('success', 'Copied');
}
async function remove(p: ProxyState) {
  removing.value = false;
  await attempt(() => herd.proxyRemove(p.id), `${p.name} removed`);
}
const dot = (p: ProxyState) => (p.mode === 'redirect' ? 'status-info' : p.reachable === null ? 'status-neutral' : p.reachable ? 'status-success' : 'status-error');
</script>

<template>
  <div class="flex min-h-0 min-w-0 flex-1">
    <aside class="flex w-64 shrink-0 flex-col border-r border-base-300/60 bg-base-200/80">
      <div class="drag title-strip flex h-14 shrink-0 items-end justify-end px-3 pb-2">
        <span class="nav-hole" aria-hidden="true" />
        <button class="btn btn-ghost btn-sm btn-square" title="Add a proxy" @click="dialog = {}">
          <svg class="size-4" viewBox="0 0 20 20" fill="currentColor"><path d="M10 4a1 1 0 0 1 1 1v4h4a1 1 0 1 1 0 2h-4v4a1 1 0 1 1-2 0v-4H5a1 1 0 1 1 0-2h4V5a1 1 0 0 1 1-1Z" /></svg>
        </button>
      </div>
      <div class="flex items-center gap-2 px-4 pb-1">
        <span class="label-caps">Proxies</span>
        <span v-if="proxies.length" class="sec-count">{{ proxies.length }}</span>
        <span class="flex-1" />
        <FoldAllButton v-if="foldable.length > 1" :any-open="anyOpen" @toggle="setAll(!anyOpen)" />
        <PopMenu v-if="proxies.length" :items="menu" align="end" :width="260">
          <button class="btn btn-ghost btn-xs btn-square" :class="{ 'text-primary': custom }" title="Sort and group">
            <svg class="size-3.5" viewBox="0 0 20 20" fill="currentColor"><path d="M2.5 5.25A.75.75 0 0 1 3.25 4.5h13.5a.75.75 0 0 1 0 1.5H3.25a.75.75 0 0 1-.75-.75Zm2 4A.75.75 0 0 1 5.25 8.5h9.5a.75.75 0 0 1 0 1.5h-9.5a.75.75 0 0 1-.75-.75Zm2 4a.75.75 0 0 1 .75-.75h5.5a.75.75 0 0 1 0 1.5h-5.5a.75.75 0 0 1-.75-.75Z" /></svg>
          </button>
        </PopMenu>
      </div>
      <div class="min-h-0 flex-1 overflow-y-auto pb-2" @dragend="dragId = dropSection = dropRow = null">
        <ul class="menu w-full flex-nowrap px-2 py-0">
          <template v-for="s in sections" :key="s.key">
            <li
              v-if="s.title"
              class="menu-title mt-1 flex-row items-center gap-1 rounded-md px-3 py-1 text-xs"
              :class="{ 'bg-primary/15': dropSection === s.key && dragId }"
              @dragover.prevent="dropSection = s.key"
              @dragleave="dropSection = dropSection === s.key ? null : dropSection"
              @drop.prevent="onDrop(s)"
              @contextmenu.prevent="s.key.startsWith('g:') && herd.proxyGroupMenu(s.key.slice(2))"
            >
              <button class="flex flex-1 items-center gap-1 text-left" @click="toggle(s.key)">
                <svg class="size-3 transition-transform" :class="{ '-rotate-90': s.collapsed }" viewBox="0 0 20 20" fill="currentColor"><path d="M5.2 7.2a.75.75 0 0 1 1.06 0L10 10.94l3.74-3.74a.75.75 0 1 1 1.06 1.06l-4.27 4.27a.75.75 0 0 1-1.06 0L5.2 8.26a.75.75 0 0 1 0-1.06Z" /></svg>
                <span class="truncate">{{ s.title }}</span>
              </button>
              <span class="opacity-60">{{ s.items.length }}</span>
            </li>
            <template v-if="!s.collapsed">
              <li
                v-for="p in s.items"
                :key="s.key + p.id"
                class="group"
                draggable="true"
                :class="{ 'drop-before': dropRow === p.id && dragId !== p.id, 'opacity-50': dragId === p.id }"
                @dragstart="dragId = p.id"
                @dragover.prevent="dropRow = p.id"
                @dragleave="dropRow = dropRow === p.id ? null : dropRow"
                @drop.prevent.stop="onDrop(s, p)"
                @contextmenu.prevent="(selectedId = p.id), herd.proxyMenu(p.id)"
              >
                <a :class="{ 'menu-active': p.id === selectedId }" :title="`${p.domain} → ${p.target}`" @click="selectedId = p.id">
                  <span class="status status-sm shrink-0" :class="dot(p)" />
                  <div class="min-w-0 flex-1">
                    <div class="truncate font-medium">{{ p.name }}</div>
                    <div class="truncate font-mono text-[11px] opacity-60">{{ p.target.replace(/^https?:\/\//, '') }}</div>
                  </div>
                  <span class="badge badge-ghost badge-xs shrink-0 group-hover:hidden">{{ p.mode === 'proxy' ? 'Proxy' : 'Redirect' }}</span>
                  <button class="btn btn-ghost btn-xs btn-square hidden shrink-0 group-hover:inline-flex" :title="`Open ${p.domain} in the browser`" @click.stop="herd.openUrl(p.address)">
                    <svg class="size-3.5" viewBox="0 0 20 20" fill="currentColor"><path d="M11 3a1 1 0 1 0 0 2h2.59l-5.3 5.3a1 1 0 0 0 1.42 1.4L15 6.42V9a1 1 0 1 0 2 0V4a1 1 0 0 0-1-1h-5Z" /><path d="M5 5a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2v-3a1 1 0 1 0-2 0v3H5V7h3a1 1 0 0 0 0-2H5Z" /></svg>
                  </button>
                </a>
              </li>
            </template>
          </template>
        </ul>
        <p v-if="!proxies.length" class="px-4 pt-2 text-xs opacity-60">No proxies yet.</p>
      </div>
    </aside>

    <main class="flex min-w-0 flex-1 flex-col bg-base-100">
      <template v-if="selected">
        <header class="drag win-top border-b border-base-300/60 px-6 pt-5 pb-4">
          <div class="flex flex-wrap items-center gap-3">
            <span class="grid size-11 shrink-0 place-items-center rounded-xl bg-base-200"><svg class="size-6" viewBox="0 0 20 20" fill="currentColor" style="color: var(--c-proxies)"><path fill-rule="evenodd" clip-rule="evenodd" :d="ICONS.proxies" /></svg></span>
            <div class="min-w-0 flex-1">
              <h2 class="flex items-center gap-2 text-lg font-semibold tracking-tight">
                {{ selected.name }}
                <button class="no-drag btn btn-ghost btn-xs btn-square" :title="selected.favorite ? 'Remove from Favorites' : 'Add to Favorites'" @click="toggleFavorite(selected)">
                  <span :class="selected.favorite ? 'text-warning' : 'opacity-40'">★</span>
                </button>
                <span class="badge badge-soft badge-sm" :class="selected.mode === 'proxy' ? 'badge-primary' : 'badge-info'">{{ selected.mode === 'proxy' ? 'Proxy' : 'Redirect' }}</span>
                <span v-if="selected.mode === 'proxy' && selected.reachable !== null" class="badge badge-soft badge-sm" :class="selected.reachable ? 'badge-success' : 'badge-error'">{{ selected.reachable ? 'reachable' : 'not reachable' }}</span>
              </h2>
              <div class="truncate font-mono text-xs opacity-60">{{ selected.domain }} → {{ selected.target }}</div>
            </div>
            <div class="no-drag flex shrink-0 items-center gap-2">
              <button class="btn btn-primary btn-sm" @click="herd.openUrl(selected.address)">Open</button>
              <button class="btn btn-sm" @click="dialog = { entry: selected }">Edit…</button>
            </div>
          </div>
        </header>

        <div class="flex-1 space-y-4 overflow-y-auto p-6">
          <div v-if="selected.mode === 'proxy' && selected.reachable === false" role="alert" class="alert alert-warning alert-soft text-sm">
            {{ selected.target }} does not answer from this {{ words.computer }}. Is the server up, and are you on its network (VPN)? DevCatz checks again every 30 seconds.
          </div>

          <div class="card">
            <div class="card-body">
              <div class="grid gap-x-6 gap-y-4 text-sm sm:grid-cols-2">
                <div class="min-w-0">
                  <span class="label-caps mb-1 block">Address</span>
                  <div class="flex items-center gap-1"><code class="selectable truncate">{{ selected.address }}</code><button class="btn btn-ghost btn-xs" @click="copy(selected.address)">Copy</button></div>
                </div>
                <div class="min-w-0">
                  <span class="label-caps mb-1 block">{{ selected.mode === 'proxy' ? 'Forwards to' : 'Redirects to' }}</span>
                  <div class="flex items-center gap-1"><code class="selectable truncate">{{ selected.target }}</code><button class="btn btn-ghost btn-xs" @click="copy(selected.target)">Copy</button></div>
                </div>
                <div v-if="selected.group"><span class="label-caps mb-1 block">Group</span>{{ selected.group }}</div>
                <template v-if="selected.mode === 'proxy'">
                  <div v-if="selected.protocol === 'https'"><span class="label-caps mb-1 block">Server certificate</span>{{ selected.insecure !== false ? 'Its own (self-signed), not checked' : 'Checked' }}</div>
                  <div><span class="label-caps mb-1 block">Host header</span><code>{{ selected.ownHost ? selected.domain : selected.target.replace(/^https?:\/\//, '') }}</code></div>
                </template>
              </div>
              <p class="mt-2 text-xs opacity-60">
                <template v-if="selected.mode === 'proxy'">
                  The name stays in the address bar; DevCatz forwards pages and WebSockets (consoles, live updates) to the server, and your browser gets DevCatz's trusted certificate.
                  Web addresses only: SSH and database ports do not go through a name. It works while this {{ words.computer }} reaches the server.
                </template>
                <template v-else>The browser goes on to the real address with the path you asked for, so logins, cookies and single sign-on stay on the real domain.</template>
              </p>
            </div>
          </div>

          <div class="flex items-center gap-2">
            <template v-if="!removing"><button class="btn btn-ghost btn-sm text-error" @click="removing = true">Remove…</button></template>
            <div v-else role="alert" class="alert alert-warning alert-soft flex flex-1 flex-wrap items-center gap-2 text-sm">
              <span class="flex-1">Remove {{ selected.name }}? Only the name {{ selected.domain }} goes; the server is not touched.</span>
              <button class="btn btn-ghost btn-xs" @click="removing = false">Keep</button>
              <button class="btn btn-error btn-xs" @click="remove(selected)">Remove</button>
            </div>
          </div>
        </div>
      </template>

      <div v-else class="drag flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
        <span class="grid size-14 place-items-center rounded-2xl bg-base-200"><svg class="size-7" viewBox="0 0 20 20" fill="currentColor" style="color: var(--c-proxies)"><path fill-rule="evenodd" clip-rule="evenodd" :d="ICONS.proxies" /></svg></span>
        <div class="space-y-1">
          <h2 class="text-lg font-semibold tracking-tight">Names for your other servers</h2>
          <p class="mx-auto max-w-md text-sm opacity-70">
            Give a server elsewhere a name here, such as <code>proxmox-prod.{{ state?.settings.tld || 'localhost' }}</code> for <code>10.10.10.10:8443</code>, and stop remembering IP addresses.
            A proxy forwards to an IP and port; a redirect sends the browser to the real address.
          </p>
        </div>
        <button class="no-drag btn btn-primary btn-sm" @click="dialog = {}">Add a proxy</button>
      </div>
    </main>
  </div>
  <Teleport to="body">
    <dialog v-if="groupDialog" open class="modal modal-open" @keydown.esc="groupDialog = null">
      <form class="modal-box w-80 space-y-3" @submit.prevent="saveGroup">
        <h3 class="font-semibold">{{ groupDialog.mode === 'new' ? 'New group' : 'Rename group' }}</h3>
        <input v-model="groupDialog.name" class="input input-sm w-full" placeholder="e.g. Production" maxlength="40" autofocus />
        <div class="modal-action mt-2">
          <button type="button" class="btn btn-sm btn-ghost" @click="groupDialog = null">Cancel</button>
          <button type="submit" class="btn btn-sm btn-primary" :disabled="!groupDialog.name.trim()">{{ groupDialog.mode === 'new' ? 'Create' : 'Rename' }}</button>
        </div>
      </form>
    </dialog>
  </Teleport>
  <ProxyDialog v-if="dialog" :entry="dialog.entry" @close="dialog = null" @saved="(id) => ((dialog = null), (selectedId = id))" />
</template>
