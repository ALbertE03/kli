import * as React from 'react';
import { Check, ChevronDown, Loader2, RefreshCw, Search } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { modelsForMode } from '@/lib/models';
import { useClickOutside, useDebounced } from '@/lib/hooks';
import { cn, truncate } from '@/lib/utils';
import { useStore } from '@/store';
import type { Mode, ModelInfo } from '@/types';

interface ModelPickerProps {
  mode: Mode;
  className?: string;
}

/**
 * Searchable model selector. The FreeLLMAPI catalogue has ~200 entries, so a
 * plain <select> is unusable — this filters by id/name on top of the mode.
 */
export function ModelPicker({ mode, className }: ModelPickerProps) {
  const models = useStore((state) => state.models);
  const modelsLoading = useStore((state) => state.modelsLoading);
  const modelsError = useStore((state) => state.modelsError);
  const selectedId = useStore((state) => state.selectedModels[mode]);
  const setSelectedModel = useStore((state) => state.setSelectedModel);
  const refreshModels = useStore((state) => state.refreshModels);

  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState('');
  const containerRef = React.useRef<HTMLDivElement>(null);
  const debouncedQuery = useDebounced(query, 120);

  useClickOutside(containerRef, () => setOpen(false), open);

  const candidates = React.useMemo(() => modelsForMode(models, mode), [models, mode]);
  const filtered = React.useMemo(() => {
    const needle = debouncedQuery.trim().toLowerCase();
    if (!needle) return candidates;
    return candidates.filter(
      (model) => model.id.toLowerCase().includes(needle) || model.name.toLowerCase().includes(needle),
    );
  }, [candidates, debouncedQuery]);

  const selected = candidates.find((model) => model.id === selectedId);

  const pick = (model: ModelInfo) => {
    setSelectedModel(mode, model.id);
    setOpen(false);
    setQuery('');
  };

  return (
    <div ref={containerRef} className={cn('relative', className)}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className={cn(
          'flex h-8 w-full items-center justify-between gap-2 rounded-md border border-border bg-background px-2.5 text-sm transition-colors',
          'hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        )}
      >
        <span className="flex min-w-0 items-center gap-2">
          <span className={cn('truncate', selected ? 'text-foreground' : 'text-muted-foreground')}>
            {selected ? truncate(selected.name, 42) : 'Selecciona un modelo'}
          </span>
          {selected && !selected.available ? (
            <Badge variant="warning" className="shrink-0">
              no disponible
            </Badge>
          ) : null}
        </span>
        {modelsLoading ? (
          <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
        ) : (
          <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
        )}
      </button>

      {open ? (
        <div className="absolute left-0 right-0 z-40 mt-1 overflow-hidden rounded-lg border border-border bg-popover shadow-xl animate-fade-in">
          <div className="flex items-center gap-2 border-b border-border px-2 py-1.5">
            <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <input
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Filtrar modelos…"
              className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            />
            <button
              type="button"
              onClick={() => void refreshModels(true)}
              title="Recargar catálogo"
              className="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <RefreshCw className={cn('h-3.5 w-3.5', modelsLoading && 'animate-spin')} />
            </button>
          </div>

          <div className="scrollbar-thin max-h-72 overflow-y-auto">
            {filtered.length === 0 ? (
              <p className="px-3 py-6 text-center text-xs text-muted-foreground">
                {modelsError
                  ? modelsError
                  : candidates.length === 0
                    ? `Este proveedor no expone modelos de tipo «${mode}».`
                    : 'Sin resultados.'}
              </p>
            ) : (
              filtered.map((model) => (
                <button
                  key={model.id}
                  type="button"
                  onClick={() => pick(model)}
                  className={cn(
                    'flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-sm transition-colors hover:bg-accent',
                    model.id === selectedId && 'bg-accent/60',
                  )}
                >
                  <span className="min-w-0">
                    <span className="block truncate text-foreground">{model.name}</span>
                    <span className="block truncate text-[11px] text-muted-foreground">
                      {model.id}
                      {model.contextWindow ? ` · ${Math.round(model.contextWindow / 1000)}k ctx` : ''}
                    </span>
                  </span>
                  <span className="flex shrink-0 items-center gap-1">
                    {!model.available ? <Badge variant="warning">off</Badge> : null}
                    {model.id === selectedId ? <Check className="h-3.5 w-3.5 text-primary" /> : null}
                  </span>
                </button>
              ))
            )}
          </div>

          <div className="border-t border-border px-3 py-1.5 text-[11px] text-muted-foreground">
            {candidates.length} modelo{candidates.length === 1 ? '' : 's'} disponible
            {candidates.length === 1 ? '' : 's'}
          </div>
        </div>
      ) : null}
    </div>
  );
}