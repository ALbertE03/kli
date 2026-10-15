/**
 * KLI — File viewer (right panel · Editor tab)
 *
 * Reads real workspace files through the harness (`POST /api/read`, which
 * resolves paths with the kernel's `ctx.resolve` rule). There is no directory
 * listing endpoint in `@kli/server`, so the panel takes a path or reuses the
 * files already attached to the conversation — it never fabricates a tree.
 */

import { useCallback, useState } from 'react';
import { FileCode2, FolderOpen, Loader2 } from 'lucide-react';
import { Alert, Badge, Button, EmptyState, Input } from '@/components/ui';
import { CodeBlock } from '@/components/CodeBlock';
import { readWorkspaceFile } from '@/lib/harness';
import { useStore } from '@/store';

interface OpenedFile {
  path: string;
  content: string;
  truncated: boolean;
}

const EXTENSION_LANGUAGE: Record<string, string> = {
  ts: 'ts', tsx: 'tsx', js: 'js', jsx: 'jsx', mjs: 'js', cjs: 'js', json: 'json',
  md: 'md', css: 'css', scss: 'scss', html: 'html', py: 'py', sh: 'sh', bash: 'sh',
  yml: 'yaml', yaml: 'yaml', rs: 'rs', go: 'go', java: 'java', sql: 'sql', toml: 'toml',
};

function languageFromPath(path: string): string | undefined {
  const extension = path.split('.').pop()?.toLowerCase();
  if (!extension) return undefined;
  return EXTENSION_LANGUAGE[extension];
}

export function FileViewer() {
  const harnessUrl = useStore((state) => state.harnessUrl);
  const connected = useStore((state) => state.harnessEnabled && state.harnessStatus === 'connected');
  const attachments = useStore((state) => state.attachments);

  const [path, setPath] = useState('');
  const [file, setFile] = useState<OpenedFile | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const open = useCallback(
    async (target: string) => {
      const trimmed = target.trim();
      if (!trimmed || !connected) return;
      setLoading(true);
      setError(null);
      try {
        const result = await readWorkspaceFile(harnessUrl, trimmed);
        setFile({ path: result.path, content: result.content, truncated: result.truncated });
        setPath(result.path);
      } catch (cause) {
        setFile(null);
        setError(cause instanceof Error ? cause.message : 'No se pudo abrir el archivo');
      } finally {
        setLoading(false);
      }
    },
    [connected, harnessUrl],
  );

  if (!connected) {
    return (
      <EmptyState
        icon={<FolderOpen className="h-8 w-8" />}
        title="Editor sin conexión"
        hint="Conecta el harness (`kli serve`) para abrir archivos del workspace."
      />
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <form
        className="flex items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void open(path);
        }}
      >
        <Input
          className="h-8 text-xs"
          value={path}
          onChange={(event) => setPath(event.target.value)}
          placeholder="ruta relativa, p. ej. packages/studio/src/App.tsx"
          aria-label="Ruta del archivo a abrir"
          spellCheck={false}
        />
        <Button size="sm" type="submit" disabled={loading || path.trim().length === 0}>
          {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FolderOpen className="h-3.5 w-3.5" />}
          Abrir
        </Button>
      </form>

      {attachments.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground">Adjuntos</span>
          {attachments.map((attachment) => (
            <button
              key={attachment.id}
              type="button"
              onClick={() => void open(attachment.path)}
              className="rounded border border-border bg-muted/40 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground transition-colors hover:border-primary/60 hover:text-foreground"
            >
              {attachment.name}
            </button>
          ))}
        </div>
      ) : null}

      {error ? (
        <Alert variant="destructive" className="text-xs">
          {error}
        </Alert>
      ) : null}

      {loading && !file ? (
        <div className="flex flex-1 items-center justify-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Leyendo…
        </div>
      ) : null}

      {!file && !loading && !error ? (
        <EmptyState
          icon={<FileCode2 className="h-8 w-8" />}
          title="Ningún archivo abierto"
          hint="Escribe una ruta relativa al workspace o elige uno de los archivos adjuntos a la conversación."
        />
      ) : null}

      {file ? (
        <>
          <div className="flex items-center gap-2">
            <span className="truncate font-mono text-[11px] text-muted-foreground">{file.path}</span>
            {file.truncated ? <Badge variant="warning">truncado</Badge> : null}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            <CodeBlock code={file.content} language={languageFromPath(file.path)} />
          </div>
        </>
      ) : null}
    </div>
  );
}
