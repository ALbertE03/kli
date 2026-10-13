/**
 * Tool contract — atomic actions the model can invoke.
 * Every tool declares the capabilities it needs; the kernel enforces them.
 */

import { z } from "zod";
import type { Capability } from "./capabilities.js";
import type { PluginContext } from "./context.js";

export const ToolResultOkSchema = z.object({
  ok: z.literal(true),
  content: z.string(),
  data: z.unknown().optional(),
  meta: z.record(z.unknown()).optional(),
});

export const ToolResultErrorSchema = z.object({
  ok: z.literal(false),
  error: z.string(),
  code: z.string().optional(),
  retryable: z.boolean().optional(),
});

export const ToolResultSchema = z.discriminatedUnion("ok", [
  ToolResultOkSchema,
  ToolResultErrorSchema,
]);

export type ToolResult<R = unknown> =
  | { ok: true; content: string; data?: R; meta?: Record<string, unknown> }
  | { ok: false; error: string; code?: string; retryable?: boolean };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface ToolDefinition<A = any, R = unknown> {
  readonly name: string;
  readonly description: string;
  readonly schema: z.ZodType<A>;
  readonly capabilities: readonly Capability[];
  /** Cannot run in parallel with other tools. */
  readonly exclusive?: boolean;
  execute(
    args: A,
    ctx: PluginContext,
    signal: AbortSignal,
  ): Promise<ToolResult<R>>;
}

/** A tool as presented to the model — no execute, no capabilities leaked. */
export interface ToolView {
  readonly name: string;
  readonly description: string;
  readonly schema: z.ZodType<unknown>;
}
