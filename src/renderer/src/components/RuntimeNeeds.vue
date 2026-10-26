<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { NodeInstallProgress, ProjectState, RuntimeNeed } from '@shared/types';
import CatMood from './CatMood.vue';
import { attempt, herd, notify, state } from '../store';

/**
 * Overview: a runtime the site needs that is not on this Mac yet (a fresh DevCatz, a PHP site and no PHP; npm and no
 * Node.js; go.mod and no Go; bun.lock and no Bun) — one click installs the version the project asks for, then Start.
 */
const props = defineProps<{ site: ProjectState }>();
const needs = ref<RuntimeNeed[]>([]);
const busy = ref<RuntimeNeed['kind'] | null>(null);

const NAMES: Record<RuntimeNeed['kind'], string> = { php: 'PHP', node: 'Node.js', go: 'Go', bun: 'Bun' };
const installing = (k: RuntimeNeed['kind']): NodeInstallProgress | null => state.value?.[k].installing ?? null;
// Look again whenever a runtime is installed or removed anywhere (the Runtimes page too).
const installedKey = computed(() => {
  const s = state.value;
  return s ? [s.php.installed.length, s.node.installed.length, s.node.system, s.go.installed.length, s.bun.installed.length].join('|') : '';
});
async function load() {
  needs.value = (await herd.siteRuntimeNeeds(props.site.id).catch(() => [])) ?? [];
}
watch(() => `${props.site.id}|${installedKey.value}|${props.site.stack.runtime}|${props.site.stack.packageManager}`, () => void load(), { immediate: true });

const short = (v: string | null) => (v ?? '').replace(/^v/, '');
function why(n: RuntimeNeed): string {
  const name = NAMES[n.kind];
  if (!n.current) return `${name} is not installed, so this site cannot ${n.kind === 'php' ? 'be served' : 'start'} yet.`;
  return `${n.from ?? 'The project'} asks for ${name} ${n.spec}; this Mac has ${short(n.current)}, which DevCatz uses for now.`;
}
async function install(n: RuntimeNeed) {
  if (!n.version) return;
  busy.value = n.kind;
  const v = n.version;
  const run = { php: () => herd.phpInstall(v), node: () => herd.nodeInstall(v), go: () => herd.goInstall(v), bun: () => herd.bunInstall(v) }[n.kind];
  const ok = await attempt(() => run().then(() => true));
  busy.value = null;
  if (ok) notify('success', `${NAMES[n.kind]} ${short(v)} installed${props.site.stack.runtime === 'php' ? '' : ' — Start the site when you are ready'}`);
  await load();
}
const pct = (p: NodeInstallProgress | null) => (p && p.total ? Math.round((p.received / p.total) * 100) : null);
</script>

<template>
  <div v-for="n in needs" :key="n.kind" role="alert" class="alert" :class="n.current ? 'alert-info alert-soft' : 'alert-warning'">
    <CatMood :mood="n.current ? 'info' : 'warning'" class="size-7 shrink-0 -my-0.5" />
    <div class="min-w-0 flex-1">
      <div class="font-medium">{{ n.current ? `${NAMES[n.kind]} ${n.spec} is not installed` : `${NAMES[n.kind]} is needed` }}</div>
      <div class="text-xs opacity-80">{{ why(n) }}</div>
      <div v-if="busy === n.kind || installing(n.kind)" class="mt-1.5 flex items-center gap-2 text-xs">
        <progress class="progress progress-primary w-40" :value="pct(installing(n.kind)) ?? undefined" max="100" />
        <span class="opacity-70">{{ installing(n.kind)?.detail ?? (installing(n.kind)?.phase === 'extract' ? 'Unpacking…' : pct(installing(n.kind)) !== null ? `${pct(installing(n.kind))}%` : 'Starting…') }}</span>
      </div>
    </div>
    <button v-if="n.version" class="btn btn-sm" :class="n.current ? '' : 'btn-primary'" :disabled="!!busy || !!installing(n.kind)" @click="install(n)">
      <span v-if="busy === n.kind" class="loading loading-spinner loading-xs" />Install {{ NAMES[n.kind] }} {{ short(n.version) }}
    </button>
    <span v-else class="text-xs opacity-70">Install it on the {{ NAMES[n.kind] }} page (Runtimes).</span>
  </div>
</template>
