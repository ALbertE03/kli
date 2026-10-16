/**
 * KLI — Sidebar
 *
 * Left rail of the shell. It hosts the cards that used to live in the old left
 * aside (provider, harness, session) plus the "nueva conversación" action, so
 * nothing that existed before is lost — only re-homed. Rendered both as the
 * static desktop column and as the mobile drawer (same component, same store).
 */

import { Activity, Plus, Settings, Zap } from 'lucide-react';
import { Badge, Button, Input } from '@/components/ui';
import { useActiveProvider, useStore } from '@/store';
import { formatDuration, formatTokens } from '@/lib/utils';
import { MODE_LABELS, type ConnectionStatus, type TokenStatus } from '@/types';

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

export function Sidebar({ onOpenSettings }: { onOpenSettings: () => void }) {
  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto p-3">
      <NewConversationButton />
      <ProviderCard onOpenSettings={onOpenSettings} />
      <HarnessCard />
      <SessionCard />
    </div>
  );
}

function NewConversationButton() {
  const messages = useStore((state) => state.messages);
  const clearMessages = useStore((state) => state.clearMessages);
  const isStreaming = useStore((state) => state.isStreaming);
  const pushToast = useStore((state) => state.pushToast);

  return (
    <Button
      className="w-full justify-start"
      variant="outline"
      disabled={messages.length === 0 || isStreaming}
      onClick={() => {
        clearMessages();
        pushToast({ variant: 'info', title: 'Conversación vaciada' });
      }}
      title="Vaciar el historial de la conversación actual"
    >
      <Plus className="h-4 w-4" />
      Nueva conversación
    </Button>
  );
}

function ProviderCard({ onOpenSettings }: { onOpenSettings: () => void }) {
  const provider = useActiveProvider();
  const models = useStore((state) => state.models);
  const lastLatencyMs = useStore((state) => state.lastLatencyMs);
  const connectionStatus = useStore((state) => state.connectionStatus);
  const tokenStatus = useStore((state) => state.tokenStatus);

  const connection = CONNECTION_COPY[connectionStatus];
  const token = TOKEN_COPY[tokenStatus];

  return (
    <section className="rounded-lg border border-border bg-card p-3">
      <h2 className="mb-3 text-sm font-semibold">Proveedor</h2>
      <dl className="space-y-2 text-xs">
        <Row label="Nombre" value={provider.label} />
        <Row label="API" value={provider.kind === 'anthropic' ? 'Anthropic' : 'OpenAI'} />
        <div className="space-y-0.5">
          <dt className="text-muted-foreground">Endpoint</dt>
          <dd className="break-all font-mono text-[11px]">{provider.baseUrl || '—'}</dd>
        </div>
        <Row label="Modelos" value={String(models.length)} />
        <Row label="Latencia" value={formatDuration(lastLatencyMs ?? NaN)} />
      </dl>

      <div className="mt-3 space-y-1.5 border-t border-border pt-2 text-xs">
        <p className="flex items-center gap-2">
          <span className={`h-2 w-2 rounded-full ${connection.dot}`} />
          <span className={connection.text}>{connection.label}</span>
        </p>
        <p className="flex items-center gap-2">
          <Badge variant={token.variant}>{token.label}</Badge>
        </p>
      </div>

      <Button className="mt-3 w-full" size="sm" variant="outline" onClick={onOpenSettings}>
        <Settings className="h-3.5 w-3.5" />
        Configurar
      </Button>
    </section>
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
    <section className="rounded-lg border border-border bg-card p-3">
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
        aria-label="URL del servidor del harness"
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

      {error && !connected ? <p className="mt-3 text-[11px] text-destructive">{error}</p> : null}

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
          Ejecuta <code>pnpm --filter @kli/server start</code> en el workspace para habilitar herramientas y subagentes.
        </p>
      ) : null}
    </section>
  );
}

function SessionCard() {
  const messages = useStore((state) => state.messages);
  const usage = useStore((state) => state.usage);
  const mode = useStore((state) => state.mode);
  const models = useStore((state) => state.models);

  return (
    <section className="rounded-lg border border-border bg-card p-3">
      <h2 className="mb-3 text-sm font-semibold">Sesión</h2>
      <p className="text-xs text-muted-foreground">
        {messages.length} mensaje{messages.length === 1 ? '' : 's'} · {formatTokens(usage.totalTokens)} tokens
      </p>
      <div className="mt-3 flex items-center gap-2 text-[11px] text-muted-foreground">
        <Activity className="h-3.5 w-3.5" />
        <span>
          {MODE_LABELS[mode]} · {models.length ? `${models.length} modelos` : 'sin catálogo'}
        </span>
      </div>
    </section>
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
