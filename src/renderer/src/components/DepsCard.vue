<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { DepCommand, ProjectState } from '@shared/types';
import { attempt, herd } from '../store';

/**
 * Dependency commands of a site, grouped by the manifests it has: composer
 * install / update / dump-autoload / outdated, <package manager> install /
 * update / outdated, the Python tool's install / update, go mod download /
 * tidy / update. Output goes to the Logs tab; updates ask first.
 */
const props = defineProps<{ project: ProjectState }>();
const emit = defineEmits<{ logs: [] }>();

const commands = ref<DepCommand[]>([]);
async function load() {
  commands.value = (await herd.depCommands(props.project.id).catch(() => [])) ?? [];
}
// Manifests and the package manager can change with a rescan.
watch(() => [props.project.id, props.project.stack.packageManager, props.project.stack.runtime, props.project.stack.depsMissing], load, { immediate: true });

const groups = computed(() => {
  const m = new Map<string, DepCommand[]>();
  for (const c of commands.value) m.set(`${c.tool}|${c.manifest}`, [...(m.get(`${c.tool}|${c.manifest}`) ?? []), c]);
  return [...m.entries()].map(([k, list]) => ({ tool: k.split('|')[0], manifest: k.split('|')[1], list }));
});
const busy = computed(() => props.project.dbTask);
const confirm = ref<DepCommand | null>(null);
const running = ref<string | null>(null);

async function runCmd(c: DepCommand, confirmed = false) {
  if (c.danger && !confirmed) {
    confirm.value = c;
    return;
  }
  confirm.value = null;
  running.value = c.id;
  const ok = await attempt(() => herd.depRun(props.project.id, c.id).then(() => true), `${c.tool} ${c.label} finished`);
  running.value = null;
  if (ok === undefined) emit('logs');
}
</script>

<template>
  <div v-if="groups.length" class="card">
    <div class="card-body">
      <div class="flex items-center gap-2">
        <h2 class="flex-1 font-semibold">Dependencies</h2>
        <span v-if="busy" class="flex items-center gap-1.5 text-xs opacity-70"><span class="loading loading-spinner loading-xs" />{{ busy }}…</span>
        <button class="btn btn-ghost btn-xs" @click="emit('logs')">Output in Logs</button>
      </div>
      <div class="space-y-3">
        <div v-for="g in groups" :key="g.tool + g.manifest" class="flex flex-wrap items-center gap-2">
          <div class="w-44 shrink-0">
            <div class="font-mono text-sm">{{ g.tool }}</div>
            <div class="text-xs opacity-60">{{ g.manifest }}</div>
          </div>
          <button
            v-for="c in g.list"
            :key="c.id"
            class="btn btn-sm"
            :class="{ 'btn-primary': c.label === 'install', 'btn-ghost text-warning': c.danger }"
            :disabled="!!busy"
            :title="c.command"
            @click="runCmd(c)"
          >
            <span v-if="running === c.id" class="loading loading-spinner loading-xs" />{{ c.label }}
          </button>
        </div>
      </div>
      <p class="text-xs opacity-60">
        Runs in the project folder with this site's PHP / Node / Bun / Python / Go (hover a button for the exact command). "update" changes lock files and
        versions, so it asks first.
      </p>
    </div>

    <dialog v-if="confirm" open class="modal modal-open" @keydown.esc="confirm = null">
      <div class="modal-box w-[28rem] space-y-3">
        <h3 class="text-lg font-semibold">Run {{ confirm.tool }} {{ confirm.label }}?</h3>
        <p class="text-sm opacity-70">It upgrades packages within the constraints of {{ confirm.manifest }} and rewrites the lock file. Commit or stash first if you want to undo it.</p>
        <code class="block rounded-md bg-base-200/70 px-2 py-1 text-xs">{{ confirm.command }}</code>
        <div class="modal-action">
          <button class="btn btn-ghost btn-sm" @click="confirm = null">Cancel</button>
          <button class="btn btn-warning btn-sm" @click="runCmd(confirm, true)">Run</button>
        </div>
      </div>
      <div class="modal-backdrop" @click="confirm = null" />
    </dialog>
  </div>
</template>
