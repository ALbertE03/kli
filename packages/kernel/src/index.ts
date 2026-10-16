/**
 * @kli/kernel — loop, registry, bus, plugin loader, prompt builder, graph cache.
 *
 * Design constraints (§4.2 non-responsibilities):
 *  - No knowledge of any specific tool by name (Rule #7)
 *  - No knowledge of any specific LLM provider
 *  - No language-specific parsing
 *  - No prompt text beyond identity fragment
 */

// Core components
export { Registry, ToolConflictError } from "./registry.js";
export { EventBus } from "./bus.js";
export type { BusLogger } from "./bus.js";
export { PluginLoader } from "./loader.js";
export type { LoadedPlugin, PluginLoaderOptions } from "./loader.js";
export { PromptBuilder } from "./prompt-builder.js";
export { GraphCache } from "./graph-cache.js";
export type { GraphCacheData } from "./graph-cache.js";
export { buildGraph } from "./graph-builder.js";
export type { BuildGraphResult } from "./graph-builder.js";
export { Loop } from "./loop.js";
export type { LoopOptions, LoopResult } from "./loop.js";
export type {
  KernelBootOptions,
  TaskRunOptions,
  TaskRunResult,
  AgentRunOptions,
  SessionMetadata,
} from "./kernel-types.js";
export type { ToolActivity } from "./loop.js";
export { hasCapabilities, CapabilityError } from "./capability-gate.js";
export { resolvePath, PathViolationError } from "./paths.js";
export type { Provider, StepResult, ToolInvocation } from "./provider.js";
export {
  defaultAgents,
  mergeAgents,
  AgentsFileSchema,
  agentPromptFragment,
  createDelegationTool,
  toAgentSummary,
  type AgentsFile,
  type AgentSummary,
  type DelegationArgs,
  type DelegationDeps,
  type DelegationToolOptions,
} from "@kli/api";

// Kernel bootstrap
import { Registry } from "./registry.js";
import { EventBus } from "./bus.js";
import { PluginLoader } from "./loader.js";
import { PromptBuilder } from "./prompt-builder.js";
import { GraphCache } from "./graph-cache.js";
import { buildGraph } from "./graph-builder.js";
import type { BuildGraphResult } from "./graph-builder.js";
import { Loop } from "./loop.js";
import { IDENTITY_FRAGMENT } from "./identity.js";
import { defaultAgents, agentPromptFragment } from "@kli/api";
import type {
  KernelBootOptions,
  TaskRunOptions,
  TaskRunResult,
  AgentRunOptions,
} from "./kernel-types.js";
import type { AgentDefinition, AgentRunResult, Capability, TaskRegistry } from "@kli/api";

export { Kernel };

class Kernel {
  readonly bus: EventBus;
  readonly registry: Registry;
  readonly loader: PluginLoader;
  readonly promptBuilder: PromptBuilder;
  readonly graphCache: GraphCache;
  readonly workspaceRoot: string;

  constructor(opts: KernelBootOptions = {}) {
    this.workspaceRoot = opts.workspaceRoot ?? process.cwd();
    this.bus = new EventBus();
    this.registry = new Registry();
    this.registry.registerPromptFragment(IDENTITY_FRAGMENT, "kli.kernel");
    for (const agent of defaultAgents()) this.registry.registerAgent(agent, "kli.kernel");
    this.promptBuilder = new PromptBuilder();
    this.graphCache = new GraphCache(this.workspaceRoot);
    this.loader = new PluginLoader({
      workspaceRoot: this.workspaceRoot,
      bus: this.bus,
      capabilities: opts.capabilities ?? new Set<Capability>(),
      logger: opts.logger,
      config: opts.config,
      secrets: opts.secrets,
    });
  }

  /** Load plugins and call their `register(registry)`. */
  async loadPlugins(specs: string[]): Promise<void> {
    const loaded = await this.loader.loadAll(specs);
    for (const plugin of loaded) {
      plugin.instance.register?.(this.registry);
    }
  }

  /** Build and persist the code graph using all registered AST backends. */
  async buildCodeGraph(opts: import("@kli/api").BuildOptions = {}): Promise<BuildGraphResult> {
    return buildGraph(this.registry.snapshot().backends, this.workspaceRoot, this.graphCache, opts);
  }

