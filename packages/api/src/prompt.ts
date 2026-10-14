/**
 * Prompt fragments — pieces of the system prompt contributed by plugins.
 * Assembled by PromptBuilder (kernel) using fixed position order + priority.
 */

import { z } from "zod";
import { ModeSchema } from "./mode.js";
import type { Mode } from "./mode.js";
import type { ToolView } from "./tool.js";

export const PromptPositionSet = [
  "identity",
  "capabilities",
  "mode",
  "skills",
  "context",
  "rules",
  "examples",
  "epilogue",
] as const;

export const PromptPositionSchema = z.enum(PromptPositionSet);
export type PromptPosition = (typeof PromptPositionSet)[number];

export interface GraphSummary {
  readonly nodes: number;
  readonly edges: number;
  readonly languages: readonly string[];
  readonly backends: readonly string[];
}

export interface SkillDescriptor {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly tools: readonly string[];
  readonly prompt: string;
}

export interface McpServerInfo {
  readonly name: string;
  readonly toolCount: number;
}

export interface BudgetSummary {
  readonly tokensTotal: number;
  readonly tokensUsed: number;
  readonly costLimitUsd: number;
  readonly costUsd: number;
  readonly deadlineMs: number;
}

/**
 * The context passed to dynamic fragment content functions.
 * Functions CANNOT do I/O (no fs/node imports) — pure render.
 */
export interface PromptContext {
  readonly workspaceRoot: string;
  readonly cwd: string;
  readonly mode: z.infer<typeof ModeSchema>;
  readonly visibleTools: readonly ToolView[];
  readonly budget: BudgetSummary;
  readonly graphSummary?: GraphSummary;
  readonly skills?: readonly SkillDescriptor[];
  readonly mcpServers?: readonly McpServerInfo[];
  readonly env: Readonly<Record<string, string>>;
  readonly userMessage: string;
}

export type PromptFragmentContent =
  | string
  | ((ctx: PromptContext) => string | Promise<string>);

export const PromptFragmentSchema = z.object({
  id: z.string(),
  priority: z.number().int(),
  position: PromptPositionSchema,
  content: z.union([z.string(), z.function()]),
  alwaysInclude: z.boolean().optional().default(false),
  /**
   * When set, the fragment is only included while the task is running in one
   * of these modes. This is how a mode plugin contributes a fragment that must
   * never leak into other modes.
   */
  modes: z.array(ModeSchema).optional(),
});

export interface PromptFragment {
  readonly id: string;
  readonly priority: number;
  readonly position: PromptPosition;
  readonly content: PromptFragmentContent;
  readonly alwaysInclude?: boolean;
  readonly modes?: readonly Mode[];
}
