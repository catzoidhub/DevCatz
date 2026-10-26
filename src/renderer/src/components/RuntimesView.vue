<script setup lang="ts">
import { computed, onMounted } from 'vue';
import { herd } from '../store';
import BunView from './BunView.vue';
import GoView from './GoView.vue';
import NodeView from './NodeView.vue';
import PhpView from './PhpView.vue';
import PythonView from './PythonView.vue';
import { ICONS } from '../icons';
import { STACK_ICONS } from '../stackicons';
import { state } from '../store';

/**
 * Runtimes (rail): the languages DevCatz installs and runs sites with. The
 * list on the left, the chosen runtime's versions and settings on the right.
 */
export type RuntimeId = 'php' | 'go' | 'python' | 'bun' | 'node';
const current = defineModel<RuntimeId>({ required: true });

const s = computed(() => state.value!);
const updatesFor = (r: string) => s.value.updates.list.filter((u) => u.runtime === r).length;
const sitesOn = (r: 'php' | 'go' | 'python' | 'node') => s.value.projects.filter((p) => p.stack.runtime === r).length;
const plural = (n: number) => `${n} site${n === 1 ? '' : 's'}`;

const items = computed(() => [
  {
    id: 'php' as const,
    label: 'PHP',
    icon: ICONS.php,
    box: '0 0 20 20',
    version: s.value.php.defaultVersion ?? s.value.php.installed[0]?.version ?? null,
    detail: `${s.value.php.installed.length} installed · ${plural(sitesOn('php'))}`,
    updates: updatesFor('php'),
  },
  {
    id: 'python' as const,
    label: 'Python',
    icon: STACK_ICONS.python.d,
    box: '0 0 24 24',
    version: s.value.python.defaultVersion ?? s.value.python.installed[0]?.version ?? null,
    detail: s.value.python.uv ? `uv ${s.value.python.uv} · ${plural(sitesOn('python'))}` : 'uv not installed',
    updates: 0,
  },
  {
    id: 'node' as const,
    label: 'Node.js',
    icon: ICONS.hexagon,
    box: '0 0 20 20',
    version: s.value.node.defaultVersion ?? s.value.node.system ?? null,
    detail: plural(sitesOn('node')),
    updates: updatesFor('node'),
  },
  {
    id: 'bun' as const,
    label: 'Bun',
    icon: ICONS.bun,
    box: '0 0 20 20',
    version: s.value.bun.defaultVersion ?? s.value.bun.installed[0]?.version ?? null,
    detail: 'Runtime and package manager',
    updates: updatesFor('bun'),
  },
  {
    id: 'go' as const,
    label: 'Go',
    icon: ICONS.go,
    box: '0 0 20 20',
    version: s.value.go.defaultVersion ?? s.value.go.installed[0]?.version ?? null,
    detail: `${s.value.go.installed.length} installed · ${plural(sitesOn('go'))}`,
    updates: updatesFor('go'),
  },
]);
// Versions added or removed outside DevCatz (Laravel Herd uninstalled, Homebrew …) are picked up on opening the page.
onMounted(() => void herd.refreshRuntimes().catch(() => undefined));
</script>

<template>
  <aside class="flex w-64 shrink-0 flex-col border-r border-base-300/60 bg-base-200/80">
    <div class="drag title-strip h-14 shrink-0"><span class="nav-hole" aria-hidden="true" /></div>
    <div class="px-4 pb-1"><span class="label-caps">Runtimes</span></div>
    <ul class="menu w-full flex-1 flex-nowrap gap-0.5 overflow-y-auto px-2">
      <li v-for="r in items" :key="r.id">
        <a :class="{ 'menu-active': current === r.id }" @click="current = r.id">
          <span class="grid size-8 shrink-0 place-items-center rounded-lg" style="color: var(--c-runtimes); background: color-mix(in oklch, var(--c-runtimes) 14%, transparent)">
            <svg class="size-4" :viewBox="r.box" fill="currentColor"><path fill-rule="evenodd" clip-rule="evenodd" :d="r.icon" /></svg>
          </span>
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-1.5">
              <span class="font-medium">{{ r.label }}</span>
              <span v-if="r.updates" class="badge badge-info badge-xs" title="Update available">↑</span>
            </div>
            <div class="truncate text-xs opacity-60">{{ r.detail }}</div>
          </div>
          <span class="badge badge-xs font-mono" :class="r.version ? 'badge-ghost' : 'opacity-60'">{{ r.version ?? 'none' }}</span>
        </a>
      </li>
    </ul>
  </aside>

  <main class="flex min-w-0 flex-1 flex-col bg-base-100">
    <PhpView v-if="current === 'php'" />
    <PythonView v-else-if="current === 'python'" />
    <NodeView v-else-if="current === 'node'" />
    <BunView v-else-if="current === 'bun'" />
    <GoView v-else-if="current === 'go'" />
  </main>
</template>
