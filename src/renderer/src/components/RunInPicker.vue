<script setup lang="ts">
import { computed } from 'vue';
import { state } from '../store';
import docatzLogo from '../assets/logos/docatz.png';

/**
 * Where a Docker gateway is installed (user, 2026-11-09): DoCatz, the default wherever DoCatz exists, or another
 * container engine installed here (OrbStack, Docker Desktop …) — offered only when there is one. Fixed after install.
 */
const model = defineModel<'docatz' | 'system' | undefined>();
const other = computed(() => state.value?.docatz.otherEngine ?? null);
const shown = computed(() => !!state.value?.docatz.forGateways && !!other.value);
</script>

<template>
  <fieldset v-if="shown" class="space-y-1.5">
    <span class="label-caps block">Run in</span>
    <div class="join">
      <button type="button" class="btn btn-sm join-item" :class="{ 'btn-active': (model ?? 'docatz') === 'docatz' }" @click="model = 'docatz'">
        <img :src="docatzLogo" alt="" class="size-4" draggable="false" />DoCatz <span class="opacity-60">(recommended)</span>
      </button>
      <button type="button" class="btn btn-sm join-item" :class="{ 'btn-active': model === 'system' }" @click="model = 'system'">{{ other }}</button>
    </div>
    <p class="text-xs opacity-60">
      {{ (model ?? 'docatz') === 'docatz' ? 'Its containers show in DoCatz under DevCatz Services.' : `It runs on ${other}, like your own containers there.` }} This stays as chosen; to move it, uninstall and install again.
    </p>
  </fieldset>
</template>
