<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import CatHeart from './CatHeart.vue';
import { aiOn } from '../ai';
import { attempt, herd, state } from '../store';
import { openCommunity, openDonate } from '../support';

/**
 * Support Catzoid, asked once at a good moment (Catzoid #94): a small card in the corner, never a modal. Only after
 * real use — 7 days after the first run, with a site served, a few minutes into this session — and never over a
 * dialog. Not now asks once more, 60 days later at the earliest; Don't show again, joining or donating ends it.
 * Settings → About keeps the links whatever the answer.
 */
const DAY = 86_400_000;
const opened = Date.now();
const now = ref(Date.now());
const tick = setInterval(() => (now.value = Date.now()), 60_000);
onBeforeUnmount(() => clearInterval(tick));

const shown = ref(false);
// Ask DevCatz's ✦ button sits in the same corner when AI is on: the card goes above it.
const askOn = aiOn('ask');
const s = computed(() => state.value?.settings);
const due = computed(() => {
  const x = s.value;
  if (!x || x.supportOff || !x.supportSince) return false;
  if (now.value - x.supportSince < 7 * DAY) return false;
  const later = x.supportLater ?? 0;
  if (later >= 2 || (later === 1 && now.value - (x.supportLaterAt ?? 0) < 60 * DAY)) return false;
  return true;
});
// The success moment: a site served in this session, a few minutes after launch, and nothing else asking for attention.
const served = computed(() => !!state.value?.projects.some((p) => p.status === 'running'));
watch(
  [due, served, now],
  () => {
    if (shown.value || !due.value || !served.value || now.value - opened < 3 * 60_000) return;
    if (document.querySelector('dialog[open], .modal-open')) return;
    shown.value = true;
  },
  { immediate: true },
);

async function answer(a: 'later' | 'never' | 'community' | 'donate') {
  shown.value = false;
  if (a === 'community') void openCommunity();
  if (a === 'donate') void openDonate();
  const patch = a === 'later' ? { supportLater: (s.value?.supportLater ?? 0) + 1, supportLaterAt: Date.now() } : { supportOff: true };
  await attempt(() => herd.updateSettings(patch));
}
</script>

<template>
  <Transition enter-from-class="translate-y-3 opacity-0" leave-to-class="translate-y-3 opacity-0" enter-active-class="transition duration-300" leave-active-class="transition duration-200">
    <aside v-if="shown" class="fixed right-5 z-40 w-[22rem] max-w-[calc(100vw-2.5rem)] rounded-box border border-base-300/70 bg-base-100 p-4 shadow-xl" :class="askOn ? 'bottom-[4.75rem]' : 'bottom-5'" role="status">
      <button class="btn btn-ghost btn-xs btn-square absolute top-2 right-2 opacity-60" title="Not now" @click="answer('later')">
        <svg class="size-3.5" viewBox="0 0 20 20" fill="currentColor"><path d="M6.28 5.22a.75.75 0 0 0-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 1 0 1.06 1.06L10 11.06l3.72 3.72a.75.75 0 1 0 1.06-1.06L11.06 10l3.72-3.72a.75.75 0 0 0-1.06-1.06L10 8.94 6.28 5.22Z" /></svg>
      </button>
      <div class="flex items-start gap-3 pr-5">
        <span class="grid size-11 shrink-0 place-items-center rounded-full bg-primary/12 text-[var(--primary-ink,var(--color-primary))]"><CatHeart class="size-7" /></span>
        <div class="space-y-1">
          <h3 class="text-sm font-semibold">Enjoying DevCatz?</h3>
          <p class="text-xs leading-relaxed opacity-70">
            It is free, and you never have to donate. Joining the community so DevCatz feels alive is already valuable support.
          </p>
        </div>
      </div>
      <div class="mt-3 flex gap-1.5 pl-14">
        <button class="btn btn-primary btn-sm" @click="answer('community')">Join the community</button>
        <button class="btn btn-sm" @click="answer('donate')">Support us</button>
      </div>
      <div class="mt-2 flex justify-end gap-3 pl-14 text-xs">
        <button class="link link-hover opacity-60" @click="answer('later')">Not now</button>
        <button class="link link-hover opacity-60" @click="answer('never')">Don't show again</button>
      </div>
    </aside>
  </Transition>
</template>
