import type { Mode, ModelInfo } from '@/types';

interface ModeMatcher {
  mode: Mode;
  patterns: RegExp;
}

/**
 * Default image model. FreeLLMAPI's image endpoint only accepts `auto` or a
 * *provider* model id (e.g. a Cloudflare `@cf/…` path) — its chat catalogue
 * lists no image models, so without this the image mode would start empty.
 */
export const DEFAULT_IMAGE_MODEL = '@cf/black-forest-labs/flux-2-klein-9b';

const MATCHERS: ModeMatcher[] = [
  {
    mode: 'image',
    patterns: /(flux|stable-?diffusion|sdxl|dall-?e|imagen|recraft|ideogram|photon|draw|picture|image-gen)/i,
  },
  {
    mode: 'audio',
    patterns: /(whisper|tts|speech|audio|elevenlabs|kokoro|bark|suno|voice|stt)/i,
  },
  {
    mode: 'embeddings',
    patterns: /(embed|bge-|bge_|e5-|gte-|minilm|nomic|jina|mxbai|retrieval|sentence-transformers)/i,
  },
];

/**
 * Most OpenAI-compatible catalogues (FreeLLMAPI included) expose no `mode`
 * field, so we infer the modality from the model id. Unmatched ids are chat
 * models, which is what the overwhelming majority are.
 */
export function classifyModel(modelId: string): Mode {
  for (const matcher of MATCHERS) {
    if (matcher.patterns.test(modelId)) return matcher.mode;
  }
  return 'chat';
}

export function modelsForMode(models: ModelInfo[], mode: Mode): ModelInfo[] {
  // The agent mode is a chat surface: it drives the same chat models.
  const target: Mode = mode === 'agent' ? 'chat' : mode;
  return models.filter((model) => classifyModel(model.id) === target);
}

export function availableModelsForMode(models: ModelInfo[], mode: Mode): ModelInfo[] {
  return modelsForMode(models, mode).filter((model) => model.available);
}

/** Preferred chat model of a catalogue: an explicit router first, then the first available. */
export function preferredChatModel(models: ModelInfo[]): ModelInfo | undefined {
  const chat = availableModelsForMode(models, 'chat');
  return chat.find((model) => model.id === 'auto') ?? chat[0];
}

/**
 * Best default for a mode. `hint` is the user's previous choice and wins when it
 * is still present and available in that mode.
 */
export function defaultModelForMode(models: ModelInfo[], mode: Mode, hint?: string | null): ModelInfo | undefined {
  const candidates = availableModelsForMode(models, mode);
  if (hint) {
    const previous = candidates.find((model) => model.id === hint);
    if (previous) return previous;
  }
  if (mode === 'chat' || mode === 'agent') return preferredChatModel(models);
  if (candidates.length > 0) return candidates[0];

  // The catalogue doesn't advertise this modality (FreeLLMAPI lists chat
  // models only): image/embedding/audio ids are typed by hand in ModelField,
  // so keep the known id instead of wiping the selection on every refresh.
  const typed = hint ?? (mode === 'image' ? DEFAULT_IMAGE_MODEL : undefined);
  return typed ? { id: typed, name: typed, provider: '', owner: '', available: true } : undefined;
}