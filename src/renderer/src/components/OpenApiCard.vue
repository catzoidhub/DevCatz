<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { ProjectState, SiteOpenApi } from '@shared/types';
import ConfirmDialog from './ConfirmDialog.vue';
import DialCatzButton from './DialCatzButton.vue';
import CatMood from './CatMood.vue';
import { attempt, herd, notify } from '../store';

/**
 * Overview → API (OpenAPI): where the site's API is described — a spec file in the project (openapi.yaml,
 * swagger.json …) or the document a running app serves (each app on its own port, so an API on a subdomain counts).
 * DialCatz imports the routes from here (DevCatz/bridge.json). When there is none, DevCatz adds one where it can:
 * Scramble for Laravel, @nestjs/swagger for NestJS; for other stacks it says how.
 */
const props = defineProps<{ site: ProjectState }>();
const emit = defineEmits<{ logs: [] }>();
const info = ref<SiteOpenApi | null>(null);
const probing = ref(false);
const running = computed(() => props.site.status === 'running' || props.site.stack.runtime === 'php');

async function load(probe: boolean) {
  probing.value = probe;
  info.value = (await attempt(() => herd.siteOpenApi(props.site.id, probe))) ?? info.value;
  probing.value = false;
}
watch(
  () => `${props.site.id}|${props.site.status}`,
  () => void load(running.value),
  { immediate: true },
);

// DialCatz can import this API: Laravel's route list (no OpenAPI needed), or an OpenAPI document DevCatz found.
const laravel = computed(() => props.site.stack.apps.some((a) => a.framework === 'laravel'));
const importable = computed(() => laravel.value || !!info.value?.specs.length);
const notYet = computed(() => (importable.value ? null : info.value ? 'Nothing to import yet: this site has no OpenAPI document (add one below)' : 'Looking for the API…'));

const rel = (file: string) => (file.startsWith(`${props.site.path}/`) ? file.slice(props.site.path.length + 1) : file);
const appName = (dir: string) => props.site.stack.apps.find((a) => a.dir === dir)?.name ?? dir;

const asking = ref(false);
const adding = ref(false);
const WHAT = {
  scramble: { title: 'Add Scramble to this Laravel site?', text: 'Runs composer require dedoc/scramble --dev. Scramble describes your routes, requests and responses by reading the code — no annotations — and serves the document at /docs/api.json (and a viewer at /docs/api) in the local environment.', button: 'Add Scramble' },
  'nest-swagger': { title: 'Add @nestjs/swagger to this NestJS site?', text: 'Installs @nestjs/swagger and adds three lines to src/main.ts, before app.listen, that serve the document at /docs-json (and a viewer at /docs). Review the change in Git afterwards.', button: 'Add @nestjs/swagger' },
} as const;
async function add() {
  if (!info.value?.install) return;
  asking.value = false;
  adding.value = true;
  emit('logs');
  const ok = await attempt(() => herd.addOpenApi(props.site.id, info.value!.install!).then(() => true));
  adding.value = false;
  if (ok) notify('success', running.value ? 'Added — restart the site, then DialCatz can import its routes' : 'Added — start the site, then DialCatz can import its routes');
  await load(running.value);
}
</script>

<template>
  <div class="card">
    <div class="card-body gap-3 p-4">
      <div class="flex items-center gap-2">
        <h2 class="font-semibold">API</h2>
        <span class="badge badge-ghost badge-sm">OpenAPI</span>
        <span class="flex-1" />
        <button class="btn btn-ghost btn-xs" :disabled="probing || !running" :title="running ? 'Ask the running apps again' : 'Start the site to look for the documents its apps serve'" @click="load(true)">
          <span v-if="probing" class="loading loading-spinner loading-xs" />Look again
        </button>
        <DialCatzButton :site-id="site.id" :disabled-reason="notYet" />
      </div>
      <p v-if="laravel" class="text-xs opacity-60">Laravel: DialCatz reads the route list (<code>php artisan route:list</code>), no OpenAPI needed{{ info?.install === 'scramble' ? '; Scramble below adds the request and response details' : '' }}.</p>

      <template v-if="info?.specs.length">
        <div v-for="(s, i) in info.specs" :key="i" class="flex items-center gap-3 rounded-box border border-base-300/60 px-3 py-2 text-sm">
          <span class="badge badge-sm" :class="s.url ? 'badge-success badge-soft' : 'badge-ghost'">{{ s.url ? 'served' : 'file' }}</span>
          <code class="min-w-0 flex-1 truncate text-xs">{{ s.url ?? rel(s.file!) }}</code>
          <span v-if="site.stack.apps.length > 1" class="text-xs opacity-60">{{ appName(s.app) }}</span>
          <button v-if="s.url" class="btn btn-ghost btn-xs" @click="herd.openUrl(s.url)">Open</button>
          <button v-else class="btn btn-ghost btn-xs" @click="herd.openapiReveal(site.id, s.file!)">Show in Finder</button>
        </div>
        <p v-if="!laravel" class="text-xs opacity-60">DialCatz imports the routes from {{ info.specs.length === 1 ? 'this document' : 'these documents' }}.</p>
      </template>

      <template v-else-if="info">
        <div class="flex items-start gap-3 text-sm">
          <CatMood mood="info" class="size-8 shrink-0" />
          <div class="min-w-0 space-y-1">
            <p v-if="laravel">No OpenAPI document — optional here: DialCatz already has the routes.</p>
            <p v-else>No OpenAPI document found{{ info.probed ? '' : running ? '' : ' in the project — start the site and DevCatz also asks its apps' }}.</p>
            <p v-if="info.hint" class="text-xs opacity-70">{{ info.hint }}</p>
            <p v-else-if="info.install && !laravel" class="text-xs opacity-70">DialCatz needs one to import this site's routes; DevCatz can add it.</p>
          </div>
        </div>
        <div v-if="info.install" class="flex justify-end">
          <button class="btn btn-sm btn-primary" :disabled="adding || !!site.dbTask" @click="asking = true">
            <span v-if="adding" class="loading loading-spinner loading-xs" />{{ WHAT[info.install].button }}
          </button>
        </div>
      </template>
      <div v-else class="flex items-center gap-2 text-sm opacity-60"><span class="loading loading-spinner loading-sm" />Looking…</div>
    </div>
    <ConfirmDialog v-if="asking && info?.install" :title="WHAT[info.install].title" :text="WHAT[info.install].text" :confirm="WHAT[info.install].button" @ok="add" @cancel="asking = false" />
  </div>
</template>
