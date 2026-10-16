/**
 * Client for the KLI harness server (`@kli/server`).
 *
 * When a workspace is connected, KLI Studio stops talking to providers directly
 * and talks to this server instead. The server runs the *real* kernel with every
 * plugin from `.kli/config.js`, so tools, skills, the code graph and subagents
 * all become available in the UI.
 */
import type {
  AgentSummary,
  Attachment,
  HarnessInfo,
  HarnessToolInfo,
  ProjectMeta,
  ProviderConfig,
  ToolCallBlock,
  SubagentBlock,
  TimelineBlock,
} from '@/types';
import { ApiError } from '@/lib/api';

/* ── HTTP plumbing ─────────────────────────────────────────────────────── */

export function normalizeHarnessUrl(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, '');
  return trimmed.length > 0 ? trimmed : 'http://127.0.0.1:4317';
}

async function request<T>(
  baseUrl: string,
  path: string,
  init: RequestInit = {},
  signal?: AbortSignal,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${normalizeHarnessUrl(baseUrl)}${path}`, {
      ...init,
      signal: signal ?? null,
      headers: {
        'content-type': 'application/json',
        ...(init.headers ?? {}),
      },
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new ApiError(
      `No se pudo contactar el servidor del harness (${baseUrl}). ¿Está corriendo el servidor KLI?`,
      0,
      'offline',
    );
  }

  const text = await response.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      body = text;
    }
  }

  if (!response.ok) {
    const record = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : null;
    const message =
      (typeof record?.error === 'string' && record.error) ||
      `El servidor respondió ${response.status}`;
    throw new ApiError(message, response.status, 'harness_error');
  }

  return body as T;
}

/* ── Reads ─────────────────────────────────────────────────────────────── */

export function getHealth(baseUrl: string, signal?: AbortSignal): Promise<HarnessInfo> {
  return request<HarnessInfo>(baseUrl, '/api/health', { method: 'GET' }, signal);
}

export function listTools(baseUrl: string, signal?: AbortSignal): Promise<{ tools: HarnessToolInfo[] }> {
  return request<{ tools: HarnessToolInfo[] }>(baseUrl, '/api/tools', { method: 'GET' }, signal);
}

export function listAgents(baseUrl: string, signal?: AbortSignal): Promise<{ agents: AgentSummary[] }> {
  return request<{ agents: AgentSummary[] }>(baseUrl, '/api/agents', { method: 'GET' }, signal);
}

export function listProjects(baseUrl: string, signal?: AbortSignal): Promise<{ projects: ProjectMeta[] }> {
  return request<{ projects: ProjectMeta[] }>(baseUrl, '/api/projects', { method: 'GET' }, signal);
}

/* ── Writes ────────────────────────────────────────────────────────────── */

export function saveAgent(
  baseUrl: string,
  agent: AgentSummary,
): Promise<{ agents: AgentSummary[] }> {
  return request<{ agents: AgentSummary[] }>(baseUrl, '/api/agents', {
    method: 'POST',
    body: JSON.stringify(agent),
  });
}

export function deleteAgent(baseUrl: string, id: string): Promise<{ agents: AgentSummary[] }> {
  return request<{ agents: AgentSummary[] }>(baseUrl, `/api/agents/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
}

export function createProject(
  baseUrl: string,
  name: string,
  path?: string,
): Promise<{ project: ProjectMeta; projects: ProjectMeta[] }> {
  return request<{ project: ProjectMeta; projects: ProjectMeta[] }>(baseUrl, '/api/projects', {
    method: 'POST',
    body: JSON.stringify(path ? { name, path } : { name }),
  });
}

