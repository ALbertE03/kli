/** Shared domain types for KLI Studio. */

export type Mode = 'agent' | 'chat' | 'image' | 'embeddings' | 'audio';

export const MODES: readonly Mode[] = ['agent', 'chat', 'image', 'embeddings', 'audio'];

export const MODE_LABELS: Record<Mode, string> = {
  agent: 'Agente',
  chat: 'Chat',
  image: 'Imagen',
  embeddings: 'Embeddings',
  audio: 'Audio',
};

export type Theme = 'dark' | 'light';

export type ConnectionStatus = 'idle' | 'connecting' | 'connected' | 'error' | 'offline';

export type TokenStatus = 'unknown' | 'valid' | 'invalid' | 'rate_limited' | 'offline';

/** How we talk to a provider. `openai` covers every OpenAI-compatible API. */
export type ProviderKind = 'openai' | 'anthropic';

export interface ProviderConfig {
  id: string;
  label: string;
  kind: ProviderKind;
  /** Base URL including the version segment, e.g. `http://127.0.0.1:31415/v1`. */
  baseUrl: string;
  requiresKey: boolean;
  /** Built-ins cannot be deleted, only edited. */
  builtin: boolean;
  /** Capabilities advertised for UX purposes; the API still validates. */
  capabilities: ProviderCapabilities;
}

export interface ProviderCapabilities {
  chat: boolean;
  embeddings: boolean;
  images: boolean;
  audio: boolean;
}

export interface ModelInfo {
  id: string;
  /** Human-readable label (falls back to the id). */
  name: string;
  /** Provider id this model came from. */
  provider: string;
  /** `owned_by` reported by the API. */
  owner: string;
  available: boolean;
  contextWindow?: number;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

/** One entry in an agent run's timeline (tool call, subagent, or note). */
export interface ToolCallBlock {
  kind: 'tool';
  id: string;
  name: string;
  args: Record<string, unknown>;
  status: 'running' | 'ok' | 'error';
  ms?: number;
  error?: string;
}

export interface SubagentBlock {
  kind: 'subagent';
  id: string;
  agent: string;
  task: string;
  status: 'running' | 'ok' | 'error';
  tools: Array<{ name: string; phase: 'start' | 'end'; ok?: boolean; ms?: number }>;
  error?: string;
}

export type TimelineBlock = ToolCallBlock | SubagentBlock;

export interface Attachment {
  id: string;
  path: string;
  name: string;
  content: string;
  truncated: boolean;
}

export interface StoredMessage extends ChatMessage {
  id: string;
  timestamp: number;
  model?: string;
  provider?: string;
  /** True while deltas are still arriving for this message. */
  streaming?: boolean;
  error?: string;
  /** Reasoning / "thinking" text streamed by the model. */
  reasoning?: string;
  /** Live tool + subagent timeline for agent-mode replies. */
  blocks?: TimelineBlock[];
  /** Files attached to this turn. */
  attachments?: Attachment[];
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface GeneratedImage {
  id: string;
  /** `data:` URL or a remote URL returned by the provider. */
  url: string;
  prompt: string;
  model: string;
  createdAt: number;
}

export interface AudioClip {
  id: string;
  url: string;
  text: string;
  voice: string;
  model: string;
  createdAt: number;
}

/* ── Harness (`kli serve`) ─────────────────────────────────────────────── */

export type HarnessStatus = 'idle' | 'connecting' | 'connected' | 'error';

export interface HarnessPluginInfo {
  id: string;
  version: string;
  kind: string[];
}

export interface HarnessInfo {
  ok: boolean;
  workspaceRoot?: string;
  plugins?: HarnessPluginInfo[];
  pluginCount?: number;
  tools?: number;
  toolsByMode?: Record<string, string[]>;
  backends?: string[];
  skills?: Array<{ id: string; name: string }>;
  agents?: number;
  projects?: number;
  error?: string;
}

/** Mirrors `AgentDefinition` from `@kli/api`. */
export interface AgentSummary {
  id: string;
  name: string;
  description: string;
  mode: 'plan' | 'build' | 'ask';
  model: string | null;
  tools: string[] | null;
  instructions?: string;
  color?: string;
  builtin?: boolean;
  hidden?: boolean;
  maxConcurrency?: number;
}

export interface ProjectMeta {
  id: string;
  name: string;
  path: string;
  createdAt: number;
  updatedAt: number;
}

export interface HarnessToolInfo {
  name: string;
  description: string;
  mode: string;
  capabilities: string[];
}