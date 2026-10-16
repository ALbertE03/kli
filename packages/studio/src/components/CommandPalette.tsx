/**
 * KLI — Command palette (⌘/Ctrl + K)
 *
 * A single entry point for every action the shell can perform. Every command
 * maps to real store state or an existing feature — no placeholders. It keeps
 * the app keyboard-first: open with ⌘K, filter, ↑/↓ to move, Enter to run.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Eraser,
  Moon,
  PanelLeft,
  Plug,
  Power,
  RefreshCw,
  Search,
  Settings,
  Sun,
  type LucideIcon,
} from 'lucide-react';
import { MODE_ICONS } from '@/lib/icons';
import { cn } from '@/lib/utils';
import { useStore } from '@/store';
import { MODE_LABELS, MODES } from '@/types';

interface Command {
  id: string;
  group: string;
  label: string;
  icon?: LucideIcon;
  run: () => void;
}

/** Removes diacritics and case so "modelo" matches "Modeló". */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

export function CommandPalette({ onOpenSettings }: { onOpenSettings: () => void }) {
  const open = useStore((state) => state.paletteOpen);
  const setOpen = useStore((state) => state.setPaletteOpen);

  const mode = useStore((state) => state.mode);
  const setMode = useStore((state) => state.setMode);
  const providers = useStore((state) => state.providers);
  const activeProviderId = useStore((state) => state.activeProviderId);
  const setActiveProvider = useStore((state) => state.setActiveProvider);
  const theme = useStore((state) => state.theme);
  const toggleTheme = useStore((state) => state.toggleTheme);
  const refreshModels = useStore((state) => state.refreshModels);
  const messages = useStore((state) => state.messages);
  const clearMessages = useStore((state) => state.clearMessages);
  const harnessEnabled = useStore((state) => state.harnessEnabled);
  const harnessStatus = useStore((state) => state.harnessStatus);
  const connectHarness = useStore((state) => state.connectHarness);
  const disconnectHarness = useStore((state) => state.disconnectHarness);
  const sidebarCollapsed = useStore((state) => state.sidebarCollapsed);
  const toggleSidebar = useStore((state) => state.toggleSidebar);

  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const connected = harnessEnabled && harnessStatus === 'connected';

  const commands = useMemo<Command[]>(() => {
    const list: Command[] = MODES.map((value) => ({
      id: `mode:${value}`,
      group: 'Modo',
      label: `Ir a ${MODE_LABELS[value]}`,
      icon: MODE_ICONS[value],
      run: () => setMode(value),
    }));

    for (const provider of providers) {
      list.push({
        id: `provider:${provider.id}`,
        group: 'Proveedor',
        label: `Usar proveedor ${provider.label}`,
        icon: Plug,
        run: () => setActiveProvider(provider.id),
      });
    }

    list.push(
      connected
        ? {
            id: 'harness:disconnect',
            group: 'Harness',
            label: 'Desconectar del harness',
            icon: Power,
            run: () => disconnectHarness(),
          }
        : {
            id: 'harness:connect',
            group: 'Harness',
            label: 'Conectar al harness (servidor KLI)',
            icon: Plug,
            run: () => void connectHarness(),
          },
    );

    if (messages.length > 0) {
      list.push({
        id: 'chat:clear',
        group: 'Conversación',
        label: `Limpiar conversación (${messages.length} mensajes)`,
        icon: Eraser,
        run: () => clearMessages(),
      });
    }

    list.push(
      {
        id: 'view:sidebar',
        group: 'Vista',
        label: sidebarCollapsed ? 'Mostrar barra lateral' : 'Ocultar barra lateral',
        icon: PanelLeft,
        run: () => toggleSidebar(),
      },
      {
        id: 'view:theme',
        group: 'Vista',
        label: theme === 'dark' ? 'Cambiar a tema claro' : 'Cambiar a tema oscuro',
        icon: theme === 'dark' ? Sun : Moon,
        run: () => toggleTheme(),
      },
      {
        id: 'data:models',
        group: 'Datos',
        label: 'Actualizar catálogo de modelos',
        icon: RefreshCw,
        run: () => void refreshModels(true),
      },
      {
        id: 'settings:providers',
        group: 'Ajustes',
        label: 'Configurar proveedores',
        icon: Settings,
        run: () => onOpenSettings(),
      },
    );

    return list;
  }, [
    providers,
    connected,
    messages.length,
    theme,
    sidebarCollapsed,
    setMode,
    setActiveProvider,
    disconnectHarness,
    connectHarness,
    clearMessages,
    toggleSidebar,
    toggleTheme,
    refreshModels,
    onOpenSettings,
  ]);

  const filtered = useMemo(() => {
    const needle = normalize(query.trim());
    if (needle.length === 0) return commands;
    return commands.filter((command) => normalize(`${command.group} ${command.label}`).includes(needle));
  }, [commands, query]);

  // Reset the cursor whenever the result set changes.
  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  useEffect(() => {
    if (open) {
      setQuery('');
      inputRef.current?.focus();
    }
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setOpen(false);
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, setOpen]);

  if (!open) return null;

  const close = () => setOpen(false);
  const runCommand = (command: Command | undefined) => {
    if (!command) return;
    close();
    command.run();
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex((index) => Math.min(index + 1, filtered.length - 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((index) => Math.max(index - 1, 0));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      runCommand(filtered[activeIndex]);
    }
  };

  let lastGroup = '';

  return (
    <div className="fixed inset-0 z-[60] flex items-start justify-center bg-black/50 p-4 pt-[12vh] backdrop-blur-sm">
      <button type="button" aria-label="Cerrar la paleta de comandos" className="absolute inset-0 cursor-default" onClick={close} />

      <div
        role="dialog"
        aria-modal="true"
        aria-label="Paleta de comandos de KLI Studio"
        className="relative flex max-h-[70vh] w-full max-w-xl flex-col overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-2xl animate-fade-in"
      >
        <div className="flex items-center gap-2 border-b border-border px-3">
          <Search className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Buscar acciones…  (Esc para cerrar)"
            aria-label="Buscar acciones"
            className="h-11 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
          <kbd className="hidden rounded border border-border px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground sm:block">
            KLI Studio
          </kbd>
        </div>

        <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto py-1">
          {filtered.length === 0 ? (
            <p className="px-4 py-6 text-center text-xs text-muted-foreground">
              Ninguna acción coincide con «{query}».
            </p>
          ) : (
            filtered.map((command, index) => {
              const showGroup = command.group !== lastGroup;
              lastGroup = command.group;
              const Icon = command.icon;
              const active = index === activeIndex;
              return (
                <div key={command.id}>
                  {showGroup ? (
                    <p className="px-4 pb-1 pt-3 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                      {command.group}
                    </p>
                  ) : null}
                  <button
                    type="button"
                    onMouseEnter={() => setActiveIndex(index)}
                    onClick={() => runCommand(command)}
                    aria-current={active}
                    className={cn(
                      'flex w-full items-center gap-2.5 px-4 py-2 text-left text-sm',
                      active ? 'bg-accent text-accent-foreground' : 'text-foreground',
                    )}
                  >
                    {Icon ? <Icon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" /> : null}
                    <span className="truncate">{command.label}</span>
                    {command.id === `mode:${mode}` || command.id === `provider:${activeProviderId}` ? (
                      <span className="ml-auto text-[10px] text-muted-foreground">actual</span>
                    ) : null}
                  </button>
                </div>
              );
            })
          )}
        </div>

        <div className="border-t border-border px-3 py-1.5 text-[10px] text-muted-foreground">
          ↑↓ navegar · Enter ejecutar · Esc cerrar
        </div>
      </div>
    </div>
  );
}
