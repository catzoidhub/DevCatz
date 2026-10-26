<script setup lang="ts">
import type { DbStatus, ProcessStatus } from '@shared/types';

defineProps<{ status: ProcessStatus | DbStatus }>();

const CLASS: Record<string, string> = {
  running: 'status-success',
  starting: 'status-warning animate-pulse',
  stopping: 'status-warning animate-pulse',
  crashed: 'status-error',
  unknown: 'status-neutral',
  stopped: 'status-neutral opacity-50',
  none: 'hidden',
};
</script>

<template>
  <span class="status status-md shrink-0" :class="CLASS[status]" :title="status" />
</template>
