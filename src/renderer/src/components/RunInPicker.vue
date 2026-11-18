<script setup lang="ts">
import { computed, onMounted } from 'vue';
import type { GwWhere } from '@shared/types';
import { state } from '../store';
import { gwPlaces, loadPlaces, placeOf } from '../engines';
import DoCatzInstallCard from './DoCatzInstallCard.vue';

/**
 * Where a Docker gateway or storage container is installed (user, 2026-11-09; every engine 2026-11-18): DoCatz first —
 * recommended and the default wherever DoCatz exists, offered even when it is not installed yet (DevCatz installs it)
 * — then every other engine installed here (OrbStack, Docker Desktop, Kiri, Colima …), each by its docker context.
 * Shown when there is a choice. Fixed after install (Move to … on its page moves it later). Cards like the Share
 * dialog's providers, the chosen one marked with the primary border, a tint and a check.
 */
const model = defineModel<GwWhere | undefined>();
/** The service being installed (DoCatz opens at it after Download & Install). */
const props = withDefaults(defineProps<{ kind: string; name: string; movable?: boolean }>(), { movable: true });
const docatzMissing = computed(() => state.value?.docatz.installed === false && !state.value.docatz.engine);
onMounted(() => void loadPlaces());
const options = computed(() => gwPlaces.value);
const shown = computed(() => options.value.length > 1);
const picked = computed(() => placeOf(model.value)?.where ?? options.value[0]?.where);
const pickedPlace = computed(() => options.value.find((o) => o.where === picked.value) ?? null);
const hint = (o: (typeof options.value)[number]) =>
  o.where === 'docatz'
    ? docatzMissing.value
      ? 'Recommended · not installed yet'
      : 'Recommended'
    : o.running
      ? o.context
        ? `Running · context ${o.context}`
        : `Running · its own ${o.id} CLI`
      : `Not running · started at install`;
</script>

<template>
  <fieldset v-if="shown">
    <span class="label-caps mb-1.5 block">Run in</span>
    <div class="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Run in">
      <button
        v-for="o in options"
        :key="o.where"
        type="button"
        role="radio"
        :aria-checked="picked === o.where"
        class="relative flex items-center gap-2.5 rounded-box border px-3 py-2 text-left transition-colors"
        :class="picked === o.where ? 'border-primary bg-primary/5 ring-1 ring-primary' : 'border-base-300/60 hover:bg-base-200/60'"
        @click="model = o.where"
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
          <span class="block truncate text-[11px] opacity-60">{{ hint(o) }}</span>
        </span>
        <span
          class="grid size-[18px] shrink-0 place-items-center rounded-full border"
          :class="picked === o.where ? 'border-primary bg-primary text-primary-content' : 'border-base-content/25'"
          aria-hidden="true"
        >
          <svg v-if="picked === o.where" viewBox="0 0 16 16" class="size-3"><path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" /></svg>
        </span>
      </button>
    </div>
    <DoCatzInstallCard v-if="picked === 'docatz' && docatzMissing" class="mt-2" :kind="props.kind" :name="props.name" />
    <p class="mt-1.5 text-xs opacity-60">
      {{ picked === 'docatz' ? 'DoCatz shows it under DevCatz Services.' : `It shows among ${pickedPlace?.name ?? 'that engine'}'s containers.` }} <template v-if="props.movable">Its data stays in its own folder either way; Move to … on its page changes this later.</template>
      <template v-else>To run it elsewhere later, uninstall it and install it there.</template>
    </p>
  </fieldset>
</template>
