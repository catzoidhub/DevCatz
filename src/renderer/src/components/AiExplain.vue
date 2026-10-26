<script setup lang="ts">
import type { AiExplainAnswer, AiExplainRequest } from '@shared/types';
import AiBox from './AiBox.vue';
import AiActions from './AiActions.vue';
import { herd } from '../store';
import { plain } from '../ai';

/**
 * Explain & fix (TODO §28): what went wrong in these lines (Logs, a crash, Docker output), why, the steps only
 * the developer can take, and one-click DevCatz fixes. Starts right away; a follow-up question goes in the field.
 */
const props = defineProps<{ siteId: string; source: AiExplainRequest['source']; lines?: string[] }>();
const emit = defineEmits<{ close: [] }>();
const req = (prompt: string): AiExplainRequest => ({ siteId: props.siteId, source: props.source, lines: plain(props.lines), prompt });
const run = (prompt: string, token: string) => herd.aiExplain(req(prompt), token);
const preview = (prompt: string) => herd.aiPreviewExplain(req(prompt));
</script>

<template>
  <AiBox :run="run" :preview="preview" auto action="Explain" placeholder="Ask about it, e.g. “why only on this page?”" busy-text="Reading the lines…" @close="emit('close')">
    <template #default="{ answer }">
      <div class="space-y-2 text-sm">
        <p class="font-medium">{{ (answer as AiExplainAnswer).summary }}</p>
        <p v-if="(answer as AiExplainAnswer).cause" class="opacity-80">{{ (answer as AiExplainAnswer).cause }}</p>
        <ol v-if="(answer as AiExplainAnswer).steps.length" class="list-decimal space-y-1 pl-5 opacity-90">
          <li v-for="(s, i) in (answer as AiExplainAnswer).steps" :key="i" class="selectable">{{ s }}</li>
        </ol>
        <AiActions :actions="(answer as AiExplainAnswer).actions" :site-id="siteId" />
      </div>
    </template>
  </AiBox>
</template>
