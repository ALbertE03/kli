import type { ChatMessage, ModelInfo, ProviderConfig, Usage } from '@/types';
import { normalizeBaseUrl } from '@/lib/utils';

const ANTHROPIC_VERSION = '2023-06-01';

/** Error carrying the HTTP status so the UI can map it to a token/connection state. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryAtMs?: number;

  constructor(message: string, status: number, code = 'api_error', retryAtMs?: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.retryAtMs = retryAtMs;
  }
}

/* ── Low-level helpers ─────────────────────────────────────────────────── */

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function authHeaders(provider: ProviderConfig, apiKey: string): Record<string, string> {
  if (provider.kind === 'anthropic') {
    return {
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
      'content-type': 'application/json',
    };
  }
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  return headers;
}

/** Extract a human message out of the many error shapes providers return. */
function extractErrorMessage(body: unknown, fallback: string): string {
  const record = asRecord(body);
  if (!record) return fallback;
  const error = asRecord(record.error);
  if (error) {
    const message = asString(error.message);
    if (message) return message;
    const type = asString(error.type);
    if (type) return type;
  }
  const message = asString(record.message) ?? asString(record.detail);
  if (message) return message;
  if (typeof body === 'string' && body.trim()) return body.trim().slice(0, 400);
  return fallback;
}

function extractErrorCode(body: unknown): string {
  const record = asRecord(body);
  const error = record ? asRecord(record.error) : null;
  return asString(error?.code) ?? asString(record?.code) ?? 'api_error';
}

async function readError(response: Response, fallback: string): Promise<ApiError> {
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  const record = asRecord(body);
  const retryAtMs = asNumber(record?.retryAtMs);
  return new ApiError(
    extractErrorMessage(body, `${fallback} (HTTP ${response.status})`),
    response.status,
    extractErrorCode(body),
    retryAtMs,
  );
}

async function requestJson<T>(
  provider: ProviderConfig,
  apiKey: string,
  path: string,
  init: RequestInit,
  fallbackMessage: string,
): Promise<T> {
  const url = `${normalizeBaseUrl(provider.baseUrl)}${path}`;
  let response: Response;
  try {
    response = await fetch(url, { ...init, headers: { ...authHeaders(provider, apiKey), ...init.headers } });
  } catch (cause) {
    throw new ApiError(
      `No se pudo conectar con ${provider.label} (${normalizeBaseUrl(provider.baseUrl)}). ${
        cause instanceof Error ? cause.message : ''
      }`.trim(),
      0,
      'network_error',
    );
  }
  if (!response.ok) throw await readError(response, fallbackMessage);
  return (await response.json()) as T;
}

/* ── Models ────────────────────────────────────────────────────────────── */

interface RawModel {
  id?: unknown;
  name?: unknown;
  display_name?: unknown;
  owned_by?: unknown;
  available?: unknown;
  unavailable_reason?: unknown;
  context_window?: unknown;
  context_length?: unknown;
}

function normalizeModel(raw: RawModel, provider: ProviderConfig): ModelInfo | null {
  const id = asString(raw.id);
  if (!id) return null;
  const contextWindow = asNumber(raw.context_window) ?? asNumber(raw.context_length);
  return {
    id,
    name: asString(raw.display_name) ?? asString(raw.name) ?? id,
    provider: provider.id,
    owner: asString(raw.owned_by) ?? provider.label,
    available: raw.available === undefined ? true : raw.available === true,
    ...(contextWindow ? { contextWindow } : {}),
  };
}

/**
 * Fetches the provider catalogue. Handles the OpenAI `{ data: [...] }` shape
 * and the Anthropic `{ data: [...] }` shape, plus legacy `{ models: [...] }`.
 */
export async function listModels(
  provider: ProviderConfig,
  apiKey: string,
  signal?: AbortSignal,
): Promise<ModelInfo[]> {
  const body = await requestJson<unknown>(
    provider,
    apiKey,
    '/models',
    { method: 'GET', signal },
    'No se pudo obtener la lista de modelos',
  );
  const record = asRecord(body);
  const rawList = Array.isArray(body)
    ? body
    : Array.isArray(record?.data)
      ? record.data
      : Array.isArray(record?.models)
        ? record.models
        : null;
  if (!rawList) throw new ApiError('Respuesta de modelos con formato inesperado', 200, 'bad_response');
  const models = rawList
    .map((entry) => asRecord(entry))
    .filter((entry): entry is Record<string, unknown> => entry !== null)
    .map((entry) => normalizeModel(entry as RawModel, provider))
    .filter((model): model is ModelInfo => model !== null);
  // Available models first, then alphabetically — most catalogues mix both.
  return models.sort((a, b) => {
    if (a.available !== b.available) return a.available ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

/* ── Chat (streaming) ──────────────────────────────────────────────────── */

export interface ChatRequest {
  provider: ProviderConfig;
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  system?: string;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  onDelta: (text: string) => void;
  onUsage?: (usage: Usage) => void;
}

interface SseEvent {
  event: string;
  data: string;
}

/** Yields decoded SSE events from a streaming response body. */
async function* readSseEvents(response: Response): AsyncGenerator<SseEvent> {
  const body = response.body;
  if (!body) throw new ApiError('La respuesta no incluye cuerpo', 200, 'no_body');
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
        const rawEvent = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const parsed = parseSseEvent(rawEvent);
        if (parsed) yield parsed;
        boundary = buffer.indexOf('\n\n');
      }
    }
    const tail = parseSseEvent(buffer);
    if (tail) yield tail;
  } finally {
    reader.releaseLock();
  }
}

