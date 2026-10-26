<script setup lang="ts">
import type { StackIcon } from '../stackicons';

/**
 * A framework / language mark: a one-colour Simple Icons path (dark brand
 * colours follow the text colour), or the project's own logo image.
 */
defineProps<{ icon: StackIcon; label?: string }>();
</script>

<template>
  <img v-if="icon.img" :src="icon.img" :alt="label ?? icon.title" class="rounded-[22%] bg-white object-contain p-px" draggable="false" />
  <svg v-else viewBox="0 0 24 24" role="img" :aria-label="label ?? icon.title" :style="{ color: icon.color === 'currentColor' ? undefined : icon.color }"><path :d="icon.d" fill="currentColor" /></svg>
</template>