  /** All registered subagents (built-ins merged with user overrides). */
  listAgents(): AgentDefinition[] {
    return this.registry.listAgents();
  }

  /**
   * Narrows a registry snapshot to one agent: its tool allow-list is intersected
   * with the mode filter, and its instructions are appended to the system
   * prompt. The parent task's registry is never mutated (Rule #4).
   */
  private scopeRegistry(
    base: TaskRegistry,
    agent: AgentDefinition,
    denyTools: readonly string[] = [],
  ): TaskRegistry {
    const fragments = [...base.fragments, agentPromptFragment(agent)];
    const allow = agent.tools;
    return {
      tools: base.tools,
      policies: base.policies,
      skills: base.skills,
      fragments,
      backends: base.backends,
      agents: base.agents,
      get: (name) => base.get(name),
      find: (name) => base.find(name),
      toolsFor: (mode, ctx) => {
        const visible =
          denyTools.length === 0
            ? base.toolsFor(mode, ctx)
            : base.toolsFor(mode, ctx).filter((tool) => !denyTools.includes(tool.name));
        return allow === null ? visible : visible.filter((tool) => allow.includes(tool.name));
      },
      agentsFor: (mode) => base.agentsFor(mode),
      agent: (id) => base.agent(id),
    };
  }

  /** Run one task to completion. */
  async run(opts: TaskRunOptions): Promise<TaskRunResult> {
    return this.runWithRegistry(this.registry.snapshot(), opts);
  }

  /**
   * Run a subagent. Same loop as the parent, but scoped to the agent's mode,
   * model and tool allow-list, and with its own budget slice.
   */
  async runAgent(opts: AgentRunOptions): Promise<AgentRunResult> {
    const base = this.registry.snapshot();
    const scoped = this.scopeRegistry(base, opts.agent, opts.denyTools ?? []);
    const startedAt = Date.now();
    const result = await this.runWithRegistry(scoped, {
      taskId: `agent_${opts.agent.id}_${Date.now()}`,
      mode: opts.agent.mode,
      message: opts.task,
      budget: opts.budget,
      provider: opts.provider,
      cwd: opts.cwd,
      capabilities: opts.capabilities,
      secrets: opts.secrets,
      config: opts.config,
      signal: opts.signal,
      graph: opts.graph,
      onToken: opts.onToken,
      ...(opts.onReasoning ? { onReasoning: opts.onReasoning } : {}),
      ...(opts.onToolActivity ? { onToolActivity: opts.onToolActivity } : {}),
    });
    const last = result.messages[result.messages.length - 1];
    return {
      agentId: opts.agent.id,
      status: result.status,
      output: last?.role === "assistant" ? last.content : "",
      steps: result.steps,
      toolCalls: result.toolCalls,
      costUsd: result.cost,
      tokensUsed: result.budget.tokensUsed,
      durationMs: Date.now() - startedAt,
      ...(result.status === "error" ? { error: last?.content ?? "Subagent failed" } : {}),
    };
  }

  private async runWithRegistry(
    snapshot: TaskRegistry,
    opts: TaskRunOptions,
  ): Promise<TaskRunResult> {
    const loop = new Loop(
      {
        taskId: opts.taskId ?? `task_${Date.now()}`,
      mode: opts.mode,
      userMessage: opts.message,
      budget: opts.budget,
      registry: snapshot,
      provider: opts.provider,
      bus: this.bus,
      workspaceRoot: this.workspaceRoot,
      cwd: opts.cwd ?? this.workspaceRoot,
      capabilities: opts.capabilities,
      secrets: opts.secrets,
      config: opts.config,
      signal: opts.signal,
      graph: opts.graph ?? undefined,
      projectId: opts.projectId,
        onToken: opts.onToken,
        ...(opts.onReasoning ? { onReasoning: opts.onReasoning } : {}),
        ...(opts.onToolActivity ? { onToolActivity: opts.onToolActivity } : {}),
      },
      this.promptBuilder,
    );
    const result = await loop.run();
    return {
      status: result.status,
      messages: result.messages,
      budget: result.budget,
      steps: result.steps,
      cost: result.cost,
      toolCalls: result.toolCalls,
    };
  }
}
