<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue';
import type { ProjectState } from '@shared/types';
import { attempt, herd, notify } from '../store';
import CopyName from './CopyName.vue';
import CatMood from './CatMood.vue';

/** Unlink confirmation: the user types the site's domain, so a misclick cannot remove a site. */
const props = defineProps<{ project: ProjectState }>();
const emit = defineEmits<{ close: []; done: [] }>();

const typed = ref('');
const busy = ref(false);
const input = ref<HTMLInputElement | null>(null);
const matches = computed(() => typed.value.trim().toLowerCase() === props.project.domain.toLowerCase());
onMounted(() => nextTick(() => input.value?.focus()));

async function submit() {
  if (!matches.value || busy.value) return;
  busy.value = true;
  const ok = await attempt(() => herd.removeProject(props.project.id, typed.value).then(() => true));
  busy.value = false;
  if (!ok) return;
  notify('success', `${props.project.name} unlinked; the folder is untouched`);
  emit('done');
}
</script>

<template>
  <dialog open class="modal modal-open" @keydown.esc="!busy && emit('close')">
    <form class="modal-box w-[30rem] max-w-[95vw] space-y-4" @submit.prevent="submit">
      <div class="flex items-start gap-3">
        <span class="grid size-10 shrink-0 place-items-center rounded-xl bg-error/12"><CatMood mood="warning" class="size-8" /></span>
        <div>
          <h3 class="text-lg font-semibold tracking-tight">Unlink {{ project.name }}?</h3>
          <p class="text-xs opacity-70">
            The site is removed from DevCatz: its domain stops working and its dev server is stopped. The project folder and its files are not
            touched; you can link it again any time.
          </p>
        </div>
      </div>

      <div class="rounded-box bg-base-200/60 p-3 text-xs">
        <div class="label-caps mb-1">Folder</div>
        <code class="selectable break-all">{{ project.path }}</code>
      </div>

      <label class="block">
        <span class="mb-1 block text-sm">
          To confirm, type the domain <CopyName :value="project.domain" />
        </span>
        <input
          ref="input"
          v-model="typed"
          class="input input-sm w-full font-mono"
          :class="{ 'input-error': typed && !matches, 'input-success': matches }"
          :placeholder="project.domain"
          spellcheck="false"
          autocomplete="off"
          autocapitalize="off"
        />
      </label>

      <div class="modal-action mt-2">
        <button type="button" class="btn btn-ghost btn-sm" :disabled="busy" @click="emit('close')">Cancel</button>
        <button class="btn btn-error btn-sm" :disabled="!matches || busy">
          <span v-if="busy" class="loading loading-spinner loading-xs" />
          Unlink
        </button>
      </div>
    </form>
    <div class="modal-backdrop" @click="!busy && emit('close')" />
  </dialog>
</template>
