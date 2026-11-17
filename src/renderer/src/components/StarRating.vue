<script setup lang="ts">
import { computed, ref } from 'vue';
import CatStar from './CatStar.vue';

/**
 * Five Catzoid stars to pick a rating (Catzoid #96): hover / focus fills up to that star, arrow keys move, Enter or a
 * click picks. A radio group for screen readers ("4 out of 5").
 */
const props = withDefaults(defineProps<{ modelValue?: number; size?: string; label?: string }>(), { modelValue: 0, size: '1.6rem', label: 'Rating' });
const emit = defineEmits<{ 'update:modelValue': [value: number] }>();
const hover = ref(0);
const shown = computed(() => hover.value || props.modelValue);
const buttons = ref<HTMLButtonElement[]>([]);

function pick(n: number) {
  emit('update:modelValue', n);
}
function key(e: KeyboardEvent, n: number) {
  const step = e.key === 'ArrowRight' || e.key === 'ArrowUp' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -1 : 0;
  if (!step) return;
  e.preventDefault();
  const next = Math.max(1, Math.min(5, n + step));
  pick(next);
  buttons.value[next - 1]?.focus();
}
</script>

<template>
  <div class="star-rating inline-flex items-center gap-[0.08em]" role="radiogroup" :aria-label="label" :style="{ fontSize: size }" @mouseleave="hover = 0">
    <button
      v-for="n in 5"
      :key="n"
      ref="buttons"
      type="button"
      role="radio"
      :aria-checked="modelValue === n"
      :aria-label="`${n} out of 5`"
      :tabindex="(modelValue || 1) === n ? 0 : -1"
      class="grid size-[1.1em] place-items-center rounded-md transition-transform hover:scale-110 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--primary-ink,var(--color-primary))]"
      @mouseenter="hover = n"
      @focus="hover = n"
      @blur="hover = 0"
      @click="pick(n)"
      @keydown="key($event, n)"
    >
      <CatStar class="size-[1.1em]" :fill="shown >= n ? 1 : 0" />
    </button>
  </div>
</template>
