/**
 * KLI — Resize handle
 *
 * A slim, keyboard-operable separator between two fixed-width panels.
 * Pointer drags report `movementX` (already signed by the parent, so the
 * parent never has to know which side it is on), and ←/→ resize by 16px
 * steps for keyboard users. Hidden below the `lg` breakpoint, where panels
 * become drawers instead.
 */

import { useCallback, useRef } from 'react';
import { cn } from '@/lib/utils';

export interface ResizeHandleProps {
  /** Applies a signed pixel delta (positive = grow the left/top panel). */
  onDelta: (delta: number) => void;
  /** Keyboard step; receives ±16. */
  onStep: (step: number) => void;
  label: string;
  /** Current size in px, mirrored to `aria-valuenow`. */
  value: number;
  min: number;
  max: number;
  className?: string;
}

export function ResizeHandle({ onDelta, onStep, label, value, min, max, className }: ResizeHandleProps) {
  const dragging = useRef(false);

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      dragging.current = true;
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [],
  );

  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!dragging.current) return;
      onDelta(event.movementX);
    },
    [onDelta],
  );

  const endDrag = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return;
    dragging.current = false;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, []);

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        onStep(-16);
      } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        onStep(16);
      } else if (event.key === 'Home') {
        event.preventDefault();
        onStep(min - value);
      } else if (event.key === 'End') {
        event.preventDefault();
        onStep(max - value);
      }
    },
    [onStep, min, max, value],
  );

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={value}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onKeyDown={onKeyDown}
      className={cn(
        'relative hidden w-1 shrink-0 cursor-col-resize touch-none select-none lg:block',
        'focus-visible:outline-none',
        className,
      )}
    >
      <span className="absolute inset-y-0 left-0 w-px bg-border transition-colors" />
      <span className="absolute inset-y-0 -left-[3px] w-[7px]" />
      <span className="absolute inset-y-0 left-0 w-px bg-transparent transition-colors hover:bg-primary/60" />
      <span className="absolute inset-y-0 left-0 w-px bg-transparent transition-colors focus-visible:bg-primary" />
    </div>
  );
}
