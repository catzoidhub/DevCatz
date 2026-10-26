<script setup lang="ts">
import { computed, ref } from 'vue';
import CatMood from './CatMood.vue';
import { attempt, herd, state } from '../store';

/**
 * First-run welcome (Catzoid #29): what DevCatz does, and the two things that ask for your password — each only
 * when you choose it, with why it is needed and how to undo it. Shown once, on the very first launch (no sites
 * yet and never dismissed); Settings → Project keeps both buttons for later.
 */
const s = computed(() => state.value);
const open = computed(() => !!s.value && !s.value.settings.welcomeSeen && s.value.projects.length === 0 && !dismissed.value);
const dismissed = ref(false);
const busy = ref<'' | 'ca' | 'urls'>('');

async function trust() {
  busy.value = 'ca';
  await attempt(() => herd.trustCa());
  busy.value = '';
}
async function cleanUrls() {
  busy.value = 'urls';
  await attempt(() => herd.installCleanUrls());
  busy.value = '';
}
async function securityDoc() {
  const info = await attempt(() => herd.aboutInfo());
  if (info?.site) await herd.openUrl(`${info.site}/docs/security`);
}
async function done() {
  dismissed.value = true;
  await attempt(() => herd.updateSettings({ welcomeSeen: true }));
}
</script>

<template>
  <Teleport to="body">
    <dialog v-if="open && s" open class="modal modal-open" @keydown.esc="done">
      <div class="modal-box w-[38rem] max-w-[95vw] space-y-5">
        <div class="flex items-start gap-3">
          <CatMood mood="success" class="size-11 shrink-0" />
          <div>
            <h3 class="text-lg font-semibold tracking-tight">Welcome to DevCatz</h3>
            <p class="text-sm opacity-70">
              Your projects run here on their own names — <span class="font-mono">https://shop.localhost</span> — with the right
              runtime, a database a click away, and mail, storage and search when they need them.
            </p>
          </div>
        </div>

        <div class="space-y-1">
          <p class="label-caps">Two things ask for your password — only if you choose them</p>
          <p class="text-xs opacity-60">Nothing is installed now. Each button says what it does first; both can be undone in Settings → Project.</p>
        </div>

        <div class="space-y-3">
          <div class="rounded-xl border border-base-300/70 bg-base-200/40 p-4">
            <div class="flex items-start justify-between gap-4">
              <div class="min-w-0">
                <p class="font-medium">1 · Trust DevCatz’s certificate</p>
                <p class="mt-1 text-sm opacity-70">
                  So <span class="font-mono">https://</span> works without warnings — cookies, sign-in callbacks and service workers behave as
                  in production. DevCatz Local CA lives only on this Mac and goes into your login keychain; macOS asks for your password or
                  Touch ID once.
                </p>
              </div>
              <span v-if="s.cert.caTrusted" class="badge badge-success badge-sm shrink-0">trusted</span>
              <button v-else class="btn btn-primary btn-sm shrink-0" :disabled="!!busy" @click="trust">
                <span v-if="busy === 'ca'" class="loading loading-spinner loading-xs" />Trust…
              </button>
            </div>
          </div>

          <div class="rounded-xl border border-base-300/70 bg-base-200/40 p-4">
            <div class="flex items-start justify-between gap-4">
              <div class="min-w-0">
                <p class="font-medium">2 · Names without a port <span class="badge badge-ghost badge-sm ml-1">optional</span></p>
                <p class="mt-1 text-sm opacity-70">
                  Sites answer on <span class="font-mono">https://shop.localhost:8443</span> out of the box. To drop the
                  <span class="font-mono">:8443</span>, DevCatz adds two small system services that forward ports 443 and 80 to it — that
                  needs your administrator password once.
                </p>
              </div>
              <span v-if="s.cleanUrls.installed" class="badge badge-success badge-sm shrink-0">on</span>
              <button v-else class="btn btn-outline btn-sm shrink-0" :disabled="!!busy" @click="cleanUrls">
                <span v-if="busy === 'urls'" class="loading loading-spinner loading-xs" />Enable…
              </button>
            </div>
          </div>
        </div>

        <p class="text-xs opacity-60">
          No changes to <span class="font-mono">/etc/hosts</span>, no kernel extensions, nothing at login unless you turn it on.
          <a class="link" @click="securityDoc">What DevCatz changes on your Mac</a>
        </p>

        <div class="modal-action mt-0">
          <button class="btn btn-ghost btn-sm" @click="done">Maybe later</button>
          <button class="btn btn-primary btn-sm" @click="done">Get started</button>
        </div>
      </div>
      <div class="modal-backdrop" @click="done" />
    </dialog>
  </Teleport>
</template>
