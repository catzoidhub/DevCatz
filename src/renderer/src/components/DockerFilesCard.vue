<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import DockerFileDialog from './DockerFileDialog.vue';
import { languageOf } from '../highlight';
import { attempt, herd } from '../store';

/** Docker tab → the site's own Docker files (Dockerfile, compose files, .dockerignore): open one in a dialog to read, edit and save. */
const props = defineProps<{ siteId: string; version: number }>();
const files = ref<string[]>([]);
const open = ref<string | null>(null);
const saved = ref<string | null>(null);
const text = ref('');
const dirty = computed(() => saved.value !== null && text.value !== saved.value);
const KIND: Record<string, string> = { dockerfile: 'Dockerfile', yaml: 'Compose', ignore: 'Ignore list', text: 'Text' };

async function list() {
  files.value = (await attempt(() => herd.dockerListFiles(props.siteId))) ?? [];
}
watch(() => props.version, list, { immediate: true });

async function show(f: string) {
  const t = await attempt(() => herd.dockerReadFile(props.siteId, f));
  if (t === undefined) return;
  open.value = f;
  saved.value = t;
  text.value = t;
}
async function save() {
  if (!open.value || !dirty.value) return;
  if (await attempt(() => herd.dockerSaveFile(props.siteId, open.value!, text.value).then(() => true), `${open.value} saved`)) saved.value = text.value;
}
function close() {
  if (dirty.value && !confirm(`Discard the unsaved changes to ${open.value}?`)) return;
  open.value = null;
  saved.value = null;
}
</script>

<template>
  <div v-if="files.length" class="card">
    <div class="card-body gap-3">
      <div>
        <h2 class="font-semibold">Docker files</h2>
        <p class="text-xs opacity-60">Open one to read or customize it; regenerating later asks before replacing it.</p>
      </div>
      <div class="divide-y divide-base-300/60 rounded-box border border-base-300/60">
        <button v-for="f in files" :key="f" class="flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-base-200/50" @click="show(f)">
          <code class="flex-1 text-sm">{{ f }}</code>
          <span class="badge badge-ghost badge-sm">{{ KIND[languageOf(f)] }}</span>
          <span class="text-xs opacity-60">Open →</span>
        </button>
      </div>
    </div>
    <DockerFileDialog v-if="open && saved !== null" v-model="text" :file="open" :site-id="siteId" :original="saved" :dirty="dirty" @save="save" @close="close">
      <template #actions>
        <button class="btn btn-ghost btn-sm" :disabled="!dirty" @click="text = saved ?? ''">Revert</button>
        <button class="btn btn-primary btn-sm" :disabled="!dirty" @click="save">Save</button>
      </template>
    </DockerFileDialog>
  </div>
</template>
