<!-- Copied from DBCatz (src/renderer/src/viewer/DvModelPicker.vue): keep the two in step until @catzoid/ui shares it. -->
<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';

/**
 * Settings → AI's model field: type to search a provider's list (routers
 * such as OpenRouter or 9router list hundreds), ↑ ↓ ⏎ to pick, or keep a
 * typed id the list does not have. Only the rows in view are drawn. Checked
 * models show ✓ / ✗; "Check" sends the matches (up to 24) to the key check.
 */
const props = defineProps<{ models: string[]; modelValue: string; status: Record<string, string | null> | undefined; checking: boolean; canCheck: boolean; placeholder: string }>();
const emit = defineEmits<{ 'update:modelValue': [id: string]; check: [ids: string[]] }>();

const open = ref(false);
const text = ref(props.modelValue);
watch(
  () => props.modelValue,
  (v) => {
    if (!open.value) text.value = v;
  },
);
const query = computed(() => (text.value === props.modelValue ? '' : text.value.trim().toLowerCase()));
/** Matches: names that start with the text (or its part after a "provider/") first; checked-and-working first within each. */
const matches = computed(() => {
  const q = query.value;
  const ok = (m: string) => props.status?.[m] === null;
  const all = q ? props.models.filter((m) => m.toLowerCase().includes(q)) : props.models;
  const starts = (m: string) => m.toLowerCase().startsWith(q) || m.toLowerCase().split('/').pop()!.startsWith(q);
  const rank = (m: string) => (ok(m) ? 0 : props.status?.[m] ? 2 : 1) + (q && !starts(m) ? 3 : 0);
  return [...all].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
});
const activeIndex = ref(0);
watch(query, () => {
  activeIndex.value = 0;
  if (list.value) list.value.scrollTop = 0;
  scrollTop.value = 0;
});

// ---- virtual list
const ROW = 28;
const VIEW = 9;
const list = ref<HTMLElement | null>(null);
const scrollTop = ref(0);
const first = computed(() => Math.max(0, Math.floor(scrollTop.value / ROW) - 4));
const visible = computed(() => matches.value.slice(first.value, first.value + VIEW + 8).map((m, i) => ({ m, i: first.value + i })));
function reveal() {
  const el = list.value;
  if (!el) return;
  const top = activeIndex.value * ROW;
  if (top < el.scrollTop) el.scrollTop = top;
  else if (top + ROW > el.scrollTop + el.clientHeight) el.scrollTop = top + ROW - el.clientHeight;
  scrollTop.value = el.scrollTop;
}

function show() {
  open.value = true;
  void nextTick(() => {
    const i = matches.value.indexOf(props.modelValue);
    activeIndex.value = Math.max(0, i);
    if (list.value) list.value.scrollTop = Math.max(0, i * ROW - 3 * ROW);
    scrollTop.value = list.value?.scrollTop ?? 0;
  });
}
function pick(id: string) {
  const v = id.trim();
  open.value = false;
  text.value = v || props.modelValue;
  if (v && v !== props.modelValue) emit('update:modelValue', v);
}
function onKey(e: KeyboardEvent) {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    if (!open.value) show();
    activeIndex.value = Math.min(matches.value.length - 1, Math.max(0, activeIndex.value + (e.key === 'ArrowDown' ? 1 : -1)));
    reveal();
  } else if (e.key === 'Enter') {
    // The highlighted match, or the typed id as it is when nothing matches.
    pick(open.value && matches.value[activeIndex.value] && query.value ? matches.value[activeIndex.value] : text.value);
  } else if (e.key === 'Escape') {
    open.value = false;
    text.value = props.modelValue;
  } else return;
  e.preventDefault();
}
function blurred() {
  // A click in the list lands first; then keep a typed id that is not in the list.
  setTimeout(() => {
    if (open.value) pick(text.value);
  }, 150);
}

function parts(m: string): [string, string, string] {
  const q = query.value;
  const at = q ? m.toLowerCase().indexOf(q) : -1;
  return at < 0 ? [m, '', ''] : [m.slice(0, at), m.slice(at, at + q.length), m.slice(at + q.length)];
}
const checked = computed(() => Object.keys(props.status ?? {}).length);
const working = computed(() => Object.values(props.status ?? {}).filter((x) => x === null).length);
</script>

<template>
  <div class="relative min-w-0 flex-1">
    <input v-model="text" class="input input-sm w-full font-mono text-xs" :placeholder="placeholder" spellcheck="false" autocomplete="off" @focus="show" @input="open = true" @keydown="onKey" @blur="blurred" />
    <div v-if="open && models.length" class="dv-pop absolute top-full left-0 z-50 mt-1 w-full" @mousedown.prevent>
      <div class="flex items-center gap-2 border-b border-base-300/60 px-2.5 py-1.5 text-[11px] opacity-60">
        <span>{{ query ? `${matches.length} of ${models.length}` : `${models.length} models` }}</span>
        <span v-if="checked">· {{ working }} of {{ checked }} checked work</span>
        <span class="flex-1" />
        <span v-if="query && !matches.length">⏎ keeps “{{ text.trim() }}”</span>
      </div>
      <div ref="list" class="relative overflow-y-auto p-1" :style="{ maxHeight: `${VIEW * ROW + 8}px` }" @scroll="scrollTop = ($event.target as HTMLElement).scrollTop">
        <p v-if="!matches.length" class="px-2 py-2 text-xs opacity-50">No model matches. ⏎ uses the id as typed.</p>
        <div :style="{ height: `${matches.length * ROW}px` }" class="relative">
          <div v-for="{ m, i } in visible" :key="m" class="absolute inset-x-0 flex cursor-pointer items-center gap-1.5 rounded-md px-2 font-mono text-xs" :class="{ 'bg-primary/15': i === activeIndex, 'font-semibold': m === modelValue, 'opacity-45': !!status?.[m] }" :style="{ top: `${i * ROW}px`, height: `${ROW}px` }" :title="status?.[m] ?? (status?.[m] === null ? 'Works with this key' : m)" @mousemove="activeIndex = i" @click="pick(m)">
            <span class="w-3 shrink-0 text-center" :class="status?.[m] === null ? 'text-success' : status?.[m] ? 'text-error' : 'text-primary'">{{ status?.[m] === null ? '✓' : status?.[m] ? '✗' : m === modelValue ? '•' : '' }}</span>
            <span class="min-w-0 flex-1 truncate" :class="{ 'line-through': !!status?.[m] }">{{ parts(m)[0] }}<b class="text-primary">{{ parts(m)[1] }}</b>{{ parts(m)[2] }}</span>
          </div>
        </div>
      </div>
      <div class="flex items-center gap-2 border-t border-base-300/60 px-2 py-1.5">
        <button type="button" class="btn btn-xs" :disabled="checking || !canCheck || !matches.length" :title="canCheck ? 'Sends one tiny request per model to see which ones the key may use' : 'Save the API key first'" @click="emit('check', matches.slice(0, 24))">
          <span v-if="checking" class="loading loading-spinner loading-xs" />{{ checking ? 'Checking…' : `Check ${Math.min(24, matches.length)} ${query ? 'matching' : 'listed'} with the key` }}
        </button>
        <span class="min-w-0 flex-1 truncate text-[11px] opacity-50">{{ matches.length > 24 ? 'Type to narrow the list first: up to 24 at a time' : '✗ hover for the reason' }}</span>
      </div>
    </div>
  </div>
</template>
