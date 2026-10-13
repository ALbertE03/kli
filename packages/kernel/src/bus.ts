/**
 * Event bus — synchronous emit, handlers run in registration order.
 * Handler errors are logged, never propagate (§4.5).
 * This is the ONLY cross-plugin channel (Rule #5).
 */
import type { Bus, Event, EventType, Handler } from "@kli/api";

export interface BusLogger {
  error(msg: string, meta?: Record<string, unknown>): void;
}

export class EventBus implements Bus {
  private readonly handlers = new Map<string, Set<Handler<EventType>>>();

  constructor(private readonly logger: BusLogger = console) {}

  emit(e: Event): void {
    const set = this.handlers.get(e.type);
    if (!set || set.size === 0) return;
    for (const h of set) {
      try {
        h(e);
      } catch (err) {
        this.logger.error(`event handler error for "${e.type}"`, {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  on<T extends EventType>(type: T, handler: Handler<T>): () => void {
    let set = this.handlers.get(type);
    if (!set) {
      set = new Set();
      this.handlers.set(type, set);
    }
    set.add(handler as unknown as Handler<EventType>);
    return () => {
      set.delete(handler as unknown as Handler<EventType>);
    };
  }

  /** Number of registered handlers (observability / tests). */
  size(): number {
    let n = 0;
    for (const s of this.handlers.values()) n += s.size;
    return n;
  }

  clear(): void {
    this.handlers.clear();
  }
}
