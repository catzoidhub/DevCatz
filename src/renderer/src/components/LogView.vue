<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { ansiToHtml } from '../ansi';
import { herd, loadLogs, logs } from '../store';
import AiExplain from './AiExplain.vue';
import { aiOn } from '../ai';

const props = defineProps<{ projectId: string; laravel?: boolean }>();

/** `dev` = DevCatz's process output; `laravel` = storage/logs/laravel.log. */
const source = ref<'dev' | 'laravel'>('dev');
const laravelText = ref('');
const laravelFile = ref<string | null>(null);
let laravelTimer: ReturnType<typeof setInterval> | undefined;
async function loadLaravel() {
  const r = await herd.laravelLog(props.projectId, 500);
  laravelText.value = r.text;
  laravelFile.value = r.file;
  if (follow.value) {
    await nextTick();
    box.value?.scrollTo({ top: box.value.scrollHeight });
  }
}
watch(source, (v) => {
  clearInterval(laravelTimer);
  if (v === 'laravel') {
    void loadLaravel();
    laravelTimer = setInterval(loadLaravel, 3000);
  }
});
onBeforeUnmount(() => clearInterval(laravelTimer));

const box = ref<HTMLElement | null>(null);

// ---- Explain with AI: the selected lines, or the tail of what is shown.
const canAi = aiOn('explain');
const explaining = ref<string[] | null>(null);
function explain() {
  const sel = window.getSelection();
  const picked = sel && box.value && sel.toString().trim() && box.value.contains(sel.anchorNode) ? sel.toString().split('\n') : null;
  const tail =
    source.value === 'laravel'
      ? laravelText.value.split('\n').slice(-150)
      : lines.value.slice(-150).map((l) => `${l.stream === 'err' ? '! ' : ''}${l.text}`);
  explaining.value = (picked ?? tail).filter((l) => l.trim()).slice(-200);
}
const follow = ref(true);
const filter = ref('');

