<script setup lang="ts">
import TaskStepper from './TaskStepper.vue';
import { confirmCleanUrls, confirmResolver, confirmTrustCa } from '../confirms';
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import CatMood from './CatMood.vue';
import { attempt, herd, state } from '../store';
import { isWin } from '../platform';

/**
 * First-run welcome (Catzoid #29): what DevCatz does, and the things that ask for your password — each only
 * when you choose it, with why it is needed and how to undo it. Shown once, on the very first launch (no sites
 * yet and never dismissed); Settings keeps the buttons for later. The DNS rule shows only where the domain needs
 * one (always on Windows, where only browsers resolve .localhost).
 */
const s = computed(() => state.value);
const open = computed(() => !!s.value && !s.value.settings.welcomeSeen && s.value.projects.length === 0 && !dismissed.value);
const dismissed = ref(false);
const busy = ref<'' | 'ca' | 'urls' | 'dns'>('');
const count = computed(() => (s.value?.domain.needsResolver ? 'Three' : 'Two'));

async function trust() {
  if (!(await confirmTrustCa())) return;
  busy.value = 'ca';
  await attempt(() => herd.trustCa());
  busy.value = '';
}
async function cleanUrls() {
  if (!(await confirmCleanUrls())) return;
  busy.value = 'urls';
  await attempt(() => herd.installCleanUrls());
  busy.value = '';
}
async function dnsRule() {
  if (!(await confirmResolver())) return;
  busy.value = 'dns';
  await attempt(() => herd.installResolver());
  busy.value = '';
}
async function securityDoc() {
  const info = await attempt(() => herd.aboutInfo());
  if (info?.site) await herd.openUrl(`${info.site}/docs/security`);
}
/**
 * The setup cards scroll inside the dialog, so it fits a small window (on Windows the first run opens a normal-size
 * window, and three cards with their steps are taller than it). A soft fade marks more above / below.
 */
const list = ref<HTMLElement | null>(null);
const fadeTop = ref(false);
const fadeBottom = ref(false);
function edges() {
  const el = list.value;
  if (!el) return;
  fadeTop.value = el.scrollTop > 2;
  fadeBottom.value = el.scrollTop + el.clientHeight < el.scrollHeight - 2;
}
let ro: ResizeObserver | null = null;
watch(list, (el) => {
  ro?.disconnect();
  if (!el) return;
  ro = new ResizeObserver(edges);
  ro.observe(el);
  for (const c of Array.from(el.children)) ro.observe(c);
  // Opens at the first card (the dialog's focus on a later button must not scroll the list down).
  void nextTick(() => {
    el.scrollTop = 0;
    edges();
  });
});
// A step list appearing under a card makes it taller.
watch(() => s.value?.setup, () => void nextTick(edges), { deep: true });
onBeforeUnmount(() => ro?.disconnect());
const fade = computed(() => {
  const top = fadeTop.value ? 'transparent, black 1.25rem' : 'black';
  const bottom = fadeBottom.value ? 'black calc(100% - 1.25rem), transparent' : 'black';
  const m = `linear-gradient(to bottom, ${top}, ${bottom})`;
  return { maskImage: m, WebkitMaskImage: m };
});

async function done() {
  dismissed.value = true;
  await attempt(() => herd.updateSettings({ welcomeSeen: true }));
}
</script>

