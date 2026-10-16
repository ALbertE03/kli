/**
 * Plugin context — what a plugin receives at setup and execute time.
 * Immutable snapshot; capabilities are the only gate (Rule #2).
 */

import { z } from "zod";
import type { Capability } from "./capabilities.js";
import type { Event } from "./bus.js";

export const BudgetSchema = z.object({
  tokensTotal: z.number().int().min(0),
  tokensUsed: z.number().int().min(0),
  costUsd: z.number().min(0),
  costLimitUsd: z.number().min(0),
  deadlineMs: z.number().int().min(0),
});

export type Budget = z.infer<typeof BudgetSchema>;

export interface Logger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

export interface PluginContext {
  readonly cwd: string;
  readonly workspaceRoot: string;
  readonly projectId?: string;
  readonly budget: Budget;
  readonly capabilities: ReadonlySet<Capability>;
  readonly logger: Logger;
  readonly emit: (e: Event) => void;
  readonly secrets: Readonly<Record<string, string>>;
  readonly config: Readonly<Record<string, unknown>>;

  /**
   * Resolves a path relative to `workspaceRoot` and validates it is inside.
   * All paths from plugins MUST go through this — never `path.join` (Rule #3).
   */
  resolve(p: string): string;
}
