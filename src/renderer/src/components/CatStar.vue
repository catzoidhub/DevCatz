<script setup lang="ts">
import { computed } from 'vue';

/**
 * One rating star (Catzoid #96), the site's drawing (Catzoid apps/web/src/lib/rating-star.ts): a five-pointed star
 * with the Catzoid head in its middle. Gold in every Catzoid app, not the app's primary (user, 2026-11-17). Filled,
 * the head sits dark on the gold; empty, both are quiet outlines in currentColor. `fill` (0–1) fills it from the left,
 * for an average like 4.3.
 */
const props = withDefaults(defineProps<{ fill?: number }>(), { fill: 0 });
const id = `cat-star-${++count}`;
const f = computed(() => Math.max(0, Math.min(1, props.fill)));
</script>
<script lang="ts">
let count = 0;
/** A five-pointed star in a 100 × 100 box, point up: outer radius 48, inner 23, centre (50, 54). */
const STAR = (() => {
  const pts: string[] = [];
  for (let i = 0; i < 10; i++) {
    const r = i % 2 ? 23 : 48;
    const a = (Math.PI / 5) * i - Math.PI / 2;
    pts.push(`${(50 + r * Math.cos(a)).toFixed(2)} ${(54 + r * Math.sin(a)).toFixed(2)}`);
  }
  return `M${pts.join(' L')} Z`;
})();
/** MrCatz's head (Catzoid/art/logos/catzoid.svg), scaled into the star's middle. */
const HEAD =
  'M268 418 L246 222 L446 334 C 487 318, 537 318, 578 334 L778 222 L756 418 C 792 470, 808 528, 808 586 C 808 712, 676 790, 512 790 C 348 790, 216 712, 216 586 C 216 528, 232 470, 268 418 Z';
const HEAD_AT = 'translate(50 58) scale(0.05) translate(-512 -500)';
</script>

<template>
  <svg class="cat-star" viewBox="0 0 100 100" aria-hidden="true">
    <defs>
      <clipPath :id="id"><rect x="0" y="0" :width="100 * f" height="100" /></clipPath>
    </defs>
    <path class="cs-empty" :d="STAR" />
    <path class="cs-empty-cat" :d="HEAD" :transform="HEAD_AT" />
    <g v-if="f > 0" :clip-path="`url(#${id})`">
      <path class="cs-full" :d="STAR" />
      <path class="cs-cat" :d="HEAD" :transform="HEAD_AT" />
    </g>
  </svg>
</template>

<style scoped>
.cat-star {
  --cs: #f5b63c;
  overflow: visible;
}
.cs-empty {
  fill: color-mix(in oklch, currentColor 6%, transparent);
  stroke: color-mix(in oklch, currentColor 32%, transparent);
  stroke-width: 4;
  stroke-linejoin: round;
}
.cs-empty-cat {
  fill: color-mix(in oklch, currentColor 22%, transparent);
}
.cs-full {
  fill: var(--cs);
  /* --cat-star-edge (main.css): a slightly darker edge on light backgrounds, where the gold looks pale */
  stroke: var(--cat-star-edge, var(--cs));
  stroke-width: 4;
  stroke-linejoin: round;
}
.cs-cat {
  fill: color-mix(in oklch, var(--cs) 30%, #241a05);
}
</style>
