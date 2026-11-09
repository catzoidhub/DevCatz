<script setup lang="ts">
import { computed } from 'vue';
import { state } from '../store';
import docatzLogo from '../assets/logos/docatz.png';
import { ENGINE_BY_NAME, ENGINE_LOGO } from '../engines';

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
  { id: 'docatz' as const, name: 'DoCatz', hint: 'Recommended', logo: docatzLogo },
  { id: 'system' as const, name: other.value ?? '', hint: 'With your own containers', logo: ENGINE_LOGO[ENGINE_BY_NAME[other.value ?? ''] ?? 'other'] ?? null },
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
        <img
          v-if="o.logo"
          :src="o.logo"
          alt=""
          class="size-7 shrink-0"
          :class="/svg/.test(o.logo) ? 'rounded-lg bg-white p-1 ring-1 ring-base-content/10' : 'drop-shadow-sm'"
          draggable="false"
        />
        <span v-else class="grid size-7 shrink-0 place-items-center rounded-lg bg-base-200 opacity-80 ring-1 ring-base-content/10" aria-hidden="true">
          <!-- a container (no other engine's logo is shipped) -->
          <svg viewBox="0 0 24 24" class="size-[18px]" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><path d="M12 3 4 7.5v9L12 21l8-4.5v-9L12 3Z" /><path d="M4 7.5 12 12l8-4.5M12 12v9" /></svg>
        </span>
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
    <p class="mt-1.5 text-xs opacity-60">
      {{ picked === 'docatz' ? 'DoCatz shows it under DevCatz Services.' : `It shows among ${other}'s containers.` }} Its data stays in its own folder either way;
      Move to … on its page changes this later.
    </p>
  </fieldset>
</template>