export function deleteProject(baseUrl: string, id: string): Promise<{ projects: ProjectMeta[] }> {
  return request<{ projects: ProjectMeta[] }>(baseUrl, `/api/projects?id=${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
}

/** Loads a workspace file so it can be attached to the next message. */
export function readWorkspaceFile(
  baseUrl: string,
  path: string,
  projectPath?: string,
): Promise<{ path: string; name: string; content: string; truncated: boolean }> {
  return request<{ path: string; name: string; content: string; truncated: boolean }>(
    baseUrl,
    '/api/read',
    {
      method: 'POST',
      body: JSON.stringify(projectPath ? { path, projectPath } : { path }),
    },
  );
}

/* ── Local disk browsing (folder picker) ───────────────────────────────── */

export interface DirListing {
  path: string;
  parent: string | null;
  home: string;
  workspaceRoot: string;
  folders: string[];
}

/**
 * Lists the sub-folders of a directory on the machine running the KLI server.
 * Without a path it starts at the user's home folder.
 */
export function listFolders(
  baseUrl: string,
  path?: string,
  signal?: AbortSignal,
): Promise<DirListing> {
  const query = path ? `?path=${encodeURIComponent(path)}` : '';
  return request<DirListing>(baseUrl, `/api/fs/dirs${query}`, { method: 'GET' }, signal);
}

/* ── Chat (SSE) ────────────────────────────────────────────────────────── */

export interface HarnessChatRequest {
  baseUrl: string;
  message: string;
  mode: 'plan' | 'build' | 'ask';
  provider: ProviderConfig;
  apiKey: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
  attachments?: Attachment[];
  projectPath?: string;
  /** ID of the active project (sent to the server for context injection). */
  projectId?: string;
  signal: AbortSignal;
  onStart?: (info: { runId: string; agents: string[]; tools: number }) => void;
  onToken?: (delta: string) => void;
  onReasoning?: (delta: string) => void;
  onToolStart?: (name: string, args: Record<string, unknown>) => void;
  onToolEnd?: (name: string, ok: boolean, ms: number, error?: string) => void;
  onAgentStart?: (block: SubagentBlock) => void;
  onAgentTool?: (id: string, name: string, ok: boolean, ms?: number) => void;
  onAgentEnd?: (id: string, ok: boolean, error?: string) => void;
  onDone?: (summary: { status: string; steps: number; tokensUsed: number; cost: number }) => void;
}

export interface HarnessStreamHandlers {
  onStart?: (info: { runId: string; agents: string[]; tools: number }) => void;
  onToken?: (delta: string) => void;
  onReasoning?: (delta: string) => void;
  onToolStart?: (name: string, args: Record<string, unknown>) => void;
  onToolEnd?: (name: string, ok: boolean, ms: number, error?: string) => void;
  onAgentStart?: (block: SubagentBlock) => void;
  onAgentTool?: (id: string, name: string, ok: boolean, ms?: number) => void;
  onAgentEnd?: (id: string, ok: boolean, error?: string) => void;
  onDone?: (summary: { status: string; steps: number; tokensUsed: number; cost: number }) => void;
}

/**
 * Streams one harness run. Resolves when the server closes the stream.
 *
 * The server emits named SSE events (`token`, `reasoning`, `tool.start`,
 * `tool.end`, `agent.start`, `agent.tool`, `agent.end`, `done`, `error`).
 */
export async function streamHarnessChat(request: HarnessChatRequest): Promise<void> {
  const body: Record<string, unknown> = {
    message: buildMessageWithAttachments(request.message, request.attachments ?? []),
    mode: request.mode,
    provider: {
      id: request.provider.id,
      kind: request.provider.kind,
      baseUrl: request.provider.baseUrl,
      // Optional fallback; the server resolves the real key from its env.
      ...(request.apiKey ? { apiKey: request.apiKey } : {}),
      model: request.model,
      ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
      ...(request.maxTokens === undefined ? {} : { maxTokens: request.maxTokens }),
    },
    ...(request.projectPath ? { projectPath: request.projectPath } : {}),
    ...(request.projectId ? { projectId: request.projectId } : {}),
  };

  let response: Response;
  try {
    response = await fetch(`${normalizeHarnessUrl(request.baseUrl)}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: request.signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new ApiError('No se pudo abrir el stream del harness.', 0, 'offline');
  }

  if (!response.ok || !response.body) {
    const text = await response.text().catch(() => '');
    throw new ApiError(text || `El servidor respondió ${response.status}`, response.status, 'harness_error');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let boundary = buffer.indexOf('\n\n');
    while (boundary !== -1) {
      const chunk = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      dispatchSseChunk(chunk, request);
      boundary = buffer.indexOf('\n\n');
    }
  }
}

