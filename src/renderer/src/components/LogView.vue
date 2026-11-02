<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { ansiToHtml } from '../ansi';
import { herd, loadLogs, logs, notify } from '../store';
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
// Docker Compose output (the `docker` stream) names its service in its own ways: `web-1  | …` (logs),
// `#7 [api build 2/5] …` (BuildKit), ` Container shop-api-1  Started`, ` web  Built`.
const DOCKER_TAG: RegExp[] = [/^([\w.-]+?)-\d+\s*\| ?/, /^#\d+ \[(?!internal\b)([\w.-]+)[ \]][^\]]*\]? ?/, /^\s*Container [\w.-]*?-([\w.]+)-\d+\s+/, /^\s*([\w.-]+)\s+Built\b/];
type Line = { stream: string; text: string };
const tagOf = (l: Line): { label: string; len: number; keep?: boolean } | null => {
  if (l.stream === 'docker') {
    for (const [i, re] of DOCKER_TAG.entries()) {
      const m = re.exec(l.text);
      // Only the logs prefix is cut; the other lines keep their wording (the tag just files them).
      if (m) return { label: m[1], len: i === 0 ? m[0].length : 0, keep: i !== 0 };
    }
    return null;
  }
  const m = TAG.exec(l.text);
  return m ? { label: (m[1] ?? m[2]).replace(/^@[\w.-]+\//, ''), len: m[0].length } : null;
};
const app = ref<string | null>(null);
const tags = computed(() => {
  const seen = new Map<string, number>();
  for (const l of logs.get(props.projectId) ?? []) {
    const t = tagOf(l)?.label;
    if (t) seen.set(t, (seen.get(t) ?? 0) + 1);
  }
  return [...seen.keys()];
});
watch(tags, (t) => {
  if (app.value && !t.includes(app.value)) app.value = null;
  void nextTick(chipEdges);
});
// The chip row scrolls sideways: a vertical wheel moves it too, and a fade marks chips hidden at either end.
const chips = ref<HTMLElement | null>(null);
const chipLeft = ref(false);
const chipRight = ref(false);
function chipEdges() {
  const el = chips.value;
  if (!el) return;
  chipLeft.value = el.scrollLeft > 2;
  chipRight.value = el.scrollLeft + el.clientWidth < el.scrollWidth - 2;
}
function chipWheel(e: WheelEvent) {
  const el = chips.value;
  if (!el || el.scrollWidth <= el.clientWidth || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
  el.scrollLeft += e.deltaY;
  e.preventDefault();
}
const chipFade = computed(() => {
  const m = `linear-gradient(to right, ${chipLeft.value ? 'transparent, black 1.5rem' : 'black'}, ${chipRight.value ? 'black calc(100% - 1.5rem), transparent' : 'black'})`;
  return { maskImage: m, WebkitMaskImage: m };
});
let chipRo: ResizeObserver | null = null;
watch(chips, (el) => {
  chipRo?.disconnect();
  if (!el) return;
  chipRo = new ResizeObserver(chipEdges);
  chipRo.observe(el);
  void nextTick(chipEdges);
});
onBeforeUnmount(() => chipRo?.disconnect());

const TAG_COLOURS = ['#7dd3fc', '#f0abfc', '#86efac', '#fcd34d', '#fda4af', '#a5b4fc', '#5eead4', '#fdba74'];
const tagColour = (t: string) => TAG_COLOURS[tags.value.indexOf(t) % TAG_COLOURS.length] ?? TAG_COLOURS[0];

/**
 * Compose prints no colours here (COMPOSE_ANSI=never keeps the log readable): states and results are coloured
 * instead — Started / Healthy / Built / DONE green, errors red, warnings yellow, BuildKit's step numbers dimmed.
 */
const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function dockerHtml(text: string): string {
  const t = esc(text);
  if (/\b(error|failed|fatal|exited \(([1-9]\d*)\)|unhealthy)\b/i.test(text)) return `<span class="text-error/90">${t}</span>`;
  if (/\b(warn(ing)?|deprecated)\b/i.test(text)) return `<span class="text-warning">${t}</span>`;
  return t
    .replace(/^(#\d+|\d{4}-\d\d-\d\dT[\d:.]+Z)/, '<span class="opacity-50">$1</span>')
    .replace(/\b(Started|Running|Healthy|Built|Created|Recreated|Pulled|Stopped|Removed|DONE(?: [\d.]+s)?|CACHED)\b/g, '<span class="text-success">$1</span>')
    .replace(/\b(Starting|Stopping|Creating|Building|Waiting|Pulling|Removing)\b/g, '<span class="text-info">$1</span>');
}

const lines = computed(() => {
  const all = logs.get(props.projectId) ?? [];
  const q = filter.value.toLowerCase();
  const only = app.value;
  return all.filter((l) => (!only || tagOf(l)?.label === only) && (!q || l.text.toLowerCase().includes(q)));
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
      const t = tags.value.length > 1 || l.stream === 'docker' ? tagOf(l) : null;
      const body = (text: string) => (l.stream === 'docker' ? dockerHtml(text) : ansiToHtml(text)) || '&nbsp;';
      if (t) return `<div class="${cls}"><span class="log-tag" style="color:${tagColour(t.label)}">[${t.label}]</span> ${body(l.text.slice(t.len))}</div>`;
      return `<div class="${cls}">${body(l.text)}</div>`;
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

/** Copies what is shown: the selection if there is one, else every line under the current filter / chip. */
async function copy() {
  const sel = window.getSelection();
  const picked = sel && box.value && sel.toString().trim() && box.value.contains(sel.anchorNode) ? sel.toString() : null;
  const text =
    picked ??
    (source.value === 'laravel'
      ? laravelText.value
          .split('\n')
          .filter((l) => !filter.value || l.toLowerCase().includes(filter.value.toLowerCase()))
          .join('\n')
      : lines.value.map((l) => l.text.replace(/\x1b\[[\d;]*m/g, '')).join('\n'));
  if (!text.trim()) return notify('info', 'Nothing to copy');
  await navigator.clipboard.writeText(text + '\n');
  const n = text.split('\n').length;
  notify('success', picked ? 'Selection copied' : `${n} line${n === 1 ? '' : 's'} copied`);
}

async function clear() {
  await herd.clearLogs(props.projectId);
  logs.set(props.projectId, []);
}
</script>

<template>
  <section class="flex min-h-0 flex-1 flex-col">
    <!-- Two rows: what to show and what to do with it, then the app / service chips (one sideways-scrolling row). -->
    <div class="space-y-2 border-b border-base-300/60 px-4 py-2">
      <div class="flex flex-wrap items-center gap-2">
        <div v-if="laravel" class="join shrink-0">
          <button class="btn btn-xs join-item" :class="{ 'btn-active': source === 'dev' }" @click="source = 'dev'">Dev servers</button>
          <button class="btn btn-xs join-item" :class="{ 'btn-active': source === 'laravel' }" @click="source = 'laravel'">laravel.log</button>
        </div>
        <input v-model="filter" class="input input-xs w-full min-w-40 max-w-72 flex-1" placeholder="Filter…" />
        <span v-if="source === 'dev'" class="shrink-0 text-xs opacity-50">{{ lines.length }} lines</span>
        <span v-else class="truncate text-xs opacity-50" :title="laravelFile ?? ''">{{ laravelFile ? laravelFile.split('/').slice(-2).join('/') : 'no laravel.log yet' }}</span>
        <div class="flex-1" />
        <div class="flex shrink-0 items-center gap-1">
          <label class="label cursor-pointer gap-1 pr-1 text-xs"><input v-model="follow" type="checkbox" class="toggle toggle-xs toggle-primary" /> follow</label>
          <button class="btn btn-ghost btn-xs" title="Copy the selected text, or every line shown (filter and chip apply)" @click="copy">Copy</button>
          <button v-if="source === 'dev'" class="btn btn-ghost btn-xs" @click="clear">Clear</button>
          <button v-if="canAi" class="btn btn-xs" title="Explain the selected lines (or the last ones) and suggest fixes" @click="explain">✦ Explain with AI</button>
        </div>
      </div>
      <div
        v-if="source === 'dev' && tags.length > 1"
        ref="chips"
        class="flex min-w-0 items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        :style="chipFade"
        role="tablist"
        aria-label="Show one app or service"
        @wheel="chipWheel"
        @scroll.passive="chipEdges"
      >
        <button class="log-chip shrink-0" :class="{ 'is-on': !app }" @click="app = null">All</button>
        <button v-for="t in tags" :key="t" class="log-chip shrink-0" :class="{ 'is-on': app === t }" :style="{ '--tag': tagColour(t) }" @click="app = app === t ? null : t">
          <span class="log-chip-dot" />{{ t }}
        </button>
      </div>
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
