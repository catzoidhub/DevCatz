<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import type { RemoteGo } from '@shared/types';
import PageHeader from './PageHeader.vue';
import { ICONS } from '../icons';
import UpdateButton from './UpdateButton.vue';
import { attempt, herd, notify, state } from '../store';
import CatMood from './CatMood.vue';


const s = computed(() => state.value!);
const b = computed(() => s.value.go);
const remote = ref<RemoteGo[]>([]);
const loadingRemote = ref(false);

async function loadRemote(refresh = false) {
  loadingRemote.value = true;
  const list = await attempt(() => herd.goRemote(refresh));
  if (list) remote.value = list;
  loadingRemote.value = false;
}
onMounted(() => loadRemote());

const latest = computed(() => remote.value[0]?.version ?? null);
const isInstalled = (v: string) => b.value.installed.some((i) => i.version === v);
const isGoSite = (p: (typeof s.value.projects)[number]) => p.stack.apps.some((a) => a.framework === 'go');
/** Sites (with Go apps) that currently resolve to this version. */
const usedBy = (version: string) => s.value.projects.filter((p) => isGoSite(p) && p.go.version === version).map((p) => p.name);
const goSites = computed(() => s.value.projects.filter(isGoSite));
/** Newer patch of the same minor (1.26.3 → 1.26.9). */

const busy = computed(() => {
  const i = b.value.installing;
  return i && i.phase !== 'done' && i.phase !== 'error' ? i : null;
});
const percent = computed(() => (busy.value?.total ? Math.round((busy.value.received / busy.value.total) * 100) : 0));

async function install(version: string, makeDefault = false) {
  await attempt(() => herd.goInstall(version));
  const fresh = await herd.getState();
  if (!fresh.go.installed.some((i) => i.version === version)) return; // failed; the toast says why
  if (makeDefault) await attempt(() => herd.goSetDefault(version));
  notify('success', `Go ${version} installed`);
}
const setDefault = (version: string | null) => attempt(() => herd.goSetDefault(version));
const uninstall = (version: string) => attempt(() => herd.goUninstall(version));

type Tab = 'installed' | 'available';
const tab = ref<Tab>('installed');
</script>