function dispatchSseChunk(chunk: string, handlers: HarnessStreamHandlers): void {
  let event = 'message';
  const dataLines: string[] = [];
  for (const line of chunk.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
  }
  if (dataLines.length === 0) return;

  let data: Record<string, unknown>;
  try {
    data = JSON.parse(dataLines.join('\n')) as Record<string, unknown>;
  } catch {
    return;
  }

  const str = (key: string): string => (typeof data[key] === 'string' ? (data[key] as string) : '');
  const num = (key: string): number => (typeof data[key] === 'number' ? (data[key] as number) : 0);
  const bool = (key: string): boolean => data[key] === true;

  switch (event) {
    case 'start':
      handlers.onStart?.({
        runId: str('runId'),
        agents: Array.isArray(data.agents) ? (data.agents as string[]) : [],
        tools: num('tools'),
      });
      break;
    case 'token':
      handlers.onToken?.(str('delta'));
      break;
    case 'reasoning':
      handlers.onReasoning?.(str('delta'));
      break;
    case 'tool.start':
      handlers.onToolStart?.(str('name'), (data.args as Record<string, unknown>) ?? {});
      break;
    case 'tool.end':
      handlers.onToolEnd?.(str('name'), bool('ok'), num('ms'), str('error') || undefined);
      break;
    case 'agent.start':
      handlers.onAgentStart?.({
        kind: 'subagent',
        id: str('id'),
        agent: str('agent'),
        task: str('task'),
        status: 'running',
        tools: [],
      });
      break;
    case 'agent.tool':
      handlers.onAgentTool?.(str('id'), str('name'), bool('ok'), num('ms'));
      break;
    case 'agent.end':
      handlers.onAgentEnd?.(str('id'), bool('ok'), str('error') || undefined);
      break;
    case 'done':
      handlers.onDone?.({
        status: str('status'),
        steps: num('steps'),
        tokensUsed: num('tokensUsed'),
        cost: num('cost'),
      });
      break;
    case 'error':
      throw new ApiError(str('message') || 'El harness devolvió un error.', 500, 'harness_error');
    default:
      break;
  }
}

/** Folds attachments into the user message so the model sees their contents. */
export function buildMessageWithAttachments(message: string, attachments: Attachment[]): string {
  if (attachments.length === 0) return message;
  const blocks = attachments
    .map(
      (attachment) =>
        `<file path="${attachment.path}">\n${attachment.content}\n</file>`,
    )
    .join('\n\n');
  return `${message}\n\nArchivos adjuntos:\n\n${blocks}`;
}

/* ── Timeline helpers (used by the store) ──────────────────────────────── */

export function upsertToolBlock(
  blocks: TimelineBlock[] | undefined,
  name: string,
  patch: Partial<ToolCallBlock> & { status: ToolCallBlock['status'] },
): TimelineBlock[] {
  const list = blocks ?? [];
  const index = findLastIndex(list, (block) => block.kind === 'tool' && block.name === name);
  if (index === -1) {
    return [
      ...list,
      {
        kind: 'tool',
        id: `${name}-${Date.now()}-${list.length}`,
        name,
        args: patch.args ?? {},
        status: patch.status,
        ...(patch.ms === undefined ? {} : { ms: patch.ms }),
        ...(patch.error === undefined ? {} : { error: patch.error }),
      },
    ];
  }
  return list.map((block, position) =>
    position === index && block.kind === 'tool'
      ? {
          ...block,
          ...patch,
          args: patch.args ?? block.args,
        }
      : block,
  );
}

function findLastIndex<T>(list: T[], predicate: (item: T) => boolean): number {
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const item = list[index];
    if (item !== undefined && predicate(item)) return index;
  }
  return -1;
}
