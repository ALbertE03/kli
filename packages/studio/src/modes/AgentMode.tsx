/**
 * KLI — Agent mode
 *
 * Drives the *real* harness (`kli serve`): the kernel boots with every plugin
 * from `.kli/config.js`, so the model gets the registered tools, the code graph
 * and the subagents. This is the Claude Code / opencode-style surface.
 *
 * The reply renders four things the direct chat cannot: the model's reasoning
 * ("thinking"), the tool timeline, delegated subagent runs, and file attachments.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Brain,
  ChevronDown,
  ChevronRight,
  FilePlus2,
  FolderOpen,
  FolderPlus,
  Paperclip,
  Send,
  Square,
  Terminal,
  Trash2,
  Users,
  Wrench,
  X,
} from 'lucide-react';
import { Alert, Badge, Button, EmptyState, Segmented, Select, Textarea } from '@/components/ui';
import { AgentEditor } from '@/components/AgentEditor';
import { FolderPicker } from '@/components/FolderPicker';
import { MessageContent } from '@/components/CodeBlock';
import { useAutoGrow } from '@/lib/hooks';
import { cn, formatRelativeTime } from '@/lib/utils';
import { useActiveProvider, useStore } from '@/store';
import type { AgentSummary, StoredMessage, SubagentBlock, TimelineBlock } from '@/types';

type AgentModeName = 'plan' | 'build' | 'ask';

const AGENT_MODES: Array<{ value: AgentModeName; label: string }> = [
  { value: 'plan', label: 'plan' },
  { value: 'build', label: 'build' },
  { value: 'ask', label: 'ask' },
];

export function AgentMode() {
  const messages = useStore((state) => state.messages);
  const messageInput = useStore((state) => state.messageInput);
  const setMessageInput = useStore((state) => state.setMessageInput);
  const isStreaming = useStore((state) => state.isStreaming);
  const cancelRequest = useStore((state) => state.cancelRequest);

  const harnessEnabled = useStore((state) => state.harnessEnabled);
  const harnessStatus = useStore((state) => state.harnessStatus);
  const harnessInfo = useStore((state) => state.harnessInfo);
  const harnessError = useStore((state) => state.harnessError);
  const connectHarness = useStore((state) => state.connectHarness);
  const agents = useStore((state) => state.harnessAgents);
  const projects = useStore((state) => state.harnessProjects);
  const activeProjectId = useStore((state) => state.activeProjectId);
  const setActiveProject = useStore((state) => state.setActiveProject);
  const removeProject = useStore((state) => state.removeProject);
  const attachments = useStore((state) => state.attachments);
  const attachFile = useStore((state) => state.attachFile);
  const removeAttachment = useStore((state) => state.removeAttachment);
  const runHarnessTask = useStore((state) => state.runHarnessTask);
  const pushToast = useStore((state) => state.pushToast);

  const selectedModelId = useStore((state) => state.selectedModels.agent);
  const provider = useActiveProvider();

  const [agentMode, setAgentMode] = useState<AgentModeName>('build');
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingAgent, setEditingAgent] = useState<AgentSummary | null>(null);
  const [folderPickerOpen, setFolderPickerOpen] = useState(false);
  const [showProjects, setShowProjects] = useState(false);
  const [showAgents, setShowAgents] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const bottomRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages]);

  const textareaRef = useAutoGrow(messageInput);

  const connected = harnessEnabled && harnessStatus === 'connected';
  const disabled = !connected || isStreaming || !selectedModelId;

  const send = useCallback(() => {
    const prompt = messageInput.trim();
    if (!prompt || disabled) return;
    void runHarnessTask(prompt, agentMode);
  }, [messageInput, disabled, runHarnessTask, agentMode]);

  const onFilesPicked = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(event.target.files ?? []);
      event.target.value = '';
      for (const file of files) {
        void file
          .text()
          .then((content) => attachFile(file.name, content))
          .catch((error: unknown) => {
            pushToast({
              variant: 'destructive',
              title: 'No se pudo adjuntar el archivo',
              description: error instanceof Error ? error.message : undefined,
            });
          });
      }
    },
    [attachFile, pushToast],
  );

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      send();
    }
  };

  const visibleAgents = useMemo(() => agents.filter((agent) => !agent.hidden), [agents]);

  return (
    <div className="flex min-h-0 flex-1 flex-col rounded-lg border border-border bg-card">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        <Segmented
          options={AGENT_MODES}
          value={agentMode}
          onValueChange={(value) => setAgentMode(value)}
          size="sm"
        />

        <Select
          className="h-7 w-auto min-w-[9rem]"
          options={projects.map((project) => ({ value: project.id, label: project.name }))}
          placeholder="Sin proyecto"
          value={activeProjectId ?? ''}
          onValueChange={(value) => setActiveProject(value)}
        />

        <Button size="sm" variant="ghost" onClick={() => setShowProjects((value) => !value)}>
          <FolderPlus className="h-3.5 w-3.5" />
          Proyecto
        </Button>

        <Button size="sm" variant="ghost" onClick={() => setShowAgents((value) => !value)}>
          <Users className="h-3.5 w-3.5" />
          Subagentes ({visibleAgents.length})
        </Button>

        <div className="ml-auto flex items-center gap-2 text-[11px] text-muted-foreground">
          {harnessInfo?.plugins ? <span>{harnessInfo.plugins.length} plugins</span> : null}
          {harnessInfo?.tools ? <span>· {harnessInfo.tools} tools</span> : null}
          <Badge variant={connected ? 'success' : harnessStatus === 'error' ? 'destructive' : 'outline'}>
            {connected ? 'harness' : harnessStatus === 'connecting' ? 'conectando…' : 'desconectado'}
          </Badge>
        </div>
      </div>

      {/* Collapsible panels */}
      {showProjects ? (
        <div className="space-y-2 border-b border-border bg-muted/30 px-3 py-2">
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" className="h-7" onClick={() => setFolderPickerOpen(true)}>
              <FolderOpen className="h-3.5 w-3.5" />
              Examinar…
            </Button>
            <span className="text-[11px] text-muted-foreground">
              El agente trabaja aislado dentro de esa carpeta.
            </span>
          </div>

          {projects.length > 0 ? (
            <ul className="flex flex-wrap gap-1.5">
              {projects.map((project) => (
                <li
                  key={project.id}
                  className={cn(
                    'flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px]',
                    project.id === activeProjectId
                      ? 'border-primary/40 bg-primary/10 text-foreground'
                      : 'border-border bg-background text-muted-foreground',
                  )}
                >
                  <button
                    type="button"
                    className="font-mono hover:underline"
                    onClick={() => setActiveProject(project.id === activeProjectId ? null : project.id)}
                    title={project.path}
                  >
                    {project.name}
                  </button>
                  <button
                    type="button"
                    className="text-muted-foreground hover:text-destructive"
                    onClick={() => void removeProject(project.id)}
                    aria-label={`Eliminar proyecto ${project.name}`}
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {folderPickerOpen ? (
        <FolderPicker
          onClose={() => setFolderPickerOpen(false)}
          onSelect={() => {
            setFolderPickerOpen(false);
          }}
        />
      ) : null}

      {showAgents ? (
        <div className="border-b border-border bg-muted/30 px-3 py-2">
          <div className="mb-2 flex items-center gap-2">
            <span className="text-xs font-medium">Subagentes</span>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setEditingAgent(null);
                setEditorOpen(true);
              }}
            >
              <FilePlus2 className="h-3.5 w-3.5" />
              Nuevo subagente
            </Button>
          </div>
          <div className="flex flex-wrap gap-2">
            {visibleAgents.map((agent) => (
              <button
                key={agent.id}
                type="button"
                onClick={() => {
                  setEditingAgent(agent);
                  setEditorOpen(true);
                }}
                className="rounded-md border border-border bg-card px-2 py-1 text-left text-[11px] hover:border-primary/60"
              >
                <span className="font-medium">{agent.name}</span>
                <span className="ml-2 text-muted-foreground">
                  {agent.id} · {agent.mode}
                </span>
              </button>
            ))}
            {visibleAgents.length === 0 ? (
              <span className="text-[11px] text-muted-foreground">No hay subagentes definidos.</span>
            ) : null}
          </div>
        </div>
      ) : null}

      {editorOpen ? (
        <AgentEditor
          agent={editingAgent}
          onClose={() => setEditorOpen(false)}
          onSaved={() => setEditorOpen(false)}
        />
      ) : null}

      {/* Transcript */}
      <div className="flex-1 space-y-3 overflow-y-auto p-4">
        {!connected ? (
          <EmptyState
            icon={<Terminal className="h-8 w-8" />}
            title="Conecta el harness para usar las herramientas"
            hint="Ejecuta `kli serve` y pulsa Conectar. Entonces el modelo recibe todos los plugins del workspace: herramientas, grafo de código y subagentes."
            action={
              <Button onClick={() => void connectHarness()}>
                <Terminal className="h-4 w-4" />
                Conectar al harness
              </Button>
            }
          />
        ) : messages.length === 0 ? (
          <EmptyState
            icon={<Terminal className="h-8 w-8" />}
            title="Modo Agente listo"
            hint={`${provider.label} · ${selectedModelId ?? 'sin modelo'} · ${visibleAgents.length} subagentes disponibles`}
          />
        ) : null}

        {messages.map((message) => (
          <Bubble key={message.id} message={message} />
        ))}
        <div ref={bottomRef} />
      </div>

      {/* Composer */}
      <div className="space-y-2 border-t border-border px-3 pb-3 pt-2">
        {harnessError ? (
          <Alert variant="destructive" className="text-xs">
            {harnessError}
          </Alert>
        ) : null}

        {!connected ? (
          <Alert variant="warning" className="text-xs">
            Sin harness conectado — el modo Agente no puede ejecutar herramientas.
          </Alert>
        ) : null}

        {/* Adjuntos siempre por encima de la barra */}
        {attachments.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {attachments.map((attachment) => (
              <span
                key={attachment.id}
                className="inline-flex items-center gap-1 rounded-full border border-border bg-muted/50 py-1 pl-2.5 pr-1 text-[11px]"
              >
                <Paperclip className="h-3 w-3" />
                {attachment.name}
                <button
                  type="button"
                  className="rounded-full p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                  onClick={() => removeAttachment(attachment.id)}
                  aria-label="Quitar adjunto"
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
          </div>
        ) : null}

        <input ref={fileInputRef} type="file" multiple hidden onChange={onFilesPicked} />

        <div className="flex items-end gap-1.5 rounded-2xl border border-input bg-background px-2 py-1.5 shadow-sm transition-colors focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/40">
          <Button
            size="icon"
            variant="ghost"
            className="h-8 w-8 shrink-0 rounded-full"
            onClick={() => fileInputRef.current?.click()}
            disabled={!connected}
            title="Adjuntar archivo"
            aria-label="Adjuntar archivo"
          >
            <Paperclip className="h-4 w-4" />
          </Button>

          <Textarea
            ref={textareaRef}
            rows={1}
            value={messageInput}
            onChange={(event) => setMessageInput(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder={
              !connected
                ? 'Conecta el harness para empezar'
                : !selectedModelId
                  ? 'Selecciona un modelo en la barra superior'
                  : 'Describe la tarea…'
            }
            disabled={!connected}
            className="max-h-48 min-h-[2rem] flex-1 resize-none border-0 bg-transparent px-1 py-1 shadow-none focus-visible:ring-0"
          />

          {isStreaming ? (
            <Button
              size="icon"
              variant="destructive"
              className="h-8 w-8 shrink-0 rounded-full"
              onClick={cancelRequest}
              title="Detener"
              aria-label="Detener"
            >
              <Square className="h-3.5 w-3.5" />
            </Button>
          ) : (
            <Button
              size="icon"
              className="h-8 w-8 shrink-0 rounded-full"
              onClick={send}
              disabled={disabled || !messageInput.trim()}
              title="Enviar (Enter)"
              aria-label="Enviar mensaje"
            >
              <Send className="h-4 w-4" />
            </Button>
          )}
        </div>

        <p className="px-1 text-[10px] text-muted-foreground">
          Enter envía · Shift+Enter salto de línea
        </p>
      </div>
    </div>
  );
}

/* ── Message rendering ─────────────────────────────────────────────────── */

function Bubble({ message }: { message: StoredMessage }) {
  const isUser = message.role === 'user';
  return (
    <div className={cn('flex gap-2', isUser ? 'justify-end' : 'justify-start')}>
      {!isUser ? (
        <span className="mt-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-border bg-secondary">
          <Terminal className="h-3 w-3" />
        </span>
      ) : null}

      <div className={cn('max-w-[88%] space-y-2', isUser ? 'items-end' : 'items-start')}>
        {message.attachments?.length ? (
          <div className="flex flex-wrap justify-end gap-1">
            {message.attachments.map((attachment) => (
              <span
                key={attachment.id}
                className="inline-flex items-center gap-1 rounded border border-border bg-muted/50 px-1.5 py-0.5 text-[10px]"
              >
                <Paperclip className="h-3 w-3" />
                {attachment.name}
              </span>
            ))}
          </div>
        ) : null}

        {message.reasoning?.trim() ? (
          <ThinkingBlock text={message.reasoning} streaming={message.streaming} />
        ) : null}

        {message.blocks?.length ? (
          <div className="space-y-1">
            {message.blocks.map((block) => (
              <Timeline key={block.kind === 'tool' ? block.id : block.id} block={block} />
            ))}
          </div>
        ) : null}

        {message.error ? (
          <Alert variant="destructive" className="text-xs">
            {message.error}
          </Alert>
        ) : message.content.trim() ? (
          <div className="rounded-xl bg-muted/60 px-3 py-2 text-sm text-foreground">
            <MessageContent content={message.content} streaming={message.streaming} />
          </div>
        ) : message.streaming ? (
          <div className="rounded-xl bg-muted/60 px-3 py-2 text-sm text-muted-foreground">Pensando…</div>
        ) : null}

        <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
          {message.model ? <span className="truncate">{message.model}</span> : null}
          <span>{formatRelativeTime(message.timestamp)}</span>
        </div>
      </div>

      {isUser ? (
        <span className="mt-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-border bg-primary text-[10px] text-primary-foreground">
          Tú
        </span>
      ) : null}
    </div>
  );
}

function ThinkingBlock({ text, streaming }: { text: string; streaming?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-lg border border-border bg-background/60 text-xs">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-muted-foreground"
      >
        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        <Brain className="h-3 w-3" />
        <span>Razonamiento</span>
        {streaming ? <span className="animate-pulse">…</span> : null}
      </button>
      {open ? (
        <p className="max-h-56 overflow-y-auto whitespace-pre-wrap border-t border-border px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">
          {text}
        </p>
      ) : null}
    </div>
  );
}

function Timeline({ block }: { block: TimelineBlock }) {
  if (block.kind === 'subagent') return <SubagentCard block={block} />;
  return (
    <div className="flex items-center gap-2 rounded-md border border-border bg-background/60 px-2 py-1 text-[11px]">
      <Wrench className="h-3 w-3 text-muted-foreground" />
      <span className="font-mono">{block.name}</span>
      <span className="truncate text-muted-foreground">{summarizeArgs(block.args)}</span>
      <span className="ml-auto">
        {block.status === 'running' ? (
          <span className="text-muted-foreground">ejecutando…</span>
        ) : block.status === 'ok' ? (
          <span className="text-emerald-500">ok{block.ms ? ` · ${block.ms}ms` : ''}</span>
        ) : (
          <span className="text-destructive">error</span>
        )}
      </span>
    </div>
  );
}

function SubagentCard({ block }: { block: SubagentBlock }) {
  const [open, setOpen] = useState(true);
  return (
    <div className="rounded-lg border border-primary/30 bg-primary/5 text-[11px]">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-2 px-2 py-1.5 text-left"
      >
        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        <Users className="h-3 w-3" />
        <span className="font-medium">subagente · {block.agent}</span>
        <span className="ml-auto">
          {block.status === 'running' ? (
            <span className="text-muted-foreground">trabajando…</span>
          ) : block.status === 'ok' ? (
            <span className="text-emerald-500">completado</span>
          ) : (
            <span className="text-destructive">falló</span>
          )}
        </span>
      </button>
      {open ? (
        <div className="space-y-1 border-t border-primary/20 px-3 py-2 text-muted-foreground">
          <p className="whitespace-pre-wrap">{block.task}</p>
          {block.tools.length > 0 ? (
            <ul className="space-y-0.5">
              {block.tools.map((tool, index) => (
                <li key={`${tool.name}-${index}`} className="font-mono">
                  · {tool.name}
                  {tool.ok === undefined ? '' : tool.ok ? ' ✓' : ' ✗'}
                  {tool.ms ? ` (${tool.ms}ms)` : ''}
                </li>
              ))}
            </ul>
          ) : null}
          {block.error ? <p className="text-destructive">{block.error}</p> : null}
        </div>
      ) : null}
    </div>
  );
}

function summarizeArgs(args: Record<string, unknown>): string {
  const entries = Object.entries(args);
  if (entries.length === 0) return '';
  const [key, value] = entries[0] ?? [];
  if (key === undefined) return '';
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return `${key}: ${text.length > 60 ? `${text.slice(0, 60)}…` : text}`;
}
