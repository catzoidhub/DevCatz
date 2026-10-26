<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { highlightCode, type CodeLanguage } from '../highlight';

/**
 * A code editor without a dependency (the same idea as DBCatz's): a transparent textarea over a highlighted
 * <pre> that scrolls with it, line numbers on the left. Tab inserts two spaces; ⌘S emits `save`.
 * ⌘F finds, ⌘⇧L finds and replaces the selection (or the word at the caret): every match is marked, Replace
 * changes them one by one, All at once.
 */
const props = withDefaults(defineProps<{ modelValue: string; language: CodeLanguage; readonly?: boolean; minRows?: number; maxHeight?: string; /** Take the parent's height (a flex child) instead of sizing to the text. */ fill?: boolean }>(), {
  readonly: false,
  fill: false,
  minRows: 8,
  maxHeight: '32rem',
});
const emit = defineEmits<{ 'update:modelValue': [value: string]; save: [] }>();
const area = ref<HTMLTextAreaElement | null>(null);
const pre = ref<HTMLElement | null>(null);
const gutter = ref<HTMLElement | null>(null);
const html = computed(() => `${highlightCode(props.language, props.modelValue)}\n`);
const marks = ref<HTMLElement | null>(null);

// ---- find & replace
const find = ref<{ replace: boolean } | null>(null);
const query = ref('');
const replacement = ref('');
const matchCase = ref(false);
const current = ref(0);
const findInput = ref<HTMLInputElement | null>(null);
const replaceInput = ref<HTMLInputElement | null>(null);
/** Start offsets of every match (literal text). */
const matches = computed<number[]>(() => {
  const q = query.value;
  if (!find.value || !q) return [];
  const hay = matchCase.value ? props.modelValue : props.modelValue.toLowerCase();
  const needle = matchCase.value ? q : q.toLowerCase();
  const out: number[] = [];
  for (let i = hay.indexOf(needle); i >= 0 && out.length < 5000; i = hay.indexOf(needle, i + needle.length)) out.push(i);
  return out;
});
watch(matches, (m) => {
  if (current.value >= m.length) current.value = Math.max(0, m.length - 1);
});
const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
/** The text again, transparent, with the matches marked: a layer under the highlighted code. */
const marksHtml = computed(() => {
  if (!matches.value.length) return '';
  const src = props.modelValue;
  const n = query.value.length;
  let out = '';
  let at = 0;
  matches.value.forEach((m, i) => {
    out += `${esc(src.slice(at, m))}<mark class="${i === current.value ? 'is-current' : ''}">${esc(src.slice(m, m + n))}</mark>`;
    at = m + n;
  });
  return `${out}${esc(src.slice(at))}\n`;
});

/** Opens the bar with the selection, or the word at the caret. */
function openFind(replace: boolean) {
  const el = area.value!;
  const { selectionStart: a, selectionEnd: b, value } = el;
  let picked = value.slice(a, b);
  if (!picked) {
    const left = /[\w.-]*$/.exec(value.slice(0, a))?.[0] ?? '';
    const right = /^[\w.-]*/.exec(value.slice(a))?.[0] ?? '';
    picked = left + right;
  }
  if (picked && !picked.includes('\n')) query.value = picked;
  find.value = { replace: replace && !props.readonly };
  if (replace && !replacement.value) replacement.value = query.value;
  void nextTick(() => {
    const target = find.value?.replace && query.value ? replaceInput.value : findInput.value;
    target?.focus();
    target?.select();
    const i = matches.value.findIndex((m) => m >= a);
    go(i < 0 ? 0 : i);
  });
}
function closeFind() {
  find.value = null;
  area.value?.focus();
}
/** Shows match i: selects it in the textarea and scrolls it to the middle. */
function go(i: number) {
  const m = matches.value;
  if (!m.length || !area.value) return;
  current.value = ((i % m.length) + m.length) % m.length;
  const at = m[current.value];
  const el = area.value;
  el.setSelectionRange(at, at + query.value.length);
  const line = props.modelValue.slice(0, at).split('\n').length - 1;
  const lh = parseFloat(getComputedStyle(el).lineHeight) || 18;
  el.scrollTop = Math.max(0, line * lh - el.clientHeight / 2);
  onScroll();
}
function replaceOne() {
  const m = matches.value;
  if (!m.length || props.readonly) return;
  const at = m[current.value];
  const v = props.modelValue;
  emit('update:modelValue', v.slice(0, at) + replacement.value + v.slice(at + query.value.length));
  // The next match takes this one's place in the list.
  void nextTick(() => go(current.value));
}
function replaceAll() {
  const m = matches.value;
  if (!m.length || props.readonly) return;
  const v = props.modelValue;
  const n = query.value.length;
  let out = '';
  let at = 0;
  for (const i of m) {
    out += v.slice(at, i) + replacement.value;
    at = i + n;
  }
  emit('update:modelValue', out + v.slice(at));
}
function findKey(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    closeFind();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    go(current.value + (e.shiftKey ? -1 : 1));
  } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') {
    e.preventDefault();
    findInput.value?.select();
  }
}
function replaceKey(e: KeyboardEvent) {
  if (e.key === 'Enter') {
    e.preventDefault();
    e.stopPropagation();
    if ((e.metaKey || e.ctrlKey) && e.altKey) replaceAll();
    else replaceOne();
  } else findKey(e);
}
const lineCount = computed(() => props.modelValue.split('\n').length);
const rows = computed(() => Math.max(props.minRows, lineCount.value));

