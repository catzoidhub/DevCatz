<script setup lang="ts">
import { computed } from 'vue';

/**
 * A tiny line + area chart (SVG, no library). `values` oldest → newest; `max`
 * fixes the top (e.g. 100 for CPU %), else it follows the data. A second
 * series (`values2`) is drawn as a dashed line (network out, disk write).
 */
const props = withDefaults(
  defineProps<{ values: number[]; values2?: number[]; max?: number; floor?: number; color?: string; color2?: string; height?: number; fill?: boolean }>(),
  { color: 'var(--color-primary)', color2: 'var(--color-secondary)', height: 28, fill: true, floor: 0 },
);

const W = 100;
const top = computed(() => {
  // `floor`: the top never drops below it, so near-zero noise stays flat instead of filling the chart.
  const m = Math.max(props.max ?? 0, props.floor, ...props.values, ...(props.values2 ?? []));
  return m > 0 ? m * (props.max ? 1 : 1.15) : 1;
});
function path(vals: number[]): string {
  if (!vals.length) return '';
  const n = vals.length;
  const step = n > 1 ? W / (n - 1) : W;
  return vals.map((v, i) => `${i ? 'L' : 'M'}${(i * step).toFixed(2)},${(props.height - (Math.min(v, top.value) / top.value) * (props.height - 2) - 1).toFixed(2)}`).join(' ');
}
const line = computed(() => path(props.values));
const line2 = computed(() => (props.values2 ? path(props.values2) : ''));
const area = computed(() => (line.value ? `${line.value} L${W},${props.height} L0,${props.height} Z` : ''));
</script>

<template>
  <svg :viewBox="`0 0 ${W} ${height}`" preserveAspectRatio="none" class="block w-full" :style="{ height: `${height}px` }">
    <path v-if="fill && area" :d="area" :fill="color" fill-opacity="0.14" />
    <path v-if="line" :d="line" fill="none" :stroke="color" stroke-width="1.5" vector-effect="non-scaling-stroke" stroke-linejoin="round" />
    <path v-if="line2" :d="line2" fill="none" :stroke="color2" stroke-width="1.2" stroke-dasharray="3 2" vector-effect="non-scaling-stroke" />
  </svg>
</template>
