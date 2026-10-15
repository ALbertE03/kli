/**
 * KLI — Image mode
 *
 * Text-to-image through the active provider. FreeLLMAPI routes to Cloudflare
 * Workers AI, whose imagen endpoint only accepts `auto` or a provider model id
 * (hence the `@cf/black-forest-labs/…` default) and ignores `n`, so the client
 * asks for the missing images one round trip at a time (see `generateImage`).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Copy, Download, ImageOff, Maximize2, Trash2, Wand2 } from 'lucide-react';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Chip,
  EmptyState,
  Input,
  Progress,
  Textarea,
} from '@/components/ui';
import { ImageLightbox } from '@/components/ImageLightbox';
import { ModelField } from '@/components/ModelField';
import { ApiError, generateImage } from '@/lib/api';
import { createId, formatRelativeTime } from '@/lib/utils';
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
const MAX_GALLERY = 32;

/* ── Saving helpers ────────────────────────────────────────────────────── */

const EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

function imageExtension(url: string): string {
  if (url.startsWith('data:')) {
    const end = url.indexOf(';');
    const mime = url.slice(5, end === -1 ? undefined : end);
    return EXTENSIONS[mime] ?? 'png';
  }
  const path = url.split(/[?#]/)[0] ?? '';
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  return EXTENSIONS[`image/${ext}`] ?? 'png';
}

function imageFilename(image: GeneratedImage): string {
  const stamp = new Date(image.createdAt).toISOString().replace(/:/g, '-').slice(0, 19);
  return `kli-${stamp}-${image.id.slice(-4)}.${imageExtension(image.url)}`;
}

function triggerDownload(href: string, filename: string) {
  const anchor = document.createElement('a');
  anchor.href = href;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

export function ImageMode() {
  const provider = useActiveProvider();
  const keys = useSecrets((state) => state.keys);
  const apiKey = resolveApiKey(provider.id, keys);
  const selectedModel = useStore((state) => state.selectedModels.image);
  const isStreaming = useStore((state) => state.isStreaming);
  const setStreaming = useStore((state) => state.setStreaming);
  const connectionStatus = useStore((state) => state.connectionStatus);
  const pushToast = useStore((state) => state.pushToast);

  const [prompt, setPrompt] = useState('');
  const [style, setStyle] = useState<string>(STYLES[0].value);
  const [size, setSize] = useState<string>(SIZES[0].value);
  const [count, setCount] = useState(1);
  const [seed, setSeed] = useState('');
  const [gallery, setGallery] = useState<GeneratedImage[]>([]);
  const [progress, setProgress] = useState<{ received: number; total: number } | null>(null);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
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
    setProgress({ received: 0, total: count });

    const fullPrompt = `${text}. Estilo: ${activeStyle.hint}`;
    let received = 0;

    try {
      await generateImage(provider, apiKey, selectedModel, fullPrompt, {
        size,
        count,
        seed: seed ? Number(seed) : undefined,
        signal: controller.signal,
        onBatch: (batch) => {
          received += batch.length;
          const created: GeneratedImage[] = batch.map((result, position) => ({
            id: createId('img'),
            url: result.url,
            prompt: text,
            model: selectedModel,
            createdAt: Date.now() + position,
          }));
          setGallery((current) => [...created, ...current].slice(0, MAX_GALLERY));
          setProgress({ received: Math.min(received, count), total: count });
        },
      });
      if (received > 0 && received === count) {
        pushToast({
          variant: 'success',
          title: count === 1 ? 'Imagen generada' : `${count} imágenes generadas`,
        });
      }
    } catch (cause) {
      if (controller.signal.aborted) return;
      const partial = received > 0 ? `${received} de ${count} imágenes se generaron antes del error. ` : '';
      setError(
        cause instanceof ApiError
          ? `${partial}${cause.message}${cause.status === 500 ? ' · revisa que el proveedor tenga credenciales para el motor de imágenes.' : ''}`
          : `${partial}Error inesperado al generar la imagen`,
      );
    } finally {
      setProgress(null);
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
    pushToast,
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

  const saveImage = useCallback(
    async (image: GeneratedImage, announce = true): Promise<boolean> => {
      const filename = imageFilename(image);
      try {
        const response = await fetch(image.url);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const blob = await response.blob();
        const href = URL.createObjectURL(blob);
        triggerDownload(href, filename);
        window.setTimeout(() => URL.revokeObjectURL(href), 30_000);
        if (announce) pushToast({ variant: 'success', title: 'Imagen guardada', description: filename });
        return true;
      } catch {
        if (image.url.startsWith('data:')) {
          triggerDownload(image.url, filename);
          if (announce) pushToast({ variant: 'success', title: 'Imagen guardada', description: filename });
          return true;
        }
        // Cross-origin images without CORS can't be fetched: let the browser
        // show it so the user can save it manually.
        window.open(image.url, '_blank', 'noopener,noreferrer');
        if (announce) {
          pushToast({
            variant: 'info',
            title: 'Imagen abierta en otra pestaña',
            description: 'Guárdala con clic derecho → «Guardar imagen como…»',
          });
        }
        return false;
      }
    },
    [pushToast],
  );

  const saveAll = useCallback(async () => {
    const images = [...gallery].reverse();
    let saved = 0;
    for (const image of images) {
      if (await saveImage(image, false)) saved += 1;
      await new Promise((resolve) => window.setTimeout(resolve, 250));
    }
    pushToast(
      saved > 0
        ? {
            variant: 'success',
            title: `${saved} ${saved === 1 ? 'imagen guardada' : 'imágenes guardadas'}`,
          }
        : { variant: 'warning', title: 'No se pudo guardar', description: 'Descarga cada imagen manualmente.' },
    );
  }, [gallery, saveImage, pushToast]);

  const removeImage = useCallback(
    (image: GeneratedImage) => {
      const index = gallery.findIndex((item) => item.id === image.id);
      const remaining = gallery.filter((item) => item.id !== image.id);
      setGallery(remaining);
      setLightboxIndex((openIndex) => {
        if (openIndex === null) return null;
        if (remaining.length === 0) return null;
        if (index >= 0 && index < openIndex) return openIndex - 1;
        return Math.min(openIndex, remaining.length - 1);
      });
    },
    [gallery],
  );

  const busyHint = progress ? `Generando ${progress.received}/${progress.total}…` : 'Generando…';

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

          {count > 1 ? (
            <p className="text-[11px] text-muted-foreground">
              Si el proveedor ignora la cantidad, KLI pide las imágenes que falten una a una hasta completar las{' '}
              {count}.
            </p>
          ) : null}

          {error ? (
            <Alert variant="destructive" className="text-xs">
              {error}
            </Alert>
          ) : null}

          {progress && progress.total > 1 ? (
            <Progress value={(progress.received / progress.total) * 100} label="Progreso de generación" />
          ) : null}

          <div className="flex items-center gap-2">
            <Button
              onClick={() => void generate()}
              loading={isStreaming}
              disabled={!prompt.trim() || !selectedModel || connectionStatus !== 'connected'}
              className="flex-1"
            >
              {isStreaming ? busyHint : count > 1 ? `Generar ${count}` : 'Generar'}
            </Button>
            {isStreaming ? (
              <Button
                variant="outline"
                onClick={() => {
                  abortRef.current?.abort();
                  setProgress(null);
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
        <CardHeader className="flex flex-wrap items-center justify-between gap-2 space-y-0">
          <CardTitle className="flex items-center gap-2">
            Galería
            {gallery.length > 0 ? (
              <Badge variant="secondary" className="font-mono">
                {gallery.length}
              </Badge>
            ) : null}
          </CardTitle>
          {gallery.length > 1 ? (
            <Button size="sm" variant="outline" onClick={() => void saveAll()}>
              <Download className="h-3.5 w-3.5" />
              Guardar todas
            </Button>
          ) : null}
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
              {gallery.map((image, index) => (
                <figure
                  key={image.id}
                  className="group relative overflow-hidden rounded-lg border border-border bg-muted/30"
                >
                  <button
                    type="button"
                    onClick={() => setLightboxIndex(index)}
                    title="Ampliar"
                    className="block w-full cursor-zoom-in"
                  >
                    <img
                      src={image.url}
                      alt={image.prompt}
                      loading="lazy"
                      className="aspect-[4/3] w-full bg-black/30 object-contain transition-transform duration-200 group-hover:scale-[1.02]"
                    />
                  </button>

                  <div className="absolute right-1.5 top-1.5 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                    <Button
                      size="icon"
                      variant="secondary"
                      className="h-7 w-7"
                      title="Guardar imagen"
                      onClick={() => void saveImage(image)}
                    >
                      <Download className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      size="icon"
                      variant="secondary"
                      className="h-7 w-7"
                      title="Ampliar"
                      onClick={() => setLightboxIndex(index)}
                    >
                      <Maximize2 className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      size="icon"
                      variant="secondary"
                      className="h-7 w-7"
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
                      className="h-7 w-7 hover:text-destructive"
                      title="Eliminar"
                      onClick={() => removeImage(image)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>

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
                </figure>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {lightboxIndex !== null ? (
        <ImageLightbox
          images={gallery}
          index={lightboxIndex}
          onIndexChange={setLightboxIndex}
          onClose={() => setLightboxIndex(null)}
          onSave={(image) => void saveImage(image)}
          onDelete={removeImage}
          onCopyPrompt={(image) => void copyPrompt(image)}
          copiedPromptId={copied}
        />
      ) : null}
    </div>
  );
}
