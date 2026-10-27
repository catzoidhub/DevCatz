<script setup lang="ts">
import PageHeader from './PageHeader.vue';
import { ICONS } from '../icons';
import UpdateButton from './UpdateButton.vue';
import { computed, onMounted, ref } from 'vue';
import type { RemoteNode } from '@shared/types';
import { attempt, herd, notify, state } from '../store';
import CatMood from './CatMood.vue';
import { isWin } from '../platform';

const s = computed(() => state.value!);
const n = computed(() => s.value.node);
const remote = ref<RemoteNode[]>([]);
const loadingRemote = ref(false);

async function loadRemote(refresh = false) {
  loadingRemote.value = true;
  const list = await attempt(() => herd.nodeRemote(refresh));
  if (list) remote.value = list;
  loadingRemote.value = false;
}
onMounted(() => loadRemote());

const lts = (major: number) => remote.value.find((r) => r.major === major)?.lts ?? null;

/** Sites currently resolving to this version. */
const usedBy = (version: string) => s.value.projects.filter((p) => p.node.version === version).map((p) => p.name);

const busy = computed(() => {
  const i = n.value.installing;
  return i && i.phase !== 'done' && i.phase !== 'error' ? i : null;
});
const percent = computed(() => (busy.value?.total ? Math.round((busy.value.received / busy.value.total) * 100) : 0));

async function install(version: string, makeDefault = false) {
  await attempt(() => herd.nodeInstall(version));
  const fresh = await herd.getState();
  if (!fresh.node.installed.some((i) => i.version === version)) return; // failed; the toast says why
  if (makeDefault) await attempt(() => herd.nodeSetDefault(version));
  notify('success', `Node ${version} installed`);
}

const setDefault = (version: string | null) => attempt(() => herd.nodeSetDefault(version));
const uninstall = (version: string) => attempt(() => herd.nodeUninstall(version));

const pathLine = computed(() => `export PATH="${n.value.shimDir}:$PATH"`);
const pathBusy = ref(false);
async function setShimPath(on: boolean) {
  pathBusy.value = true;
  if (await attempt(() => herd.shimPathSet(on).then(() => true))) notify('success', on ? 'Added to your Path. Open a new terminal to use it.' : 'Removed from your Path.');
  pathBusy.value = false;
}
async function copyPath() {
  await navigator.clipboard.writeText(pathLine.value);
  notify('info', 'Copied. Add it to the end of ~/.zshrc, then open a new terminal.');
}

type Tab = 'installed' | 'available' | 'terminal';
const tab = ref<Tab>('installed');
</script>

