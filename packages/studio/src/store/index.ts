import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { ApiError, listModels } from '@/lib/api';
import {
  createProject as harnessCreateProject,
  deleteAgent as harnessDeleteAgent,
  deleteProject as harnessDeleteProject,
  getHealth,
  listAgents as harnessListAgents,
  listProjects as harnessListProjects,
  readWorkspaceFile,
  saveAgent as harnessSaveAgent,
  streamHarnessChat,
  upsertToolBlock,
} from '@/lib/harness';
import { DEFAULT_PROVIDER_ID, createDefaultProviders, findProvider } from '@/lib/providers';
import { DEFAULT_IMAGE_MODEL, defaultModelForMode } from '@/lib/models';
import { resolveApiKey, useSecrets } from '@/store/secrets';
import {
  MODES,
  type AgentSummary,
  type Attachment,
  type ConnectionStatus,
  type HarnessInfo,
  type HarnessStatus,
  type Mode,
  type ModelInfo,
  type ProjectMeta,
  type ProviderConfig,
  type StoredMessage,
  type SubagentBlock,
  type Theme,
  type Toast,
  type TokenStatus,
  type TimelineBlock,
  type Usage,
} from '@/types';

const emptyUsage: Usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

function emptySelection(): Record<Mode, string | null> {
  return { agent: null, chat: null, image: DEFAULT_IMAGE_MODEL, embeddings: null, audio: null };
}

/** Module-scoped so an AbortController never reaches localStorage. */
let inFlightController: AbortController | null = null;
/** Separate controller for harness runs so the two never cancel each other. */
let harnessController: AbortController | null = null;

function newId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/* Panel width bounds — also enforced by the resize handles. */
export const SIDEBAR_WIDTH_MIN = 220;
export const SIDEBAR_WIDTH_MAX = 480;

/** Conversation key used when no project is active. */
const DEFAULT_CONVERSATION = 'default';

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}

/** Messages persisted per conversation, capped and never mid-stream. */
function settleMessages(messages: StoredMessage[]): StoredMessage[] {
  return messages.slice(-200).map((message) =>
    message.streaming ? { ...message, streaming: false } : message,
  );
}

/** Applies a patch to the tool/subagent timeline of one message. */
function patchBlocks(
  blocks: TimelineBlock[] | undefined,
  updater: (list: TimelineBlock[]) => TimelineBlock[],
): TimelineBlock[] {
  return updater(blocks ?? []);
}

function upsertSubagent(
  blocks: TimelineBlock[],
  id: string,
  patch: Partial<SubagentBlock>,
): TimelineBlock[] {
  const index = blocks.findIndex((block) => block.kind === 'subagent' && block.id === id);
  if (index === -1) {
    const base: SubagentBlock = {
      kind: 'subagent',
      id,
      agent: patch.agent ?? 'agent',
      task: patch.task ?? '',
      status: patch.status ?? 'running',
      tools: patch.tools ?? [],
    };
    return [...blocks, { ...base, ...patch }];
  }
  return blocks.map((block, position) =>
    position === index && block.kind === 'subagent' ? { ...block, ...patch } : block,
  );
}

export interface StudioState {
  mode: Mode;
  setMode: (mode: Mode) => void;

  providers: ProviderConfig[];
  activeProviderId: string;
  setActiveProvider: (id: string) => void;
  updateProvider: (id: string, patch: Partial<Omit<ProviderConfig, 'id'>>) => void;
  addProvider: (provider: ProviderConfig) => void;
  removeProvider: (id: string) => void;

  models: ModelInfo[];
  modelsLoading: boolean;
  modelsError: string | null;
  modelsFetchedAt: number | null;
  refreshModels: (force?: boolean) => Promise<void>;

  selectedModels: Record<Mode, string | null>;
  setSelectedModel: (mode: Mode, modelId: string | null) => void;

  connectionStatus: ConnectionStatus;
  tokenStatus: TokenStatus;
  lastError: string | null;
  lastLatencyMs: number | null;

  messages: StoredMessage[];
  /**
   * One conversation per project id (plus `default` when none is active) —
   * switching projects swaps the visible transcript, keeping runs isolated.
   */
  projectMessages: Record<string, StoredMessage[]>;
  addMessage: (message: StoredMessage) => void;
  appendToMessage: (id: string, delta: string) => void;
  finalizeMessage: (id: string, patch?: Partial<StoredMessage>) => void;
  clearMessages: () => void;