function parseSseEvent(raw: string): SseEvent | null {
  let event = 'message';
  const dataLines: string[] = [];
  for (const rawLine of raw.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (!line || line.startsWith(':')) continue;
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
  }
  if (dataLines.length === 0) return null;
  return { event, data: dataLines.join('\n') };
}

function readUsage(value: unknown): Usage {
  const record = asRecord(value);
  const prompt = asNumber(record?.prompt_tokens) ?? 0;
  const completion = asNumber(record?.completion_tokens) ?? 0;
  const total = asNumber(record?.total_tokens) ?? prompt + completion;
  return { promptTokens: prompt, completionTokens: completion, totalTokens: total };
}

function readAnthropicUsage(value: unknown): Usage {
  const record = asRecord(value);
  const prompt = asNumber(record?.input_tokens) ?? 0;
  const completion = asNumber(record?.output_tokens) ?? 0;
  return { promptTokens: prompt, completionTokens: completion, totalTokens: prompt + completion };
}

function handleOpenAiChunk(payload: unknown, onDelta: (text: string) => void): Usage | null {
  const record = asRecord(payload);
  if (record?.error) {
    throw new ApiError(extractErrorMessage(payload, 'Error durante la generación'), 200, 'stream_error');
  }
  const choices = Array.isArray(record?.choices) ? record.choices : [];
  for (const choice of choices) {
    const delta = asRecord(asRecord(choice)?.delta);
    const text = asString(delta?.content);
    if (text) onDelta(text);
  }
  const usage = asRecord(record?.usage);
  return usage ? readUsage(usage) : null;
}

function handleAnthropicEvent(event: SseEvent, onDelta: (text: string) => void): Usage | null {
  if (event.data === '[DONE]') return null;
  let payload: unknown;
  try {
    payload = JSON.parse(event.data);
  } catch {
    return null;
  }
  const record = asRecord(payload);
  if (!record) return null;
  switch (record.type) {
    case 'content_block_delta': {
      const delta = asRecord(record.delta);
      if (asString(delta?.type) === 'text_delta') {
        const text = asString(delta?.text);
        if (text) onDelta(text);
      }
      return null;
    }
    case 'message_start': {
      const usage = asRecord(asRecord(record.message)?.usage);
      return usage ? readAnthropicUsage(usage) : null;
    }
    case 'message_delta': {
      const usage = asRecord(record.usage);
      return usage ? readAnthropicUsage(usage) : null;
    }
    case 'error':
      throw new ApiError(extractErrorMessage(payload, 'Error durante la generación'), 200, 'stream_error');
    default:
      return null;
  }
}

/** Streams a chat completion, invoking `onDelta` for every text fragment. */
export async function streamChat(request: ChatRequest): Promise<void> {
  const { provider, apiKey, model, messages, system, temperature, maxTokens, signal, onDelta, onUsage } =
    request;
  const isAnthropic = provider.kind === 'anthropic';

  const payload: Record<string, unknown> = isAnthropic
    ? {
        model,
        max_tokens: maxTokens ?? 4096,
        stream: true,
        messages,
        ...(system ? { system } : {}),
        ...(temperature === undefined ? {} : { temperature }),
      }
    : {
        model,
        messages: system ? [{ role: 'system', content: system }, ...messages] : messages,
        stream: true,
        ...(temperature === undefined ? {} : { temperature }),
        ...(maxTokens === undefined ? {} : { max_tokens: maxTokens }),
      };

  const url = `${normalizeBaseUrl(provider.baseUrl)}${isAnthropic ? '/messages' : '/chat/completions'}`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: authHeaders(provider, apiKey),
      body: JSON.stringify(payload),
      ...(signal ? { signal } : {}),
    });
  } catch (cause) {
    if (signal?.aborted) return;
    throw new ApiError(
      `No se pudo conectar con ${provider.label}. ${cause instanceof Error ? cause.message : ''}`.trim(),
      0,
      'network_error',
    );
  }
  if (!response.ok) throw await readError(response, 'Error al iniciar el stream');

  let usage: Usage | null = null;
  for await (const event of readSseEvents(response)) {
    if (event.event === 'ping' || event.event === 'content_block_start') continue;
    if (event.data === '[DONE]') break;
    if (isAnthropic) {
      usage = handleAnthropicEvent(event, onDelta) ?? usage;
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(event.data);
    } catch {
      continue;
    }
    usage = handleOpenAiChunk(parsed, onDelta) ?? usage;
  }
  if (usage && onUsage) onUsage(usage);
}

