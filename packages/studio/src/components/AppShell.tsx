/**
 * KLI Studio — application shell
 *
 * Full-viewport layout with no page-level scroll:
 *
 *   ┌ header (brand · modes · provider · model · actions) ─────────────┐
 *   │ sidebar │        main (agent / chat / image / …)                 │
 *   └ footer (usage · shortcuts) ──────────────────────────────────────┘
 *
 * The sidebar is resizable on desktop (drag or ←/→ with the separator
 * focused) and becomes an overlay drawer below the `lg` breakpoint. Mode
 * rendering is unchanged: each mode keeps its own component.
 */

import { useEffect, useState } from 'react';
import {
  Command,
  Moon,
  PanelLeft,
  RefreshCw,
  Settings,
  Sun,
} from 'lucide-react';
import { Badge, Button, Segmented } from '@/components/ui';
import { ModelPicker } from '@/components/ModelPicker';
import { ResizeHandle } from '@/components/ResizeHandle';
import { Sidebar } from '@/components/Sidebar';
import { AgentMode } from '@/modes/AgentMode';
import { AudioMode } from '@/modes/AudioMode';
import { ChatMode } from '@/modes/ChatMode';
import { EmbeddingsMode } from '@/modes/EmbeddingsMode';
import { ImageMode } from '@/modes/ImageMode';
import { MODE_ICONS } from '@/lib/icons';
import { useMediaQuery } from '@/lib/hooks';
import { cn, formatTokens } from '@/lib/utils';
import { SIDEBAR_WIDTH_MAX, SIDEBAR_WIDTH_MIN, useActiveProvider, useStore } from '@/store';
import { MODE_LABELS, MODES } from '@/types';

