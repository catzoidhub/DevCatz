<script setup lang="ts">
import type { ProcessStatus, ProjectState } from '@shared/types';
import StatusDot from './StatusDot.vue';
import { state } from '../store';

/** One tab of a site's detail (label plus its status dots / git chip); used by the visible strip and its measuring copy. */
const props = defineProps<{ t: string; project: ProjectState; wsStatus: ProcessStatus; searchStatus: ProcessStatus; s3Status: ProcessStatus }>();
const LABEL: Record<string, string> = { api: 'API', websocket: 'WebSocket', search: 'Search Engine', whatsapp: 'Gateways' };
const gatewayStatus = (): ProcessStatus => {
  const p = props.project;
  const wa = p.waInfo?.engine && state.value?.whatsapp.find((w) => w.engine === p.waInfo!.engine)?.status === 'running';
  const gw = state.value?.gateways.some((g) => p.gwInfo?.kinds.includes(g.kind) && g.status === 'running');
  return wa || gw ? 'running' : 'stopped';
};
</script>

<template>
  <span class="capitalize">{{ LABEL[t] ?? t }}</span>
  <StatusDot v-if="t === 'whatsapp'" :status="gatewayStatus()" />
  <StatusDot v-if="t === 'mail'" :status="project.mailInfo?.catcher && state?.mail.running ? 'running' : 'stopped'" />
  <span v-if="t === 'git' && project.git && (project.git.changed || project.git.ahead || project.git.operation)" class="git-chip" :class="{ 'is-warn': project.git.conflicts || project.git.operation }">{{ project.git.operation ?? (project.git.changed || `↑${project.git.ahead}`) }}</span>
  <span v-if="t === 'database' && (project.stack.database || project.stack.redis)" class="flex gap-0.5">
    <StatusDot v-if="project.stack.database" :status="project.dbStatus" />
    <StatusDot v-if="project.stack.redis" :status="project.redisStatus" />
  </span>
  <StatusDot v-if="t === 'websocket'" :status="wsStatus" />
  <StatusDot v-if="t === 'search'" :status="searchStatus" />
  <StatusDot v-if="t === 'storage'" :status="s3Status" />
</template>