/* ── Embeddings ────────────────────────────────────────────────────────── */

export async function createEmbedding(
  provider: ProviderConfig,
  apiKey: string,
  model: string,
  input: string,
  signal?: AbortSignal,
): Promise<number[]> {
  const body = await requestJson<unknown>(
    provider,
    apiKey,
    '/embeddings',
    { method: 'POST', body: JSON.stringify({ model, input }), signal },
    'Error al generar el embedding',
  );
  const record = asRecord(body);
  const first = Array.isArray(record?.data) ? asRecord(record.data[0]) : null;
  const vector = first?.embedding;
  if (!Array.isArray(vector)) throw new ApiError('La respuesta no incluye un vector válido', 200, 'bad_response');
  return vector.filter((value): value is number => typeof value === 'number');
}

/* ── Images ────────────────────────────────────────────────────────────── */

export interface ImageResult {
  url: string;
}

export async function generateImage(
  provider: ProviderConfig,
  apiKey: string,
  model: string,
  prompt: string,
  options: { size: string; count: number; signal?: AbortSignal },
): Promise<ImageResult[]> {
  const body = await requestJson<unknown>(
    provider,
    apiKey,
    '/images/generations',
    {
      method: 'POST',
      body: JSON.stringify({ model, prompt, n: options.count, size: options.size }),
      signal: options.signal,
    },
    'Error al generar la imagen',
  );
  return extractImages(body);
}

function extractImages(body: unknown): ImageResult[] {
  const record = asRecord(body);
  const items = Array.isArray(record?.data)
    ? record.data
    : Array.isArray(record?.images)
      ? record.images
      : Array.isArray(body)
        ? body
        : null;
  const fromData = items?.map((item) => {
    const entry = asRecord(item);
    const b64 = asString(entry?.b64_json) ?? asString(entry?.base64) ?? asString(entry?.image);
    if (b64) return `data:image/png;base64,${b64}`;
    return asString(entry?.url);
  });
  const results = (fromData ?? []).filter((url): url is string => Boolean(url));

  if (results.length === 0) {
    const legacy = asString(record?.bases64);
    if (legacy) results.push(`data:image/png;base64,${legacy}`);
  }
  if (results.length === 0) {
    const url = asString(record?.url);
    if (url) results.push(url);
  }
  if (results.length === 0) throw new ApiError('La respuesta no incluye ninguna imagen', 200, 'bad_response');
  return results.map((url) => ({ url }));
}

/* ── Audio ─────────────────────────────────────────────────────────────── */

export async function synthesizeSpeech(
  provider: ProviderConfig,
  apiKey: string,
  model: string,
  text: string,
  options: { voice: string; format: string; signal?: AbortSignal },
): Promise<Blob> {
  const url = `${normalizeBaseUrl(provider.baseUrl)}/audio/speech`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: authHeaders(provider, apiKey),
      body: JSON.stringify({
        model,
        input: text,
        voice: options.voice,
        response_format: options.format,
      }),
      signal: options.signal,
    });
  } catch (cause) {
    if (options.signal?.aborted) throw new ApiError('Cancelado', 0, 'aborted');
    throw new ApiError(
      `No se pudo conectar con ${provider.label}. ${cause instanceof Error ? cause.message : ''}`.trim(),
      0,
      'network_error',
    );
  }
  if (!response.ok) throw await readError(response, 'Error al sintetizar el audio');
  return response.blob();
}

export async function transcribeAudio(
  provider: ProviderConfig,
  apiKey: string,
  model: string,
  audio: Blob,
  signal?: AbortSignal,
): Promise<string> {
  const url = `${normalizeBaseUrl(provider.baseUrl)}/audio/transcriptions`;
  const form = new FormData();
  const extension = audio.type.includes('wav') ? 'wav' : 'mp3';
  form.append('file', audio, `audio.${extension}`);
  form.append('model', model);

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: provider.kind === 'anthropic' ? authHeaders(provider, apiKey) : apiKey ? { authorization: `Bearer ${apiKey}` } : {},
      body: form,
      signal,
    });
  } catch (cause) {
    if (signal?.aborted) throw new ApiError('Cancelado', 0, 'aborted');
    throw new ApiError(
      `No se pudo conectar con ${provider.label}. ${cause instanceof Error ? cause.message : ''}`.trim(),
      0,
      'network_error',
    );
  }
  if (!response.ok) throw await readError(response, 'Error al transcribir el audio');

  const body = (await response.json()) as unknown;
  const text = asString(asRecord(body)?.text);
  if (!text) throw new ApiError('La transcripción vino vacía', 200, 'bad_response');
  return text;
}