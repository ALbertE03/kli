/**
 * KLI — Image mode
 *
 * Text-to-image through the active provider (FreeLLMAPI routes to Cloudflare
 * Workers AI by default).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Copy, ImageOff, Trash2, Wand2 } from 'lucide-react';
import { Alert, Badge, Button, Card, CardContent, CardHeader, CardTitle, Chip, EmptyState, Input, Textarea } from '@/components/ui';
import { ModelField } from '@/components/ModelField';
import { ApiError, generateImage } from '@/lib/api';
import { cn, createId, formatRelativeTime } from '@/lib/utils';
import { useActiveProvider, useStore } from '@/store';
import { resolveApiKey, useSecrets } from '@/store/secrets';
import type { GeneratedImage } from '@/types';

const STYLES = [
  { value: 'photorealistic', label: 'Fotorrealista', hint: 'luz cinematográfica, detalle alto' },
  { value: 'watercolor', label: 'Acuarela', hint: 'pinturatraditional, papel texturado' },
  { value: 'anime', label: 'Anime', hint: 'estudio japonés, contornos limpios' },
  { value: '3d', label: '3D', hint: 'render, materiales PBR' },
  { value: 'sketch', label: 'Boceto', hint: 'lápiz, líneas de tinta' },
] as const;

const SIZES = [
  { value: '1024x1024', label: 'Cuadrado' },
  { value: '1024x1536', label: 'Vertical' },
  { value: '1536x1024', label: 'Horizontal' },
  { value: '1280x768', label: 'Cine' },
] as const;

const COUNTS = [1, 2, 3, 4];

export function ImageMode() {
  const provider = useActiveProvider();
  const keys = useSecrets((state) => state.keys);
  const apiKey = resolveApiKey(provider.id, keys);
  const selectedModel = useStore((state) => state.selectedModels.image);
  const isStreaming = useStore((state) => state.isStreaming);
  const setStreaming = useStore((state) => state.setStreaming);
  const connectionStatus = useStore((state) => state.connectionStatus);

  const [prompt, setPrompt] = useState('');
  const [style, setStyle] = useState<string>(STYLES[0].value);
  const [size, setSize] = useState<string>(SIZES[0].value);
  const [count, setCount] = useState(1);
  const [seed, setSeed] = useState('');
  const [gallery, setGallery] = useState<GeneratedImage[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => () => abortRef.current?.abort(), []);

  const activeStyle = STYLES.find((item) => item.value === style) ?? STYLES[0];

  const generate = useCallback(async () => {
    const text = prompt.trim();
    if (!text || !selectedModel || isStreaming || connectionStatus !== 'connected') return;

    const controller = new AbortController();
    abortRef.current = controller;
    setStreaming(true);
    setError(null);

    const fullPrompt = seed
      ? `${text}. Estilo: ${activeStyle.hint}. seed: ${seed}`
      : `${text}. Estilo: ${activeStyle.hint}`;

    try {
      const results = await generateImage(provider, apiKey, selectedModel, fullPrompt, {
        size,
        count,
        signal: controller.signal,
      });
      const created: GeneratedImage[] = results.map((result) => ({
        id: createId('img'),
        url: result.url,
        prompt: text,
        model: selectedModel,
        createdAt: Date.now(),
      }));
      setGallery((current) => [...created, ...current].slice(0, 24));
    } catch (cause) {
      if (controller.signal.aborted) return;
      setError(
        cause instanceof ApiError
          ? `${cause.message}${cause.status === 500 ? ' · revisa que el proveedor tenga credenciales para el motor de imágenes.' : ''}`
          : 'Error inesperado al generar la imagen',
      );
    } finally {
      if (!controller.signal.aborted) setStreaming(false);
      abortRef.current = null;
    }
  }, [
    prompt,
    selectedModel,
    isStreaming,
    connectionStatus,
    provider,
    apiKey,
    activeStyle.hint,
    seed,
    size,
    count,
    setStreaming,
  ]);

  const copyPrompt = useCallback(async (image: GeneratedImage) => {
    try {
      await navigator.clipboard.writeText(image.prompt);
      setCopied(image.id);
      window.setTimeout(() => setCopied(null), 1500);
    } catch {
      /* clipboard blocked */
    }
  }, []);

  return (
    <div className="grid flex-1 gap-4 lg:grid-cols-2">
      <Card className="flex flex-col">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Wand2 className="h-4 w-4 text-primary" />
            Generar imagen
          </CardTitle>
        </CardHeader>
        <CardContent className="flex-1 space-y-4">
          <label className="block space-y-1.5">
            <span className="text-xs text-muted-foreground">Descripción</span>
            <Textarea
              rows={4}
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              placeholder="Ej: un gato astronauta en Marte, luz cálida, detalle cinematográfico"
            />
          </label>

          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">Estilo</p>
            <div className="flex flex-wrap gap-2">
              {STYLES.map((item) => (
                <Chip key={item.value} active={style === item.value} onClick={() => setStyle(item.value)}>
                  {item.label}
                </Chip>
              ))}
            </div>
          </div>

          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">Tamaño</p>
            <div className="grid grid-cols-4 gap-2">
              {SIZES.map((item) => (
                <Chip
                  key={item.value}
                  active={size === item.value}
                  onClick={() => setSize(item.value)}
                  className="px-2 text-center"
                >
                  {item.label}
                </Chip>
              ))}
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground">Cantidad</p>
              <div className="grid grid-cols-4 gap-2">
                {COUNTS.map((value) => (
                  <Chip key={value} active={count === value} onClick={() => setCount(value)} className="px-2 text-center">
                    {value}
                  </Chip>
                ))}
              </div>
            </div>
            <label className="space-y-1.5">
              <span className="text-xs text-muted-foreground">Seed (opcional)</span>
              <Input
                value={seed}
                inputMode="numeric"
                placeholder="Aleatorio"
                onChange={(event) => setSeed(event.target.value.replace(/[^\d]/g, ''))}
              />
            </label>
          </div>

          <ModelField mode="image" label="Modelo de imagen" />

          {error ? (
            <Alert variant="destructive" className="text-xs">
              {error}
            </Alert>
          ) : null}

          <div className="flex items-center gap-2">
            <Button
              onClick={() => void generate()}
              loading={isStreaming}
              disabled={!prompt.trim() || !selectedModel || connectionStatus !== 'connected'}
              className="flex-1"
            >
              {isStreaming ? 'Generando…' : 'Generar'}
            </Button>
            {isStreaming ? (
              <Button
                variant="outline"
                onClick={() => {
                  abortRef.current?.abort();
                  setStreaming(false);
                }}
              >
                Cancelar
              </Button>
            ) : null}
          </div>
        </CardContent>
      </Card>

      <Card className="flex flex-col">
        <CardHeader>
          <CardTitle>Galería</CardTitle>
        </CardHeader>
        <CardContent className="flex-1">
          {gallery.length === 0 ? (
            <EmptyState
              icon={<ImageOff className="h-8 w-8" />}
              title="Sin generaciones todavía"
              hint="Las imágenes que generes aparecerán aquí durante esta sesión."
            />
          ) : (
            <div className="grid grid-cols-2 gap-3">
              {gallery.map((image) => (
                <figure
                  key={image.id}
                  className={cn('group relative overflow-hidden rounded-lg border border-border bg-muted/30')}
                >
                  <img
                    src={image.url}
                    alt={image.prompt}
                    loading="lazy"
                    className="aspect-square w-full object-cover"
                  />
                  <figcaption className="space-y-1 p-2">
                    <p className="line-clamp-2 text-[11px] text-muted-foreground">{image.prompt}</p>
                    <div className="flex items-center justify-between gap-1">
                      <Badge variant="outline" className="max-w-[9rem] truncate">
                        {image.model}
                      </Badge>
                      <span className="text-[10px] text-muted-foreground">
                        {formatRelativeTime(image.createdAt)}
                      </span>
                    </div>
                  </figcaption>
                  <div className="absolute right-1 top-1 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                    <Button
                      size="icon"
                      variant="secondary"
                      title="Copiar prompt"
                      onClick={() => void copyPrompt(image)}
                    >
                      {copied === image.id ? (
                        <Check className="h-3.5 w-3.5 text-success" />
                      ) : (
                        <Copy className="h-3.5 w-3.5" />
                      )}
                    </Button>
                    <Button
                      size="icon"
                      variant="secondary"
                      title="Eliminar"
                      onClick={() => setGallery((current) => current.filter((item) => item.id !== image.id))}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </figure>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}