  messageInput: string;
  setMessageInput: (value: string) => void;

  isStreaming: boolean;
  usage: Usage;
  setStreaming: (value: boolean) => void;
  addUsage: (usage: Usage) => void;
  resetUsage: () => void;
  beginRequest: () => AbortSignal;
  cancelRequest: () => void;

  theme: Theme;
  setTheme: (theme: Theme) => void;
  toggleTheme: () => void;

  /* ── UI shell (layout, palette, toasts) ────────────────────────────── */
  sidebarCollapsed: boolean;
  sidebarWidth: number;
  toggleSidebar: () => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  setSidebarWidth: (width: number) => void;

  paletteOpen: boolean;
  setPaletteOpen: (open: boolean) => void;
  togglePalette: () => void;

  toasts: Toast[];
  /** Queues a toast; returns its id so callers can dismiss it explicitly. */
  pushToast: (toast: Omit<Toast, 'id'>) => string;
  dismissToast: (id: string) => void;

  /* ── Harness (`kli serve`) ─────────────────────────────────────────── */
  harnessUrl: string;
  setHarnessUrl: (url: string) => void;
  harnessEnabled: boolean;
  setHarnessEnabled: (enabled: boolean) => void;
  harnessStatus: HarnessStatus;
  harnessInfo: HarnessInfo | null;
  harnessError: string | null;
  connectHarness: () => Promise<void>;
  disconnectHarness: () => void;

  harnessAgents: AgentSummary[];
  agentsLoading: boolean;
  refreshAgents: () => Promise<void>;
  saveAgent: (agent: AgentSummary) => Promise<void>;
  removeAgent: (id: string) => Promise<void>;

  harnessProjects: ProjectMeta[];
  activeProjectId: string | null;
  setActiveProject: (id: string | null) => void;
  refreshProjects: () => Promise<void>;
  createProject: (name: string, path?: string) => Promise<void>;
  removeProject: (id: string) => Promise<void>;

  attachments: Attachment[];
  attachPath: (path: string) => Promise<void>;
  /** Attaches a locally picked file (name + text content). */
  attachFile: (name: string, content: string) => void;
  removeAttachment: (id: string) => void;
  clearAttachments: () => void;

  /** Runs one harness task, streaming tokens/tools/subagents into a message. */
  runHarnessTask: (message: string, agentMode: 'plan' | 'build' | 'ask') => Promise<void>;
}

