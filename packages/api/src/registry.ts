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
import type { Mode, ModePolicy } from "./mode.js";
import type { AgentDefinition } from "./agent.js";

export interface Registry {
  registerTool(tool: ToolDefinition, source: string, priority?: number): void;
  registerPolicy(policy: Policy, source: string): void;
  registerSkill(skill: SkillManifest, source: string): void;
  registerPromptFragment(fragment: PromptFragment, source: string): void;
  registerBackend(b: AstBackend): void;
  registerMcpServer(name: string, tools: ToolDefinition[]): void;
  /**
   * Register (or override) a subagent. Later registrations win, so a user's
   * `.kli/agents.json` always overrides the built-in defaults.
   */
  registerAgent(agent: AgentDefinition, source: string): void;

  /**
   * Install a mode. Scopes the mode's prompt fragment to that mode and
   * registers its policy + tool-visibility filter. Preferred over
   * `setModeFilter`/`registerPromptFragment` because it is type-safe on
   * `Mode` and can never leak a fragment into another mode.
   */
  registerMode(policy: ModePolicy, source: string): void;

  /** Throws if the tool is not registered. */
  get(name: string): ToolDefinition;
  find(name: string): ToolDefinition | undefined;
  toolsFor(mode: Mode, ctx: PluginContext): ToolDefinition[];
  /** Freeze a point-in-time view (§4.6 step 1, Rule #4). */
  snapshot(): TaskRegistry;

  /**
   * Low-level: register the tool visibility filter for a mode. Prefer
   * `registerMode`. Installed by a mode plugin — the kernel itself never
   * names a tool or a mode.
   */
  setModeFilter(
    mode: Mode,
    filter: (tool: ToolDefinition, ctx: PluginContext) => boolean,
  ): void;
}

/**
 * The frozen, per-task view of the registry (Rule #4). It is intentionally
 * read-only: there is no `setModeFilter` here, so any attempt to mutate a
 * snapshot is a *compile-time* error rather than a runtime throw.
 */
export interface TaskRegistry {
  readonly tools: ReadonlyMap<string, ToolDefinition>;
  readonly policies: readonly Policy[];
  readonly skills: readonly SkillManifest[];
  readonly fragments: readonly PromptFragment[];
  readonly backends: readonly AstBackend[];
  readonly agents: readonly AgentDefinition[];
  get(name: string): ToolDefinition;
  find(name: string): ToolDefinition | undefined;
  toolsFor(mode: Mode, ctx: PluginContext): ToolDefinition[];
  /** Subagents visible to the model (hidden ones are excluded). */
  agentsFor(mode: Mode): readonly AgentDefinition[];
  agent(id: string): AgentDefinition | undefined;
}
