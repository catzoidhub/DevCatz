<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import type { RuntimeNeed } from '@shared/types';
import { attempt, herd, notify, state } from '../store';

/** "Install PHP 8.4.x" next to a runtime warning (New Site): the version that fits what the project asks for. */
const props = defineProps<{ kind: RuntimeNeed['kind']; spec: string | null }>();
const emit = defineEmits<{ installed: [] }>();
const NAMES: Record<RuntimeNeed['kind'], string> = { php: 'PHP', node: 'Node.js', go: 'Go', bun: 'Bun' };
const version = ref<string | null>(null);
const busy = ref(false);
const progress = computed(() => state.value?.[props.kind].installing ?? null);
const pct = computed(() => (progress.value?.total ? Math.round((progress.value.received / progress.value.total) * 100) : null));
onMounted(async () => (version.value = await herd.runtimePick(props.kind, props.spec).catch(() => null)));

async function install() {
  const v = version.value;
  if (!v) return;
  busy.value = true;
  const run = { php: () => herd.phpInstall(v), node: () => herd.nodeInstall(v), go: () => herd.goInstall(v), bun: () => herd.bunInstall(v) }[props.kind];
  const ok = await attempt(() => run().then(() => true));
  busy.value = false;
  if (ok) {
    notify('success', `${NAMES[props.kind]} ${v.replace(/^v/, '')} installed`);
    emit('installed');
  }
}
</script>

<template>
  <span v-if="version" class="inline-flex items-center gap-2">
    <button type="button" class="btn btn-xs btn-primary" :disabled="busy || !!progress" @click="install">
      <span v-if="busy" class="loading loading-spinner loading-xs" />Install {{ NAMES[kind] }} {{ version.replace(/^v/, '') }}
    </button>
    <span v-if="busy && progress" class="text-xs opacity-60">{{ progress.detail ?? (progress.phase === 'extract' ? 'Unpacking…' : pct !== null ? `${pct}%` : 'Starting…') }}</span>
  </span>
</template>
