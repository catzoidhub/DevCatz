import { safeStorage } from 'electron';
import { AI_DEFAULTS, AI_FEATURES, AI_PROVIDERS, type AiFeature, type AiProvider, type AiSettings, type AiSettingsPatch } from '@shared/types';
import { store } from '../store';
import { readShared, setSharedKey, sharedKey, writeShared } from '../shared';

/**
 * AI settings (TODO §28). The connection — provider, models, addresses and API keys — is shared with the other
 * Catzoid apps (shared.ts: Catzoid/shared.json + the "Catzoid AI" Keychain item), so a key entered in DBCatz
 * works here and the other way round. AI on / off and the feature switches stay DevCatz's own. Keys never leave
 * the main process. The settings and keys DevCatz kept before (safeStorage) move over once (migrateAiToShared).
 */
const KEY = 'ai';
const KEYS = 'aiKeys';
const PROVIDERS = AI_PROVIDERS.map((p) => p.id);
const FEATURES = AI_FEATURES.map((f) => f.id);

type Stored = Omit<AiSettings, 'keys'>;

function stored(): Stored {
  const s = { ...AI_DEFAULTS, ...(store.extra<Partial<Stored>>(KEY) ?? {}) };
  const shared = readShared().ai ?? {};
  const provider = shared.provider ?? s.provider;
  return {
    enabled: s.enabled === true,
    provider: PROVIDERS.includes(provider) ? provider : 'anthropic',
    models: shared.models ?? s.models ?? {},
    baseUrls: shared.baseUrls ?? s.baseUrls ?? {},
    off: (s.off ?? []).filter((f): f is AiFeature => FEATURES.includes(f)),
  };
}

function encryptedKeys(): Partial<Record<AiProvider, string>> {
  return store.extra<Partial<Record<AiProvider, string>>>(KEYS) ?? {};
}

export function aiSettings(): AiSettings {
  const local = encryptedKeys();
  const shared = new Set(readShared().ai?.keys ?? []);
  return { ...stored(), keys: PROVIDERS.filter((p) => shared.has(p) || local[p]) };
}

export function setAiSettings(patch: AiSettingsPatch): AiSettings {
  const s = stored();
  if (patch.enabled !== undefined) s.enabled = patch.enabled === true;
  if (patch.provider !== undefined) {
    if (!PROVIDERS.includes(patch.provider)) throw new Error(`Unknown AI provider ${patch.provider}`);
    s.provider = patch.provider;
  }
  for (const [p, m] of Object.entries(patch.models ?? {})) {
    if (!PROVIDERS.includes(p as AiProvider)) continue;
    const id = String(m ?? '').trim().slice(0, 200);
    if (id) s.models[p as AiProvider] = id;
    else delete s.models[p as AiProvider];
  }
  for (const [p, u] of Object.entries(patch.baseUrls ?? {})) {
    if (!PROVIDERS.includes(p as AiProvider)) continue;
    const url = String(u ?? '').trim();
    if (url && !/^https?:\/\/[^\s]+$/i.test(url)) throw new Error('The address must start with http:// or https://');
    if (url) s.baseUrls[p as AiProvider] = url.slice(0, 500);
    else delete s.baseUrls[p as AiProvider];
  }
  if (patch.off !== undefined) s.off = [...new Set(patch.off)].filter((f) => FEATURES.includes(f));
  store.setExtra(KEY, s);
  // The connection is shared with DBCatz; on / off and the features are not.
  if (patch.provider !== undefined || patch.models !== undefined || patch.baseUrls !== undefined) writeShared({ ai: { provider: s.provider, models: s.models, baseUrls: s.baseUrls } });
  return aiSettings();
}

/** Saves (or with '' removes) a provider's key in the shared Keychain item; DevCatz's own old copy goes. */
export async function setAiKey(provider: AiProvider, key: string): Promise<AiSettings> {
  if (!PROVIDERS.includes(provider)) throw new Error(`Unknown AI provider ${provider}`);
  await setSharedKey(provider, key);
  const all = { ...encryptedKeys() };
  if (all[provider]) {
    delete all[provider];
    store.setExtra(KEYS, all);
  }
  return aiSettings();
}

/** The key of a provider ('' = none): the shared one, else DevCatz's own from before. Main process only. */
export async function aiKey(provider: AiProvider): Promise<string> {
  const shared = await sharedKey(provider);
  if (shared) return shared;
  const v = encryptedKeys()[provider];
  return v && safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(Buffer.from(v, 'base64')) : '';
}

/**
 * Once, at start: what DevCatz kept on its own before the settings were shared moves to the shared file and
 * Keychain item, unless another app shared its choice already (that one wins).
 */
export async function migrateAiToShared(): Promise<void> {
  const local = { ...AI_DEFAULTS, ...(store.extra<Partial<Stored>>(KEY) ?? {}) };
  if (!readShared().ai?.provider && store.extra(KEY)) writeShared({ ai: { provider: local.provider, models: local.models ?? {}, baseUrls: local.baseUrls ?? {} } });
  const keys = encryptedKeys();
  const shared = new Set(readShared().ai?.keys ?? []);
  let moved = false;
  for (const p of PROVIDERS) {
    const v = keys[p];
    if (!v) continue;
    try {
      if (!shared.has(p) && safeStorage.isEncryptionAvailable()) await setSharedKey(p, safeStorage.decryptString(Buffer.from(v, 'base64')));
      delete keys[p];
      moved = true;
    } catch (e) {
      console.warn(`AI key ${p} not moved to the shared Keychain item:`, (e as Error).message);
    }
  }
  if (moved) store.setExtra(KEYS, keys);
}

/** Throws unless AI and this feature are on. */
export function needFeature(feature: AiFeature): void {
  const s = stored();
  const label = AI_FEATURES.find((f) => f.id === feature)?.label ?? feature;
  if (!s.enabled) throw new Error('AI is off: turn it on in Settings → AI');
  if (s.off.includes(feature)) throw new Error(`${label} is switched off in Settings → AI`);
}
