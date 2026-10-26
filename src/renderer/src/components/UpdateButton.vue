<script setup lang="ts">
import { computed } from 'vue';
import type { RuntimeKind } from '@shared/types';
import { attempt, herd, notify, state } from '../store';

/** "Update to x.y.z" for an installed runtime, from the update list the main process keeps. */
const props = defineProps<{ runtime: RuntimeKind; version: string }>();
const update = computed(() => state.value?.updates.list.find((u) => u.runtime === props.runtime && u.from === props.version) ?? null);
const updating = computed(() => state.value?.updates.updating ?? null);
const mine = computed(() => updating.value === `${props.runtime}@${props.version}`);

async function run() {
  const u = update.value;
  if (!u) return;
  const ok = await attempt(() => herd.runtimeUpdate(u.runtime, u.from).then(() => true));
  if (ok) notify('success', `Updated to ${u.to}${u.isDefault ? ' (now the default)' : ''}. ${u.from} is kept for sites that pin it.`);
}
</script>

<template>
  <button
    v-if="update"
    class="btn btn-xs btn-primary"
    :disabled="!!updating"
    :title="update.isDefault ? `Installs ${update.to} and makes it the default` : `Installs ${update.to} next to ${update.from}`"
    @click="run"
  >
    <span v-if="mine" class="loading loading-spinner loading-xs" />
    Update to {{ update.to }}
  </button>
</template>