export function AppShell({ onOpenSettings }: { onOpenSettings: () => void }) {
  const mode = useStore((state) => state.mode);
  const setMode = useStore((state) => state.setMode);

  const providers = useStore((state) => state.providers);
  const activeProvider = useActiveProvider();
  const setActiveProvider = useStore((state) => state.setActiveProvider);
  const modelsLoading = useStore((state) => state.modelsLoading);
  const refreshModels = useStore((state) => state.refreshModels);

  const theme = useStore((state) => state.theme);
  const toggleTheme = useStore((state) => state.toggleTheme);

  const sidebarCollapsed = useStore((state) => state.sidebarCollapsed);
  const sidebarWidth = useStore((state) => state.sidebarWidth);
  const setSidebarWidth = useStore((state) => state.setSidebarWidth);
  const toggleSidebar = useStore((state) => state.toggleSidebar);

  const paletteOpen = useStore((state) => state.paletteOpen);
  const togglePalette = useStore((state) => state.togglePalette);

  const usage = useStore((state) => state.usage);
  const harnessStatus = useStore((state) => state.harnessStatus);
  const harnessEnabled = useStore((state) => state.harnessEnabled);

  const isDesktop = useMediaQuery('(min-width: 1024px)');
  const [drawer, setDrawer] = useState<'sidebar' | null>(null);

  // Panels are static on desktop; a drawer must never survive a resize.
  useEffect(() => {
    if (isDesktop) setDrawer(null);
  }, [isDesktop]);

  const openSidebar = () => {
    if (isDesktop) toggleSidebar();
    else setDrawer((current) => (current === 'sidebar' ? null : 'sidebar'));
  };

  const harnessConnected = harnessEnabled && harnessStatus === 'connected';

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-background text-foreground">
      {/* ── Header ─────────────────────────────────────────────────────── */}
      <header className="z-30 shrink-0 border-b border-border bg-background/85 backdrop-blur">
        <div className="flex flex-wrap items-center gap-2 px-3 py-2">
          <Button
            size="icon"
            variant="ghost"
            className="h-8 w-8 shrink-0"
            onClick={openSidebar}
            aria-label={sidebarCollapsed ? 'Mostrar barra lateral' : 'Ocultar barra lateral'}
            title="Barra lateral (⌘/Ctrl + B)"
            aria-expanded={isDesktop ? !sidebarCollapsed : drawer === 'sidebar'}
          >
            <PanelLeft className="h-4 w-4" />
          </Button>

          <div className="flex shrink-0 items-center gap-2.5">
            <img src="./kli.svg" alt="" width={32} height={32} className="h-8 w-8 rounded-lg" />
            <div className="leading-none">
              <h1 className="text-base font-bold tracking-tight">KLI Studio</h1>
              <p className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
                agentic coding harness
              </p>
            </div>
          </div>

          <Segmented
            className="order-3 w-full sm:order-none sm:w-auto"
            options={MODES.map((value) => {
              const Icon = MODE_ICONS[value];
              return {
                value,
                label: (
                  <>
                    <Icon className="h-3.5 w-3.5" />
                    <span className="hidden md:inline">{MODE_LABELS[value]}</span>
                  </>
                ),
              };
            })}
            value={mode}
            onValueChange={setMode}
          />

          <div className="ml-auto flex flex-1 items-center justify-end gap-2 sm:flex-none">
            <div className="hidden w-40 md:block">
              <select
                aria-label="Proveedor"
                value={activeProvider.id}
                onChange={(event) => event.target.value && setActiveProvider(event.target.value)}
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
              aria-label="Actualizar catálogo de modelos"
              onClick={() => void refreshModels(true)}
              disabled={modelsLoading}
            >
              <RefreshCw className={modelsLoading ? 'animate-spin' : undefined} />
            </Button>
            <Button
              size="icon"
              variant="ghost"
              title={theme === 'dark' ? 'Tema claro' : 'Tema oscuro'}
              aria-label={theme === 'dark' ? 'Cambiar a tema claro' : 'Cambiar a tema oscuro'}
              onClick={toggleTheme}
            >
              {theme === 'dark' ? <Sun /> : <Moon />}
            </Button>
            <Button
              size="icon"
              variant="ghost"
              title="Configurar proveedores"
              aria-label="Configurar proveedores"
              onClick={onOpenSettings}
            >
              <Settings />
            </Button>
            <Button
              size="icon"
              variant="ghost"
              className="hidden sm:inline-flex"
              title="Paleta de comandos (⌘/Ctrl + K)"
              aria-label="Abrir paleta de comandos"
              aria-haspopup="dialog"
              aria-expanded={paletteOpen}
              onClick={togglePalette}
            >
              <Command />
            </Button>
          </div>
        </div>

        {/* Small screens keep the provider switcher reachable — it is the only
            way to change provider without the sidebar. */}
        <div className="flex items-center gap-3 border-t border-border/60 px-3 py-1.5 text-[11px] text-muted-foreground sm:hidden">
          <select
            aria-label="Proveedor"
            value={activeProvider.id}
            onChange={(event) => event.target.value && setActiveProvider(event.target.value)}
            className="h-7 flex-1 rounded border border-border bg-background px-2 text-xs"
          >
            {providers.map((provider) => (
              <option key={provider.id} value={provider.id}>
                {provider.label}
              </option>
            ))}
          </select>
          <Badge variant={harnessConnected ? 'success' : harnessStatus === 'error' ? 'destructive' : 'outline'}>
            {harnessConnected ? 'harness' : 'sin harness'}
          </Badge>
        </div>
      </header>

      {/* ── Body ───────────────────────────────────────────────────────── */}
      <div className="flex min-h-0 flex-1">
        {!sidebarCollapsed ? (
          <aside
            style={{ width: sidebarWidth }}
            className="hidden shrink-0 border-r border-border bg-card/30 lg:block"
            aria-label="Barra lateral"
          >
            <Sidebar onOpenSettings={onOpenSettings} />
          </aside>
        ) : null}

        {!sidebarCollapsed ? (
          <ResizeHandle
            label="Redimensionar barra lateral"
            value={sidebarWidth}
            min={SIDEBAR_WIDTH_MIN}
            max={SIDEBAR_WIDTH_MAX}
            onDelta={(delta) => setSidebarWidth(useStore.getState().sidebarWidth + delta)}
            onStep={(step) => setSidebarWidth(useStore.getState().sidebarWidth + step)}
          />
        ) : null}

        <main className={cn('flex min-w-0 flex-1 flex-col p-3')} aria-label="Área de trabajo">
          {mode === 'agent' ? <AgentMode /> : null}
          {mode === 'chat' ? <ChatMode /> : null}
          {mode === 'image' ? <ImageMode /> : null}
          {mode === 'embeddings' ? <EmbeddingsMode /> : null}
          {mode === 'audio' ? <AudioMode /> : null}
        </main>
      </div>

      {/* ── Footer ─────────────────────────────────────────────────────── */}
      <footer className="shrink-0 border-t border-border bg-background/85 px-3 py-1.5 backdrop-blur">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
          <span>
            Tokens: <span className="font-medium text-foreground">{formatTokens(usage.totalTokens)}</span>{' '}
            <span>
              ({formatTokens(usage.promptTokens)} entrada · {formatTokens(usage.completionTokens)} salida)
            </span>
          </span>
          <span className="hidden items-center gap-3 md:flex">
            <span>⌘K paleta</span>
            <span>⌘B lateral</span>
            <span>⌘← → modo</span>
            <span className="text-muted-foreground">KLI Studio</span>
          </span>
        </div>
      </footer>

      {/* ── Drawers (below `lg`) ───────────────────────────────────────── */}
      {!isDesktop && drawer === 'sidebar' ? (
        <div className="fixed inset-0 z-40">
          <button
            type="button"
            aria-label="Cerrar barra lateral"
            className="absolute inset-0 cursor-default bg-black/50 backdrop-blur-sm"
            onClick={() => setDrawer(null)}
          />
          <aside
            className="absolute inset-y-0 left-0 w-[min(88vw,300px)] border-r border-border bg-background shadow-2xl animate-fade-in"
            aria-label="Barra lateral"
          >
            <Sidebar onOpenSettings={onOpenSettings} />
          </aside>
        </div>
      ) : null}
    </div>
  );
}
