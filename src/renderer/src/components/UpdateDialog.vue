<script setup lang="ts">
import { computed } from 'vue';
import CatMood from './CatMood.vue';
import { attempt, herd, state, updateDialog } from '../store';
import devcatzLogo from '../assets/logos/devcatz.svg';

/**
 * DevCatz's update (Catzoid #54): What's New (the notes of every version since the installed one), then the download
 * (percent, MB of MB, speed, time left, Cancel), then Restart now / Install when I quit. Errors in plain words with
 * Retry and the site's download page. Before the restart it says what stops; running sites start again afterwards.
 */
const u = computed(() => state.value?.appUpdate ?? null);
const site = computed(() => state.value?.reports.site ?? 'https://catzoid.com');
const running = computed(() => state.value?.projects.filter((p) => p.status === 'running' || p.status === 'starting') ?? []);
const services = computed(() => {
  const s = state.value;
  if (!s) return 0;
  const on = (st: string) => st === 'running' || st === 'starting';
  return s.databases.filter((d) => on(d.status)).length + s.storage.filter((x) => on(x.status)).length + s.websockets.filter((x) => on(x.status)).length + s.searchEngines.filter((x) => on(x.status)).length;
});

const mb = (n: number) => `${(n / 1024 / 1024).toFixed(n > 100 * 1024 * 1024 ? 0 : 1)} MB`;
const left = computed(() => {
  const p = u.value?.progress;
  if (!p || !p.bytesPerSecond) return '';
  const s = Math.max(0, Math.round((p.total - p.transferred) / p.bytesPerSecond));
  return s < 60 ? `${s} s left` : `${Math.ceil(s / 60)} min left`;
});
const date = (d: string | null) => (d ? new Date(d).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' }) : '');

/** A small, safe Markdown: headings, lists, bold, code, links (text only); everything else as text. */
function md(src: string): string {
  const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const inline = (t: string) =>
    esc(t)
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  const out: string[] = [];
  let list = false;
  for (const line of src.split('\n')) {
    const item = line.match(/^\s*[-*]\s+(.*)$/);
    if (item) {
      if (!list) out.push('<ul>');
      list = true;
      out.push(`<li>${inline(item[1])}</li>`);
      continue;
    }
    if (list) out.push('</ul>');
    list = false;
    const h = line.match(/^#{1,4}\s+(.*)$/);
    if (h) out.push(`<h4>${inline(h[1])}</h4>`);
    else if (line.trim()) out.push(`<p>${inline(line)}</p>`);
  }
  if (list) out.push('</ul>');
  return out.join('');
}

const check = () => attempt(() => herd.appUpdateCheck());
const download = () => attempt(() => herd.appUpdateDownload());
const restart = () => attempt(() => herd.appUpdateRestart());
async function later() {
  if (u.value?.status === 'downloaded') await herd.appUpdateInstallOnQuit(true);
  updateDialog.value = false;
}
async function skip() {
  await herd.appUpdateSkip();
  updateDialog.value = false;
}
const close = () => (updateDialog.value = false);
</script>

<template>
  <Teleport to="body">
    <dialog v-if="updateDialog && u" open class="modal modal-open" @keydown.esc="close">
      <div class="modal-box w-[36rem] max-w-[95vw] space-y-4">
        <div class="flex items-start gap-4">
          <img :src="devcatzLogo" alt="" class="size-14 shrink-0 drop-shadow-md" draggable="false" />
          <div class="min-w-0 flex-1 space-y-0.5">
            <h3 class="text-lg font-semibold tracking-tight">
              <template v-if="u.status === 'checking'">Looking for updates…</template>
              <template v-else-if="u.status === 'none'">You're up to date</template>
              <template v-else-if="u.status === 'downloaded'">DevCatz {{ u.version }} is ready to install</template>
              <template v-else-if="u.status === 'error'">The update did not work</template>
              <template v-else-if="u.version">DevCatz {{ u.version }} is available</template>
              <template v-else>Updates</template>
            </h3>
            <p class="text-sm opacity-60">
              You have {{ u.current }}<template v-if="u.version && u.status !== 'none'"> · new: {{ u.version }}<template v-if="u.size"> · {{ mb(u.size) }}</template></template>
            </p>
          </div>
        </div>

        <!-- What's New -->
        <div v-if="u.notes.length && (u.status === 'available' || u.status === 'downloading' || u.status === 'downloaded')" class="update-notes max-h-72 space-y-4 overflow-y-auto rounded-box bg-base-200/60 px-4 py-3 text-sm">
          <section v-for="n in u.notes" :key="n.version">
            <div class="mb-1 flex items-baseline gap-2">
              <span class="font-semibold">{{ n.version }}</span>
              <span class="text-xs opacity-50">{{ date(n.date) }}</span>
            </div>
            <div v-if="n.notes.trim()" class="selectable" v-html="md(n.notes)" />
            <p v-else class="opacity-50">No notes for this version.</p>
          </section>
        </div>

        <!-- Download -->
        <div v-if="u.status === 'downloading' && u.progress" class="space-y-1.5">
          <progress class="progress progress-primary w-full" :value="u.progress.percent" max="100" />
          <div class="flex justify-between text-xs opacity-60">
            <span>{{ Math.floor(u.progress.percent) }}% · {{ mb(u.progress.transferred) }} of {{ mb(u.progress.total) }}</span>
            <span>{{ u.progress.bytesPerSecond ? `${mb(u.progress.bytesPerSecond)}/s · ${left}` : 'Starting…' }}</span>
          </div>
          <p v-if="u.progress.percent >= 100" class="text-xs opacity-60">Verifying…</p>
        </div>

        <!-- Before the restart: what stops -->
        <div v-if="u.status === 'downloaded'" role="alert" class="alert alert-info alert-soft text-sm">
          <CatMood mood="info" class="size-7 shrink-0 -my-0.5" />
          <span v-if="running.length || services">
            Restarting stops {{ running.length ? `${running.length} running site${running.length === 1 ? '' : 's'}` : '' }}{{ running.length && services ? ' and ' : '' }}{{ services ? `${services} service${services === 1 ? '' : 's'}` : '' }} for a few seconds.
            The sites start again by themselves; services set to start automatically do too.
          </span>
          <span v-else>Nothing is running: the restart takes a few seconds.</span>
        </div>

        <div v-if="u.status === 'none'" class="flex items-center gap-3 text-sm">
          <CatMood mood="success" class="size-8 shrink-0" />
          <span>DevCatz {{ u.current }} is the newest version{{ state?.settings.appUpdateChannel === 'beta' ? ' (Beta channel)' : '' }}.</span>
        </div>
        <div v-if="u.status === 'error'" role="alert" class="alert alert-error alert-soft text-sm">
          <CatMood mood="error" class="size-7 shrink-0 -my-0.5" />
          <span>{{ u.error }}</span>
        </div>
        <p v-if="u.dev && u.status === 'available'" class="text-xs opacity-60">A development build: it shows updates but cannot install them.</p>

        <div class="modal-action flex-wrap">
          <template v-if="u.status === 'available'">
            <button type="button" class="btn btn-ghost btn-sm" @click="skip">Skip this version</button>
            <button type="button" class="btn btn-ghost btn-sm" @click="close">Later</button>
            <button type="button" class="btn btn-primary btn-sm" @click="download">Update now</button>
          </template>
          <template v-else-if="u.status === 'downloading'">
            <button type="button" class="btn btn-ghost btn-sm" @click="herd.appUpdateCancel()">Cancel</button>
            <button type="button" class="btn btn-ghost btn-sm" @click="close">Hide</button>
          </template>
          <template v-else-if="u.status === 'downloaded'">
            <button type="button" class="btn btn-ghost btn-sm" @click="later">Install when I quit</button>
            <button type="button" class="btn btn-primary btn-sm" @click="restart">Restart now</button>
          </template>
          <template v-else-if="u.status === 'error'">
            <button type="button" class="btn btn-ghost btn-sm" @click="herd.openUrl(`${site}/download/devcatz`)">Download from the site</button>
            <button type="button" class="btn btn-ghost btn-sm" @click="close">Close</button>
            <button type="button" class="btn btn-primary btn-sm" @click="u.version ? download() : check()">Retry</button>
          </template>
          <template v-else>
            <button type="button" class="btn btn-ghost btn-sm" :disabled="u.status === 'checking'" @click="check"><span v-if="u.status === 'checking'" class="loading loading-spinner loading-xs" />Check again</button>
            <button type="button" class="btn btn-primary btn-sm" @click="close">OK</button>
          </template>
        </div>
      </div>
      <div class="modal-backdrop" @click="u.status !== 'downloading' && close()" />
    </dialog>
  </Teleport>
</template>

<style scoped>
.update-notes :deep(h4) {
  margin: 0.5rem 0 0.25rem;
  font-weight: 600;
}
.update-notes :deep(ul) {
  list-style: disc;
  padding-left: 1.25rem;
}
.update-notes :deep(p),
.update-notes :deep(li) {
  margin: 0.15rem 0;
  line-height: 1.5;
}
.update-notes :deep(code) {
  font-size: 0.85em;
  padding: 0 0.25rem;
  border-radius: 0.25rem;
  background: oklch(from var(--color-base-content) l c h / 0.08);
}
</style>