export const useStore = create<StudioState>()(
  persist(
    (set, get) => ({
      mode: 'chat',
      setMode: (mode) => set({ mode }),

      providers: createDefaultProviders(),
      activeProviderId: DEFAULT_PROVIDER_ID,
      setActiveProvider: (id) =>
        set((state) => ({
          activeProviderId: id,
          models: [],
          modelsFetchedAt: null,
          modelsError: null,
          connectionStatus: 'idle',
          tokenStatus: 'unknown',
          lastError: null,
          selectedModels:
            state.providers.some((provider) => provider.id === id) ? state.selectedModels : emptySelection(),
        })),
      updateProvider: (id, patch) =>
        set((state) => ({
          providers: state.providers.map((provider) =>
            provider.id === id ? { ...provider, ...patch } : provider,
          ),
          ...(patch.baseUrl === undefined
            ? {}
            : { models: [], modelsFetchedAt: null, connectionStatus: 'idle' as ConnectionStatus }),
        })),
      addProvider: (provider) =>
        set((state) =>
          state.providers.some((item) => item.id === provider.id)
            ? state
            : { providers: [...state.providers, provider] },
        ),
      removeProvider: (id) =>
        set((state) => ({
          providers: state.providers.filter((provider) => provider.id !== id),
          activeProviderId: state.activeProviderId === id ? DEFAULT_PROVIDER_ID : state.activeProviderId,
        })),

      models: [],
      modelsLoading: false,
      modelsError: null,
      modelsFetchedAt: null,
      refreshModels: async (force = false) => {
        const state = get();
        const provider = findProvider(state.providers, state.activeProviderId);
        if (!provider || state.modelsLoading) return;
        if (!force && state.models.length > 0 && state.modelsFetchedAt !== null) return;

        inFlightController?.abort();
        const controller = new AbortController();
        inFlightController = controller;

        set({ modelsLoading: true, modelsError: null, connectionStatus: 'connecting' });
        const apiKey = resolveApiKey(provider.id, useSecrets.getState().keys);
        const startedAt = performance.now();

        try {
          const models = await listModels(provider, apiKey, controller.signal);
          if (controller.signal.aborted) return;
          const latency = Math.round(performance.now() - startedAt);
          set((current) => {
            const nextSelection = { ...current.selectedModels };
            for (const mode of MODES) {
              nextSelection[mode] = defaultModelForMode(models, mode, nextSelection[mode])?.id ?? null;
            }
            return {
              models,
              modelsLoading: false,
              modelsError: null,
              modelsFetchedAt: Date.now(),
              connectionStatus: 'connected' as ConnectionStatus,
              tokenStatus: 'valid' as TokenStatus,
              lastError: null,
              lastLatencyMs: latency,
              selectedModels: nextSelection,
            };
          });
        } catch (error) {
          if (controller.signal.aborted) return;
          const apiError = error instanceof ApiError ? error : null;
          const offline = apiError?.status === 0;
          const unauthorized = apiError?.status === 401 || apiError?.status === 403;
          const message = error instanceof Error ? error.message : 'Error desconocido';
          set({
            modelsLoading: false,
            models: [],
            modelsError: message,
            connectionStatus: offline ? 'offline' : unauthorized ? 'error' : 'error',
            tokenStatus: unauthorized
              ? 'invalid'
              : apiError?.status === 429
                ? 'rate_limited'
                : offline
                  ? 'offline'
                  : 'unknown',
            lastError: message,
          });
        } finally {
          if (inFlightController === controller) inFlightController = null;
        }
      },

      selectedModels: emptySelection(),
      setSelectedModel: (mode, modelId) =>
        set((state) => ({ selectedModels: { ...state.selectedModels, [mode]: modelId } })),

      connectionStatus: 'idle',
      tokenStatus: 'unknown',
      lastError: null,
      lastLatencyMs: null,

      messages: [],
      projectMessages: {},
      addMessage: (message) => set((state) => ({ messages: [...state.messages, message] })),
      appendToMessage: (id, delta) =>
        set((state) => ({
          messages: state.messages.map((message) =>
            message.id === id ? { ...message, content: `${message.content}${delta}` } : message,
          ),
        })),
      finalizeMessage: (id, patch) =>
        set((state) => ({
          messages: state.messages.map((message) =>
            message.id === id ? { ...message, ...patch, streaming: false } : message,
          ),
        })),
      clearMessages: () => set({ messages: [] }),

      messageInput: '',
      setMessageInput: (messageInput) => set({ messageInput }),

      isStreaming: false,
      usage: emptyUsage,
      setStreaming: (isStreaming) => set({ isStreaming }),
      addUsage: (usage) =>
        set((state) => ({
          usage: {
            promptTokens: state.usage.promptTokens + usage.promptTokens,
            completionTokens: state.usage.completionTokens + usage.completionTokens,
            totalTokens: state.usage.totalTokens + usage.totalTokens,
          },
        })),
      resetUsage: () => set({ usage: emptyUsage }),
      beginRequest: () => {
        inFlightController?.abort();
        const controller = new AbortController();
        inFlightController = controller;
        return controller.signal;
      },
      cancelRequest: () => {
        inFlightController?.abort();
        inFlightController = null;
      },

      theme: 'dark',
      setTheme: (theme) => set({ theme }),
      toggleTheme: () => set((state) => ({ theme: state.theme === 'dark' ? 'light' : 'dark' })),

      /* ── UI shell ─────────────────────────────────────────────────── */
      sidebarCollapsed: false,
      sidebarWidth: 264,
      toggleSidebar: () => set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),
      setSidebarCollapsed: (sidebarCollapsed) => set({ sidebarCollapsed }),
      setSidebarWidth: (sidebarWidth) =>
        set({ sidebarWidth: clamp(sidebarWidth, SIDEBAR_WIDTH_MIN, SIDEBAR_WIDTH_MAX) }),

      paletteOpen: false,
      setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
      togglePalette: () => set((state) => ({ paletteOpen: !state.paletteOpen })),

      toasts: [],
      pushToast: (toast) => {
        const id = newId('toast');
        set((state) => ({ toasts: [...state.toasts, { ...toast, id }] }));
        return id;
      },
      dismissToast: (id) => set((state) => ({ toasts: state.toasts.filter((item) => item.id !== id) })),

      /* ── Harness ───────────────────────────────────────────────────── */
      harnessUrl: 'http://127.0.0.1:4317',
      setHarnessUrl: (harnessUrl) =>
        set({ harnessUrl, harnessStatus: 'idle', harnessInfo: null, harnessError: null }),
      harnessEnabled: false,
      setHarnessEnabled: (harnessEnabled) => set({ harnessEnabled }),
      harnessStatus: 'idle',
      harnessInfo: null,
      harnessError: null,
      connectHarness: async () => {
        set({ harnessStatus: 'connecting', harnessError: null });
        try {
          const info = await getHealth(get().harnessUrl);
          if (!info.ok) throw new Error(info.error ?? 'El harness no está listo.');
          set({ harnessStatus: 'connected', harnessInfo: info, harnessError: null, harnessEnabled: true });
          await Promise.all([get().refreshAgents(), get().refreshProjects()]);
        } catch (error) {
          set({
            harnessStatus: 'error',
            harnessInfo: null,
            harnessEnabled: false,
            harnessError: error instanceof Error ? error.message : 'Error desconocido',
          });
        }
      },
      disconnectHarness: () =>
        set({
          harnessEnabled: false,
          harnessStatus: 'idle',
          harnessInfo: null,
          harnessError: null,
        }),

      harnessAgents: [],
      agentsLoading: false,
      refreshAgents: async () => {
        if (!get().harnessEnabled && get().harnessStatus !== 'connected') return;
        set({ agentsLoading: true });
        try {
          const { agents } = await harnessListAgents(get().harnessUrl);
          set({ harnessAgents: agents, agentsLoading: false });
        } catch (error) {
          set({
            agentsLoading: false,
            harnessError: error instanceof Error ? error.message : 'Error desconocido',
          });
        }
      },
      saveAgent: async (agent) => {
        const { agents } = await harnessSaveAgent(get().harnessUrl, agent);
        set({ harnessAgents: agents });
        await get().connectHarness();
      },
      removeAgent: async (id) => {
        const { agents } = await harnessDeleteAgent(get().harnessUrl, id);
        set({ harnessAgents: agents });
        await get().connectHarness();
      },

      harnessProjects: [],
      activeProjectId: null,
      // Switching projects swaps the visible transcript: the current one is
      // stashed under its project key and the target conversation is loaded,
      // so every project keeps its own isolated session.
      setActiveProject: (activeProjectId) =>
        set((state) => {
          if (state.activeProjectId === activeProjectId) return {};
          const projectMessages = {
            ...state.projectMessages,
            [state.activeProjectId ?? DEFAULT_CONVERSATION]: state.messages,
          };
          return {
            activeProjectId,
            messages: projectMessages[activeProjectId ?? DEFAULT_CONVERSATION] ?? [],
            projectMessages,
          };
        }),
      refreshProjects: async () => {
        if (!get().harnessEnabled && get().harnessStatus !== 'connected') return;
        try {
          const { projects } = await harnessListProjects(get().harnessUrl);
          set({ harnessProjects: projects });
        } catch {
          /* non-fatal */
        }
      },
      createProject: async (name, path) => {
        const { projects, project } = await harnessCreateProject(get().harnessUrl, name, path);
        set({ harnessProjects: projects });
        get().setActiveProject(project.id);
      },
      removeProject: async (id) => {
        const { projects } = await harnessDeleteProject(get().harnessUrl, id);
        set((state) => {
          const projectMessages = { ...state.projectMessages };
          delete projectMessages[id];
          return {
            harnessProjects: projects,
            projectMessages,
            activeProjectId: state.activeProjectId === id ? null : state.activeProjectId,
          };
        });
      },

      attachments: [],
      attachPath: async (path) => {
        const state = get();
        const projectPath = state.harnessProjects.find(
          (project) => project.id === state.activeProjectId,
        )?.path;
        const file = await readWorkspaceFile(state.harnessUrl, path, projectPath);
        const attachment: Attachment = {
          id: newId('att'),
          path: file.path,
          name: file.name,
          content: file.content,
          truncated: file.truncated,
        };
        set((current) =>
          current.attachments.some((item) => item.path === attachment.path)
            ? current
            : { attachments: [...current.attachments, attachment] },
        );
      },
      attachFile: (name, content) => {
        const attachment: Attachment = {
          id: newId('att'),
          path: name,
          name,
          content,
          truncated: content.length > 200_000,
        };
        set((state) => ({ attachments: [...state.attachments, attachment] }));
      },
      removeAttachment: (id) =>
        set((state) => ({ attachments: state.attachments.filter((item) => item.id !== id) })),
      clearAttachments: () => set({ attachments: [] }),

      runHarnessTask: async (message, agentMode) => {
        const state = get();
        const provider = findProvider(state.providers, state.activeProviderId);
        const model = state.selectedModels.agent ?? state.selectedModels.chat ?? null;
        if (!provider) {
          set({ harnessError: 'No hay provider seleccionado.' });
          return;
        }
        if (!model) {
          set({ harnessError: 'Selecciona un modelo para el modo Agente.' });
          return;
        }

        harnessController?.abort();
        const controller = new AbortController();
        harnessController = controller;

        const attachments = state.attachments;
        const userMessage: StoredMessage = {
          id: newId('user'),
          role: 'user',
          content: message,
          timestamp: Date.now(),
          ...(attachments.length > 0 ? { attachments } : {}),
        };
        const assistantId = newId('assistant');
        const assistantMessage: StoredMessage = {
          id: assistantId,
          role: 'assistant',
          content: '',
          timestamp: Date.now(),
          model,
          provider: provider.id,
          streaming: true,
          reasoning: '',
          blocks: [],
        };

        set((current) => ({
          messages: [...current.messages, userMessage, assistantMessage],
          isStreaming: true,
          messageInput: '',
          attachments: [],
          harnessError: null,
        }));

        const projectPath = state.harnessProjects.find((project) => project.id === state.activeProjectId)?.path;

        try {
          await streamHarnessChat({
            baseUrl: state.harnessUrl,
            message,
            mode: agentMode,
            provider,
            apiKey: resolveApiKey(provider.id, useSecrets.getState().keys),
            model,
            attachments,
            ...(projectPath ? { projectPath } : {}),
            signal: controller.signal,
            onToken: (delta) => get().appendToMessage(assistantId, delta),
            onReasoning: (delta) =>
              set((current) => ({
                messages: current.messages.map((item) =>
                  item.id === assistantId
                    ? { ...item, reasoning: `${item.reasoning ?? ''}${delta}` }
                    : item,
                ),
              })),
            onToolStart: (name, args) =>
              set((current) => ({
                messages: current.messages.map((item) =>
                  item.id === assistantId
                    ? {
                        ...item,
                        blocks: patchBlocks(item.blocks, (blocks) =>
                          upsertToolBlock(blocks, name, { status: 'running', args }),
                        ),
                      }
                    : item,
                ),
              })),
            onToolEnd: (name, ok, ms, error) =>
              set((current) => ({
                messages: current.messages.map((item) =>
                  item.id === assistantId
                    ? {
                        ...item,
                        blocks: patchBlocks(item.blocks, (blocks) =>
                          upsertToolBlock(blocks, name, {
                            status: ok ? 'ok' : 'error',
                            ms,
                            ...(error ? { error } : {}),
                          }),
                        ),
                      }
                    : item,
                ),
              })),
            onAgentStart: (block) =>
              set((current) => ({
                messages: current.messages.map((item) =>
                  item.id === assistantId
                    ? { ...item, blocks: patchBlocks(item.blocks, (blocks) => upsertSubagent(blocks, block.id, block)) }
                    : item,
                ),
              })),
            onAgentTool: (id, name, ok, ms) =>
              set((current) => ({
                messages: current.messages.map((item) =>
                  item.id === assistantId
                    ? {
                        ...item,
                        blocks: patchBlocks(item.blocks, (blocks) =>
                          upsertSubagent(blocks, id, {
                            tools: [
                              ...(blocks.find((block) => block.kind === 'subagent' && block.id === id) as
                                | SubagentBlock
                                | undefined)?.tools ?? [],
                              { name, phase: 'end', ok, ms },
                            ],
                          }),
                        ),
                      }
                    : item,
                ),
              })),
            onAgentEnd: (id, ok, error) =>
              set((current) => ({
                messages: current.messages.map((item) =>
                  item.id === assistantId
                    ? {
                        ...item,
                        blocks: patchBlocks(item.blocks, (blocks) =>
                          upsertSubagent(blocks, id, {
                            status: ok ? 'ok' : 'error',
                            ...(error ? { error } : {}),
                          }),
                        ),
                      }
                    : item,
                ),
              })),
            onDone: (summary) =>
              set((current) => ({
                messages: current.messages.map((item) =>
                  item.id === assistantId
                    ? { ...item, streaming: false, blocks: item.blocks ?? [] }
                    : item,
                ),
                isStreaming: false,
                usage: {
                  promptTokens: current.usage.promptTokens,
                  completionTokens: current.usage.completionTokens,
                  totalTokens: current.usage.totalTokens + summary.tokensUsed,
                },
              })),
          });

          get().finalizeMessage(assistantId);
          await get().refreshProjects();
        } catch (error) {
          if (error instanceof DOMException && error.name === 'AbortError') {
            get().finalizeMessage(assistantId, { streaming: false });
          } else {
            const message2 = error instanceof Error ? error.message : 'Error desconocido';
            // A failed run does not mean the harness is gone: keep the
            // connection so the user can simply retry.
            get().finalizeMessage(assistantId, { error: message2 });
            set({ harnessError: message2 });
          }
        } finally {
          if (harnessController === controller) harnessController = null;
          set({ isStreaming: false });
        }
      },
    }),
    {
      name: 'kli-studio-storage',
      version: 4,
      storage: createJSONStorage(() => localStorage),
      // v2 → v3: conversations became per project (`projectMessages`), and the
      // right workbench panel was removed from the shell.
      // v3 → v4: the image mode now ships a default model (the catalogue has
      // no image entries, so the selection used to start empty).
      migrate: (persisted) => {
        const state = (persisted ?? {}) as Record<string, unknown>;
        state.projectMessages ??= {};
        delete state.rightPanelOpen;
        delete state.rightPanelWidth;
        delete state.rightPanelTab;
        const selection = (state.selectedModels ?? {}) as Record<string, string | null>;
        if (!selection.image) selection.image = DEFAULT_IMAGE_MODEL;
        state.selectedModels = selection;
        return state as unknown as StudioState;
      },
      partialize: (state) => ({
        mode: state.mode,
        providers: state.providers,
        activeProviderId: state.activeProviderId,
        selectedModels: state.selectedModels,
        theme: state.theme,
        usage: state.usage,
        sidebarWidth: state.sidebarWidth,
        sidebarCollapsed: state.sidebarCollapsed,
        harnessUrl: state.harnessUrl,
        harnessEnabled: state.harnessEnabled,
        activeProjectId: state.activeProjectId,
        messages: settleMessages(state.messages),
        projectMessages: Object.fromEntries(
          Object.entries(state.projectMessages).map(([key, list]) => [key, settleMessages(list)]),
        ),
      }),
    },
  ),
);

/* ── Derived selectors ─────────────────────────────────────────────────── */

const FALLBACK_PROVIDER: ProviderConfig = {
  id: 'freellmapi',
  label: 'FreeLLMAPI',
  kind: 'openai',
  baseUrl: 'http://127.0.0.1:31415/v1',
  requiresKey: true,
  builtin: true,
  capabilities: { chat: true, embeddings: true, images: true, audio: true },
};

export function useActiveProvider(): ProviderConfig {
  return useStore(
    (state) =>
      state.providers.find((provider) => provider.id === state.activeProviderId) ?? FALLBACK_PROVIDER,
  );
}

export function useSelectedModelId(mode: Mode): string | null {
  return useStore((state) => state.selectedModels[mode]);
}