<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { attempt, herd, state, updateDialog, updateDialogAuto } from '../store';

/**
 * DevCatz's own update opens What's New by itself (Catzoid #97) — not the tools' and runtimes' updates, which keep their
 * badges. Once per version and launch, at a calm moment: the window in front, no other dialog open, nothing installing,
 * not during the first-run welcome. Later = again on the next launch, or 24 h after it last opened in a long session;
 * Skip this version = never for that version; "Don't open this on its own" (in the dialog, and Settings → Updates)
 * leaves only the dot, Settings and the notification. A finished download opens it once more for Restart now.
 */
const DAY = 86_400_000;
const now = ref(Date.now());
const tick = setInterval(() => (now.value = Date.now()), 30_000);
const wake = () => (now.value = Date.now());
window.addEventListener('focus', wake);
document.addEventListener('visibilitychange', wake);
onBeforeUnmount(() => {
  clearInterval(tick);
  window.removeEventListener('focus', wake);
  document.removeEventListener('visibilitychange', wake);
});

/** What was opened in this launch: `<version>:available` / `<version>:downloaded`. */
const shown = new Set<string>();

const u = computed(() => state.value?.appUpdate ?? null);
const s = computed(() => state.value?.settings);
/** What would open now (null = nothing to ask). */
const want = computed(() => {
  const x = u.value;
  const st = s.value;
  if (!x || !st || !x.version || st.appUpdateDialog === false || st.appUpdateSkip === x.version) return null;
  if (x.status === 'downloaded') return x.installOnQuit && shown.has(`${x.version}:downloaded`) ? null : `${x.version}:downloaded`;
  if (x.status === 'available') return `${x.version}:available`;
  return null;
});
/** Something is running that a dialog on top would interrupt. */
const busy = computed(() => {
  const x = state.value;
  return !!x && (!!x.toolTask || !!x.uninstall || !!x.setup);
});

watch(
  [want, busy, now],
  () => {
    const key = want.value;
    if (!key || updateDialog.value || busy.value) return;
    const again = (s.value?.appUpdatePromptAt ?? 0) + DAY <= now.value;
    if (shown.has(key) && !again) return;
    if (document.visibilityState !== 'visible' || !document.hasFocus()) return;
    if (document.querySelector('dialog[open], .modal-open')) return;
    shown.add(key);
    updateDialogAuto.value = true;
    updateDialog.value = true;
    void attempt(() => herd.updateSettings({ appUpdatePromptAt: Date.now() }));
  },
  { immediate: true },
);
watch(updateDialog, (open) => {
  if (!open) updateDialogAuto.value = false;
});
</script>

<template>
  <span hidden />
</template>
