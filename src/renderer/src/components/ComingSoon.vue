<script setup lang="ts">
/** Placeholder for a top-level section that is still being built (WebSocket, Search Engine, Monitoring). */
defineProps<{
  title: string;
  icon: string;
  intro: string;
  features: { title: string; text: string }[];
  meanwhile?: string;
  /** Section colour (`--c-<tint>`). */
  tint?: string;
}>();
</script>

<template>
  <!-- No page header (like Projects); the top strip moves the window. -->
  <section class="flex min-w-0 flex-1 flex-col bg-base-100">
    <div class="drag h-6 shrink-0" />
    <div class="flex-1 overflow-y-auto px-6 pb-6">
      <div class="mx-auto max-w-3xl space-y-6 pt-4">
        <div class="rounded-box border border-dashed border-base-300 p-8 text-center">
          <span class="mx-auto grid size-16 place-items-center rounded-2xl" :style="{ color: `var(--c-${tint ?? 'projects'})`, background: `color-mix(in oklch, var(--c-${tint ?? 'projects'}) 14%, transparent)` }">
            <svg class="size-8" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" clip-rule="evenodd" :d="icon" /></svg>
          </span>
          <div class="mt-3 flex items-center justify-center gap-2">
            <h1 class="text-lg font-semibold tracking-tight">{{ title }}</h1>
            <span class="badge badge-warning badge-soft badge-sm">In development</span>
          </div>
          <p class="mx-auto mt-1 max-w-lg text-sm opacity-70">{{ intro }}</p>
        </div>
        <div>
          <h3 class="mb-2 text-xs font-semibold tracking-wide uppercase opacity-50">Planned</h3>
          <div class="grid gap-3 sm:grid-cols-2">
            <div v-for="f in features" :key="f.title" class="rounded-box border border-base-300/60 p-4">
              <div class="font-medium">{{ f.title }}</div>
              <p class="mt-1 text-xs opacity-70">{{ f.text }}</p>
            </div>
          </div>
        </div>
        <p v-if="meanwhile" class="text-xs opacity-60">{{ meanwhile }}</p>
      </div>
    </div>
  </section>
</template>
