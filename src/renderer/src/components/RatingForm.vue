<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import StarRating from './StarRating.vue';
import { herd, notify, reportDialog, state } from '../store';

/**
 * Rate DevCatz (Catzoid #96): the stars, then an optional short review and Send. Used by the corner card and Settings →
 * About. Every rating is sent the same way whatever the stars; 1–2 stars also offer Report a Bug, the rating still goes.
 */
const props = withDefaults(defineProps<{ start?: number; compact?: boolean }>(), { start: 0, compact: false });
const emit = defineEmits<{ done: [sent: boolean]; cancel: []; pick: [stars: number] }>();
const MAX = 1000;
const mine = computed(() => state.value?.settings.supportRating ?? null);
const stars = ref(props.start || mine.value?.rating || 0);
const text = ref(mine.value?.text ?? '');
const busy = ref(false);
const error = ref('');
watch(stars, (n) => n && emit('pick', n));

async function send() {
  if (!stars.value || busy.value) return;
  busy.value = true;
  error.value = '';
  try {
    const r = await herd.ratingSend(stars.value, text.value.trim() || null);
    notify(r.queued ? 'info' : 'success', r.queued ? 'No connection: your rating goes by itself when DevCatz is online.' : 'Thank you for rating DevCatz!');
    emit('done', true);
  } catch (e) {
    error.value = (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="space-y-2">
    <div class="flex items-center gap-3">
      <StarRating v-model="stars" label="Rate DevCatz" :size="compact ? '1.45rem' : '1.6rem'" />
      <span class="text-xs opacity-60">{{ stars ? ['', 'Poor', 'Could be better', 'Good', 'Very good', 'Love it'][stars] : 'Rate DevCatz' }}</span>
    </div>
    <template v-if="stars">
      <textarea
        v-model="text"
        class="textarea textarea-sm w-full resize-none leading-relaxed"
        :rows="compact ? 2 : 3"
        :maxlength="MAX"
        placeholder="A few words for other developers (optional)"
      />
      <div class="flex items-center justify-between gap-2 text-[11px] opacity-55">
        <span>Shown on catzoid.com after a quick look by the team. No name, only the version and system.</span>
        <span v-if="text.length > MAX - 200" class="shrink-0 tabular-nums">{{ text.length }}/{{ MAX }}</span>
      </div>
      <p v-if="stars <= 2" class="text-xs opacity-70">
        Something broken?
        <button type="button" class="link link-hover text-[var(--primary-ink,var(--color-primary))]" @click="reportDialog = 'bug'">Report a bug</button>
        and we will look at it. Your rating is sent either way.
      </p>
      <p v-if="error" class="text-xs text-error">{{ error }}</p>
      <div class="flex justify-end gap-2">
        <button type="button" class="btn btn-ghost btn-sm" :disabled="busy" @click="emit('cancel')">Cancel</button>
        <button type="button" class="btn btn-primary btn-sm" :disabled="busy" @click="send">
          <span v-if="busy" class="loading loading-spinner loading-xs" />{{ mine ? 'Update rating' : 'Send rating' }}
        </button>
      </div>
    </template>
  </div>
</template>
