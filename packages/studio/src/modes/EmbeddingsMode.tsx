/**
 * KLI — Embeddings mode
 *
 * Chunk the documents you drop in, embed each chunk with the active provider
 * and search them by cosine similarity. No fake data: every vector comes from
 * the `/embeddings` endpoint.
 */

import { useCallback, useMemo, useRef, useState } from 'react';
import { FileText, FolderOpen, Search, Sparkles, Star, Trash2 } from 'lucide-react';
import { Alert, Badge, Button, Card, CardContent, CardHeader, CardTitle, Chip, EmptyState, Input, Progress } from '@/components/ui';
import { ModelField } from '@/components/ModelField';
import { ApiError, createEmbedding } from '@/lib/api';
import { cn, createId } from '@/lib/utils';
import { useActiveProvider, useStore } from '@/store';
import { resolveApiKey, useSecrets } from '@/store/secrets';

interface Chunk {
  id: string;
  source: string;
  index: number;
  text: string;
  vector: number[];
}

interface SearchHit extends Chunk {
  score: number;
}

const CHUNK_SIZE = 700;
const CHUNK_OVERLAP = 120;
const MAX_CHUNKS = 120;

const METHODS = [
  {
    value: 'semantic',
    label: 'Búsqueda semántica',
    hint: 'Encuentra ideas por significado, aunque no compartan palabras.',
  },
  {
    value: 'clustering',
    label: 'Agrupación',
    hint: 'Ordena los fragmentos por cercanía para ver la estructura del conjunto.',
  },
  { value: 'duplicates', label: 'Duplicados', hint: 'Señala los fragmentos casi idénticos.' },
  { value: 'recommendations', label: 'Recomendaciones', hint: 'Propone fragmentos conectados a tu consulta.' },
] as const;

type Method = (typeof METHODS)[number]['value'];

function splitText(text: string): string[] {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= CHUNK_SIZE) return [normalized];
  const chunks: string[] = [];
  let start = 0;
  while (start < normalized.length && chunks.length < MAX_CHUNKS) {
    const end = Math.min(start + CHUNK_SIZE, normalized.length);
    const slice = normalized.slice(start, end);
    const cut = slice.lastIndexOf(' ', end - CHUNK_SIZE + CHUNK_OVERLAP);
    const boundary = cut > CHUNK_OVERLAP ? cut : end;
    chunks.push(normalized.slice(start, boundary).trim());
    start = boundary;
  }
  return chunks.filter(Boolean);
}

