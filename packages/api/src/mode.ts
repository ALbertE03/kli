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
 *
 * A mode plugin builds one of these and hands it to
 * `registry.registerMode(policy)`, which is the only supported way to install
 * a mode. The registry scopes the fragment to `mode` so it can never leak into
 * another mode's system prompt.
 */
export interface ModePolicy extends Policy {
  readonly mode: Mode;
  /** Decides which tools are visible to the model for this mode. */
  readonly allowedTools: (tool: ToolDefinition) => boolean;
  /** Contributed prompt fragment for this mode. */
  readonly promptFragment: PromptFragment;
}

/**
 * Convenience helper: build a mode policy whose tool filter is derived from an
 * allow-list of tool names. Keeps mode plugins declarative and type-checked
 * against `Mode` (unlike a bare string).
 */
export function defineModePolicy(opts: {
  mode: Mode;
  /** Tool names visible in this mode. `null` means "all tools". */
  allowTools: readonly string[] | null;
  promptFragment: PromptFragment;
  policy?: Policy;
}): ModePolicy {
  const allow = opts.allowTools;
  const base: Policy = opts.policy ?? { name: `mode.${opts.mode}` };
  return {
    ...base,
    name: base.name,
    mode: opts.mode,
    allowedTools: (tool) => (allow === null ? true : allow.includes(tool.name)),
    promptFragment: opts.promptFragment,
  };
}
