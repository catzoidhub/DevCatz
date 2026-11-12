<script setup lang="ts">
import CatHeart from './CatHeart.vue';
import { SUPPORT_TEXT, openCommunity, openDonate } from '../support';

/** Settings → About: Support Catzoid (Catzoid #94), always there; the heart in the rail and the corner card lead here. */
</script>

<template>
  <div id="support-catzoid" class="card scroll-mt-4">
    <div class="card-body flex-row flex-wrap items-center gap-4">
      <span class="grid size-10 shrink-0 place-items-center rounded-full bg-primary/12 text-[var(--primary-ink,var(--color-primary))]">
        <CatHeart class="size-6" />
      </span>
      <div class="min-w-0 flex-1 space-y-0.5">
        <h2 class="font-semibold">Support Catzoid</h2>
        <p class="text-xs leading-relaxed opacity-65">{{ SUPPORT_TEXT }}</p>
      </div>
      <div class="flex shrink-0 flex-wrap gap-2">
        <button class="btn btn-primary btn-sm" @click="openCommunity">Join the community</button>
        <button class="btn btn-sm" @click="openDonate">Support us</button>
      </div>
    </div>
  </div>
</template>
