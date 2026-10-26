import { computed } from 'vue';
import type { AiFeature } from '@shared/types';
import { state } from './store';

/** True when AI is on and this feature is not switched off (Settings → AI): the AI buttons show only then. */
export const aiOn = (feature: AiFeature) => computed(() => Boolean(state.value?.ai.enabled && !state.value.ai.off.includes(feature)));

let n = 0;
/** A token for one request, so Stop can abort it. */
export const aiToken = () => `ai-${Date.now().toString(36)}-${++n}`;

/** "Error invoking remote method …: Error: x" → "x". */
export const aiError = (e: unknown) => String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

/**
 * A plain copy for IPC: Vue's reactive proxies (a ref's array, an answer's action) cannot go through Electron's
 * structured clone ("An object could not be cloned").
 */
export const plain = <T>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T));