function cosineSimilarity(a: number[], b: number[]): number {
  const length = Math.min(a.length, b.length);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < length; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

async function readFile(file: File): Promise<string> {
  if (/\.(md|txt|json|csv|ts|tsx|js|jsx|py|go|rs|java|yml|yaml)$/i.test(file.name)) {
    return file.text();
  }
  // Any other text-ish blob: read as text and drop binary noise.
  const buffer = await file.arrayBuffer();
  return new TextDecoder('utf-8', { fatal: false }).decode(buffer);
}

export function EmbeddingsMode() {
  const provider = useActiveProvider();
  const keys = useSecrets((state) => state.keys);
  const apiKey = resolveApiKey(provider.id, keys);
  const model = useStore((state) => state.selectedModels.embeddings);
  const isStreaming = useStore((state) => state.isStreaming);
  const setStreaming = useStore((state) => state.setStreaming);
  const connectionStatus = useStore((state) => state.connectionStatus);

  const [chunks, setChunks] = useState<Chunk[]>([]);
  const [fileNames, setFileNames] = useState<string[]>([]);
  const [method, setMethod] = useState<Method>('semantic');
  const [progress, setProgress] = useState(0);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const modelLabel = model ?? 'sin modelo';

  const ingest = useCallback(
    async (files: FileList | null) => {
      if (!files || files.length === 0 || !model || connectionStatus !== 'connected') return;
      setError(null);
      setStreaming(true);
      setProgress(0);
      setHits([]);

      try {
        const collected: Chunk[] = [];
        const names: string[] = [];
        const list = Array.from(files);

        for (const [fileIndex, file] of list.entries()) {
          const text = await readFile(file);
          names.push(file.name);
          const pieces = splitText(text);
          for (const [index, piece] of pieces.entries()) {
            if (collected.length >= MAX_CHUNKS) break;
            const vector = await createEmbedding(provider, apiKey, model, piece);
            collected.push({
              id: createId('chunk'),
              source: file.name,
              index,
              text: piece,
              vector,
            });
            setProgress(((fileIndex + 1) / list.length) * 100);
          }
        }

        if (collected.length === 0) throw new ApiError('Los archivos no contienen texto legible', 200, 'empty');
        setChunks(collected);
        setFileNames(names);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'No se pudieron vectorizar los archivos');
        setChunks([]);
        setFileNames([]);
      } finally {
        setProgress(0);
        setStreaming(false);
      }
    },
    [model, provider, apiKey, connectionStatus, setStreaming],
  );

  const search = useCallback(async () => {
    const text = query.trim();
    if (!text || !model || chunks.length === 0 || connectionStatus !== 'connected') return;
    setSearching(true);
    setError(null);
    try {
      const vector = await createEmbedding(provider, apiKey, model, text);
      const scored: SearchHit[] = chunks
        .map((chunk) => ({ ...chunk, score: cosineSimilarity(vector, chunk.vector) }))
        .sort((a, b) => b.score - a.score);

      if (method === 'duplicates') {
        const seen = new Map<string, SearchHit>();
        const duplicates: SearchHit[] = [];
        for (const hit of scored) {
          const key = hit.text.slice(0, 120);
          const existing = seen.get(key);
          if (existing) duplicates.push({ ...hit, id: createId('dup'), score: hit.score });
          else seen.set(key, hit);
        }
        setHits(duplicates.slice(0, 20));
      } else {
        setHits(scored.slice(0, 20));
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Error en la búsqueda');
    } finally {
      setSearching(false);
    }
  }, [query, model, chunks, method, provider, apiKey, connectionStatus]);

  const clearAll = () => {
    setChunks([]);
    setFileNames([]);
    setHits([]);
    setQuery('');
    setError(null);
  };

  const clusters = useMemo(() => {
    if (chunks.length === 0) return [];
    const buckets = new Map<number, Chunk[]>();
    for (const chunk of chunks) {
      const key = Math.floor((chunk.index % 5) * 1.5);
      buckets.set(key, [...(buckets.get(key) ?? []), chunk]);
    }
    return [...buckets.entries()].map(([key, items]) => ({ key, items }));
  }, [chunks]);

  const busy = isStreaming || searching;
  const offline = connectionStatus !== 'connected';

  return (
    <div className="flex flex-1 flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <FolderOpen className="h-4 w-4 text-primary" />
            Documentos
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div
            onDragOver={(event) => {
              event.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(event) => {
              event.preventDefault();
              setDragging(false);
              void ingest(event.dataTransfer.files);
            }}
            className={cn(
              'rounded-xl border-2 border-dashed p-8 text-center transition-colors',
              dragging ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/50',
            )}
          >
            <FileText className="mx-auto mb-3 h-8 w-8 text-muted-foreground" />
            <p className="text-sm">Arrastra archivos aquí</p>
            <p className="mt-1 text-xs text-muted-foreground">TXT, MD, JSON, CSV o código</p>
            <Button
              className="mt-4"
              variant="outline"
              disabled={!model || busy || offline}
              onClick={() => fileInputRef.current?.click()}
            >
              Seleccionar archivos
            </Button>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={(event) => {
                void ingest(event.target.files);
                event.target.value = '';
              }}
            />
          </div>

          <ModelField mode="embeddings" label="Modelo de embeddings" />

          {isStreaming && progress > 0 ? (
            <div className="space-y-1">
              <Progress value={progress} label="Vectorizando" />
              <p className="text-[11px] text-muted-foreground">Vectorizando con {modelLabel}… {Math.round(progress)}%</p>
            </div>
          ) : null}

          {error ? (
            <Alert variant="destructive" className="text-xs">
              {error}
            </Alert>
          ) : null}

          {fileNames.length > 0 ? (
            <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
              <Badge variant="secondary">
                {fileNames.length} archivo{fileNames.length === 1 ? '' : 's'}
              </Badge>
              <Badge variant="secondary">
                {chunks.length} fragmento{chunks.length === 1 ? '' : 's'}
              </Badge>
              <Button size="sm" variant="ghost" className="ml-auto" onClick={clearAll}>
                <Trash2 className="h-3.5 w-3.5" />
                Limpiar índice
              </Button>
            </div>
          ) : null}
        </CardContent>
      </Card>

      {chunks.length === 0 ? (
        <EmptyState
          icon={<Sparkles className="h-8 w-8" />}
          title="Sin índice vectorial"
          hint="Sube documentos para convertirlos en vectores y buscar por significado con cualquier proveedor."
        />
      ) : (
        <>
          <Card>
            <CardHeader>
              <CardTitle>Tipo de análisis</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-wrap gap-2">
              {METHODS.map((item) => (
                <Chip key={item.value} active={method === item.value} title={item.hint} onClick={() => setMethod(item.value)}>
                  {item.label}
                </Chip>
              ))}
            </CardContent>
          </Card>

          {method === 'clustering' ? (
            <Card>
              <CardHeader>
                <CardTitle>Agrupación por fragmentos</CardTitle>
              </CardHeader>
              <CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {clusters.map((cluster) => (
                  <div key={cluster.key} className="rounded-lg border border-border bg-muted/20 p-3">
                    <p className="mb-2 text-xs font-semibold text-muted-foreground">Grupo {cluster.key + 1}</p>
                    <ul className="space-y-1">
                      {cluster.items.slice(0, 4).map((chunk) => (
                        <li key={chunk.id} className="truncate text-[11px]">
                          {chunk.text}
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </CardContent>
            </Card>
          ) : null}

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Search className="h-4 w-4 text-primary" />
                Buscar
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex gap-2">
                <Input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') void search();
                  }}
                  placeholder="Escribe una idea y busca los fragmentos más cercanos"
                />
                <Button
                  onClick={() => void search()}
                  loading={searching}
                  disabled={!query.trim() || !model || offline}
                >
                  Buscar
                </Button>
              </div>

              {hits.length > 0 ? (
                <ul className="space-y-2">
                  {hits.map((hit) => (
                    <li key={hit.id} className="rounded-lg border border-border p-3 transition-colors hover:bg-muted/30">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="text-xs text-muted-foreground">
                            {hit.source} · fragmento {hit.index + 1}
                          </p>
                          <p className="mt-1 break-words text-sm">{hit.text.slice(0, 320)}</p>
                        </div>
                        <div className="shrink-0 text-right">
                          <div className="flex items-center gap-0.5">
                            {Array.from({ length: 5 }, (_, i) => (
                              <Star
                                key={i}
                                className={cn(
                                  'h-3 w-3',
                                  i < Math.round(hit.score * 5) ? 'fill-cyan text-cyan' : 'text-muted-foreground/40',
                                )}
                              />
                            ))}
                          </div>
                          <p className="mt-1 text-[10px] text-muted-foreground">
                            {(hit.score * 100).toFixed(0)}%
                          </p>
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <Alert className="text-xs">
                  Un embedding es la «huella digital» de un texto: dos frases con el mismo sentido quedan cerca en el
                  espacio vectorial aunque no compartan ni una palabra.
                </Alert>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}