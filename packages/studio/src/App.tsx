/**
 * KLI — Main application shell
 *
 * Unified workspace frontend. Defaults to the FreeLLMAPI provider and lets you
 * switch provider/model at runtime.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  Activity,
  Bot,
  MessageSquare,
  Moon,
  RefreshCw,
  Settings,
  Sun,
  Waves,
  Zap,
  Image as ImageIcon,
  Boxes,
} from 'lucide-react';
import { Badge, Button, Input, Segmented } from '@/components/ui';
import { ModelPicker } from '@/components/ModelPicker';
import { ProviderSettings } from '@/components/ProviderSettings';
import { AgentMode } from '@/modes/AgentMode';
import { AudioMode } from '@/modes/AudioMode';
import { ChatMode } from '@/modes/ChatMode';
import { EmbeddingsMode } from '@/modes/EmbeddingsMode';
import { ImageMode } from '@/modes/ImageMode';
import { useActiveProvider, useStore } from '@/store';
import { formatDuration, formatTokens } from '@/lib/utils';
import { MODE_LABELS, MODES, type ConnectionStatus, type Mode, type TokenStatus } from '@/types';

const MODE_ICONS: Record<Mode, typeof MessageSquare> = {
  agent: Bot,
  chat: MessageSquare,
  image: ImageIcon,
  embeddings: Boxes,
  audio: Waves,
};

const CONNECTION_COPY: Record<ConnectionStatus, { label: string; dot: string; text: string }> = {
  idle: { label: 'inactivo', dot: 'bg-muted-foreground', text: 'text-muted-foreground' },
  connecting: { label: 'conectando', dot: 'bg-warning animate-pulse-dot', text: 'text-warning' },
  connected: { label: 'conectado', dot: 'bg-success animate-pulse-dot', text: 'text-success' },
  error: { label: 'error', dot: 'bg-destructive', text: 'text-destructive' },
  offline: { label: 'sin conexión', dot: 'bg-destructive', text: 'text-destructive' },
};

const TOKEN_COPY: Record<TokenStatus, { label: string; variant: 'success' | 'warning' | 'destructive' | 'secondary' }> = {
  unknown: { label: 'token ?', variant: 'secondary' },
  valid: { label: 'token válido', variant: 'success' },
  invalid: { label: 'token inválido', variant: 'destructive' },
  rate_limited: { label: 'límite alcanzado', variant: 'warning' },
  offline: { label: 'sin token', variant: 'secondary' },
};

export function App() {
  const mode = useStore((state) => state.mode);
  const setMode = useStore((state) => state.setMode);
  const providers = useStore((state) => state.providers);
  const activeProvider = useActiveProvider();
  const setActiveProvider = useStore((state) => state.setActiveProvider);
  const models = useStore((state) => state.models);
  const modelsLoading = useStore((state) => state.modelsLoading);
  const refreshModels = useStore((state) => state.refreshModels);
  const connectionStatus = useStore((state) => state.connectionStatus);
  const tokenStatus = useStore((state) => state.tokenStatus);
  const lastLatencyMs = useStore((state) => state.lastLatencyMs);
  const usage = useStore((state) => state.usage);
  const messages = useStore((state) => state.messages);
  const theme = useStore((state) => state.theme);
  const toggleTheme = useStore((state) => state.toggleTheme);
  const connectHarness = useStore((state) => state.connectHarness);

  const [settingsOpen, setSettingsOpen] = useState(false);

  // Load the catalogue of the active provider — FreeLLMAPI on boot, and again
  // whenever the user switches provider (or the provider's base URL changes,
  // which clears the cached models and re-triggers this effect).
  useEffect(() => {
    void refreshModels();
  }, [refreshModels, activeProvider.id, activeProvider.baseUrl]);

  // Keep the <html> class in sync with the persisted theme.
  useEffect(() => {
    const root = document.documentElement;
    root.classList.remove('dark', 'light');
    root.classList.add(theme);
  }, [theme]);

  // If the user was using the harness last time, reconnect on boot.
  useEffect(() => {
    if (useStore.getState().harnessEnabled) void connectHarness();
  }, [connectHarness]);

  // Free fallbacks for chat keyboard shortcuts.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key === 'Enter') return;
      const target = event.target;
      if (target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement) return;
      const index = MODES.indexOf(mode);
      if (index === -1) return;
      const delta = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
      if (delta === 0) return;
      event.preventDefault();
      setMode(MODES[(index + delta + MODES.length) % MODES.length]!);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [mode, setMode]);

  const onProviderChange = useCallback(
    (value: string) => {
      if (value) setActiveProvider(value);
    },
    [setActiveProvider],
  );

  const connection = CONNECTION_COPY[connectionStatus];
  const token = TOKEN_COPY[tokenStatus];

  return (
    <div className="flex h-full min-h-screen flex-col bg-background text-foreground">
      {/* ── Header ─────────────────────────────────────────────────────── */}
      <header className="sticky top-0 z-30 border-b border-border bg-background/85 backdrop-blur">
        <div className="mx-auto flex w-full max-w-[1600px] flex-wrap items-center gap-3 px-4 py-2.5">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-violet to-cyan">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path
                  d="M9 4v16M15 4v16M5.5 8l11 8M18.5 8l-11 8"
                  stroke="#0a0a0b"
                  strokeWidth="2.2"
                  strokeLinecap="round"
                />
              </svg>
            </div>
            <div className="leading-none">
              <h1 className="text-base font-bold tracking-tight">KLI</h1>
              <p className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">Studio</p>
            </div>
          </div>

          <Segmented
            className="order-3 w-full sm:order-none sm:w-auto"
            options={MODES.map((value) => ({
              value,
              label: (
                <>
                  {(() => {
                    const Icon = MODE_ICONS[value];
                    return <Icon className="h-3.5 w-3.5" />;
                  })()}
                  <span className="hidden md:inline">{MODE_LABELS[value]}</span>
                </>
              ),
            }))}
            value={mode}
            onValueChange={setMode}
          />

          <div className="ml-auto flex flex-1 items-center justify-end gap-2 sm:flex-none">
            <div className="hidden w-40 md:block">
              <select
                aria-label="Proveedor"
                value={activeProvider.id}
                onChange={(event) => onProviderChange(event.target.value)}
                className="h-8 w-full truncate rounded-md border border-border bg-background px-2 text-sm transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {providers.map((provider) => (
                  <option key={provider.id} value={provider.id}>
                    {provider.label}
                  </option>
                ))}
              </select>
            </div>

            <ModelPicker mode={mode} className="w-full sm:w-56 md:w-64" />

            <Button
              size="icon"
              variant="ghost"
              title="Actualizar catálogo"
              onClick={() => void refreshModels(true)}
              disabled={modelsLoading}
            >
              <RefreshCw className={modelsLoading ? 'animate-spin' : undefined} />
            </Button>
            <Button size="icon" variant="ghost" title="Configurar proveedores" onClick={() => setSettingsOpen(true)}>
              <Settings />
            </Button>
            <Button size="icon" variant="ghost" title={theme === 'dark' ? 'Tema claro' : 'Tema oscuro'} onClick={toggleTheme}>
              {theme === 'dark' ? <Sun /> : <Moon />}
            </Button>
          </div>
        </div>

        <div className="flex items-center gap-3 border-t border-border/60 px-4 py-1.5 text-[11px] text-muted-foreground sm:hidden">
          <select
            aria-label="Proveedor"
            value={activeProvider.id}
            onChange={(event) => onProviderChange(event.target.value)}
            className="h-7 flex-1 rounded border border-border bg-background px-2 text-xs"
          >
            {providers.map((provider) => (
              <option key={provider.id} value={provider.id}>
                {provider.label}
              </option>
            ))}
          </select>
        </div>
      </header>

      {/* ── Body ───────────────────────────────────────────────────────── */}
      <div className="mx-auto flex w-full max-w-[1600px] flex-1 flex-col gap-4 p-4 lg:flex-row">
        <aside className="flex shrink-0 flex-col gap-4 lg:w-64">
          <div className="rounded-lg border border-border bg-card p-4">
            <h2 className="mb-3 text-sm font-semibold">Proveedor</h2>
            <dl className="space-y-2 text-xs">
              <div className="flex items-center justify-between gap-2">
                <dt className="text-muted-foreground">Nombre</dt>
                <dd className="truncate font-medium">{activeProvider.label}</dd>
              </div>
              <div className="flex items-center justify-between gap-2">
                <dt className="text-muted-foreground">API</dt>
                <dd className="font-medium">{activeProvider.kind === 'anthropic' ? 'Anthropic' : 'OpenAI'}</dd>
              </div>
              <div className="space-y-0.5">
                <dt className="text-muted-foreground">Endpoint</dt>
                <dd className="break-all font-mono text-[11px]">{activeProvider.baseUrl || '—'}</dd>
              </div>
              <div className="flex items-center justify-between gap-2">
                <dt className="text-muted-foreground">Modelos</dt>
                <dd className="font-medium">{models.length}</dd>
              </div>
              <div className="flex items-center justify-between gap-2">
                <dt className="text-muted-foreground">Latencia</dt>
                <dd className="font-medium">{formatDuration(lastLatencyMs ?? NaN)}</dd>
              </div>
            </dl>

            <div className="mt-4 space-y-2 border-t border-border pt-3 text-xs">
              <p className="flex items-center gap-2">
                <span className={`h-2 w-2 rounded-full ${connection.dot}`} />
                <span className={connection.text}>{connection.label}</span>
              </p>
              <p className="flex items-center gap-2">
                <span
                  className={`h-2 w-2 rounded-full ${
                    tokenStatus === 'valid'
                      ? 'bg-success'
                      : tokenStatus === 'invalid'
                        ? 'bg-destructive'
                        : 'bg-warning'
                  }`}
                />
                <span className="text-muted-foreground">{token.label}</span>
              </p>
            </div>

            <Button
              className="mt-4 w-full"
              size="sm"
              variant="outline"
              onClick={() => setSettingsOpen(true)}
            >
              <Settings className="h-3.5 w-3.5" />
              Configurar
            </Button>
          </div>

          <HarnessCard />

          <div className="rounded-lg border border-border bg-card p-4">
            <h2 className="mb-3 text-sm font-semibold">Sesión</h2>
            <p className="text-xs text-muted-foreground">
              {messages.length} mensaje{messages.length === 1 ? '' : 's'} ·{' '}
              {formatTokens(usage.totalTokens)} tokens
            </p>
            <div className="mt-3 flex items-center gap-2 text-[11px] text-muted-foreground">
              <Activity className="h-3.5 w-3.5" />
              <span>
                {MODE_LABELS[mode]} · {models.length ? `${models.length} modelos` : 'sin catálogo'}
              </span>
            </div>
          </div>
        </aside>

        <main className="flex min-w-0 flex-1 flex-col">
          {mode === 'agent' ? <AgentMode /> : null}
          {mode === 'chat' ? <ChatMode /> : null}
          {mode === 'image' ? <ImageMode /> : null}
          {mode === 'embeddings' ? <EmbeddingsMode /> : null}
          {mode === 'audio' ? <AudioMode /> : null}
        </main>

        <aside className="hidden shrink-0 lg:block lg:w-64">
          <div className="rounded-lg border border-border bg-card p-4">
            <h2 className="mb-3 text-sm font-semibold">Inspector</h2>
            <ModelInspector mode={mode} />
          </div>
        </aside>
      </div>

      {/* ── Footer ─────────────────────────────────────────────────────── */}
      <footer className="border-t border-border bg-background/85 px-4 py-2.5 backdrop-blur">
        <div className="mx-auto flex w-full max-w-[1600px] flex-wrap items-center justify-between gap-3 text-[11px] text-muted-foreground">
          <span>
            Tokens: <span className="font-medium text-foreground">{formatTokens(usage.totalTokens)}</span>{' '}
            <span className="text-muted-foreground">
              ({formatTokens(usage.promptTokens)} entrada · {formatTokens(usage.completionTokens)} salida)
            </span>
          </span>
          <span className="flex items-center gap-3">
            <span>⌘/Ctrl + ← → cambia de modo</span>
            <span className="text-muted-foreground">KLI</span>
          </span>
        </div>
      </footer>

      <ProviderSettings open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
  );
}

