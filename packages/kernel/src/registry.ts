/**
 * Registry — central plugin registration surface.
 *
 * Conflict rule (§4.3): higher priority wins. Equal priority MUST throw
 * ToolConflictError — never "last wins".
 */

import type {
  Registry as IRegistry,
  TaskRegistry,
  PluginContext,
  ToolDefinition,
  Policy,
  SkillManifest,
  PromptFragment,
  AstBackend,
  Mode,
  ModePolicy,
  AgentDefinition,
} from "@kli/api";

export class ToolConflictError extends Error {
  override readonly name = "ToolConflictError";
  constructor(
    readonly toolName: string,
    readonly sources: readonly string[],
  ) {
    super(
      `Tool conflict for "${toolName}": equal priority from ${sources.join(", ")}`,
    );
  }
}

interface ToolEntry {
  tool: ToolDefinition;
  source: string;
  priority: number;
}

interface PolicyEntry {
  policy: Policy;
  source: string;
}

interface SkillEntry {
  skill: SkillManifest;
  source: string;
}

interface FragmentEntry {
  fragment: PromptFragment;
  source: string;
}

export class Registry implements IRegistry {
  /** Tool name → the tool that will be served. Other candidates stay reachable. */
  private readonly tools = new Map<string, ToolEntry>();
  /** Every registered tool, including shadowed ones, keyed by `source::name`. */
  private readonly allTools = new Map<string, ToolEntry>();
  private readonly policies: PolicyEntry[] = [];
  private readonly skills: SkillEntry[] = [];
  private readonly fragments: FragmentEntry[] = [];
  private readonly backends: AstBackend[] = [];
  private readonly mcpServers = new Map<string, ToolDefinition[]>();
  /** mode → visibility filter, installed by ModePolicy plugins. */
  private readonly modeFilters = new Map<
    string,
    (tool: ToolDefinition, ctx: PluginContext) => boolean
  >();
  /** agent id → definition. Later registrations override earlier ones. */
  private readonly agents = new Map<string, { agent: AgentDefinition; source: string }>();

  registerTool(tool: ToolDefinition, source: string, priority = 0): void {
    const existing = this.tools.get(tool.name);
    if (existing) {
      // The same registrant re-registering its own tool is not a conflict: it
      // is an update. This is what lets a long-lived host (the CLI REPL, the
      // KLI Studio server) install a per-run tool such as the delegation tool
      // without tripping the cross-plugin conflict rule on every run.
      if (existing.source === source) {
        this.tools.set(tool.name, { tool, source, priority });
        this.allTools.set(`${source}::${tool.name}`, { tool, source, priority });
        return;
      }
      if (existing.priority > priority) return; // higher already wins
      if (existing.priority === priority) {
        throw new ToolConflictError(tool.name, [existing.source, source]);
      }
    }
    this.tools.set(tool.name, { tool, source, priority });
    this.allTools.set(`${source}::${tool.name}`, { tool, source, priority });
  }

  registerPolicy(policy: Policy, source: string): void {
    this.policies.push({ policy, source });
  }

  /**
   * Install a mode: its prompt fragment (scoped to the mode), its policy, and
   * its tool-visibility filter. Type-safe alternative to calling
   * `registerPromptFragment` + `setModeFilter` + `registerPolicy` by hand.
   */
  registerMode(policy: ModePolicy, source: string): void {
    this.registerPromptFragment(
      { ...policy.promptFragment, modes: [policy.mode] },
      source,
    );
    this.registerPolicy(policy, source);
    this.setModeFilter(policy.mode, (tool) => policy.allowedTools(tool));
  }

  registerSkill(skill: SkillManifest, source: string): void {
    this.skills.push({ skill, source });
  }

  registerPromptFragment(f: PromptFragment, source: string): void {
    this.fragments.push({ fragment: f, source });
  }

  registerBackend(b: AstBackend): void {
    const dup = this.backends.some((x) => x.id === b.id);
    if (dup) throw new Error(`Backend already registered: ${b.id}`);
    this.backends.push(b);
  }

