/**
 * Modes — plan, build, ask. And the ModePolicy interface.
 *
 * The kernel has no opinion on modes by name (Rule #7). The vocabulary
 * (plan|build|ask) is defined here so all packages share a single source.
 */

import { z } from "zod";
import type { Policy } from "./policy.js";
import type { PromptFragment } from "./prompt.js";
import type { ToolDefinition } from "./tool.js";

export const ModeSet = ["plan", "build", "ask"] as const;
export const ModeSchema = z.enum(ModeSet);
export type Mode = (typeof ModeSet)[number];

/**
 * A mode is a policy that gates tool visibility and contributes a prompt
 * fragment. Modes are themselves plugins.
 */
export interface ModePolicy extends Policy {
  readonly mode: Mode;
  /** Decides which tools are visible to the model for this mode. */
  readonly allowedTools: (tool: ToolDefinition) => boolean;
  /** Contributed prompt fragment for this mode. */
  readonly promptFragment: PromptFragment;
}
