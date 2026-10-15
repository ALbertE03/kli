import * as React from 'react';

/** Calls `handler` when a pointer event happens outside `ref`. */
export function useClickOutside<T extends HTMLElement>(
  ref: React.RefObject<T>,
  handler: () => void,
  enabled = true,
): void {
  React.useEffect(() => {
    if (!enabled) return undefined;
    const onPointerDown = (event: MouseEvent | TouchEvent) => {
      const element = ref.current;
      if (!element || element.contains(event.target as Node)) return;
      handler();
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('touchstart', onPointerDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('touchstart', onPointerDown);
    };
  }, [ref, handler, enabled]);
}

/** Latest-value ref, handy for streaming callbacks that must not re-subscribe. */
export function useLatest<T>(value: T): React.MutableRefObject<T> {
  const ref = React.useRef(value);
  ref.current = value;
  return ref;
}

/** Debounced mirror of `value` — used for the model filter input. */
export function useDebounced<T>(value: T, delay = 200): T {
  const [debounced, setDebounced] = React.useState(value);
  React.useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delay);
    return () => window.clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

/**
 * Auto-grows a `<textarea>` to fit its content up to `maxHeight` px, then lets
 * it scroll. Returns the ref to attach to the element.
 */
export function useAutoGrow(
  value: string,
  maxHeight = 192,
): React.RefObject<HTMLTextAreaElement> {
  const ref = React.useRef<HTMLTextAreaElement>(null);
  React.useEffect(() => {
    const element = ref.current;
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${Math.min(element.scrollHeight, maxHeight)}px`;
  }, [value, maxHeight]);
  return ref;
}

/** Reactive `window.matchMedia`. Used to switch panels between static and drawer. */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = React.useState(
    () => typeof window !== 'undefined' && window.matchMedia(query).matches,
  );

  React.useEffect(() => {
    const list = window.matchMedia(query);
    const onChange = () => setMatches(list.matches);
    onChange();
    list.addEventListener('change', onChange);
    return () => list.removeEventListener('change', onChange);
  }, [query]);

  return matches;
}