  registerMcpServer(name: string, tools: ToolDefinition[]): void {
    this.mcpServers.set(name, tools);
    for (const tool of tools) this.registerTool(tool, `mcp:${name}`);
  }

  registerAgent(agent: AgentDefinition, source: string): void {
    // Override is intentional: user config must win over built-in defaults.
    this.agents.set(agent.id, { agent, source });
  }

  /** All registered subagents, in registration order. */
  listAgents(): AgentDefinition[] {
    return [...this.agents.values()].map((entry) => entry.agent);
  }

  /**
   * Register the tool visibility filter for a mode. Installed by the mode
   * plugin — the kernel itself never names a tool or a mode.
   */
  setModeFilter(
    mode: Mode,
    filter: (tool: ToolDefinition, ctx: PluginContext) => boolean,
  ): void {
    this.modeFilters.set(mode, filter);
  }

  get(name: string): ToolDefinition {
    const entry = this.tools.get(name);
    if (!entry) throw new Error(`Tool not found: ${name}`);
    return entry.tool;
  }

  find(name: string): ToolDefinition | undefined {
    return this.tools.get(name)?.tool;
  }

  /** Every registered tool including shadowed duplicates, for inspection. */
  everyTool(): ToolDefinition[] {
    return [...this.allTools.values()].map((entry) => entry.tool);
  }

  toolsFor(mode: Mode, ctx: PluginContext): ToolDefinition[] {
    const filter = this.modeFilters.get(mode);
    const all = [...this.tools.values()].map((e) => e.tool);
    if (!filter) return all;
    return all.filter((t) => {
      try {
        return filter(t, ctx);
      } catch {
        return false;
      }
    });
  }

  mcpServerTools(name: string): ToolDefinition[] {
    return this.mcpServers.get(name) ?? [];
  }

  snapshot(): TaskRegistry {
    return new FrozenRegistry(
      new Map(this.tools),
      [...this.policies],
      [...this.skills],
      [...this.fragments],
      [...this.backends],
      new Map(this.modeFilters),
      this.listAgents(),
    );
  }
}

/** Immutable view handed to a single task (Rule #4). */
class FrozenRegistry implements TaskRegistry {
  readonly tools: ReadonlyMap<string, ToolDefinition>;
  readonly backends: readonly AstBackend[];
  readonly agents: readonly AgentDefinition[];

  constructor(
    private readonly _entries: Map<string, ToolEntry>,
    private readonly _policies: readonly PolicyEntry[],
    private readonly _skills: readonly SkillEntry[],
    private readonly _fragments: readonly FragmentEntry[],
    backends: AstBackend[],
    private readonly _modeFilters: ReadonlyMap<
      string,
      (tool: ToolDefinition, ctx: PluginContext) => boolean
    >,
    agents: readonly AgentDefinition[],
  ) {
    this.tools = new Map(
      [..._entries.entries()].map(([k, v]) => [v.tool.name, v.tool] as const),
    ) as ReadonlyMap<string, ToolDefinition>;
    this.backends = [...backends];
    this.agents = [...agents];
  }

  get policies(): readonly Policy[] {
    return this._policies.map((e) => e.policy);
  }
  get skills(): readonly SkillManifest[] {
    return this._skills.map((e) => e.skill);
  }
  get fragments(): readonly PromptFragment[] {
    return this._fragments.map((e) => e.fragment);
  }

  get(name: string): ToolDefinition {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`Tool not found: ${name}`);
    return tool;
  }

  find(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  toolsFor(mode: Mode, ctx: PluginContext): ToolDefinition[] {
    const filter = this._modeFilters.get(mode);
    const all = [...this.tools.values()];
    if (!filter) return all;
    return all.filter((t) => {
      try {
        return filter(t, ctx);
      } catch {
        return false;
      }
    });
  }

  agentsFor(mode: Mode): readonly AgentDefinition[] {
    return this.agents.filter((agent) => !agent.hidden && agent.mode === mode);
  }

  agent(id: string): AgentDefinition | undefined {
    return this.agents.find((agent) => agent.id === id);
  }
}
