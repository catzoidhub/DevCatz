<script setup lang="ts">
import { computed, ref } from 'vue';
import type { ProjectState } from '@shared/types';
import { attempt, herd, state } from '../store';
import { DB_LOGO, isActive } from '../db';
import StatusDot from './StatusDot.vue';
import DbEnvWriter from './DbEnvWriter.vue';
import DbCatzButton from './DbCatzButton.vue';

/** Site Database tab: the DevCatz database service this site uses (start/stop, viewer, .env lines). */
const props = defineProps<{ project: ProjectState }>();

const services = computed(() => (state.value?.databases ?? []).filter((d) => !d.pending));
const linked = computed(() => services.value.find((d) => d.id === props.project.dbService) ?? null);
const choice = ref('');
const showEnv = ref(false);
const busy = ref(false);

async function link() {
  if (!choice.value) return;
  await attempt(() => herd.updateProject(props.project.id, { dbService: choice.value }));
  choice.value = '';
  showEnv.value = true;
}
const unlink = () => attempt(() => herd.updateProject(props.project.id, { dbService: '' }));
async function act(action: 'start' | 'stop') {
  busy.value = true;
  await attempt(() => herd.dbAction(linked.value!.id, action));
  busy.value = false;
}
</script>

<template>
  <div class="card">
    <div class="card-body">
      <div class="flex items-center gap-2">
        <h2 class="font-semibold">DevCatz database service</h2>
        <span class="flex-1" />
        <button v-if="linked" class="btn btn-ghost btn-xs" @click="unlink">Unlink</button>
      </div>

      <template v-if="linked">
        <div class="flex flex-wrap items-center gap-3">
          <img :src="DB_LOGO[linked.engine]" alt="" class="size-8 rounded-lg bg-white p-1 ring-1 ring-base-content/10" draggable="false" />
          <div class="min-w-0">
            <div class="flex items-center gap-2 font-medium">
              {{ linked.name }}
              <template v-if="linked.engine !== 'sqlite'"><StatusDot :status="linked.status" /><span class="text-xs opacity-60">{{ linked.status }}</span></template>
            </div>
            <div class="font-mono text-xs opacity-60">
              {{ linked.engineName }} {{ linked.version }}<template v-if="linked.engine !== 'sqlite'"> · {{ linked.host ?? '127.0.0.1' }}:{{ linked.port }}</template>
            </div>
          </div>
          <span class="flex-1" />
          <template v-if="linked.engine !== 'sqlite'">
            <button v-if="!isActive(linked)" class="btn btn-primary btn-sm" :disabled="busy" @click="act('start')">Start</button>
            <button v-else class="btn btn-sm" :disabled="busy || linked.status === 'stopping'" @click="act('stop')">Stop</button>
          </template>
          <DbCatzButton :conn-id="`svc:${linked.id}`" :database="project.stack.database?.database ?? undefined" />
          <button class="btn btn-sm" @click="showEnv = !showEnv">{{ showEnv ? 'Hide .env lines' : '.env lines…' }}</button>
        </div>
        <div v-if="linked.error" class="text-xs text-error">{{ linked.error }}</div>
        <p class="text-xs opacity-60">It starts when this site starts. Settings, logs and removal are on the Database page (rail).</p>
        <DbEnvWriter v-if="showEnv" :key="linked.id" :service="linked" :site-id="project.id" />
      </template>

      <template v-else>
        <p class="text-xs opacity-70">
          Link one of DevCatz’s MySQL, MariaDB, PostgreSQL, Redis, MongoDB, Elasticsearch or SQLite services: it starts with the site and its connection can be written
          into this site’s .env.
        </p>
        <div v-if="services.length" class="flex flex-wrap items-center gap-2">
          <select v-model="choice" class="select select-sm w-64">
            <option value="" disabled>Choose a service…</option>
            <option v-for="d in services" :key="d.id" :value="d.id">{{ d.name }} · {{ d.engineName }} {{ d.version }}{{ d.engine !== 'sqlite' ? ` · :${d.port}` : '' }}</option>
          </select>
          <button class="btn btn-sm btn-primary" :disabled="!choice" @click="link">Link</button>
        </div>
        <p v-else class="text-xs opacity-60">No services yet: create one on the Database page (rail).</p>
      </template>
    </div>
  </div>
</template>