<template>
  <Teleport to="body">
    <dialog v-if="open && s" open class="modal modal-open" @keydown.esc="done">
      <div class="modal-box flex max-h-[calc(100vh-2.5rem)] w-[38rem] max-w-[95vw] flex-col gap-5 overflow-hidden">
        <div class="flex shrink-0 items-start gap-3">
          <CatMood mood="success" class="size-11 shrink-0" />
          <div>
            <h3 class="text-lg font-semibold tracking-tight">Welcome to DevCatz</h3>
            <p class="text-sm opacity-70">
              Your projects run here on their own names — <span class="font-mono">https://shop.localhost</span> — with the right
              runtime, a database a click away, and mail, storage and search when they need them.
            </p>
          </div>
        </div>

        <div class="shrink-0 space-y-1">
          <p class="label-caps">{{ count }} things {{ isWin ? 'ask you to confirm' : 'ask for your password' }} — only if you choose them</p>
          <p class="text-xs opacity-60">
            Nothing is installed now. Each button says what it does first; {{ s.domain.needsResolver ? 'all' : 'both' }} can be undone in Settings
            (Project{{ s.domain.needsResolver ? ', General' : '' }}).
          </p>
        </div>

        <div ref="list" class="-mx-1 min-h-0 flex-1 space-y-3 overflow-y-auto px-1 [scrollbar-width:thin]" :style="fade" @scroll.passive="edges">
          <div class="rounded-xl border border-base-300/70 bg-base-200/40 p-4">
            <div class="flex items-start justify-between gap-4">
              <div class="min-w-0">
                <p class="font-medium">1 · Trust DevCatz’s certificate</p>
                <p class="mt-1 text-sm opacity-70">
                  So <span class="font-mono">https://</span> works without warnings — cookies, sign-in callbacks and service workers behave as
                  in production.
                  <template v-if="isWin">DevCatz Local CA lives only on this PC and goes into your own Trusted Root certificates; Windows asks you to confirm once.</template>
                  <template v-else>DevCatz Local CA lives only on this Mac and goes into your login keychain; macOS asks for your password or Touch ID once.</template>
                </p>
              </div>
              <span v-if="s.cert.caTrusted" class="badge badge-success badge-sm shrink-0">trusted</span>
              <button v-else class="btn btn-primary btn-sm shrink-0" :disabled="!!busy" @click="trust">
                <span v-if="busy === 'ca'" class="loading loading-spinner loading-xs" />Trust…
              </button>
            </div>
            <TaskStepper v-if="s.setup?.what === 'ca'" :task="s.setup.task" compact class="mt-3" />
          </div>

          <div class="rounded-xl border border-base-300/70 bg-base-200/40 p-4">
            <div class="flex items-start justify-between gap-4">
              <div class="min-w-0">
                <p class="font-medium">2 · Names without a port <span class="badge badge-ghost badge-sm ml-1">optional</span></p>
                <p class="mt-1 text-sm opacity-70">
                  Sites answer on <span class="font-mono">https://shop.localhost:8443</span> out of the box. To drop the
                  <span class="font-mono">:8443</span>,
                  <template v-if="isWin">DevCatz asks Windows to forward ports 443 and 80 to it — that needs administrator approval once.</template>
                  <template v-else>DevCatz adds two small system services that forward ports 443 and 80 to it — that needs your administrator password once.</template>
                </p>
              </div>
              <span v-if="s.cleanUrls.installed" class="badge badge-success badge-sm shrink-0">on</span>
              <button v-else class="btn btn-outline btn-sm shrink-0" :disabled="!!busy" @click="cleanUrls">
                <span v-if="busy === 'urls'" class="loading loading-spinner loading-xs" />Enable…
              </button>
            </div>
            <TaskStepper v-if="s.setup?.what === 'urls'" :task="s.setup.task" compact class="mt-3" />
          </div>

          <div v-if="s.domain.needsResolver" class="rounded-xl border border-base-300/70 bg-base-200/40 p-4">
            <div class="flex items-start justify-between gap-4">
              <div class="min-w-0">
                <p class="font-medium">3 · Site names for your code <span class="badge badge-ghost badge-sm ml-1">recommended</span></p>
                <p class="mt-1 text-sm opacity-70">
                  <template v-if="isWin">
                    Browsers find <span class="font-mono">*.{{ s.domain.tld }}</span> by themselves; Node, PHP, Python and curl on Windows do not, so a
                    site calling another by name fails. DevCatz adds Windows DNS rules that send these names to its own DNS on this PC — administrator
                    approval once.
                  </template>
                  <template v-else>
                    <span class="font-mono">*.{{ s.domain.tld }}</span> names go to DevCatz's own DNS through
                    <span class="font-mono">/etc/resolver/{{ s.domain.tld }}</span> — your administrator password once.
                  </template>
                </p>
              </div>
              <span v-if="s.domain.resolver === 'ours' && s.domain.resolves" class="badge badge-success badge-sm shrink-0">on</span>
              <button v-else class="btn btn-outline btn-sm shrink-0" :disabled="!!busy" @click="dnsRule">
                <span v-if="busy === 'dns'" class="loading loading-spinner loading-xs" />Add…
              </button>
            </div>
            <TaskStepper v-if="s.setup?.what === 'dns'" :task="s.setup.task" compact class="mt-3" />
          </div>
        </div>

        <p class="shrink-0 text-xs opacity-60">
          <template v-if="isWin">
            No changes to the <span class="font-mono">hosts</span> file, no drivers, nothing at sign-in unless you turn it on.
          </template>
          <template v-else>No changes to <span class="font-mono">/etc/hosts</span>, no kernel extensions, nothing at login unless you turn it on.</template>
          {{ ' ' }}<a class="link" @click="securityDoc">What DevCatz changes on your {{ isWin ? 'PC' : 'Mac' }}</a>
        </p>

        <div class="modal-action mt-0 shrink-0">
          <button class="btn btn-ghost btn-sm" @click="done">Maybe later</button>
          <button class="btn btn-primary btn-sm" @click="done">Get started</button>
        </div>
      </div>
      <div class="modal-backdrop" @click="done" />
    </dialog>
  </Teleport>
</template>
