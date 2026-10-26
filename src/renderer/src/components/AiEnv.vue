<script setup lang="ts">
import type { AiEnvAnswer } from '@shared/types';
import AiBox from './AiBox.vue';
import AiActions from './AiActions.vue';
import { herd } from '../store';

/**
 * Env tab → Check with AI (TODO §28): what the keys of this .env are for and which look wrong for local
 * development, with values that point at DevCatz services written on click. Only key names and harmless shapes
 * are sent, never the values.
 */
const props = defineProps<{ siteId: string; file: string }>();
const emit = defineEmits<{ close: []; changed: [] }>();
const req = (prompt: string) => ({ siteId: props.siteId, file: props.file, prompt });
const run = (prompt: string, token: string) => herd.aiEnv(req(prompt), token);
const preview = (prompt: string) => herd.aiPreviewEnv(req(prompt));
</script>

<template>
  <AiBox :run="run" :preview="preview" auto action="Check" :placeholder="`Ask about ${file}, e.g. “what is SESSION_DOMAIN for?”`" busy-text="Reading the key names…" @close="emit('close')">
    <template #default="{ answer }">
      <div class="space-y-2 text-sm">
        <p>{{ (answer as AiEnvAnswer).summary }}</p>
        <div v-for="i in (answer as AiEnvAnswer).items" :key="i.key" class="rounded-box border border-base-300/60 p-2">
          <div class="flex flex-wrap items-center gap-2">
            <code class="font-semibold">{{ i.key }}</code>
            <span v-if="i.issue" class="badge badge-warning badge-soft badge-sm">needs a look</span>
            <span class="flex-1" />
            <AiActions v-if="i.action" :actions="[i.action]" :site-id="siteId" @done="emit('changed')" />
          </div>
          <p class="mt-1 text-xs opacity-80">{{ i.meaning }}</p>
          <p v-if="i.issue" class="mt-1 text-xs text-warning">{{ i.issue }}</p>
          <p v-if="i.suggestion" class="selectable mt-1 text-xs opacity-80">→ {{ i.suggestion }}</p>
        </div>
      </div>
    </template>
  </AiBox>
</template>
