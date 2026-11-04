<script setup lang="ts">
import { computed } from 'vue';
import { navRequest } from '../store';

/** After GitHub's limit message (main/github.ts): the way to the Git page, where connecting an account lifts the limit. */
const props = defineProps<{ text?: string | null }>();
const emit = defineEmits<{ opened: [] }>();
const shown = computed(() => !!props.text?.includes('connect a GitHub account'));
function open() {
  navRequest.value = { section: 'git' };
  emit('opened');
}
</script>

<template>
  <button v-if="shown" type="button" class="btn btn-xs shrink-0" @click="open">Open Git</button>
</template>
