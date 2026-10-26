<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { ProjectState } from '@shared/types';
import { ICONS } from '../icons';
import { attempt, herd } from '../store';

const props = defineProps<{ project: ProjectState; url: string }>();

const src = ref<string | null>(null);
const running = computed(() => props.project.status === 'running');

// Reload the image whenever a new capture lands.
watch(
  () => [props.project.id, props.project.screenshotAt] as const,
  async ([id, at]) => {
    src.value = at ? await herd.getScreenshot(id) : null;
  },
  { immediate: true },
);

const age = computed(() => {
  const at = props.project.screenshotAt;
  if (!at) return '';
  const min = Math.round((Date.now() - at) / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  return h < 48 ? `${h} h ago` : new Date(at).toLocaleDateString();
});

const refresh = () => attempt(() => herd.refreshScreenshot(props.project.id));
</script>

<template>
  <div class="group relative aspect-[16/10] w-full overflow-hidden rounded-box border border-base-300/70 bg-base-200 shadow-sm">
    <img
      v-if="src"
      :src="src"
      alt=""
      class="size-full cursor-pointer object-cover object-top transition group-hover:scale-[1.01]"
      :class="{ 'opacity-50 grayscale': !running }"
      draggable="false"
      @click="herd.openUrl(url)"
    />
    <div v-else class="flex size-full flex-col items-center justify-center gap-2 text-xs opacity-60">
      <svg class="size-8" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" clip-rule="evenodd" :d="ICONS.globe" /></svg>
      <span v-if="project.capturing">Taking a screenshot…</span>
      <span v-else-if="running">No preview yet</span>
      <span v-else>Start the site to see a preview</span>
    </div>

    <div class="absolute inset-x-0 bottom-0 flex items-center gap-2 bg-gradient-to-t from-black/60 to-transparent px-3 pt-6 pb-2 text-xs text-white">
      <span v-if="age" class="opacity-80">{{ running ? '' : 'Stopped · ' }}{{ age }}</span>
      <div class="flex-1" />
      <button
        class="btn btn-xs border-white/20 bg-black/40 text-white hover:bg-black/60"
        :disabled="!running || project.capturing"
        title="Take a new screenshot"
        @click.stop="refresh"
      >
        <span v-if="project.capturing" class="loading loading-spinner loading-xs" />
        <svg v-else class="size-3.5" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" clip-rule="evenodd" :d="ICONS.refresh" /></svg>
        Refresh
      </button>
    </div>
  </div>
</template>
