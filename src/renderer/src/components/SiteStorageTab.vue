<script setup lang="ts">
import { STORAGE_LOGO } from '../logos';
import { computed, ref, watch } from 'vue';
import type { ProjectState, S3Bucket, StorageKind } from '@shared/types';
import StatusDot from './StatusDot.vue';
import { attempt, herd, navRequest, notify, state } from '../store';

/**
 * A site's Storage tab: its S3 libraries and current .env (AWS, another
 * endpoint, or DevCatz), a DevCatz object storage service and bucket for it,
 * and the .env lines written after a preview.
 */
const props = defineProps<{ project: ProjectState }>();
const p = computed(() => props.project);
const s3 = computed(() => p.value.s3);
const services = computed(() => (state.value?.storage ?? []).filter((s) => s.installed));
const LOGO = STORAGE_LOGO;

const chosen = ref<StorageKind | ''>(p.value.storageService ?? s3.value.service ?? services.value[0]?.kind ?? '');
watch(services, (l) => !chosen.value && l[0] && (chosen.value = l[0].kind));
const service = computed(() => services.value.find((s) => s.kind === chosen.value) ?? null);

// ---- buckets
const buckets = ref<S3Bucket[]>([]);
const bucket = ref(s3.value.bucket ?? '');
const loading = ref(false);
async function loadBuckets() {
  buckets.value = [];
  if (!service.value || service.value.status !== 'running') return;
  loading.value = true;
  buckets.value = (await herd.s3Buckets(service.value.kind).catch(() => [])) ?? [];
  loading.value = false;
  if (!bucket.value || (!buckets.value.some((b) => b.name === bucket.value) && !newBucket.value)) bucket.value = buckets.value.find((b) => b.name === s3.value.bucket)?.name ?? buckets.value[0]?.name ?? '';
}
watch(() => [chosen.value, service.value?.status], loadBuckets, { immediate: true });
const suggested = computed(() => p.value.name.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'app');
const newBucket = ref('');
async function createBucket() {
  const name = (newBucket.value || suggested.value).trim();
  if (await attempt(() => herd.s3CreateBucket(service.value!.kind, name).then(() => true))) {
    notify('success', `Bucket ${name} created`);
    newBucket.value = '';
    await loadBuckets();
    bucket.value = name;
  }
}
const current = computed(() => buckets.value.find((b) => b.name === bucket.value) ?? null);
async function setPublic(on: boolean) {
  if (await attempt(() => herd.s3SetPublic(service.value!.kind, bucket.value, on).then(() => true))) await loadBuckets();
}

