<script setup lang="ts">
import { computed } from 'vue';
import mcatzpLogo from '../assets/logos/mcatzp.svg';
import { attempt, herd, state } from '../store';

/** MCatzP asks here: may this MCP client connect (the first time), and may it do this change. */
const ask = computed(() => state.value?.mcatzpAsk ?? null);
const CAN = ['Sites, favorites and groups', 'Services and runtimes', 'Git status and history', 'Logs, with secrets masked', '.env variable names, never values'];
const answer = (a: 'deny' | 'once' | 'session') => {
  const id = ask.value?.id;
  if (id) void attempt(() => herd.mcatzpAnswer(id, a).then(() => true));
};
</script>

<template>
  <!-- At the end of <body>, above everything: it can come up on any page, over another dialog. -->
  <Teleport to="body">
    <dialog v-if="ask" open class="modal modal-open z-[1000]" @keydown.esc.prevent="answer('deny')">
      <div class="modal-box flex w-[27rem] max-w-[95vw] flex-col items-center gap-4 text-center">
        <img :src="mcatzpLogo" alt="MCatzP" class="size-16 rounded-2xl shadow-sm" draggable="false" />
        <template v-if="ask.kind === 'pair'">
          <div>
            <h3 class="text-lg font-semibold tracking-tight">Let <span class="selectable">{{ ask.client }}</span> use DevCatz?</h3>
            <p class="mt-0.5 text-xs opacity-60">{{ ask.version ? `Version ${ask.version}, connecting` : 'Connecting' }} through MCatzP</p>
          </div>
          <div class="w-full rounded-box border border-base-300/70 bg-base-200/40 p-3 text-left">
            <span class="label-caps mb-1.5 block">It can read</span>
            <ul class="space-y-1 text-sm">
              <li v-for="c in CAN" :key="c" class="flex items-center gap-2"><span class="status status-success status-xs shrink-0" />{{ c }}</li>
            </ul>
            <p class="mt-2 border-t border-base-300/60 pt-2 text-xs opacity-70">It can also ask to start, stop and restart sites and services; DevCatz asks you first. What it reads goes to that assistant's model provider.</p>
          </div>
          <p class="text-xs opacity-60">This approval lasts until DevCatz quits. The name is what the client says about itself: if you did not just start it, choose Don't Allow.</p>
          <div class="flex w-full gap-2">
            <button class="btn btn-sm flex-1" autofocus @click="answer('deny')">Don't Allow</button>
            <button class="btn btn-primary btn-sm flex-1" @click="answer('once')">Allow</button>
          </div>
        </template>
        <template v-else>
          <div>
            <h3 class="text-lg font-semibold tracking-tight">{{ ask.title }}</h3>
            <p class="mt-0.5 text-xs opacity-60"><span class="selectable">{{ ask.client }}</span> asks through MCatzP</p>
          </div>
          <dl class="w-full space-y-1 rounded-box border border-base-300/70 bg-base-200/40 p-3 text-left text-sm">
            <div v-for="f in ask.facts" :key="f.label" class="flex gap-3">
              <dt class="w-16 shrink-0 opacity-60">{{ f.label }}</dt>
              <dd class="selectable min-w-0 flex-1 break-words">{{ f.value }}</dd>
            </div>
          </dl>
          <div class="flex w-full flex-col gap-2">
            <div class="flex w-full gap-2">
              <button class="btn btn-sm flex-1" autofocus @click="answer('deny')">Don't Allow</button>
              <button class="btn btn-primary btn-sm flex-1" @click="answer('once')">Allow once</button>
            </div>
            <button v-if="ask.allowSession" class="btn btn-ghost btn-xs" title="This kind of action, without asking, until the client disconnects or DevCatz quits" @click="answer('session')">Allow this kind of action for this session</button>
          </div>
        </template>
      </div>
    </dialog>
  </Teleport>
</template>
