import { Info } from 'lucide-react';
import { ModelPicker } from '@/components/ModelPicker';
import { Input } from '@/components/ui';
import { modelsForMode } from '@/lib/models';
import { cn } from '@/lib/utils';
import { useStore } from '@/store';
import type { Mode } from '@/types';

interface ModelFieldProps {
  mode: Mode;
  className?: string;
  label?: string;
}

/**
 * Model control for a mode. Falls back to a free-text field when the active
 * provider does not advertise models of that modality (FreeLLMAPI only lists
 * chat models, for instance) — so image/embedding/audio ids stay reachable.
 */
export function ModelField({ mode, className, label }: ModelFieldProps) {
  const candidates = useStore((state) => modelsForMode(state.models, mode));
  const selectedId = useStore((state) => state.selectedModels[mode]);
  const setSelectedModel = useStore((state) => state.setSelectedModel);
  const loading = useStore((state) => state.modelsLoading);

  if (loading) {
    return <div className={cn('h-9 animate-pulse rounded-md bg-muted', className)} aria-hidden="true" />;
  }

  if (candidates.length === 0) {
    return (
      <div className={cn('space-y-1', className)}>
        {label ? <span className="text-xs text-muted-foreground">{label}</span> : null}
        <Input
          value={selectedId ?? ''}
          onChange={(event) => setSelectedModel(mode, event.target.value.trim() || null)}
          placeholder="id del modelo (p. ej. @cf/black-forest-labs/flux-1-schnell)"
        />
        <p className="flex items-start gap-1 text-[11px] text-muted-foreground">
          <Info className="mt-0.5 h-3 w-3 shrink-0" />
          Este proveedor no publica modelos de imagen: escribe el identificador a mano.
        </p>
      </div>
    );
  }

  return <ModelPicker mode={mode} className={className} />;
}