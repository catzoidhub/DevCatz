<script setup lang="ts">
import { ref } from 'vue';
import AiExplain from './AiExplain.vue';

/**
 * Docker tab → ✦ Explain the last Docker output (TODO §28): a failed build or `compose up` in the site's log,
 * explained with fixes. Editing a Docker file with AI lives in the file editors (DockerFileEditor).
 */
defineProps<{ siteId: string }>();
const open = ref(false);
</script>

<template>
  <button v-if="!open" class="btn btn-sm" title="Explain the last Docker output in the site's log (a failed build or compose up)" @click="open = true">✦ Explain the last Docker output</button>
  <AiExplain v-else :site-id="siteId" source="docker" @close="open = false" />
</template>
