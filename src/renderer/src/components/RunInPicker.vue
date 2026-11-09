<script setup lang="ts">
import { computed } from 'vue';
import { state } from '../store';
import docatzLogo from '../assets/logos/docatz.png';

/**
 * Where a Docker gateway is installed (user, 2026-11-09): DoCatz, the default wherever DoCatz exists, or another
 * container engine installed here (OrbStack, Docker Desktop …) — offered only when there is one. Fixed after install
 * (Move to … on the gateway's page moves it later). Two cards like the Share dialog's providers, the chosen one marked
 * with the primary border, a tint and a check (user: the earlier segmented buttons did not show which was picked).
 */
const model = defineModel<'docatz' | 'system' | undefined>();
const other = computed(() => state.value?.docatz.otherEngine ?? null);
const shown = computed(() => !!state.value?.docatz.forGateways && !!other.value);
const picked = computed(() => model.value ?? 'docatz');
const options = computed(() => [
  { id: 'docatz' as const, name: 'DoCatz', hint: 'Recommended · shown under DevCatz Services', logo: docatzLogo },
  { id: 'system' as const, name: other.value ?? '', hint: 'Next to your own containers there', logo: null },
]);
</script>

<template>
  <fieldset v-if="shown">
    <span class="label-caps mb-1.5 block">Run in</span>
    <div class="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Run in">
      <button
        v-for="o in options"
        :key="o.id"
        type="button"
        role="radio"
        :aria-checked="picked === o.id"
        class="relative flex items-center gap-2.5 rounded-box border px-3 py-2 text-left transition-colors"
        :class="picked === o.id ? 'border-primary bg-primary/5 ring-1 ring-primary' : 'border-base-300/60 hover:bg-base-200/60'"
        @click="model = o.id"
      >
        <img v-if="o.logo" :src="o.logo" alt="" class="size-7 shrink-0 drop-shadow-sm" draggable="false" />
        <span v-else class="grid size-7 shrink-0 place-items-center rounded-lg bg-base-200 text-xs font-semibold opacity-70 ring-1 ring-base-content/10">{{ o.name.slice(0, 1) }}</span>
        <span class="min-w-0 flex-1">
          <span class="block truncate text-sm font-medium">{{ o.name }}</span>
          <span class="block truncate text-[11px] opacity-60">{{ o.hint }}</span>
        </span>
        <span
          class="grid size-[18px] shrink-0 place-items-center rounded-full border"
          :class="picked === o.id ? 'border-primary bg-primary text-primary-content' : 'border-base-content/25'"
          aria-hidden="true"
        >
          <svg v-if="picked === o.id" viewBox="0 0 16 16" class="size-3"><path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" /></svg>
        </span>
      </button>
    </div>
    <p class="mt-1.5 text-xs opacity-60">Its data stays in its own folder either way; Move to … on its page changes this later.</p>
  </fieldset>
</template>
