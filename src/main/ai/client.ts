import Anthropic from '@anthropic-ai/sdk';
import { aiProvider, type AiPreview, type AiProvider, type AiTurn } from '@shared/types';
import { aiKey, aiSettings } from './settings';

/**
 * The provider layer of DevCatz's AI features, ported from DBCatz (src/main/ai.ts) so both apps behave the
 * same; to become the shared @catzoid/ai package (TODO §28). One request = a system prompt, the turns, and a
 * JSON schema the answer must follow. Claude goes through the official SDK with structured output; Gemini,
 * Ollama and every OpenAI-style server through their HTTP APIs.
 */

const TIMEOUT_MS = 120_000;
/** Model ids that are not chat models (OpenAI, Gemini, Mistral, Groq … list them all together). */
const NOT_CHAT = /embed|whisper|tts|transcribe|dall-e|image|imagen|moderation|audio|realtime|rerank|ocr|speech|veo|aqa|guard/i;
const OK_SCHEMA = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false };

interface Use {
  provider?: AiProvider;
  model?: string;
  signal?: AbortSignal;
}

export class AiClient {
  /** Running requests by token (Stop aborts them). */
  private running = new Map<string, AbortController>();

  /** The provider and model requests go to (Settings → AI). */
  choice(): { provider: AiProvider; model: string } {
    const ai = aiSettings();
    if (!ai.enabled) throw new Error('AI is off: turn it on in Settings → AI');
    const info = aiProvider(ai.provider);
    const model = ai.models[ai.provider] || info.models[0] || '';
    if (!model) throw new Error(`Choose a model for ${info.name} in Settings → AI`);
    return { provider: ai.provider, model };
  }

  /** "Preview what is sent": the exact system prompt and turns, nothing is sent. */
  preview(system: string, messages: AiTurn[]): AiPreview {
    const { provider, model } = this.choice();
    return { provider: aiProvider(provider).name, model, system, messages };
  }

  cancel(token: string): void {
    this.running.get(token)?.abort();
  }

  /** One request with a JSON answer of `schema`'s shape; `token` lets Stop abort it. */
  async run<T>(system: string, turns: AiTurn[], schema: Record<string, unknown>, token = ''): Promise<T> {
    const ctl = new AbortController();
    if (token) this.running.set(token, ctl);
    try {
      return await this.complete<T>(system, turns, schema, { signal: ctl.signal });
    } catch (e) {
      if (ctl.signal.aborted) throw new Error('Stopped');
      throw e;
    } finally {
      if (token) this.running.delete(token);
    }
  }

  /** A tiny request to see that the key and model work. */
  async test(): Promise<string> {
    const { provider, model } = this.choice();
    const r = await this.complete<{ ok: boolean }>('Answer with the JSON object {"ok": true}.', [{ role: 'user', text: 'Are you there?' }], OK_SCHEMA);
    if (r.ok !== true) throw new Error('The model answered, but not in the expected form');
    return `${aiProvider(provider).name} · ${model}`;
  }

  /** Models the provider lists for this key, without the ones that cannot chat (embeddings, speech, images …). */
  async models(provider: AiProvider): Promise<string[]> {
    return (await this.listModels(provider)).filter((m) => !NOT_CHAT.test(m));
  }

  /** Which of these models answer with this key: one tiny request each (four at a time). null = works. */
  async probe(provider: AiProvider, models: string[]): Promise<Record<string, string | null>> {
    const out: Record<string, string | null> = {};
    const list = [...new Set(models)].slice(0, 24);
    for (let i = 0; i < list.length; i += 4)
      await Promise.all(
        list.slice(i, i + 4).map(async (model) => {
          try {
            await this.complete<{ ok: boolean }>('Answer with the JSON object {"ok": true}.', [{ role: 'user', text: 'ok?' }], OK_SCHEMA, { provider, model });
            out[model] = null;
          } catch (e) {
            out[model] = (e as Error).message;
          }
        }),
      );
    return out;
  }