// ---- .env
const entries = ref<Record<string, string>>({});
const error = ref('');
async function loadEnv() {
  error.value = '';
  entries.value = {};
  if (!service.value || !bucket.value) return;
  try {
    entries.value = await herd.storageEnv(service.value.kind, p.value.id, bucket.value);
  } catch (e) {
    error.value = (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  }
}
watch(() => [chosen.value, bucket.value], loadEnv, { immediate: true });
const text = computed(() =>
  Object.entries(entries.value)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n'),
);
type Plan = { added: string[]; changed: { key: string; from: string; to: string }[]; unchanged: string[] };
const plan = ref<Plan | null>(null);
watch(text, () => (plan.value = null));
const comment = computed(() => `S3 (DevCatz ${service.value?.name ?? ''})`);
async function preview() {
  plan.value = (await attempt(() => herd.envMerge(p.value.id, '.env', { ...entries.value }, comment.value, false))) ?? null;
}
async function write() {
  const r = await attempt(() => herd.envMerge(p.value.id, '.env', { ...entries.value }, comment.value, true));
  if (!r) return;
  if (p.value.storageService !== chosen.value && chosen.value) await attempt(() => herd.updateProject(p.value.id, { storageService: chosen.value as StorageKind }));
  notify('success', `.env updated (${r.added.length} added, ${r.changed.length} changed)${p.value.status === 'running' ? '. Restart the site to apply it.' : ''}`);
  plan.value = null;
}
const mask = (k: string, v: string) => (/SECRET/i.test(k) ? '••••••••' : v || '""');
const where = computed(() => {
  if (s3.value.service) return `DevCatz ${state.value?.storage.find((s) => s.kind === s3.value.service)?.name ?? s3.value.service}`;
  if (!s3.value.endpoint) return s3.value.bucket || s3.value.disk === 's3' ? 'Amazon S3 (no endpoint set)' : 'not configured';
  return s3.value.endpoint;
});
function openStorage() {
  navRequest.value = { section: 'storage', id: chosen.value || undefined };
}
</script>

<template>
  <section class="site-tab">
    <div class="card">
      <div class="card-body">
        <h2 class="font-semibold">S3 in this site</h2>
        <div class="flex flex-wrap gap-1.5">
          <span v-for="l in s3.libs" :key="l.name" class="badge badge-ghost" :title="`Found in ${l.source}`">{{ l.name }}</span>
        </div>
        <div class="grid gap-2 text-sm sm:grid-cols-3">
          <div><span class="label-caps block">Now points at</span><span :class="s3.service ? 'text-success' : ''">{{ where }}</span></div>
          <div><span class="label-caps block">Bucket</span><code>{{ s3.bucket ?? '—' }}</code></div>
          <div v-if="p.stack.runtime === 'php'"><span class="label-caps block">Default disk</span><code>{{ s3.disk ?? 'local' }}</code></div>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-body">
        <div class="flex flex-wrap items-center gap-2">
          <StatusDot v-if="service" :status="service.status" />
          <h2 class="flex-1 font-semibold">DevCatz object storage</h2>
          <div v-if="services.length > 1" class="seg">
            <a v-for="s in services" :key="s.kind" class="seg-item normal-case" :class="{ 'is-active': chosen === s.kind }" @click="chosen = s.kind">
              <img :src="LOGO[s.kind]" alt="" class="size-4 rounded bg-white object-contain" draggable="false" />{{ s.name }}
            </a>
          </div>
        </div>
        <div v-if="!services.length" class="flex items-center gap-2 text-sm">
          <span class="flex-1 opacity-70">No object storage installed yet (RustFS, MinIO or SeaweedFS).</span>
          <button class="btn btn-primary btn-xs" @click="openStorage">Install on the Storage page</button>
        </div>
        <template v-else-if="service">
          <div v-if="service.status !== 'running'" class="alert alert-soft text-sm">
            {{ service.name }} is {{ service.status }}.
            <button class="btn btn-xs" @click="herd.storageAction(service.kind, 'start')">Start</button>
          </div>
          <template v-else>
            <div class="flex flex-wrap items-center gap-2">
              <span class="label-caps">Bucket</span>
              <select v-model="bucket" class="select select-sm w-56 font-mono">
                <option v-if="!buckets.length" value="" disabled>{{ loading ? 'Loading…' : 'No buckets yet' }}</option>
                <option v-for="b in buckets" :key="b.name" :value="b.name">{{ b.name }}{{ b.public ? ' (public)' : '' }}</option>
              </select>
              <label v-if="current" class="flex cursor-pointer items-center gap-2 text-xs" title="Anonymous read: files open by URL (images, downloads)">
                <input type="checkbox" class="toggle toggle-xs toggle-primary" :checked="current.public" @change="setPublic(($event.target as HTMLInputElement).checked)" />public read
              </label>
              <span class="flex-1" />
              <input v-model="newBucket" class="input input-sm w-44 font-mono" :placeholder="suggested" spellcheck="false" />
              <button class="btn btn-sm" @click="createBucket">Create bucket</button>
            </div>
            <div v-if="error" class="text-xs text-error">{{ error }}</div>
            <template v-else-if="text">
              <div class="flex flex-wrap items-center gap-2">
                <span class="text-sm font-medium">.env lines</span>
                <span class="flex-1" />
                <button class="btn btn-ghost btn-xs" @click="openStorage">Browse on the Storage page</button>
                <button class="btn btn-xs" @click="preview">Preview changes</button>
                <button class="btn btn-primary btn-xs" :disabled="!plan || (!plan.added.length && !plan.changed.length)" title="Preview first" @click="write">Write to .env</button>
              </div>
              <pre class="selectable overflow-x-auto rounded-box bg-base-200/70 p-3 font-mono text-xs leading-6">{{ text }}</pre>
              <div v-if="plan" class="rounded-box border border-base-300/60 p-2 font-mono text-xs leading-6">
                <div v-for="k in plan.added" :key="'a' + k" class="text-success">+ {{ k }}={{ mask(k, entries[k]) }}</div>
                <div v-for="c in plan.changed" :key="'c' + c.key">
                  <span class="text-error">- {{ c.key }}={{ mask(c.key, c.from) }}</span><br />
                  <span class="text-success">+ {{ c.key }}={{ mask(c.key, c.to) }}</span>
                </div>
                <div v-if="plan.unchanged.length" class="opacity-50">= {{ plan.unchanged.join(', ') }} (already set)</div>
                <div v-if="!plan.added.length && !plan.changed.length" class="font-sans opacity-70">Nothing to change: the .env already has these values.</div>
              </div>
              <p class="text-xs opacity-60">
                The app talks to {{ service.name }} on 127.0.0.1 (no TLS, so any PHP / Node / Python works); public file URLs use
                <code>{{ service.urls?.api }}</code>{{ current?.public ? '' : ' (turn on public read for files opened by URL)' }}.
              </p>
            </template>
          </template>
        </template>
      </div>
    </div>
  </section>
</template>
