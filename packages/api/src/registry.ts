/**
 * Registry — the central plugin registration surface.
 * Conflict resolution: higher priority wins. Equal priority must throw
 * ToolConflictError, never "last wins" (§4.3).
 */

import type { PluginContext } from "./context.js";
import type { AstBackend } from "./backend.js";
import type { ToolDefinition } from "./tool.js";
import type { Policy } from "./policy.js";
import type { SkillManifest } from "./skill.js";
import type { PromptFragment } from "./prompt.js";
import type { Mode } from "./mode.js";

export interface Registry {
  registerTool(tool: ToolDefinition, source: string, priority?: number): void;
  registerPolicy(policy: Policy, source: string): void;
  registerSkill(skill: SkillManifest, source: string): void;
  registerPromptFragment(f: PromptFragment, source: string): void;
  registerBackend(b: AstBackend): void;
  registerMcpServer(name: string, tools: ToolDefinition[]): void;

  /** Throws if the tool is not registered. */
  get(name: string): ToolDefinition;
  find(name: string): ToolDefinition | undefined;
  toolsFor(mode: Mode, ctx: PluginContext): ToolDefinition[];
  /** Freeze a point-in-time view (§4.6 step 1, Rule #4). */
  snapshot(): TaskRegistry;

  /**
   * Register the tool visibility filter for a mode. Installed by the mode
   * plugin — the kernel itself never names a tool or a mode.
   */
  setModeFilter(
    mode: Mode,
    filter: (tool: ToolDefinition, ctx: PluginContext) => boolean,
  ): void;
}

export interface TaskRegistry {
  readonly tools: ReadonlyMap<string, ToolDefinition>;
  readonly policies: readonly Policy[];
  readonly skills: readonly SkillManifest[];
  readonly fragments: readonly PromptFragment[];
  readonly backends: readonly AstBackend[];
  get(name: string): ToolDefinition;
  find(name: string): ToolDefinition | undefined;
  toolsFor(mode: Mode, ctx: PluginContext): ToolDefinition[];
  setModeFilter(
    mode: Mode,
    filter: (tool: ToolDefinition, ctx: PluginContext) => boolean,
  ): void;
}
