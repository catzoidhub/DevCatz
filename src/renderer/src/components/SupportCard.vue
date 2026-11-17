<script setup lang="ts">
import { computed, ref } from 'vue';
import CatHeart from './CatHeart.vue';
import CatStar from './CatStar.vue';
import RatingForm from './RatingForm.vue';
import { SUPPORT_TEXT, openCommunity, openDonate } from '../support';
import { state } from '../store';

/**
 * Settings → About: Support Catzoid (Catzoid #94), always there; the heart in the rail and the corner card lead here.
 * Rating (Catzoid #96): "Your rating" with Edit, or Rate DevCatz; a rating waiting for a connection says so.
 */
const s = computed(() => state.value?.settings);
const mine = computed(() => s.value?.supportRating ?? null);
const queued = computed(() => s.value?.supportRatingQueued ?? null);
const editing = ref(false);
/** Cancel clears the stars picked (a fresh form). */
const formKey = ref(0);
function stop() {
  editing.value = false;
  formKey.value++;
}
const status = computed(() => {
  const m = mine.value;
  if (!m?.text) return '';
  return { none: '', pending: 'Your review waits for a quick look by the team.', approved: 'Your review is on catzoid.com.', hidden: 'Your review is not shown on the site; your stars still count.' }[m.status];
});
</script>

<template>
  <div id="support-catzoid" class="card scroll-mt-4">
    <div class="card-body gap-4">
      <div class="flex flex-row flex-wrap items-center gap-4">
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

      <div class="border-t border-base-300/60 pt-4 sm:pl-14">
        <RatingForm v-if="editing || (!mine && !queued)" :key="formKey" @done="stop" @cancel="stop" />
        <div v-else class="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
          <span class="opacity-70">Your rating</span>
          <span class="inline-flex gap-[0.08em] text-[1.15rem]" :aria-label="`${(mine ?? queued)!.rating} out of 5`">
            <CatStar v-for="n in 5" :key="n" class="size-[1.1em]" :fill="(mine ?? queued)!.rating >= n ? 1 : 0" />
          </span>
          <button class="link link-hover text-xs text-[var(--primary-ink,var(--color-primary))]" @click="editing = true">Edit</button>
          <p v-if="queued" class="w-full text-xs opacity-60">Not sent yet: it goes by itself when DevCatz is online.</p>
          <p v-else-if="mine?.text" class="selectable w-full text-xs leading-relaxed opacity-70">“{{ mine.text }}”</p>
          <p v-if="status && !queued" class="w-full text-[11px] opacity-50">{{ status }}</p>
        </div>
      </div>
    </div>
  </div>
</template>
