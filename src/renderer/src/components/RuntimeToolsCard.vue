<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { RuntimeToolRuntime, RuntimeToolState } from '@shared/types';
import { attempt, herd, notify, state } from '../store';
import ConfirmDialog from './ConfirmDialog.vue';

/**
 * Runtimes → Tools for Node.js, Go and Python: the CLIs their frameworks are used with, installed into DevCatz's tools
 * folder (npm -g --prefix, go install, uv tool install), with the newest release from the registry and Update.
 */
const props = defineProps<{ runtime: RuntimeToolRuntime; ready: boolean; missing: string }>();

const list = ref<RuntimeToolState[] | null>(null);
const checking = ref(false);
const busy = ref<string | null>(null);
async function load(refresh = false) {
  checking.value = refresh;
  list.value = (await attempt(() => herd.toolsState(props.runtime, refresh))) ?? list.value;
  checking.value = false;
}
watch(() => props.runtime, () => void load(), { immediate: true });

const updates = computed(() => list.value?.filter((t) => t.update) ?? []);
/** The install / update running on this page, with the last line npm / go / uv printed. */
const task = computed(() => (state.value?.toolTask?.runtime === props.runtime ? state.value.toolTask : null));
const HOW: Record<RuntimeToolRuntime, string> = {
  node: 'npm install -g into DevCatz’s tools folder with the default Node.js, so they stay when you switch versions.',
  go: 'go install …@latest with the default Go; the binaries go to DevCatz’s tools folder.',
  python: 'uv tool install: each tool in its own environment, the commands in DevCatz’s tools folder.',
};

async function install(t: RuntimeToolState, update = false) {
  busy.value = t.id;
  const ok = await attempt(() => herd.toolInstall(t.id).then(() => true));
  busy.value = null;
  if (ok) notify('success', update ? `${t.label} updated` : `${t.label} installed`);
  await load();
}
async function updateAll() {
  for (const t of updates.value) await install(t, true);
}
const asking = ref<RuntimeToolState | null>(null);
async function uninstall(t: RuntimeToolState) {
  asking.value = null;
  busy.value = t.id;
  await attempt(() => herd.toolUninstall(t.id), `${t.label} removed`);
  busy.value = null;
  await load();
}
</script>

<template>
  <div class="card">
    <div class="card-body gap-3">
      <div class="flex flex-wrap items-center gap-2">
        <h2 class="flex-1 font-semibold">Framework tools</h2>
        <button v-if="updates.length > 1" class="btn btn-primary btn-xs" :disabled="!!busy" @click="updateAll">Update all ({{ updates.length }})</button>
        <button class="btn btn-ghost btn-xs" :disabled="checking || !!busy" title="Ask the registries for the newest releases" @click="load(true)">
          <span v-if="checking" class="loading loading-spinner loading-xs" />Check for updates
        </button>
      </div>
      <p class="text-xs opacity-60">{{ HOW[runtime] }} Sites find them, and so do terminals that use DevCatz’s shims.</p>
      <div v-if="!ready" role="alert" class="alert alert-warning alert-soft text-sm">{{ missing }}</div>
      <div v-if="task" class="alert">
        <span class="loading loading-spinner loading-sm" />
        <div class="min-w-0 flex-1">
          <div class="text-sm">Installing {{ task.label }}…<span class="opacity-60"> a minute or two{{ runtime === 'go' ? ' (Go compiles it)' : '' }}</span></div>
          <div class="truncate font-mono text-xs opacity-60">{{ task.detail }}</div>
          <progress class="progress progress-primary w-full" />
        </div>
        <button class="btn btn-ghost btn-sm" @click="herd.installCancel(`tool:${task.id}`)">Cancel</button>
      </div>
      <div v-if="list" class="grid gap-2 lg:grid-cols-2">
        <div v-for="t in list" :key="t.id" class="flex flex-wrap items-center gap-3 rounded-box border border-base-300/60 px-3 py-2">
          <div class="min-w-0 flex-1 basis-48">
            <div class="flex flex-wrap items-center gap-1.5">
              <span class="font-medium">{{ t.label }}</span>
              <span v-if="(t.installed || t.onPath) && t.version" class="badge badge-ghost badge-sm font-mono">{{ t.version }}</span>
              <span v-if="t.update" class="badge badge-info badge-soft badge-sm font-mono" :title="`${t.latest} is out`">→ {{ t.latest }}</span>
              <span v-if="t.neededBy.length" class="badge badge-warning badge-soft badge-sm" :title="t.neededBy.join(', ')">needed by {{ t.neededBy.length }} site{{ t.neededBy.length === 1 ? '' : 's' }}</span>
            </div>
            <div class="text-xs opacity-60">{{ t.why }}</div>
            <div class="truncate font-mono text-[11px] opacity-40" :title="t.externalPath ?? t.pkg">{{ !t.installed && t.externalPath ? t.externalPath : t.pkg }}</div>
          </div>
          <span v-if="busy === t.id" class="loading loading-spinner loading-sm" />
          <div v-else-if="t.installed" class="flex shrink-0 items-center gap-1">
            <button v-if="t.update" class="btn btn-primary btn-xs" :disabled="!!busy || !ready" @click="install(t, true)">Update</button>
            <span v-else class="text-xs opacity-60">installed</span>
            <button class="btn btn-ghost btn-xs text-error" :disabled="!!busy" @click="asking = t">Remove</button>
          </div>
          <!-- The user's own copy (Homebrew, corepack, npm -g, go install …): it is what runs; DevCatz leaves it alone. -->
          <span v-else-if="t.onPath" class="text-xs opacity-60" :title="`${t.externalPath} — installed outside DevCatz; update it the way you installed it`">your own copy</span>
          <button v-else class="btn btn-xs" :class="{ 'btn-primary': t.neededBy.length }" :disabled="!!busy || !ready" @click="install(t)">Install</button>
        </div>
      </div>
      <div v-else class="flex items-center gap-2 text-sm opacity-60"><span class="loading loading-spinner loading-sm" />Reading the tools…</div>

    </div>
    <ConfirmDialog
      v-if="asking"
      :title="`Remove ${asking.label}?`"
      :text="`Removes ${asking.label} ${asking.version ?? ''} from DevCatz's tools folder. Sites and terminals that run it will not find it any more (unless you have your own copy).`"
      confirm="Remove"
      tone="error"
      @ok="uninstall(asking)"
      @cancel="asking = null"
    />
  </div>
</template>
