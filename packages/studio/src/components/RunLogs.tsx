/**
 * KLI — Run logs (right panel · Logs tab)
 *
 * Flattens the conversation's real timeline (tool calls, subagent runs and
 * errors streamed by `kli serve`) into a chronological log. It reads the same
 * store the chat renders, so it never shows anything the harness did not emit.
 */

import { useEffect, useMemo, useRef } from 'react';
import { ScrollText } from 'lucide-react';
import { EmptyState } from '@/components/ui';
import { cn } from '@/lib/utils';
import { useStore } from '@/store';
import type { StoredMessage, TimelineBlock } from '@/types';

type LogKind = 'tool' | 'subagent' | 'error';

interface LogEntry {
  id: string;
  time: number;
  kind: LogKind;
  label: string;
  detail: string;
  status: TimelineBlock['status'] | 'error';
}

function summarizeArgs(args: Record<string, unknown>): string {
  const entries = Object.entries(args);
  if (entries.length === 0) return '';
  return entries
    .map(([key, value]) => {
      const text = typeof value === 'string' ? value : JSON.stringify(value);
      return `${key}=${text.length > 80 ? `${text.slice(0, 80)}…` : text}`;
    })
    .join(' ');
}

function entriesFor(message: StoredMessage): LogEntry[] {
  const out: LogEntry[] = [];

  for (const block of message.blocks ?? []) {
    if (block.kind === 'tool') {
      out.push({
        id: `${message.id}-${block.id}`,
        time: message.timestamp,
        kind: 'tool',
        label: block.name,
        detail: block.error ?? summarizeArgs(block.args),
        status: block.status,
      });
    } else {
      out.push({
        id: `${message.id}-${block.id}`,
        time: message.timestamp,
        kind: 'subagent',
        label: `subagente · ${block.agent}`,
        detail: block.error ?? block.task,
        status: block.status,
      });
      for (const [index, tool] of block.tools.entries()) {
        out.push({
          id: `${message.id}-${block.id}-${index}`,
          time: message.timestamp,
          kind: 'tool',
          label: `${block.agent} → ${tool.name}`,
          detail: tool.ms ? `${tool.ms}ms` : '',
          status: tool.ok === false ? 'error' : 'ok',
        });
      }
    }
  }

  if (message.error) {
    out.push({
      id: `${message.id}-error`,
      time: message.timestamp,
      kind: 'error',
      label: 'error',
      detail: message.error,
      status: 'error',
    });
  }

  return out;
}

const STATUS_TONE: Record<LogEntry['status'], string> = {
  running: 'text-warning',
  ok: 'text-success',
  error: 'text-destructive',
};

const STATUS_LABEL: Record<LogEntry['status'], string> = {
  running: 'en curso',
  ok: 'ok',
  error: 'error',
};

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString();
}

export function RunLogs() {
  const messages = useStore((state) => state.messages);
  const bottomRef = useRef<HTMLDivElement>(null);

  const entries = useMemo(() => messages.flatMap(entriesFor), [messages]);
  const lastEntryId = entries[entries.length - 1]?.id;

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [lastEntryId]);

  if (entries.length === 0) {
    return (
      <EmptyState
        icon={<ScrollText className="h-8 w-8" />}
        title="Sin actividad todavía"
        hint="Ejecuta una tarea en el modo Agente: cada herramienta, subagente y error aparecerá aquí en orden."
      />
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto font-mono text-[11px]">
      {entries.map((entry) => (
        <div key={entry.id} className="flex items-start gap-2 border-b border-border/50 px-1 py-1.5 last:border-0">
          <span className="shrink-0 text-muted-foreground/70">{formatTime(entry.time)}</span>
          <span className="w-16 shrink-0 text-muted-foreground">{entry.kind}</span>
          <span className="min-w-0 flex-1">
            <span className="text-foreground">{entry.label}</span>
            {entry.detail ? <span className="ml-2 break-all text-muted-foreground">{entry.detail}</span> : null}
          </span>
          <span className={cn('shrink-0', STATUS_TONE[entry.status])}>{STATUS_LABEL[entry.status]}</span>
        </div>
      ))}
      <div ref={bottomRef} />
    </div>
  );
}