function onScroll() {
  if (!area.value) return;
  for (const layer of [pre.value, marks.value]) {
    if (!layer) continue;
    layer.scrollTop = area.value.scrollTop;
    layer.scrollLeft = area.value.scrollLeft;
  }
  if (gutter.value) gutter.value.scrollTop = area.value.scrollTop;
}
function onKey(e: KeyboardEvent) {
  const mod = e.metaKey || e.ctrlKey;
  if (mod && !e.shiftKey && e.key.toLowerCase() === 'f') {
    e.preventDefault();
    openFind(false);
    return;
  }
  if (mod && e.shiftKey && e.key.toLowerCase() === 'l') {
    e.preventDefault();
    openFind(true);
    return;
  }
  if (e.key === 'Escape' && find.value) {
    e.preventDefault();
    closeFind();
    return;
  }
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
    e.preventDefault();
    emit('save');
    return;
  }
  if (e.key === 'Tab' && !e.metaKey && !e.ctrlKey && !props.readonly) {
    e.preventDefault();
    const el = area.value!;
    const { selectionStart: a, selectionEnd: b, value } = el;
    const next = `${value.slice(0, a)}  ${value.slice(b)}`;
    emit('update:modelValue', next);
    requestAnimationFrame(() => el.setSelectionRange(a + 2, a + 2));
  }
}
</script>

<template>
  <div class="code-editor" :class="{ 'is-readonly': readonly, 'min-h-0 flex-1': fill }" :style="fill ? undefined : { height: `min(${maxHeight}, ${rows * 1.55 + 1.5}rem)` }">
    <div ref="gutter" class="code-gutter" aria-hidden="true"><div v-for="n in lineCount" :key="n">{{ n }}</div></div>
    <div class="code-body">
      <pre v-if="marksHtml" ref="marks" class="code-hl code-marks" aria-hidden="true" v-html="marksHtml" />
      <pre ref="pre" class="code-hl" aria-hidden="true" v-html="html" />
      <textarea
        ref="area"
        class="code-input"
        :value="modelValue"
        :readonly="readonly"
        spellcheck="false"
        autocapitalize="off"
        autocorrect="off"
        autocomplete="off"
        wrap="off"
        @input="emit('update:modelValue', ($event.target as HTMLTextAreaElement).value)"
        @scroll="onScroll"
        @keydown="onKey"
      />
    </div>

    <!-- Find & replace (⌘F / ⌘⇧L) -->
    <div v-if="find" class="code-find" @keydown.stop>
      <div class="code-find-row">
        <input ref="findInput" v-model="query" class="code-find-input" placeholder="Find" spellcheck="false" @input="go(0)" @keydown="findKey" />
        <button class="code-find-btn" :class="{ 'is-on': matchCase }" title="Match case" @click="matchCase = !matchCase">Aa</button>
        <span class="code-find-count" :class="{ 'text-error': query && !matches.length }">{{ query ? (matches.length ? `${current + 1} of ${matches.length}` : 'No results') : '' }}</span>
        <button class="code-find-btn" title="Previous (⇧⏎)" :disabled="!matches.length" @click="go(current - 1)">↑</button>
        <button class="code-find-btn" title="Next (⏎)" :disabled="!matches.length" @click="go(current + 1)">↓</button>
        <button v-if="!readonly" class="code-find-btn" :class="{ 'is-on': find.replace }" title="Replace (⌘⇧L)" @click="find.replace = !find.replace">⇄</button>
        <button class="code-find-btn" title="Close (Esc)" @click="closeFind">✕</button>
      </div>
      <div v-if="find.replace" class="code-find-row">
        <input ref="replaceInput" v-model="replacement" class="code-find-input" placeholder="Replace with" spellcheck="false" @keydown="replaceKey" />
        <button class="btn btn-xs" title="Replace this one and go to the next (⏎)" :disabled="!matches.length" @click="replaceOne">Replace</button>
        <button class="btn btn-primary btn-xs" title="Replace every match (⌘⌥⏎)" :disabled="!matches.length" @click="replaceAll">All</button>
      </div>
    </div>
  </div>
</template>