/**
 * Harness connection card — the switch that turns the bundled tools, skills,
 * graph and subagents on. Without `kli serve` the Studio still works as a plain
 * multi-provider chat client.
 */
function HarnessCard() {
  const url = useStore((state) => state.harnessUrl);
  const setUrl = useStore((state) => state.setHarnessUrl);
  const status = useStore((state) => state.harnessStatus);
  const info = useStore((state) => state.harnessInfo);
  const error = useStore((state) => state.harnessError);
  const connect = useStore((state) => state.connectHarness);
  const disconnect = useStore((state) => state.disconnectHarness);

  const connected = status === 'connected';

  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">Harness</h2>
        <Badge variant={connected ? 'success' : status === 'error' ? 'destructive' : 'outline'}>
          {connected ? 'conectado' : status === 'connecting' ? 'conectando…' : 'desconectado'}
        </Badge>
      </div>

      <Input
        className="h-8 text-xs"
        value={url}
        onChange={(event) => setUrl(event.target.value)}
        placeholder="http://127.0.0.1:4317"
        disabled={connected}
      />

      {connected && info ? (
        <dl className="mt-3 space-y-1.5 text-xs">
          <Row label="Plugins" value={String(info.pluginCount ?? 0)} />
          <Row label="Herramientas" value={String(info.tools ?? 0)} />
          <Row label="Subagentes" value={String(info.agents ?? 0)} />
          <Row label="Backends" value={(info.backends ?? []).join(', ') || '—'} />
          <Row label="Skills" value={String(info.skills?.length ?? 0)} />
        </dl>
      ) : null}

      {error && !connected ? (
        <p className="mt-3 text-[11px] text-destructive">{error}</p>
      ) : null}

      <div className="mt-3 flex gap-2">
        {connected ? (
          <Button className="flex-1" size="sm" variant="outline" onClick={disconnect}>
            Desconectar
          </Button>
        ) : (
          <Button className="flex-1" size="sm" onClick={() => void connect()} disabled={status === 'connecting'}>
            <Zap className="h-3.5 w-3.5" />
            Conectar
          </Button>
        )}
      </div>

      {!connected ? (
        <p className="mt-2 text-[10px] leading-relaxed text-muted-foreground">
          Ejecuta <code>kli serve</code> en el workspace para habilitar herramientas y subagentes.
        </p>
      ) : null}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="truncate font-medium">{value}</dd>
    </div>
  );
}