// ---- Per app: a site that runs several processes tags their lines `[web] …`, `[api] …` (one per monorepo /
// folder app, plus queue / vite …). A chip per tag filters to it; each tag has its own colour.
// `[web] …` from DevCatz (one process per app), or turbo's `web:dev: …` when one root command runs them all.
const TAG = /^(?:\[([\w.@-]{1,40})\] |([\w@./-]{1,40}):(?:dev|start|serve|watch): )/;
const tagOf = (text: string) => {
  const m = TAG.exec(text);
  return m ? { label: (m[1] ?? m[2]).replace(/^@[\w.-]+\//, ''), len: m[0].length } : null;
};
const app = ref<string | null>(null);
const tags = computed(() => {
  const seen = new Map<string, number>();
  for (const l of logs.get(props.projectId) ?? []) {
    const t = tagOf(l.text)?.label;
    if (t) seen.set(t, (seen.get(t) ?? 0) + 1);
  }
  return [...seen.keys()];
});
watch(tags, (t) => {
  if (app.value && !t.includes(app.value)) app.value = null;
});
const TAG_COLOURS = ['#7dd3fc', '#f0abfc', '#86efac', '#fcd34d', '#fda4af', '#a5b4fc', '#5eead4', '#fdba74'];
const tagColour = (t: string) => TAG_COLOURS[tags.value.indexOf(t) % TAG_COLOURS.length] ?? TAG_COLOURS[0];

const lines = computed(() => {
  const all = logs.get(props.projectId) ?? [];
  const q = filter.value.toLowerCase();
  const only = app.value;
  return all.filter((l) => (!only || tagOf(l.text)?.label === only) && (!q || l.text.toLowerCase().includes(q)));
});

const html = computed(() =>
  source.value === 'laravel'
    ? laravelText.value
        .split('\n')
        .filter((l) => !filter.value || l.toLowerCase().includes(filter.value.toLowerCase()))
        .map((l) => {
          const cls = /\.(ERROR|CRITICAL|ALERT|EMERGENCY):/.test(l) ? 'text-error/90' : /\.WARNING:/.test(l) ? 'text-warning' : '';
          return `<div class="${cls}">${l.replace(/&/g, '&amp;').replace(/</g, '&lt;') || '&nbsp;'}</div>`;
        })
        .join('')
    : lines.value
    .map((l) => {
      const cls = l.stream === 'sys' ? 'text-primary' : l.stream === 'db' ? 'text-secondary' : l.stream === 'err' ? 'text-error/90' : '';
      const t = tags.value.length > 1 ? tagOf(l.text) : null;
      if (t) return `<div class="${cls}"><span class="log-tag" style="color:${tagColour(t.label)}">[${t.label}]</span> ${ansiToHtml(l.text.slice(t.len)) || '&nbsp;'}</div>`;
      return `<div class="${cls}">${ansiToHtml(l.text) || '&nbsp;'}</div>`;
    })
    .join(''),
);

function onScroll() {
  const el = box.value!;
  follow.value = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
}

watch(html, async () => {
  if (!follow.value) return;
  await nextTick();
  box.value?.scrollTo({ top: box.value.scrollHeight });
});

onMounted(async () => {
  await loadLogs(props.projectId);
  await nextTick();
  box.value?.scrollTo({ top: box.value.scrollHeight });
});

async function clear() {
  await herd.clearLogs(props.projectId);
  logs.set(props.projectId, []);
}
</script>

<template>
  <section class="flex min-h-0 flex-1 flex-col">
    <div class="flex items-center gap-2 border-b border-base-300/60 px-4 py-2">
      <div v-if="laravel" class="join">
        <button class="btn btn-xs join-item" :class="{ 'btn-active': source === 'dev' }" @click="source = 'dev'">Dev servers</button>
        <button class="btn btn-xs join-item" :class="{ 'btn-active': source === 'laravel' }" @click="source = 'laravel'">laravel.log</button>
      </div>
      <input v-model="filter" class="input input-xs w-56" placeholder="Filter…" />
      <div v-if="source === 'dev' && tags.length > 1" class="flex flex-wrap items-center gap-1" role="tablist" aria-label="Show one app">
        <button class="log-chip" :class="{ 'is-on': !app }" @click="app = null">All</button>
        <button v-for="t in tags" :key="t" class="log-chip" :class="{ 'is-on': app === t }" :style="{ '--tag': tagColour(t) }" @click="app = app === t ? null : t">
          <span class="log-chip-dot" />{{ t }}
        </button>
      </div>
      <span v-if="source === 'dev'" class="text-xs opacity-50">{{ lines.length }} lines</span>
      <span v-else class="truncate text-xs opacity-50" :title="laravelFile ?? ''">{{ laravelFile ? laravelFile.split('/').slice(-2).join('/') : 'no laravel.log yet' }}</span>
      <div class="flex-1" />
      <label class="label cursor-pointer gap-1 text-xs"><input v-model="follow" type="checkbox" class="toggle toggle-xs toggle-primary" /> follow</label>
      <button v-if="source === 'dev'" class="btn btn-ghost btn-xs" @click="clear">Clear</button>
      <button v-if="canAi" class="btn btn-xs" title="Explain the selected lines (or the last ones) and suggest fixes" @click="explain">✦ Explain with AI</button>
    </div>
    <div v-if="explaining" class="max-h-[50%] shrink-0 overflow-y-auto border-b border-base-300/60 p-3">
      <AiExplain :key="explaining.join('\n').length" :site-id="projectId" source="logs" :lines="explaining" @close="explaining = null" />
    </div>
    <div
      ref="box"
      class="selectable flex-1 overflow-auto bg-neutral px-4 py-3 font-mono text-xs leading-relaxed whitespace-pre-wrap text-neutral-content"
      @scroll="onScroll"
      v-html="html"
    />
  </section>
</template>
