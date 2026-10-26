<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref } from 'vue';

/**
 * Click-to-open menu rendered in <body>. The DaisyUI focus dropdown cannot be
 * used in the title bar: those areas are `-webkit-app-region: drag`, which
 * macOS hit-tests itself, so a menu inside them may never open or receive clicks.
 */
export interface MenuItem {
  label: string;
  hint?: string;
  /** SVG path data (20×20 viewBox). */
  icon?: string;
  /** A tick in front (radio-like choices). */
  checked?: boolean;
  /** A rule above this item. */
  separator?: boolean;
  action: () => void;
}

const props = withDefaults(defineProps<{ items: MenuItem[]; align?: 'start' | 'end'; width?: number }>(), {
  align: 'start',
  width: 240,
});

const open = ref(false);
const trigger = ref<HTMLElement | null>(null);
const menu = ref<HTMLElement | null>(null);
const pos = ref({ top: 0, left: 0 });

function place() {
  const r = trigger.value!.getBoundingClientRect();
  const left = props.align === 'end' ? r.right - props.width : r.left;
  pos.value = { top: r.bottom + 6, left: Math.max(8, Math.min(left, window.innerWidth - props.width - 8)) };
}

function onOutside(e: MouseEvent) {
  const t = e.target as Node;
  if (!menu.value?.contains(t) && !trigger.value?.contains(t)) close();
}
function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') close();
}

async function toggle() {
  if (open.value) return close();
  place();
  open.value = true;
  await nextTick();
  document.addEventListener('mousedown', onOutside);
  document.addEventListener('keydown', onKey);
  window.addEventListener('resize', close);
}

function close() {
  open.value = false;
  document.removeEventListener('mousedown', onOutside);
  document.removeEventListener('keydown', onKey);
  window.removeEventListener('resize', close);
}

function run(item: MenuItem) {
  close();
  item.action();
}

onBeforeUnmount(close);
/** Lets a parent open the menu another way (e.g. right-click on the trigger). */
defineExpose({ toggle });
</script>

<template>
  <span ref="trigger" class="no-drag inline-flex" @click="toggle">
    <slot :open="open" />
  </span>
  <Teleport to="body">
    <ul
      v-if="open"
      ref="menu"
      role="menu"
      class="menu no-drag fixed z-50 rounded-box border border-base-300 bg-base-100 p-1.5 text-sm shadow-xl"
      :style="{ top: `${pos.top}px`, left: `${pos.left}px`, width: `${width}px` }"
    >
      <li v-for="item in items" :key="item.label" :class="{ 'mt-1 border-t border-base-300/60 pt-1': item.separator }">
        <a role="menuitem" class="items-start gap-2.5" @click="run(item)">
          <span v-if="item.checked !== undefined" class="w-3 shrink-0 text-center text-xs" :class="item.checked ? 'opacity-100' : 'opacity-0'">✓</span>
          <svg v-if="item.icon" class="mt-0.5 size-4 shrink-0 opacity-70" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" clip-rule="evenodd" :d="item.icon" /></svg>
          <span class="min-w-0">
            <span class="block font-medium">{{ item.label }}</span>
            <span v-if="item.hint" class="block text-xs opacity-60">{{ item.hint }}</span>
          </span>
        </a>
      </li>
    </ul>
  </Teleport>
</template>