<template>
  <PageHeader title="Node.js" :closable="false" tint="runtimes" :icon="ICONS.hexagon">
    <p class="text-xs opacity-60">
      Official builds from nodejs.org (SHA-256 verified). Sites use their own pick, then <code>.nvmrc</code> / <code>engines.node</code>,
      then the default.
    </p>
  
    <div role="tablist" class="seg no-drag mt-3">
      <a role="tab" class="seg-item" :class="{ 'is-active': tab === 'installed' }" @click="tab = 'installed'">Installed</a>
      <a role="tab" class="seg-item" :class="{ 'is-active': tab === 'available' }" @click="tab = 'available'">Available</a>
      <a role="tab" class="seg-item" :class="{ 'is-active': tab === 'terminal' }" @click="tab = 'terminal'">Terminal</a>
    </div>
  </PageHeader>

  <section class="site-tab">
    <template v-if="tab === 'installed'">
    <!-- Installed -->
    <div class="card">
      <div class="card-body">
        <div class="flex items-center gap-2">
          <h2 class="flex-1 font-semibold">Installed</h2>
          <span class="text-xs opacity-60">Shell: {{ n.system ?? 'no node on PATH' }}</span>
        </div>

        <div class="overflow-x-auto rounded-box border border-base-300/60">
          <table class="table table-sm">
            <thead>
              <tr><th>Version</th><th></th><th>Used by</th><th class="text-right">Actions</th></tr>
            </thead>
            <tbody>
              <tr v-for="v in n.installed" :key="v.version">
                <td class="whitespace-nowrap">
                  <div class="font-mono">{{ v.version }}</div>
                  <span v-if="lts(v.major)" class="badge badge-ghost badge-xs whitespace-nowrap">LTS {{ lts(v.major) }}</span>
                </td>
                <td>
                  <div class="flex flex-wrap items-center gap-1">
                  <span v-if="n.defaultVersion === v.version" class="badge badge-primary badge-soft badge-sm whitespace-nowrap">default</span>
                  <span v-if="v.source === 'herd'" class="badge badge-ghost badge-sm whitespace-nowrap" title="Installed by Laravel Herd's nvm; DevCatz only uses it">Laravel Herd</span>
                  </div>
                </td>
                <td class="text-xs opacity-70">{{ usedBy(v.version).join(', ') || '—' }}</td>
                <td class="text-right whitespace-nowrap">
                  <UpdateButton runtime="node" :version="v.version" />
                  <button v-if="n.defaultVersion !== v.version" class="btn btn-xs btn-ghost" @click="setDefault(v.version)">Make default</button>
                  <button v-if="v.source === 'mrcatz'" class="btn btn-xs btn-ghost text-error" @click="uninstall(v.version)">Uninstall</button>
                </td>
              </tr>
              <tr v-if="!n.installed.length">
                <td colspan="4" class="text-center opacity-60">No versions yet. Install one below.</td>
              </tr>
            </tbody>
          </table>
        </div>

        <div class="flex items-center gap-2 text-xs">
          <span class="opacity-70">Default:</span>
          <select class="select select-xs w-52" :value="n.defaultVersion ?? ''" @change="setDefault(($event.target as HTMLSelectElement).value || null)">
            <option value="">Shell's node ({{ n.system ?? 'none' }})</option>
            <option v-for="v in n.installed" :key="v.version" :value="v.version">{{ v.version }}</option>
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
          {{ busy.phase === 'extract' ? 'Unpacking' : 'Downloading' }} Node {{ busy.version }}…
          <span v-if="busy.total" class="opacity-60">{{ (busy.received / 1048576).toFixed(1) }} / {{ (busy.total / 1048576).toFixed(1) }} MB</span>
        </div>
        <progress class="progress progress-primary w-full" :value="busy.phase === 'extract' ? 100 : percent" max="100" />
      </div>
    </div>
    <div v-else-if="n.installing?.phase === 'error'" class="alert alert-error text-sm"><CatMood mood="error" class="size-7 shrink-0 -my-0.5" />
      Installing {{ n.installing.version }} failed: {{ n.installing.error }}
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
          <div v-for="r in remote" :key="r.version" class="flex items-center gap-3 rounded-box border border-base-300/60 px-3 py-2">
            <div class="min-w-0 flex-1">
              <div class="font-medium">
                Node {{ r.major }}
                <span v-if="r.lts" class="badge badge-success badge-xs ml-1">LTS {{ r.lts }}</span>
                <span v-else class="badge badge-ghost badge-xs ml-1">Current</span>
              </div>
              <div class="font-mono text-xs opacity-60">{{ r.version }} · {{ r.date }}</div>
            </div>
            <span v-if="n.installed.some((i) => i.version === r.version)" class="text-xs opacity-60">installed</span>
            <button v-else class="btn btn-xs" :disabled="!!busy" @click="install(r.version)">Install</button>
          </div>
        </div>
      </div>
    </div>

    </template>
    <template v-if="tab === 'terminal'">
    <!-- Terminal -->
    <div class="card">
      <div class="card-body gap-2">
        <h2 class="font-semibold">
          Use the default in your terminal
          <span class="badge badge-sm ml-1" :class="n.shimOnPath ? 'badge-success' : 'badge-ghost'">{{ n.shimOnPath ? 'active' : 'not on PATH' }}</span>
        </h2>
        <template v-if="isWin">
          <p class="text-xs opacity-70">
            DevCatz keeps <code>node</code>, <code>npm</code>, <code>npx</code> and <code>corepack</code> shims for the default version — and
            <code>bun</code>, <code>go</code>, <code>php</code>, <code>composer</code> for theirs — in one folder. Add it to your own Path (no
            administrator rights) and new terminals (Windows Terminal, PowerShell, cmd, VS Code) use them.
          </p>
          <p class="text-xs opacity-70">
            <code class="selectable">{{ n.shimDir }}</code>
          </p>
          <p class="text-xs opacity-60">A Node installed for all users (Program Files) still comes first: Windows puts the system Path before yours.</p>
          <div class="flex gap-2">
            <button v-if="!n.shimOnPath" class="btn btn-sm btn-primary" :disabled="pathBusy" @click="setShimPath(true)">
              <span v-if="pathBusy" class="loading loading-spinner loading-xs" />Add to my Path
            </button>
            <button v-else class="btn btn-sm btn-outline" :disabled="pathBusy" @click="setShimPath(false)">Remove from my Path</button>
          </div>
        </template>
        <p v-if="!isWin" class="text-xs opacity-70">
          DevCatz keeps <code>node</code>, <code>npm</code>, <code>npx</code> and <code>corepack</code> shims for the default version. To use them in
          your terminal, add this line to the <b>end</b> of <code>~/.zshrc</code>. It then takes precedence over a node from another tool (nvm, Homebrew …).
        </p>
        <div v-if="!isWin" class="join">
          <code class="selectable join-item flex-1 truncate rounded-l-box bg-base-200 px-3 py-1.5 text-xs">{{ pathLine }}</code>
          <button class="btn btn-sm join-item" @click="copyPath">Copy</button>
        </div>
      </div>
    </div>
    </template>
  </section>
</template>
