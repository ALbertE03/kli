/**
 * KLI — Command history (right panel · Terminal tab)
 *
 * `@kli/server` does not expose an interactive terminal, so this panel does
 * not fake one. It lists the real `execute_bash` invocations the agent made
 * during the conversation (the command and its outcome), which is what the
 * stream actually carries.
 */

import { useMemo } from 'react';
import { Terminal } from 'lucide-react';
import { EmptyState } from '@/components/ui';
import { cn } from '@/lib/utils';
import { useStore } from '@/store';

interface CommandEntry {
  id: string;
  command: string;
  status: 'running' | 'ok' | 'error';
  ms?: number;
  error?: string;
}

export function CommandHistory() {
  const messages = useStore((state) => state.messages);

  const commands = useMemo(() => {
    const out: CommandEntry[] = [];
    for (const message of messages) {
      for (const block of message.blocks ?? []) {
        if (block.kind !== 'tool' || block.name !== 'execute_bash') continue;
        const command = block.args['command'];
        out.push({
          id: `${message.id}-${block.id}`,
          command: typeof command === 'string' ? command : JSON.stringify(block.args),
          status: block.status,
          ...(block.ms === undefined ? {} : { ms: block.ms }),
          ...(block.error === undefined ? {} : { error: block.error }),
        });
      }
    }
    return out;
  }, [messages]);

  if (commands.length === 0) {
    return (
      <EmptyState
        icon={<Terminal className="h-8 w-8" />}
        title="Sin comandos en esta conversación"
        hint="El agente ejecuta comandos con la herramienta `execute_bash`; aparecerán aquí con su resultado. El servidor aún no expone un terminal interactivo."
      />
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto font-mono text-[11px]">
      {commands.map((entry) => (
        <div key={entry.id} className="border-b border-border/50 px-1 py-2 last:border-0">
          <div className="flex items-start gap-2">
            <span className="shrink-0 select-none text-success">$</span>
            <span className="min-w-0 flex-1 whitespace-pre-wrap break-all text-foreground">{entry.command}</span>
          </div>
          <div className="mt-0.5 flex items-center gap-2 pl-4 text-[10px]">
            <span
              className={cn(
                entry.status === 'ok' && 'text-success',
                entry.status === 'error' && 'text-destructive',
                entry.status === 'running' && 'text-warning',
              )}
            >
              {entry.status === 'ok' ? 'ok' : entry.status === 'error' ? 'error' : 'ejecutando…'}
            </span>
            {entry.ms !== undefined ? <span className="text-muted-foreground">{entry.ms}ms</span> : null}
            {entry.error ? <span className="break-all text-destructive">{entry.error}</span> : null}
          </div>
        </div>
      ))}
    </div>
  );
}
