/**
 * KLI — Chat mode
 *
 * Streaming chat against the active provider. Works with both OpenAI-compatible
 * SSE (`choices[].delta.content`) and Anthropic's event stream.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Copy, Eraser, Square, Terminal, User } from 'lucide-react';
import { Alert, Button, EmptyState, Textarea } from '@/components/ui';
import { ApiError, streamChat } from '@/lib/api';
import { cn, createId, formatRelativeTime } from '@/lib/utils';
import { useActiveProvider, useStore } from '@/store';
import { resolveApiKey, useSecrets } from '@/store/secrets';
import type { ChatMessage, StoredMessage } from '@/types';

export function ChatMode() {
  const messages = useStore((state) => state.messages);
  const addMessage = useStore((state) => state.addMessage);
  const appendToMessage = useStore((state) => state.appendToMessage);
  const finalizeMessage = useStore((state) => state.finalizeMessage);
  const clearMessages = useStore((state) => state.clearMessages);
  const messageInput = useStore((state) => state.messageInput);
  const setMessageInput = useStore((state) => state.setMessageInput);
  const isStreaming = useStore((state) => state.isStreaming);
  const setStreaming = useStore((state) => state.setStreaming);
  const beginRequest = useStore((state) => state.beginRequest);
  const cancelRequest = useStore((state) => state.cancelRequest);
  const addUsage = useStore((state) => state.addUsage);
  const connectionStatus = useStore((state) => state.connectionStatus);
  const modelsError = useStore((state) => state.modelsError);
  const selectedModelId = useStore((state) => state.selectedModels.chat);

  const provider = useActiveProvider();
  const keys = useSecrets((state) => state.keys);
  const apiKey = resolveApiKey(provider.id, keys);

  const [copiedId, setCopiedId] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Follow the stream.
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages]);

  const send = useCallback(async () => {
    const prompt = messageInput.trim();
    const model = selectedModelId;
    if (!prompt || isStreaming || !model || connectionStatus !== 'connected') return;

    const userMessage: StoredMessage = {
      id: createId('user'),
      role: 'user',
      content: prompt,
      timestamp: Date.now(),
    };
    const assistantId = createId('assistant');
    const history: ChatMessage[] = [...messages, userMessage].map(({ role, content }) => ({ role, content }));

    setMessageInput('');
    addMessage(userMessage);
    addMessage({
      id: assistantId,
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      model,
      provider: provider.id,
      streaming: true,
    });
    setStreaming(true);

    const signal = beginRequest();
    const startedAt = performance.now();

    try {
      await streamChat({
        provider,
        apiKey,
        model,
        messages: history,
        signal,
        onDelta: (delta) => appendToMessage(assistantId, delta),
        onUsage: (usage) => addUsage(usage),
      });
      finalizeMessage(assistantId, {
        error: undefined,
        model,
        provider: provider.id,
      });
      setStreaming(false);
      void startedAt;
    } catch (error) {
      const aborted = signal.aborted || (error instanceof ApiError && error.code === 'aborted');
      if (aborted) {
        finalizeMessage(assistantId, {});
      } else {
        finalizeMessage(assistantId, {
          error: error instanceof Error ? error.message : 'Error desconocido',
        });
      }
      setStreaming(false);
    }
  }, [
    messageInput,
    isStreaming,
    selectedModelId,
    connectionStatus,
    messages,
    provider,
    apiKey,
    addMessage,
    appendToMessage,
    finalizeMessage,
    setMessageInput,
    setStreaming,
    beginRequest,
    addUsage,
  ]);

  const copy = useCallback(async (message: StoredMessage) => {
    try {
      await navigator.clipboard.writeText(message.content);
      setCopiedId(message.id);
      window.setTimeout(() => setCopiedId(null), 1500);
    } catch {
      /* clipboard blocked — ignore */
    }
  }, []);

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void send();
    }
  };

  const disconnected = connectionStatus !== 'connected';
  const disabled = !selectedModelId || isStreaming || disconnected;

  return (
    <div className="flex min-h-0 flex-1 flex-col rounded-lg border border-border bg-card">
      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
        <p className="truncate text-xs text-muted-foreground">
          {selectedModelId ?? 'Sin modelo seleccionado'} · {provider.label}
        </p>
        <Button size="sm" variant="ghost" onClick={clearMessages} disabled={messages.length === 0}>
          <Eraser className="h-3.5 w-3.5" />
          Limpiar
        </Button>
      </div>

      <div className="flex-1 space-y-3 overflow-y-auto p-4">
        {messages.length === 0 ? (
          <EmptyState
            icon={<Terminal className="h-8 w-8" />}
            title="Empieza una conversación"
            hint="El proveedor por defecto es FreeLLMAPI. Cambia de proveedor o de modelo desde la barra superior."
          />
        ) : null}

        {messages.map((message) => (
          <Bubble
            key={message.id}
            message={message}
            copied={copiedId === message.id}
            onCopy={() => void copy(message)}
          />
        ))}
        <div ref={bottomRef} />
      </div>

      <div className="space-y-2 border-t border-border p-3">
        {connectionStatus !== 'connected' && modelsError ? (
          <Alert variant="warning" className="text-xs">
            {modelsError}
          </Alert>
        ) : null}

        <div className="flex items-end gap-2">
          <Textarea
            ref={textareaRef}
            rows={2}
            value={messageInput}
            onChange={(event) => setMessageInput(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder={
              !selectedModelId
                ? 'Selecciona un modelo para empezar'
                : disconnected
                  ? 'Sin conexión con el proveedor — revisa la configuración'
                  : 'Escribe tu mensaje…  (Enter envía, Shift+Enter salto de línea)'
            }
            disabled={!selectedModelId}
            className="max-h-48 min-h-[2.5rem] resize-none"
          />
          {isStreaming ? (
            <Button variant="destructive" onClick={cancelRequest}>
              <Square className="h-4 w-4" />
              Detener
            </Button>
          ) : (
            <Button onClick={() => void send()} disabled={disabled || !messageInput.trim()}>
              Enviar
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

function Bubble({
  message,
  copied,
  onCopy,
}: {
  message: StoredMessage;
  copied: boolean;
  onCopy: () => void;
}) {
  const isUser = message.role === 'user';
  return (
    <div className={cn('group flex gap-2', isUser ? 'justify-end' : 'justify-start')}>
      {!isUser ? (
        <span className="mt-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-border bg-secondary">
          <Terminal className="h-3 w-3" />
        </span>
      ) : null}
      <div
        className={cn(
          'max-w-[85%] rounded-xl px-3 py-2 text-sm',
          isUser ? 'bg-primary text-primary-foreground' : 'bg-muted/60 text-foreground',
        )}
      >
        {message.error ? (
          <Alert variant="destructive" className="text-xs">
            {message.error}
          </Alert>
        ) : (
          <p className="whitespace-pre-wrap break-words leading-relaxed">
            {message.content}
            {message.streaming ? <span className="ml-0.5 animate-pulse">▌</span> : null}
          </p>
        )}
        <div
          className={cn(
            'mt-1 flex items-center gap-2 text-[10px]',
            isUser ? 'text-primary-foreground/70' : 'text-muted-foreground',
          )}
        >
          {message.model ? <span className="truncate">{message.model}</span> : null}
          <span>{formatRelativeTime(message.timestamp)}</span>
          {!isUser && message.content ? (
            <button
              type="button"
              onClick={onCopy}
              className="inline-flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100"
            >
              <Copy className="h-3 w-3" />
              {copied ? 'Copiado' : 'Copiar'}
            </button>
          ) : null}
        </div>
      </div>
      {isUser ? (
        <span className="mt-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-border bg-secondary">
          <User className="h-3 w-3" />
        </span>
      ) : null}
    </div>
  );
}