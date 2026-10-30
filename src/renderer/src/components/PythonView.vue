<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import type { RemotePython } from '@shared/types';
import PageHeader from './PageHeader.vue';
import { STACK_ICONS } from '../stackicons';
import { attempt, herd, notify, state } from '../store';
import CatMood from './CatMood.vue';

/** Python versions through uv (Astral): uv itself, installed CPythons, the ones uv can download, the default. */

const s = computed(() => state.value!);
const b = computed(() => s.value.python);
const remote = ref<RemotePython[]>([]);
const loadingRemote = ref(false);

async function loadRemote() {
  if (!b.value.uv) return;
  loadingRemote.value = true;
  const list = await attempt(() => herd.pythonRemote());
  if (list) remote.value = list;
  loadingRemote.value = false;
}
onMounted(loadRemote);

const isInstalled = (v: string) => b.value.installed.some((i) => i.version === v);
const pySites = computed(() => s.value.projects.filter((p) => p.stack.runtime === 'python'));
/** A venv records 3.13 or 3.13.16 (pyvenv.cfg), so a short version matches the full one. */
const usedBy = (version: string) => pySites.value.filter((p) => p.python.version && (version === p.python.version || version.startsWith(`${p.python.version}.`))).map((p) => p.name);

const busy = computed(() => {
  const i = b.value.installing;
  return i && i.phase !== 'done' && i.phase !== 'error' ? i : null;
});
const percent = computed(() => (busy.value?.total ? Math.round((busy.value.received / busy.value.total) * 100) : 0));

async function installUv() {
  if (await attempt(() => herd.uvInstall().then(() => true))) {
    notify('success', 'uv installed');
    await loadRemote();
  }
}
async function install(version: string) {
  if (await attempt(() => herd.pythonInstall(version).then(() => true))) notify('success', `Python ${version} installed`);
}
const setDefault = (version: string | null) => attempt(() => herd.pythonSetDefault(version));
const uninstall = (version: string) => attempt(() => herd.pythonUninstall(version));

type Tab = 'installed' | 'available';
const tab = ref<Tab>('installed');
</script>

<template>
  <PageHeader title="Python" :closable="false" tint="runtimes" :icon="STACK_ICONS.python.d" icon-view-box="0 0 24 24">
    <p class="text-xs opacity-60">
      Managed with <a class="link" @click="herd.openUrl('https://docs.astral.sh/uv/')">uv</a>: CPython builds (python-build-standalone) in DevCatz’s folder,
      a <code>.venv</code> per site, dependencies from pyproject.toml, requirements.txt or Pipfile.
    </p>
    <div role="tablist" class="seg no-drag mt-3">
      <a role="tab" class="seg-item" :class="{ 'is-active': tab === 'installed' }" @click="tab = 'installed'">Installed</a>
      <a role="tab" class="seg-item" :class="{ 'is-active': tab === 'available' }" @click="tab = 'available'">Available</a>
    </div>
  </PageHeader>

  <section class="site-tab">
    <div v-if="!b.uv" role="alert" class="alert flex flex-wrap">
      <div class="min-w-48 flex-1">
        <div class="font-medium">uv is not installed yet</div>
        <div class="text-xs opacity-80">
          DevCatz downloads Astral’s uv (one small binary, SHA-256 checked); it then installs Pythons and each site’s packages. {{ pySites.length }} Python site(s) linked.
        </div>
      </div>
      <button class="btn btn-sm btn-primary shrink-0" :disabled="!!busy" @click="installUv">Install uv</button>
    </div>

    <!-- Progress -->
    <div v-if="busy" class="alert">
      <span class="loading loading-spinner loading-sm" />
      <div class="flex-1">
        <div class="text-sm">
          Installing {{ busy.version.startsWith('uv') ? busy.version : `Python ${busy.version}` }}…
          <span v-if="busy.total" class="opacity-60">{{ (busy.received / 1048576).toFixed(1) }} / {{ (busy.total / 1048576).toFixed(1) }} MB</span>
          <span v-else-if="busy.detail" class="font-mono text-xs opacity-60">{{ busy.detail }}</span>
        </div>
        <progress class="progress progress-primary w-full" :value="busy.total ? percent : undefined" max="100" />
      </div>
    </div>
    <div v-else-if="b.installing?.phase === 'error'" class="alert alert-error text-sm"><CatMood mood="error" class="size-7 shrink-0 -my-0.5" />Installing {{ b.installing.version }} failed: {{ b.installing.error }}</div>

    <template v-if="tab === 'installed'">
    <!-- Installed -->
    <div class="card">
      <div class="card-body">
        <div class="flex items-center gap-2">
          <h2 class="flex-1 font-semibold">Installed</h2>
          <span v-if="b.uv" class="badge badge-ghost badge-sm font-mono">uv {{ b.uv }}</span>
        </div>
        <div class="overflow-x-auto rounded-box border border-base-300/60">
          <table class="table table-sm">
            <thead>
              <tr><th>Version</th><th></th><th>Used by</th><th class="text-right">Actions</th></tr>
            </thead>
            <tbody>
              <tr v-for="v in b.installed" :key="v.version + v.source">
                <td class="font-mono whitespace-nowrap">{{ v.version }}</td>
                <td>
                  <div class="flex flex-wrap items-center gap-1">
                    <span v-if="b.defaultVersion === v.version" class="badge badge-primary badge-soft badge-sm whitespace-nowrap">default</span>
                    <span v-if="v.source === 'system'" class="badge badge-ghost badge-sm whitespace-nowrap" :title="v.path">your own</span>
                  </div>
                </td>
                <td class="text-xs opacity-70">{{ usedBy(v.version).join(', ') || '—' }}</td>
                <td class="text-right whitespace-nowrap">
                  <button v-if="b.defaultVersion !== v.version" class="btn btn-xs btn-ghost" @click="setDefault(v.version)">Make default</button>
                  <button v-if="v.source === 'mrcatz'" class="btn btn-xs btn-ghost text-error" @click="uninstall(v.version)">Uninstall</button>
                </td>
              </tr>
              <tr v-if="!b.installed.length">
                <td colspan="4" class="text-center opacity-60">{{ b.uv ? 'None yet.' : 'Install uv first.' }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p class="text-xs opacity-60">
          A site’s venv is created with the version it asks for (<code>.python-version</code> / <code>requires-python</code>), else the default; a missing version is fetched
          by uv when dependencies are installed.
        </p>
      </div>
    </div>

    </template>
    <template v-if="tab === 'available'">
    <!-- Available -->
    <div v-if="b.uv" class="card">
      <div class="card-body">
        <div class="flex items-center gap-2">
          <h2 class="flex-1 font-semibold">Available</h2>
          <button class="btn btn-ghost btn-xs" :disabled="loadingRemote" @click="loadRemote">
            <span v-if="loadingRemote" class="loading loading-spinner loading-xs" />Refresh
          </button>
        </div>
        <div class="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
          <div v-for="(r, i) in remote" :key="r.version" class="flex items-center gap-3 rounded-box border border-base-300/60 px-3 py-2">
            <div class="min-w-0 flex-1">
              <div class="font-medium">
                Python {{ r.minor }}
                <span v-if="i === 0" class="badge badge-success badge-xs ml-1">latest</span>
              </div>
              <div class="font-mono text-xs opacity-60">{{ r.version }}</div>
            </div>
            <span v-if="isInstalled(r.version)" class="text-xs opacity-60">installed</span>
            <button v-else class="btn btn-xs" :disabled="!!busy" @click="install(r.version)">Install</button>
          </div>
        </div>
      </div>
    </div>
    </template>
  </section>
</template>
