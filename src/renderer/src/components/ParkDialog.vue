<script setup lang="ts">
import { computed, ref } from 'vue';
import { attempt, herd, state } from '../store';

/**
 * Park a folder (after it was picked): every project inside becomes a site; optionally all of them, and the ones
 * added to the folder later, go into one sidebar group (named after the folder unless renamed).
 */
const props = defineProps<{ dir: string }>();
const emit = defineEmits<{ close: [] }>();

const folderName = props.dir.split(/[\\/]/).filter(Boolean).pop() ?? props.dir;
const asGroup = ref(false);
const name = ref(folderName);
const busy = ref(false);
const existing = computed(() => state.value?.settings.siteGroups.find((g) => g.name.toLowerCase() === name.value.trim().toLowerCase()) ?? null);
const tld = computed(() => state.value?.settings.tld ?? 'localhost');

async function park() {
  busy.value = true;
  const group = asGroup.value ? name.value.trim() || folderName : null;
  const ok = await attempt(
    () => herd.parkFolder(props.dir, group).then(() => true),
    `Parked ${folderName}: every project inside gets a .${tld.value} domain${group ? `, in the group “${group}”` : ''}`,
  );
  busy.value = false;
  if (ok) emit('close');
}
</script>

<template>
  <div class="no-drag fixed inset-0 z-40 flex items-center justify-center bg-black/30 p-6" @mousedown.self="emit('close')">
    <form class="w-full max-w-md rounded-box border border-base-300 bg-base-100 p-5 shadow-2xl" role="dialog" aria-label="Park a folder" @submit.prevent="park">
      <h2 class="text-base font-semibold">Park a folder</h2>
      <p class="mt-1 text-xs opacity-70">Every project inside becomes a site on .{{ tld }}, now and when you add more later.</p>
      <div class="mt-3 truncate rounded-md bg-base-200/70 px-2 py-1 font-mono text-xs" :title="dir">{{ dir }}</div>

      <label class="mt-4 flex cursor-pointer items-start gap-3">
        <input v-model="asGroup" type="checkbox" class="toggle toggle-primary toggle-sm mt-0.5" />
        <span>
          <span class="block font-medium">Park as a group</span>
          <span class="block text-xs opacity-60">Its sites sit together in the sidebar, and projects added to the folder later join the group too.</span>
        </span>
      </label>
      <label v-if="asGroup" class="mt-3 block pl-12">
        <span class="label-caps mb-1 block">Group name</span>
        <input v-model="name" class="input input-sm w-full" maxlength="40" :placeholder="folderName" />
        <span v-if="existing" class="mt-1 block text-xs opacity-60">The group “{{ existing.name }}” exists: these sites join it.</span>
      </label>

      <div class="mt-5 flex justify-end gap-2">
        <button type="button" class="btn btn-ghost btn-sm" @click="emit('close')">Cancel</button>
        <button type="submit" class="btn btn-primary btn-sm" :disabled="busy"><span v-if="busy" class="loading loading-spinner loading-xs" />Park</button>
      </div>
    </form>
  </div>
</template>
