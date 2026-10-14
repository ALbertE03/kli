/**
 * Provider contract — the LLM backend boundary.
 * Providers are plugins; the kernel calls `step()` once per loop iteration.
 * The kernel has no knowledge of any specific provider (Rule #7).
 */

import type { TaskState } from "./task.js";
import type { ToolDefinition } from "./tool.js";

export interface ToolInvocation {
  /** Stable id to correlate the assistant turn with the tool result. */
  readonly id: string;
  readonly name: string;
  /** Provider-supplied argument object; validated against the tool schema. */
  readonly args: Record<string, unknown>;
}

export interface StepResult {
  /** Assistant text, if any. */
  readonly content?: string;
  readonly finishReason: "stop" | "end_turn" | "tool_use" | "error";
  readonly toolCalls?: readonly ToolInvocation[];
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly cost: number;
}

export interface ModelInfo {
  id: string;
  context_window?: number;
}

export interface Provider {
  readonly name: string;

  /**
   * Produce one assistant turn. Implementations that support streaming SHOULD
   * invoke `onToken` for each incremental text delta; `onToken` may be omitted.
   */
  step(
    state: TaskState,
    tools: readonly ToolDefinition[],
    systemPrompt: string,
    signal: AbortSignal,
    onToken?: (delta: string) => void,
  ): Promise<StepResult>;

  /** Cheap token estimate (used for budget accounting and prompt trimming). */
  countTokens(text: string): number;

  /** Estimate USD for a token pair (used for budget checks). */
  estimateCost(tokensIn: number, tokensOut: number): number;

  /** List available models (optional, for `kli model list`). */
  listModels?(): Promise<ModelInfo[]>;
}
