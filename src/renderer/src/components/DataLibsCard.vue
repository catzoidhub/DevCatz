<script setup lang="ts">
import { computed } from 'vue';
import type { DataLib, ProjectState } from '@shared/types';
import { libMark } from '../datamarks';
import StackMark from './StackMark.vue';

/** The ORMs, query builders and migration tools this site uses, each with its mark; their commands are in the cards below. */
const props = defineProps<{ project: ProjectState }>();
const libs = computed<DataLib[]>(() => props.project.stack.dataLibs ?? []);
const KIND: Record<DataLib['kind'], string> = { orm: 'ORM', 'query-builder': 'Query builder', migrations: 'Migrations', codegen: 'Code generator', driver: 'Driver' };
</script>

<template>
  <div v-if="libs.length" class="card">
    <div class="card-body gap-3">
      <div class="flex items-center gap-2">
        <h2 class="font-semibold">Data access</h2>
        <span class="text-xs opacity-55">{{ libs.length }} found</span>
      </div>
      <ul class="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
        <li v-for="l in libs" :key="`${l.id}:${l.dir}`" class="flex items-center gap-3 rounded-xl border border-base-300/60 bg-base-200/40 px-3 py-2.5">
          <span class="grid size-9 shrink-0 place-items-center rounded-lg bg-base-100 ring-1 ring-base-content/10">
            <StackMark v-if="libMark(l.id)" :icon="libMark(l.id)!" :label="l.name" class="size-5" />
          </span>
          <span class="min-w-0 flex-1">
            <span class="flex items-center gap-1.5">
              <span class="truncate text-sm font-medium">{{ l.name }}</span>
              <span class="badge badge-ghost badge-xs shrink-0">{{ KIND[l.kind] }}</span>
            </span>
            <span v-if="l.note" class="block truncate text-[11px] opacity-55" :title="l.note">{{ l.note }}</span>
          </span>
        </li>
      </ul>
    </div>
  </div>
</template>