function ModelInspector({ mode }: { mode: Mode }) {
  const selectedId = useStore((state) => state.selectedModels[mode]);
  const model = useStore((state) => state.models.find((item) => item.id === selectedId));

  return (
    <div className="space-y-2 text-xs">
      <div className="space-y-0.5">
        <p className="text-muted-foreground">Modelo activo</p>
        <p className="break-words font-medium">{model?.name ?? 'Ninguno'}</p>
      </div>
      <div className="space-y-0.5">
        <p className="text-muted-foreground">ID</p>
        <p className="break-all font-mono text-[11px] text-foreground/80">{model?.id ?? '—'}</p>
      </div>
      <div className="flex items-center justify-between gap-2">
        <span className="text-muted-foreground">Publicado por</span>
        <span className="truncate font-medium">{model?.owner ?? '—'}</span>
      </div>
      <div className="flex items-center justify-between gap-2">
        <span className="text-muted-foreground">Contexto</span>
        <span className="font-medium">
          {model?.contextWindow ? `${formatTokens(model.contextWindow)} tokens` : '—'}
        </span>
      </div>
      <div className="flex items-center justify-between gap-2">
        <span className="text-muted-foreground">Estado</span>
        <span className={model?.available === false ? 'font-medium text-warning' : 'font-medium text-success'}>
          {model ? (model.available ? 'disponible' : 'no disponible') : '—'}
        </span>
      </div>
    </div>
  );
}