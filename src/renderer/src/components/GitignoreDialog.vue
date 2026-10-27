<script setup lang="ts">
import { keyLabel, words } from '@shared/platform';
import { computed, onMounted, ref } from 'vue';
import CodeEditor from './CodeEditor.vue';
import CatMood from './CatMood.vue';
import { attempt, herd } from '../store';

/**
 * Git tab → .gitignore: the site's .gitignore in a large code editor (highlighted, ⌘S saves, Esc closes), like the
 * Docker file dialog. When the site has none yet, an empty state offers to add one, starting from the usual
 * entries for its stack (dependencies, build output, secrets), which can be changed before it is saved.
 */
const props = defineProps<{ siteId: string; siteName: string }>();
const emit = defineEmits<{ close: []; saved: [] }>();

const loaded = ref(false);
const exists = ref(false);
const adding = ref(false);
const original = ref('');
const text = ref('');
const suggested = ref('');
const saving = ref(false);

onMounted(async () => {
  const r = await attempt(() => herd.gitignoreRead(props.siteId));
  if (r) {
    exists.value = r.exists;
    original.value = r.content;
    text.value = r.content;
    suggested.value = r.suggested;
  }
  loaded.value = true;
});

const editing = computed(() => exists.value || adding.value);
const dirty = computed(() => editing.value && (text.value !== original.value || !exists.value));
const lines = computed(() => text.value.split('\n').filter((l) => l.trim() && !l.trim().startsWith('#')).length);

function startAdding(withTemplate: boolean) {
  text.value = withTemplate ? suggested.value : '';
  adding.value = true;
}
async function save() {
  if (!editing.value || saving.value) return;
  saving.value = true;
  const ok = await attempt(() => herd.gitignoreSave(props.siteId, text.value).then(() => true), exists.value ? '.gitignore saved' : '.gitignore added');
  saving.value = false;
  if (!ok) return;
  exists.value = true;
  original.value = text.value.endsWith('\n') || !text.value ? text.value : `${text.value}\n`;
  text.value = original.value;
  emit('saved');
}
</script>

<template>
  <dialog open class="modal modal-open" @keydown.esc.stop="emit('close')">
    <div class="modal-box flex max-h-[90vh] w-[56rem] max-w-[95vw] flex-col gap-3">
      <div class="flex items-center gap-2">
        <h3 class="font-mono text-base font-semibold">.gitignore</h3>
        <span class="text-xs opacity-60">· {{ siteName }}</span>
        <span v-if="dirty && exists" class="badge badge-warning badge-soft badge-sm">unsaved</span>
        <span v-else-if="adding && !exists" class="badge badge-info badge-soft badge-sm">new</span>
        <span class="flex-1" />
        <button class="btn btn-ghost btn-sm btn-square" title="Close (Esc)" aria-label="Close" @click="emit('close')">✕</button>
      </div>

      <div v-if="!loaded" class="flex items-center gap-2 py-10 text-sm opacity-60"><span class="loading loading-spinner loading-sm" />Reading…</div>

      <!-- No .gitignore yet -->
      <div v-else-if="!editing" class="flex flex-col items-center gap-3 py-10 text-center">
        <CatMood mood="info" class="size-20" />
        <div class="text-base font-semibold">No .gitignore yet</div>
        <p class="max-w-md text-sm opacity-70">
          Without one, Git sees dependencies, build output and <code>.env</code> secrets as files to commit. Start from the usual entries for this site's stack and change them before you save.
        </p>
        <div class="flex gap-2">
          <button class="btn btn-primary btn-sm" @click="startAdding(true)">Add .gitignore</button>
          <button class="btn btn-ghost btn-sm" @click="startAdding(false)">Start empty</button>
        </div>
      </div>

      <template v-else>
        <p v-if="adding && !exists" class="text-xs opacity-70">The usual entries for this site's stack. Change them as you like; nothing is written until you save.</p>
        <div class="min-h-0 flex-1 overflow-y-auto">
          <CodeEditor v-model="text" language="ignore" :min-rows="22" max-height="62vh" @save="save" />
        </div>
      </template>

      <div class="flex items-center gap-2">
        <span class="text-xs opacity-60">
          <template v-if="editing">{{ lines }} rule{{ lines === 1 ? '' : 's' }} · <kbd class="kbd kbd-xs">{{ keyLabel('mod+S') }}</kbd> saves · </template><kbd class="kbd kbd-xs">Esc</kbd> closes
        </span>
        <span class="flex-1" />
        <button class="btn btn-ghost btn-sm" @click="emit('close')">{{ dirty ? 'Cancel' : 'Close' }}</button>
        <button v-if="editing" class="btn btn-primary btn-sm" :disabled="!dirty || saving" @click="save">
          <span v-if="saving" class="loading loading-spinner loading-xs" />{{ exists ? 'Save' : 'Add .gitignore' }}
        </button>
      </div>
    </div>
    <div class="modal-backdrop" @click="emit('close')" />
  </dialog>
</template>