<template>
  <PageHeader title="Go" :closable="false" tint="runtimes" :icon="ICONS.go">
    <p class="text-xs opacity-60">
      Official toolchains from go.dev (SHA-256 verified). Go apps use the newest installed toolchain that satisfies their
      <code>go.mod</code>, preferring the default.
    </p>
    <div role="tablist" class="seg no-drag mt-3">
      <a role="tab" class="seg-item" :class="{ 'is-active': tab === 'installed' }" @click="tab = 'installed'">Installed</a>
      <a role="tab" class="seg-item" :class="{ 'is-active': tab === 'available' }" @click="tab = 'available'">Available</a>
    </div>
  </PageHeader>

  <section class="site-tab">
    <div v-if="!b.installed.length" role="alert" class="alert alert-warning"><CatMood mood="warning" class="size-7 shrink-0 -my-0.5" />
      <div class="flex-1">
        <div class="font-medium">Go is not installed</div>
        <div class="text-xs opacity-80">{{ goSites.length }} site(s) have Go apps and cannot start until it is installed.</div>
      </div>
      <button v-if="latest" class="btn btn-sm" :disabled="!!busy" @click="install(latest, true)">Install Go {{ latest }}</button>
    </div>

    <template v-if="tab === 'installed'">
    <!-- Installed -->
    <div class="card">
      <div class="card-body">
        <h2 class="font-semibold">Installed</h2>
        <div class="overflow-x-auto rounded-box border border-base-300/60">
          <table class="table table-sm">
            <thead>
              <tr><th>Version</th><th></th><th>Used by</th><th class="text-right">Actions</th></tr>
            </thead>
            <tbody>
              <tr v-for="v in b.installed" :key="v.version + v.source">
                <td class="font-mono" whitespace-nowrap>{{ v.version }}</td>
                <td>
                  <div class="flex flex-wrap items-center gap-1">
                  <span v-if="b.defaultVersion === v.version" class="badge badge-primary badge-soft badge-sm whitespace-nowrap">default</span>
                  <span v-if="v.source === 'system'" class="badge badge-ghost badge-sm whitespace-nowrap" :title="v.binDir">your own</span>
                  </div>
                </td>
                <td class="text-xs opacity-70">{{ usedBy(v.version).join(', ') || '—' }}</td>
                <td class="text-right whitespace-nowrap">
                  <UpdateButton runtime="go" :version="v.version" />
                  <button v-if="b.defaultVersion !== v.version" class="btn btn-xs btn-ghost" @click="setDefault(v.version)">Make default</button>
                  <button v-if="v.source === 'mrcatz'" class="btn btn-xs btn-ghost text-error" @click="uninstall(v.version)">Uninstall</button>
                </td>
              </tr>
              <tr v-if="!b.installed.length">
                <td colspan="4" class="text-center opacity-60">None yet.</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div class="flex items-center gap-2 text-xs">
          <span class="opacity-70">Default:</span>
          <select class="select select-xs w-52" :value="b.defaultVersion ?? ''" @change="setDefault(($event.target as HTMLSelectElement).value || null)">
            <option value="">Your own go (if any)</option>
            <option v-for="v in b.installed.filter((i) => i.source === 'mrcatz')" :key="v.version" :value="v.version">{{ v.version }}</option>
          </select>
        </div>
      </div>
    </div>

    </template>
    <!-- Progress -->
    <div v-if="busy" class="alert">
      <span class="loading loading-spinner loading-sm" />
      <div class="flex-1">
        <div class="text-sm">
          {{ busy.phase === 'extract' ? 'Unpacking' : 'Downloading' }} Go {{ busy.version }}…
          <span v-if="busy.total" class="opacity-60">{{ (busy.received / 1048576).toFixed(1) }} / {{ (busy.total / 1048576).toFixed(1) }} MB</span>
        </div>
        <progress class="progress progress-primary w-full" :value="busy.phase === 'extract' ? 100 : percent" max="100" />
      </div>
    </div>
    <div v-else-if="b.installing?.phase === 'error'" class="alert alert-error text-sm"><CatMood mood="error" class="size-7 shrink-0 -my-0.5" />
      Installing Go {{ b.installing.version }} failed: {{ b.installing.error }}
    </div>

    <template v-if="tab === 'available'">
    <!-- Available -->
    <div class="card">
      <div class="card-body">
        <div class="flex items-center gap-2">
          <h2 class="flex-1 font-semibold">Available</h2>
          <button class="btn btn-ghost btn-xs" :disabled="loadingRemote" @click="loadRemote(true)">
            <span v-if="loadingRemote" class="loading loading-spinner loading-xs" />Refresh
          </button>
        </div>
        <div class="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
          <div v-for="(r, i) in remote" :key="r.version" class="flex items-center gap-3 rounded-box border border-base-300/60 px-3 py-2">
            <div class="min-w-0 flex-1">
              <div class="font-medium">
                Go {{ r.minor }}
                <span v-if="i === 0" class="badge badge-success badge-xs ml-1">latest</span>
              </div>
              <div class="font-mono text-xs opacity-60">{{ r.version }}</div>
            </div>
            <span v-if="isInstalled(r.version)" class="text-xs opacity-60">installed</span>
            <button v-else class="btn btn-xs" :disabled="!!busy" @click="install(r.version)">Install</button>
          </div>
        </div>
        <p class="text-xs opacity-60">
          DevCatz also keeps <code>go</code>/<code>gofmt</code> shims for the default toolchain in
          <code class="selectable">{{ s.node.shimDir }}</code> (same folder as the Node.js shims).
        </p>
      </div>
    </div>
    </template>
  </section>
</template>
