import * as React from 'react';
import { Check, KeyRound, Plus, RefreshCw, Server, Trash2, Wifi } from 'lucide-react';
import { Alert, Badge, Button, Dialog, Input } from '@/components/ui';
import { slugifyProviderId } from '@/lib/providers';
import { normalizeBaseUrl } from '@/lib/utils';
import { useActiveProvider, useStore } from '@/store';
import { resolveApiKey, useSecrets } from '@/store/secrets';
import type { ProviderConfig, ProviderKind } from '@/types';

interface ProviderSettingsProps {
  open: boolean;
  onClose: () => void;
}

export function ProviderSettings({ open, onClose }: ProviderSettingsProps) {
  const providers = useStore((state) => state.providers);
  const activeProvider = useActiveProvider();
  const setActiveProvider = useStore((state) => state.setActiveProvider);
  const updateProvider = useStore((state) => state.updateProvider);
  const addProvider = useStore((state) => state.addProvider);
  const removeProvider = useStore((state) => state.removeProvider);
  const refreshModels = useStore((state) => state.refreshModels);
  const connectionStatus = useStore((state) => state.connectionStatus);
  const modelsLoading = useStore((state) => state.modelsLoading);
  const modelsError = useStore((state) => state.modelsError);
  const modelsCount = useStore((state) => state.models.length);

  const keys = useSecrets((state) => state.keys);
  const setKey = useSecrets((state) => state.setKey);

  const [label, setLabel] = React.useState(activeProvider.label);
  const [baseUrl, setBaseUrl] = React.useState(activeProvider.baseUrl);
  const [kind, setKind] = React.useState<ProviderKind>(activeProvider.kind);
  const [newLabel, setNewLabel] = React.useState('');
  const [newBaseUrl, setNewBaseUrl] = React.useState('');

  React.useEffect(() => {
    setLabel(activeProvider.label);
    setBaseUrl(activeProvider.baseUrl);
    setKind(activeProvider.kind);
  }, [activeProvider]);

  const effectiveKey = resolveApiKey(activeProvider.id, keys);
  const dirty = label !== activeProvider.label || normalizeBaseUrl(baseUrl) !== activeProvider.baseUrl || kind !== activeProvider.kind;

  const saveActive = () => {
    if (!label.trim()) return;
    updateProvider(activeProvider.id, {
      label: label.trim(),
      baseUrl: normalizeBaseUrl(baseUrl) || activeProvider.baseUrl,
      kind,
    });
  };

  const createCustom = () => {
    const id = slugifyProviderId(newLabel, providers);
    const provider: ProviderConfig = {
      id,
      label: newLabel.trim(),
      kind: 'openai',
      baseUrl: normalizeBaseUrl(newBaseUrl),
      requiresKey: false,
      builtin: false,
      capabilities: { chat: true, embeddings: true, images: false, audio: false },
    };
    addProvider(provider);
    setNewLabel('');
    setNewBaseUrl('');
    setActiveProvider(id);
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Proveedores"
      description="FreeLLMAPI es el proveedor por defecto. Puedes apuntar KLI a cualquier API compatible con OpenAI o a Anthropic, y cambiar de modelo en caliente."
      footer={
        <Button variant="outline" onClick={onClose}>
          Cerrar
        </Button>
      }
    >
      <div className="space-y-5">
        {/* Provider switcher */}
        <section className="space-y-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Proveedor activo</h3>
          <div className="grid gap-2 sm:grid-cols-2">
            {providers.map((provider) => {
              const active = provider.id === activeProvider.id;
              return (
                <button
                  key={provider.id}
                  type="button"
                  onClick={() => setActiveProvider(provider.id)}
                  className={`flex items-start justify-between gap-2 rounded-lg border p-3 text-left transition-colors ${
                    active
                      ? 'border-primary bg-primary/10'
                      : 'border-border hover:bg-accent'
                  }`}
                >
                  <span className="min-w-0">
                    <span className="flex items-center gap-1.5 text-sm font-medium">
                      <Server className="h-3.5 w-3.5 text-muted-foreground" />
                      <span className="truncate">{provider.label}</span>
                    </span>
                    <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">{provider.baseUrl}</span>
                  </span>
                  {active ? <Check className="h-4 w-4 shrink-0 text-primary" /> : null}
                </button>
              );
            })}
          </div>
        </section>

        {/* Connection state */}
        <section className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-muted/30 px-3 py-2">
          <Wifi className={`h-4 w-4 ${connectionStatus === 'connected' ? 'text-success' : 'text-muted-foreground'}`} />
          <span className="text-xs font-medium">
            {connectionStatus === 'connected'
              ? `Conectado · ${modelsCount} modelos`
              : connectionStatus === 'connecting'
                ? 'Conectando…'
                : 'Sin conexión'}
          </span>
          {modelsError ? <span className="text-xs text-destructive">{modelsError}</span> : null}
          <Button
            size="sm"
            variant="outline"
            className="ml-auto"
            loading={modelsLoading}
            onClick={() => void refreshModels(true)}
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Probar conexión
          </Button>
        </section>

        {/* Active provider config */}
        <section className="space-y-3">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Configuración de {activeProvider.label}
          </h3>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="space-y-1">
              <span className="text-xs text-muted-foreground">Nombre</span>
              <Input value={label} onChange={(event) => setLabel(event.target.value)} />
            </label>
            <label className="space-y-1">
              <span className="text-xs text-muted-foreground">API</span>
              <select
                value={kind}
                onChange={(event) => setKind(event.target.value as ProviderKind)}
                className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
              >
                <option value="openai">OpenAI-compatible</option>
                <option value="anthropic">Anthropic Messages</option>
              </select>
            </label>
            <label className="space-y-1 sm:col-span-2">
              <span className="text-xs text-muted-foreground">Base URL</span>
              <Input
                value={baseUrl}
                placeholder="http://127.0.0.1:31415/v1"
                onChange={(event) => setBaseUrl(event.target.value)}
              />
            </label>
            <label className="space-y-1 sm:col-span-2">
              <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <KeyRound className="h-3 w-3" />
                API key
                <Badge variant="secondary" className="px-1 py-0 text-[10px]">
                  servidor: .env
                </Badge>
              </span>
              <Input
                type="password"
                value={keys[activeProvider.id] ?? ''}
                placeholder={effectiveKey ? 'Usando clave del servidor' : 'Opcional: solo si el servidor no tiene clave'}
                onChange={(event) => setKey(activeProvider.id, event.target.value.trim())}
              />
              <span className="block text-[11px] text-muted-foreground">
                El servidor KLI resuelve la clave desde su <code className="text-foreground">.env</code>{' '}
                (<code className="text-foreground">OPENAI_API_KEY</code> /{' '}
                <code className="text-foreground">ANTHROPIC_API_KEY</code>). Lo que escribas aquí es solo un
                respaldo de sesión.
              </span>
            </label>
          </div>
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={saveActive} disabled={!dirty}>
              Guardar cambios
            </Button>
            {!activeProvider.builtin ? (
              <Button size="sm" variant="ghost" onClick={() => removeProvider(activeProvider.id)}>
                <Trash2 className="h-3.5 w-3.5" />
                Eliminar proveedor
              </Button>
            ) : null}
          </div>
        </section>

        {/* Custom provider */}
        <section className="space-y-3">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Añadir proveedor compatible
          </h3>
          <div className="grid gap-3 sm:grid-cols-[1fr_2fr_auto] sm:items-end">
            <label className="space-y-1">
              <span className="text-xs text-muted-foreground">Nombre</span>
              <Input
                value={newLabel}
                placeholder="Mi servidor"
                onChange={(event) => setNewLabel(event.target.value)}
              />
            </label>
            <label className="space-y-1">
              <span className="text-xs text-muted-foreground">Base URL</span>
              <Input
                value={newBaseUrl}
                placeholder="http://localhost:8000/v1"
                onChange={(event) => setNewBaseUrl(event.target.value)}
              />
            </label>
            <Button size="sm" onClick={createCustom} disabled={!newLabel.trim() || !newBaseUrl.trim()}>
              <Plus className="h-3.5 w-3.5" />
              Añadir
            </Button>
          </div>
          <Alert variant="info" className="text-xs">
            Cualquier servidor con la ruta <code className="text-foreground">GET /models</code> compatible con OpenAI
            aparecerá aquí con su catálogo completo, y podrás cambiar de modelo sin recargar la página.
          </Alert>
        </section>
      </div>
    </Dialog>
  );
}