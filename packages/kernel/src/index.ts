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
export type { KernelBootOptions, TaskRunOptions, TaskRunResult, SessionMetadata } from "./kernel-types.js";
export { hasCapabilities, CapabilityError } from "./capability-gate.js";
export { resolvePath, PathViolationError } from "./paths.js";
export type { Provider, StepResult, ToolInvocation } from "./provider.js";

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
import type { KernelBootOptions, TaskRunOptions, TaskRunResult } from "./kernel-types.js";

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
    this.promptBuilder = new PromptBuilder();
    this.graphCache = new GraphCache(this.workspaceRoot);
    this.loader = new PluginLoader({
      workspaceRoot: this.workspaceRoot,
      bus: this.bus,
      capabilities: opts.capabilities ?? new Set(),
      logger: opts.logger,
      config: opts.config,
      secrets: opts.secrets,
    });
  }

  /** Load plugins and call their `register(registry)`. */
  async loadPlugins(specs: string[]): Promise<void> {
    const loaded = await this.loader.loadAll(specs);
    for (const p of loaded) {
      if (p.instance.register) {
        p.instance.register(this.registry);
      }
    }
  }

  /** Build and persist the code graph using all registered AST backends. */
  async buildCodeGraph(opts: import("@kli/api").BuildOptions = {}): Promise<BuildGraphResult> {
    const snapshot = this.registry.snapshot();
    return buildGraph(snapshot.backends, this.workspaceRoot, this.graphCache, opts);
  }

  /** Run one task to completion. */
  async run(opts: TaskRunOptions): Promise<TaskRunResult> {
    const snapshot = this.registry.snapshot();
    const loop = new Loop({
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
      onToken: opts.onToken,
    }, this.promptBuilder);
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
