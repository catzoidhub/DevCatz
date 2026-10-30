<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import type { RemoteBun } from '@shared/types';
import PageHeader from './PageHeader.vue';
import { ICONS } from '../icons';
import UpdateButton from './UpdateButton.vue';
import { attempt, herd, notify, state } from '../store';
import CatMood from './CatMood.vue';


const s = computed(() => state.value!);
const b = computed(() => s.value.bun);
const remote = ref<RemoteBun[]>([]);
const loadingRemote = ref(false);

async function loadRemote(refresh = false) {
  loadingRemote.value = true;
  const list = await attempt(() => herd.bunRemote(refresh));
  if (list) remote.value = list;
  loadingRemote.value = false;
}
onMounted(() => loadRemote());

const latest = computed(() => remote.value[0]?.version ?? null);
const isInstalled = (v: string) => b.value.installed.some((i) => i.version === v);
/** Sites (using Bun) that currently resolve to this version. */
const usedBy = (version: string) =>
  s.value.projects.filter((p) => p.stack.packageManager === 'bun' && p.bun.version === version).map((p) => p.name);
const bunSites = computed(() => s.value.projects.filter((p) => p.stack.packageManager === 'bun'));

const busy = computed(() => {
  const i = b.value.installing;
  return i && i.phase !== 'done' && i.phase !== 'error' ? i : null;
});
const percent = computed(() => (busy.value?.total ? Math.round((busy.value.received / busy.value.total) * 100) : 0));

async function install(version: string, makeDefault = false) {
  await attempt(() => herd.bunInstall(version));
  const fresh = await herd.getState();
  if (!fresh.bun.installed.some((i) => i.version === version)) return; // failed; the toast says why
  if (makeDefault) await attempt(() => herd.bunSetDefault(version));
  notify('success', `Bun ${version} installed`);
}
const setDefault = (version: string | null) => attempt(() => herd.bunSetDefault(version));
const uninstall = (version: string) => attempt(() => herd.bunUninstall(version));

type Tab = 'installed' | 'available';
const tab = ref<Tab>('installed');
</script>

<template>
  <PageHeader title="Bun" :closable="false" tint="runtimes" :icon="ICONS.bun">
    <p class="text-xs opacity-60">
      Official releases from GitHub (SHA-256 verified). Bun sites use the version pinned in <code>packageManager</code>, else the
      default.
    </p>
    <div role="tablist" class="seg no-drag mt-3">
      <a role="tab" class="seg-item" :class="{ 'is-active': tab === 'installed' }" @click="tab = 'installed'">Installed</a>
      <a role="tab" class="seg-item" :class="{ 'is-active': tab === 'available' }" @click="tab = 'available'">Available</a>
    </div>
  </PageHeader>

  <section class="site-tab">
    <div v-if="!b.installed.length" role="alert" class="alert alert-warning flex flex-wrap"><CatMood mood="warning" class="size-7 shrink-0 -my-0.5" />
      <div class="min-w-48 flex-1">
        <div class="font-medium">Bun is not installed</div>
        <div class="text-xs opacity-80">{{ bunSites.length }} site(s) use Bun and cannot start until it is installed.</div>
      </div>
      <button v-if="latest" class="btn btn-sm shrink-0" :disabled="!!busy" @click="install(latest, true)">Install Bun {{ latest }}</button>
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
                  <UpdateButton runtime="bun" :version="v.version" />
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
            <option value="">Your own bun (if any)</option>
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
          {{ busy.phase === 'extract' ? 'Unpacking' : 'Downloading' }} Bun {{ busy.version }}…
          <span v-if="busy.total" class="opacity-60">{{ (busy.received / 1048576).toFixed(1) }} / {{ (busy.total / 1048576).toFixed(1) }} MB</span>
        </div>
        <progress class="progress progress-primary w-full" :value="busy.phase === 'extract' ? 100 : percent" max="100" />
      </div>
    </div>
    <div v-else-if="b.installing?.phase === 'error'" class="alert alert-error text-sm"><CatMood mood="error" class="size-7 shrink-0 -my-0.5" />
      Installing Bun {{ b.installing.version }} failed: {{ b.installing.error }}
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
          <div v-for="(r, i) in remote.slice(0, 12)" :key="r.version" class="flex items-center gap-3 rounded-box border border-base-300/60 px-3 py-2">
            <div class="min-w-0 flex-1">
              <div class="font-medium">
                Bun {{ r.version }}
                <span v-if="i === 0" class="badge badge-success badge-xs ml-1">latest</span>
              </div>
              <div class="font-mono text-xs opacity-60">{{ r.date }}</div>
            </div>
            <span v-if="isInstalled(r.version)" class="text-xs opacity-60">installed</span>
            <button v-else class="btn btn-xs" :disabled="!!busy" @click="install(r.version)">Install</button>
          </div>
        </div>
        <p class="text-xs opacity-60">
          DevCatz also keeps a <code>bun</code>/<code>bunx</code> shim for the default version in
          <code class="selectable">{{ s.node.shimDir }}</code> (same folder as the Node.js shims).
        </p>
      </div>
    </div>
    </template>
  </section>
</template>
