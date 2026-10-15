import type { ProviderConfig } from '@/types';
import { normalizeBaseUrl } from '@/lib/utils';

/**
 * Built-in providers. FreeLLMAPI is the default because KLI ships with it
 * configured (`OPENAI_BASE_URL=http://127.0.0.1:31415/v1`).
 */
export const PROVIDER_PRESETS: readonly ProviderConfig[] = [
  {
    id: 'freellmapi',
    label: 'FreeLLMAPI',
    kind: 'openai',
    baseUrl: 'http://127.0.0.1:31415/v1',
    requiresKey: true,
    builtin: true,
    capabilities: { chat: true, embeddings: true, images: true, audio: true },
  },
  {
    id: 'openai',
    label: 'OpenAI',
    kind: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    requiresKey: true,
    builtin: true,
    capabilities: { chat: true, embeddings: true, images: true, audio: true },
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    kind: 'anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    requiresKey: true,
    builtin: true,
    capabilities: { chat: true, embeddings: false, images: false, audio: false },
  },
  {
    id: 'ollama',
    label: 'Ollama',
    kind: 'openai',
    baseUrl: 'http://127.0.0.1:11434/v1',
    requiresKey: false,
    builtin: true,
    capabilities: { chat: true, embeddings: true, images: false, audio: false },
  },
  {
    id: 'lmstudio',
    label: 'LM Studio',
    kind: 'openai',
    baseUrl: 'http://127.0.0.1:1234/v1',
    requiresKey: false,
    builtin: true,
    capabilities: { chat: true, embeddings: true, images: false, audio: false },
  },
];

export const DEFAULT_PROVIDER_ID = 'freellmapi';

export function createDefaultProviders(): ProviderConfig[] {
  return PROVIDER_PRESETS.map((preset) => ({ ...preset, capabilities: { ...preset.capabilities } }));
}

export function findProvider(providers: ProviderConfig[], id: string | null): ProviderConfig | undefined {
  if (!id) return undefined;
  return providers.find((provider) => provider.id === id);
}

interface ImportMetaEnvLike {
  VITE_FREELLMAPI_BASE_URL?: string;
  VITE_FREELLMAPI_KEY?: string;
  VITE_OPENAI_KEY?: string;
  VITE_ANTHROPIC_KEY?: string;
}

const env = import.meta.env as unknown as ImportMetaEnvLike;

/**
 * Seed API keys from build-time env (`VITE_*`). Users can always override them
 * at runtime from the Settings dialog; secrets live in sessionStorage only.
 */
export function envApiKey(providerId: string): string {
  switch (providerId) {
    case 'freellmapi':
      return env.VITE_FREELLMAPI_KEY ?? '';
    case 'openai':
      return env.VITE_OPENAI_KEY ?? '';
    case 'anthropic':
      return env.VITE_ANTHROPIC_KEY ?? '';
    default:
      return '';
  }
}

export function envBaseUrlOverride(): string | null {
  return env.VITE_FREELLMAPI_BASE_URL ? normalizeBaseUrl(env.VITE_FREELLMAPI_BASE_URL) : null;
}

/** Slugify a label into a unique provider id. */
export function slugifyProviderId(label: string, existing: ProviderConfig[]): string {
  const base =
    label
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'provider';
  let id = base;
  let counter = 2;
  while (existing.some((provider) => provider.id === id)) {
    id = `${base}-${counter}`;
    counter += 1;
  }
  return id;
}