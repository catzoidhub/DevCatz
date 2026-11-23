<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { ProxyState } from '@shared/types';
import { words } from '@shared/platform';
import { attempt, herd, notify, state } from '../store';
import { ICONS } from '../icons';
import ProxyDialog from './ProxyDialog.vue';

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

/** Favourites, then each group by name, then the rest. */
const sections = computed(() => {
  const sort = (l: ProxyState[]) => [...l].sort((a, b) => a.name.localeCompare(b.name));
  const out: { title: string; items: ProxyState[] }[] = [];
  const favs = proxies.value.filter((p) => p.favorite);
  if (favs.length) out.push({ title: '★ Favorites', items: sort(favs) });
  const rest = proxies.value.filter((p) => !p.favorite);
  for (const g of [...new Set(rest.map((p) => p.group).filter(Boolean))].sort()) out.push({ title: g, items: sort(rest.filter((p) => p.group === g)) });
  const loose = rest.filter((p) => !p.group);
  if (loose.length) out.push({ title: out.length ? 'Others' : '', items: sort(loose) });
  return out;
});

const inputOf = (p: ProxyState) => ({ name: p.name, mode: p.mode, protocol: p.protocol, host: p.host, port: p.port, insecure: p.insecure, ownHost: p.ownHost, url: p.url, group: p.group, favorite: p.favorite });
async function toggleFavorite(p: ProxyState) {
  await attempt(() => herd.proxySave({ ...inputOf(p), favorite: !p.favorite }, p.id));
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
      <div class="min-h-0 flex-1 overflow-y-auto pb-2">
        <template v-for="s in sections" :key="s.title">
          <div v-if="s.title" class="flex items-center gap-2 px-4 pt-2 pb-1">
            <span class="label-caps truncate">{{ s.title }}</span>
            <span class="sec-count">{{ s.items.length }}</span>
          </div>
          <ul class="menu w-full px-2 py-0">
            <li v-for="p in s.items" :key="p.id" class="group">
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
          </ul>
        </template>
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
  <ProxyDialog v-if="dialog" :entry="dialog.entry" @close="dialog = null" @saved="(id) => ((dialog = null), (selectedId = id))" />
</template>
