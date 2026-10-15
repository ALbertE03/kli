/**
 * KLI Studio — image lightbox
 *
 * Full-screen carousel for generated images: wrap-around navigation (buttons,
 * arrow keys and swipe), download, copy prompt and delete without leaving the
 * viewer.
 */

import { useEffect, useRef } from 'react';
import { ChevronLeft, ChevronRight, Copy, Check, Download, Trash2, X } from 'lucide-react';
import { Badge, Button } from '@/components/ui';
import { formatRelativeTime } from '@/lib/utils';
import type { GeneratedImage } from '@/types';

interface ImageLightboxProps {
  images: GeneratedImage[];
  index: number;
  onIndexChange: (index: number) => void;
  onClose: () => void;
  onSave: (image: GeneratedImage) => void;
  onDelete: (image: GeneratedImage) => void;
  onCopyPrompt: (image: GeneratedImage) => void;
  copiedPromptId: string | null;
}

export function ImageLightbox({
  images,
  index,
  onIndexChange,
  onClose,
  onSave,
  onDelete,
  onCopyPrompt,
  copiedPromptId,
}: ImageLightboxProps) {
  const count = images.length;
  const safeIndex = count === 0 ? 0 : Math.min(Math.max(index, 0), count - 1);
  const current = images[safeIndex];
  const touchStartX = useRef<number | null>(null);

  const go = (delta: number) => {
    if (count <= 1) return;
    onIndexChange((safeIndex + delta + count) % count);
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
      else if (event.key === 'ArrowLeft') onIndexChange((safeIndex - 1 + count) % count);
      else if (event.key === 'ArrowRight') onIndexChange((safeIndex + 1) % count);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [count, safeIndex, onClose, onIndexChange]);

  // Warm the neighbouring frames so the carousel feels instant.
  useEffect(() => {
    if (count <= 1) return;
    for (const offset of [1, -1]) {
      const neighbour = images[(safeIndex + offset + count) % count];
      if (!neighbour) continue;
      const preload = new Image();
      preload.src = neighbour.url;
    }
  }, [count, images, safeIndex]);

  if (!current) return null;

  return (
    <div className="fixed inset-0 z-[70] flex flex-col bg-black/90 backdrop-blur-sm animate-fade-in">
      <button
        type="button"
        aria-label="Cerrar visor"
        className="absolute inset-0 cursor-default"
        onClick={onClose}
      />

      <header className="relative z-10 flex items-center justify-between gap-3 px-4 py-3 text-white/90">
        <span className="rounded-full bg-white/10 px-2.5 py-1 font-mono text-[11px]">
          {safeIndex + 1} / {count}
        </span>
        <div className="flex items-center gap-1">
          <Button
            size="sm"
            variant="ghost"
            className="text-white/90 hover:bg-white/10 hover:text-white"
            onClick={() => onCopyPrompt(current)}
          >
            {copiedPromptId === current.id ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
            Prompt
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="text-white/90 hover:bg-white/10 hover:text-white"
            onClick={() => onSave(current)}
          >
            <Download className="h-4 w-4" />
            Guardar
          </Button>
          <Button
            size="icon"
            variant="ghost"
            title="Eliminar imagen"
            className="text-white/90 hover:bg-white/10 hover:text-destructive"
            onClick={() => onDelete(current)}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            title="Cerrar"
            className="text-white/90 hover:bg-white/10 hover:text-white"
            onClick={onClose}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      </header>

      <div
        className="relative z-10 flex min-h-0 flex-1 items-center justify-center px-2"
        onTouchStart={(event) => {
          touchStartX.current = event.touches[0]?.clientX ?? null;
        }}
        onTouchEnd={(event) => {
          const start = touchStartX.current;
          const end = event.changedTouches[0]?.clientX;
          touchStartX.current = null;
          if (start === null || end === undefined) return;
          const delta = end - start;
          if (Math.abs(delta) > 45) go(delta < 0 ? 1 : -1);
        }}
      >
        {count > 1 ? (
          <button
            type="button"
            aria-label="Imagen anterior"
            onClick={() => go(-1)}
            className="absolute left-3 z-20 flex h-11 w-11 items-center justify-center rounded-full bg-white/10 text-white backdrop-blur transition-colors hover:bg-white/20"
          >
            <ChevronLeft className="h-6 w-6" />
          </button>
        ) : null}

        <img
          key={current.id}
          src={current.url}
          alt={current.prompt}
          className="max-h-full max-w-full select-none rounded-lg object-contain shadow-2xl"
        />

        {count > 1 ? (
          <button
            type="button"
            aria-label="Imagen siguiente"
            onClick={() => go(1)}
            className="absolute right-3 z-20 flex h-11 w-11 items-center justify-center rounded-full bg-white/10 text-white backdrop-blur transition-colors hover:bg-white/20"
          >
            <ChevronRight className="h-6 w-6" />
          </button>
        ) : null}
      </div>

      <footer className="relative z-10 border-t border-white/10 px-4 py-3">
        <p className="line-clamp-2 text-xs text-white/80">{current.prompt}</p>
        <div className="mt-1.5 flex items-center gap-2">
          <Badge variant="outline" className="max-w-[14rem] truncate border-white/20 text-white/70">
            {current.model}
          </Badge>
          <span className="text-[11px] text-white/50">{formatRelativeTime(current.createdAt)}</span>
        </div>
      </footer>
    </div>
  );
}
