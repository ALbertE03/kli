/**
 * Subagent editor — create, edit and delete the agents the main model delegates
 * to through the `task` tool.
 *
 * Agents are configuration: the definition is written to `.kli/agents.json` by
 * the harness server and overrides the built-ins that ship with the kernel.
 */

import { useEffect, useState } from 'react';
import { Trash2 } from 'lucide-react';
import { Alert, Button, Dialog, Input, Textarea } from '@/components/ui';
import { useStore } from '@/store';
import type { AgentSummary } from '@/types';

const MODES: Array<AgentSummary['mode']> = ['plan', 'build', 'ask'];

const BLANK: AgentSummary = {
  id: '',
  name: '',
  description: '',
  mode: 'build',
  model: null,
  tools: null,
  instructions: '',
  hidden: false,
  builtin: false,
};

export function AgentEditor({
  agent,
  onClose,
  onSaved,
}: {
  agent: AgentSummary | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const saveAgent = useStore((state) => state.saveAgent);
  const removeAgent = useStore((state) => state.removeAgent);
  const models = useStore((state) => state.models);
  const harnessInfo = useStore((state) => state.harnessInfo);
  const toolsByMode = harnessInfo?.toolsByMode ?? {};

  const [draft, setDraft] = useState<AgentSummary>(agent ?? BLANK);
  const [toolsText, setToolsText] = useState((agent?.tools ?? []).join(', '));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDraft(agent ?? BLANK);
    setToolsText((agent?.tools ?? []).join(', '));
    setError(null);
  }, [agent]);

  const isNew = agent === null;
  const availableTools = toolsByMode[draft.mode] ?? [];

  const update = (patch: Partial<AgentSummary>) => setDraft((current) => ({ ...current, ...patch }));

  const submit = async () => {
    setError(null);
    const id = draft.id.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
    if (!id) {
      setError('El id es obligatorio y solo admite letras minúsculas, números y guiones.');
      return;
    }
    if (!draft.name.trim()) {
      setError('El nombre es obligatorio.');
      return;
    }
    if (!draft.description.trim()) {
      setError('La descripción es obligatoria: el modelo la usa para decidir cuándo delegarle.');
      return;
    }

    setBusy(true);
    try {
      await saveAgent({
        ...draft,
        id,
        name: draft.name.trim(),
        description: draft.description.trim(),
        tools: toolsText.trim()
          ? toolsText.split(',').map((tool) => tool.trim()).filter(Boolean)
          : null,
      });
      onSaved();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'No se pudo guardar el subagente');
    } finally {
      setBusy(false);
    }
  };

  const destroy = async () => {
    if (!agent) return;
    setBusy(true);
    try {
      await removeAgent(agent.id);
      onSaved();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'No se pudo eliminar el subagente');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={isNew ? 'Nuevo subagente' : `Subagente · ${agent?.name}`}
      description="Un subagente es un rol reutilizable: modo, modelo, herramientas permitidas e instrucciones propias."
      footer={
        <>
          {!isNew && agent?.builtin !== true ? (
            <Button variant="destructive" onClick={() => void destroy()} disabled={busy}>
              <Trash2 className="h-4 w-4" />
              Eliminar
            </Button>
          ) : null}
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancelar
          </Button>
          <Button onClick={() => void submit()} disabled={busy}>
            Guardar
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {error ? <Alert variant="destructive" className="text-xs">{error}</Alert> : null}
        {!isNew && agent?.builtin === true ? (
          <Alert variant="info" className="text-xs">
            Es un subagente incorporado: guardar crea una sobrescritura en <code>.kli/agents.json</code>.
          </Alert>
        ) : null}

        <div className="grid grid-cols-2 gap-3">
          <Field label="Id (slug)">
            <Input
              value={draft.id}
              onChange={(event) => update({ id: event.target.value })}
              placeholder="security-auditor"
              disabled={!isNew}
            />
          </Field>
          <Field label="Nombre">
            <Input
              value={draft.name}
              onChange={(event) => update({ name: event.target.value })}
              placeholder="Auditor de seguridad"
            />
          </Field>
        </div>

        <Field label="Descripción (el modelo la lee para decidir)">
          <Textarea
            rows={2}
            value={draft.description}
            onChange={(event) => update({ description: event.target.value })}
            placeholder="Revisa inyecciones SQL, rutas sin sanear y secretos filtrados."
          />
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Modo">
            <div className="flex gap-1">
              {MODES.map((mode) => (
                <Button
                  key={mode}
                  size="sm"
                  variant={draft.mode === mode ? 'default' : 'outline'}
                  onClick={() => update({ mode })}
                >
                  {mode}
                </Button>
              ))}
            </div>
          </Field>
          <Field label="Modelo (opcional)">
            <Input
              list="agent-models"
              value={draft.model ?? ''}
              onChange={(event) => update({ model: event.target.value.trim() || null })}
              placeholder="hereda el modelo del padre"
            />
            <datalist id="agent-models">
              {models.slice(0, 200).map((model) => (
                <option key={model.id} value={model.id} />
              ))}
            </datalist>
          </Field>
        </div>

        <Field label={`Herramientas permitidas (vacío = todas las del modo ${draft.mode})`}>
          <Input
            value={toolsText}
            onChange={(event) => setToolsText(event.target.value)}
            placeholder={availableTools.slice(0, 4).join(', ')}
          />
          {availableTools.length > 0 ? (
            <div className="mt-1 flex flex-wrap gap-1">
              {availableTools.map((tool) => (
                <button
                  key={tool}
                  type="button"
                  onClick={() =>
                    setToolsText((current) => {
                      const list = current.split(',').map((item) => item.trim()).filter(Boolean);
                      return list.includes(tool)
                        ? list.filter((item) => item !== tool).join(', ')
                        : [...list, tool].join(', ');
                    })
                  }
                  className="rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground hover:border-primary/60"
                >
                  {tool}
                </button>
              ))}
            </div>
          ) : null}
        </Field>

        <Field label="Instrucciones (se añaden al system prompt del subagente)">
          <Textarea
            rows={4}
            value={draft.instructions ?? ''}
            onChange={(event) => update({ instructions: event.target.value })}
            placeholder="Empieza leyendo el diff. Cita file:line en cada hallazgo. Ordena por severidad."
          />
        </Field>

        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <input
            type="checkbox"
            checked={draft.hidden ?? false}
            onChange={(event) => update({ hidden: event.target.checked })}
          />
          Oculto (el modelo no puede elegirlo; útil para agentes internos)
        </label>
      </div>
    </Dialog>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}