  private async listModels(provider: AiProvider): Promise<string[]> {
    const base = this.baseUrl(provider);
    const key = await aiKey(provider);
    if (provider === 'anthropic') {
      const ids: string[] = [];
      for await (const m of this.anthropic(key).models.list()) ids.push(m.id);
      return ids;
    }
    if (provider === 'ollama') {
      const r = (await this.http(`${base}/api/tags`, { method: 'GET' })) as { models?: { name: string }[] };
      return (r.models ?? []).map((m) => m.name);
    }
    if (provider === 'gemini') {
      const r = (await this.http(`${base}/models?pageSize=200`, { method: 'GET', headers: { 'x-goog-api-key': this.need(provider, key) } })) as { models?: { name: string; supportedGenerationMethods?: string[] }[] };
      return (r.models ?? []).filter((m) => m.supportedGenerationMethods?.includes('generateContent')).map((m) => m.name.replace(/^models\//, ''));
    }
    const r = (await this.http(`${base}/models`, { method: 'GET', headers: key ? { authorization: `Bearer ${key}` } : {} })) as { data?: { id: string }[] };
    return (r.data ?? []).map((m) => m.id).sort();
  }

  private baseUrl(provider: AiProvider): string {
    return (aiSettings().baseUrls[provider] || aiProvider(provider).baseUrl).replace(/\/+$/, '');
  }

  private need(provider: AiProvider, key: string): string {
    if (!key) throw new Error(`Add your ${aiProvider(provider).name} API key in Settings → AI`);
    return key;
  }

  private anthropic(key: string): Anthropic {
    return new Anthropic({ apiKey: this.need('anthropic', key), timeout: TIMEOUT_MS, maxRetries: 1 });
  }

  private async complete<T>(system: string, turns: AiTurn[], schema: Record<string, unknown>, use: Use = {}): Promise<T> {
    const chosen = use.provider && use.model ? null : this.choice();
    const provider = use.provider ?? chosen!.provider;
    const model = use.model ?? chosen!.model;
    const signal = use.signal;
    const key = await aiKey(provider);
    const base = this.baseUrl(provider);
    let text: string;
    if (provider === 'anthropic') text = await this.viaAnthropic(key, model, system, turns, schema, signal);
    else if (provider === 'gemini') {
      const r = (await this.http(`${base}/models/${encodeURIComponent(model)}:generateContent`, {
        method: 'POST',
        headers: { 'x-goog-api-key': this.need(provider, key) },
        signal,
        body: { systemInstruction: { parts: [{ text: system }] }, contents: turns.map((t) => ({ role: t.role === 'assistant' ? 'model' : 'user', parts: [{ text: t.text }] })), generationConfig: { responseMimeType: 'application/json' } },
      })) as { candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[] };
      text = r.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
      if (!text) throw new Error(`Gemini gave no answer${r.candidates?.[0]?.finishReason ? ` (${r.candidates[0].finishReason})` : ''}`);
    } else if (provider === 'ollama') {
      const r = (await this.http(`${base}/api/chat`, { method: 'POST', signal, body: { model, stream: false, format: schema, messages: [{ role: 'system', content: system }, ...turns.map((t) => ({ role: t.role, content: t.text }))] } })) as { message?: { content?: string } };
      text = r.message?.content ?? '';
    } else {
      // OpenAI and the servers that speak its chat completions API.
      if (provider !== 'openai-compatible') this.need(provider, key);
      const r = (await this.http(`${base}/chat/completions`, {
        method: 'POST',
        headers: key ? { authorization: `Bearer ${key}` } : {},
        signal,
        body: { model, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: system }, ...turns.map((t) => ({ role: t.role, content: t.text }))] },
      })) as { choices?: { message?: { content?: string; refusal?: string } }[] };
      const m = r.choices?.[0]?.message;
      if (m?.refusal) throw new Error(`The model declined: ${m.refusal}`);
      text = m?.content ?? '';
    }
    return parseJson<T>(text);
  }

  private async viaAnthropic(key: string, model: string, system: string, turns: AiTurn[], schema: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
    try {
      const r = await this.anthropic(key).beta.messages.create(
        {
          model,
          max_tokens: 16000,
          // A request Claude declines is retried server-side on a model that can answer it.
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default',
          // The system prompt (instructions + context) is the long, stable part: cached across follow-ups.
          system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
          messages: turns.map((t) => ({ role: t.role, content: t.text })),
          output_config: { effort: 'medium', format: { type: 'json_schema', schema } },
        },
        { signal },
      );
      if (r.stop_reason === 'refusal') throw new Error(`Claude declined this request${r.stop_details?.explanation ? `: ${r.stop_details.explanation}` : ''}`);
      if (r.stop_reason === 'max_tokens') throw new Error('The answer was cut off; ask for something smaller');
      return r.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
    } catch (e) {
      if (signal?.aborted) throw new Error('Stopped');
      if (e instanceof Anthropic.AuthenticationError) throw new Error('Anthropic did not accept the API key (Settings → AI)');
      if (e instanceof Anthropic.NotFoundError) throw new Error(`Anthropic does not know the model ${model}`);
      if (e instanceof Anthropic.RateLimitError) throw new Error('Anthropic rate limit reached; try again in a moment');
      if (e instanceof Anthropic.APIConnectionError) throw new Error('Could not reach api.anthropic.com');
      if (e instanceof Anthropic.APIError) throw new Error(`Anthropic: ${e.message}`);
      throw e;
    }
  }

  private async http(url: string, o: { method: 'GET' | 'POST'; headers?: Record<string, string>; body?: unknown; signal?: AbortSignal }): Promise<unknown> {
    let r: Response;
    const timeout = AbortSignal.timeout(TIMEOUT_MS);
    try {
      r = await fetch(url, { method: o.method, headers: { 'content-type': 'application/json', ...(o.headers ?? {}) }, body: o.body === undefined ? undefined : JSON.stringify(o.body), signal: o.signal ? AbortSignal.any([o.signal, timeout]) : timeout });
    } catch (e) {
      if (o.signal?.aborted) throw new Error('Stopped');
      if (timeout.aborted) throw new Error(`${new URL(url).host} did not answer within ${TIMEOUT_MS / 1000} s`);
      throw new Error(`Could not reach ${new URL(url).host}: ${(e as Error).message}`);
    }
    const text = await r.text();
    if (!r.ok) {
      let msg = text.slice(0, 300);
      try {
        const j = JSON.parse(text) as { error?: { message?: string } | string; message?: string };
        msg = (typeof j.error === 'string' ? j.error : j.error?.message) ?? j.message ?? msg;
      } catch {
        /* not JSON */
      }
      throw new Error(`${new URL(url).host} answered ${r.status}${r.status === 401 || r.status === 403 ? ' (check the API key in Settings → AI)' : ''}: ${msg}`);
    }
    return JSON.parse(text);
  }
}

/** The JSON object in a model's answer (some wrap it in ``` fences or add a word before it). */
function parseJson<T>(text: string): T {
  const t = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try {
    return JSON.parse(t) as T;
  } catch {
    const a = t.indexOf('{');
    const b = t.lastIndexOf('}');
    if (a >= 0 && b > a) {
      try {
        return JSON.parse(t.slice(a, b + 1)) as T;
      } catch {
        /* fall through */
      }
    }
    throw new Error('The model did not answer in the expected form; try again or pick another model');
  }
}
