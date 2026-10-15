/**
 * Agents — subagent definitions, built-in defaults, and the delegation tool.
 *
 * An agent is a named, reusable persona: a mode, a model, a tool allow-list and
 * a prompt fragment. The parent model delegates work to one by calling the tool
 * returned by `createDelegationTool`, which runs a full nested task with a fresh
 * loop and returns only the subagent's final report.
 *
 * Agents are *configuration*, not code — the built-ins below are defaults that
 * users override from `.kli/agents.json`, the CLI (`kli agent add`) or the UI.
 */

import { z } from "zod";
import { ModeSchema } from "./mode.js";
import { PromptFragmentSchema } from "./prompt.js";
import type { PromptFragment } from "./prompt.js";
import type { Budget, PluginContext } from "./context.js";
import type { ToolDefinition, ToolResult } from "./tool.js";

export const AgentDefinitionSchema = z.object({
  /** Unique slug, `[a-z0-9-]+`. Also the tool argument value. */
  id: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9-]*$/, "agent ids must be lowercase slugs"),
  name: z.string().min(1).max(80),
  description: z.string().min(1).max(400),
  /** Mode the subagent runs under — decides which tools are visible. */
  mode: ModeSchema,
  /** Provider model id. `null` inherits the parent task's model. */
  model: z.string().min(1).max(120).nullable().default(null),
  /** Explicit tool allow-list. `null` means "everything the mode allows". */
  tools: z.array(z.string().min(1)).nullable().default(null),
  /** Extra system prompt contributed only while this agent runs. */
  instructions: z.string().max(4000).default(""),
  /** Accent used by UIs when rendering this agent. */
  color: z.string().max(32).default("violet"),
  /** Hidden agents cannot be picked by the model. */
  hidden: z.boolean().default(false),
  /** Built-in agents cannot be deleted, only overridden. */
  builtin: z.boolean().default(false),
  /** How many subagents of this kind may run concurrently in one task. */
  maxConcurrency: z.number().int().min(1).max(8).default(2),
});

export type AgentDefinition = z.infer<typeof AgentDefinitionSchema>;

/** Builds the prompt fragment an agent contributes while it is running. */
export function agentPromptFragment(agent: AgentDefinition): PromptFragment {
  const parsed = PromptFragmentSchema.parse({
    id: `agent.${agent.id}`,
    priority: 120,
    position: "mode",
    modes: [agent.mode],
    content: [
      `You are acting as the **${agent.name}** subagent.`,
      agent.description,
      agent.instructions,
    ]
      .filter((part) => part.trim().length > 0)
      .join("\n\n"),
  });
  return parsed as PromptFragment;
}

/** Serialised shape used by `kli agent list` and the HTTP API. */
export interface AgentSummary {
  id: string;
  name: string;
  description: string;
  mode: z.infer<typeof ModeSchema>;
  model: string | null;
  tools: string[] | null;
  color: string;
  builtin: boolean;
  hidden: boolean;
}

export function toAgentSummary(agent: AgentDefinition): AgentSummary {
  return {
    id: agent.id,
    name: agent.name,
    description: agent.description,
    mode: agent.mode,
    model: agent.model,
    tools: agent.tools,
    color: agent.color,
    builtin: agent.builtin,
    hidden: agent.hidden,
  };
}

/** Result of one delegated subagent run. */
export interface AgentRunResult {
  agentId: string;
  status: "ok" | "error" | "halted";
  /** Final assistant text — this is what the parent model receives. */
  output: string;
  steps: number;
  toolCalls: Array<{ name: string; ok: boolean; ms: number }>;
  costUsd: number;
  tokensUsed: number;
  durationMs: number;
  error?: string;
}

/** Progress callbacks a host can wire to a UI while a subagent runs. */
export interface AgentRunHooks {
  onToken?: (delta: string) => void;
  onReasoning?: (delta: string) => void;
  onToolCall?: (name: string, args: Record<string, unknown>) => void;
  onToolResult?: (name: string, ok: boolean, ms: number) => void;
}

/* ── Built-in defaults ─────────────────────────────────────────────────── */

const RAW_DEFAULTS = [
  {
    id: "explorer",
    name: "Explorador",
    description:
      "Read-only scout. Finds files, symbols and code paths, then reports what it found with file:line references.",
    mode: "ask" as const,
    tools: ["read_file", "execute_bash", "web_search", "fetch_url", "graph_query", "graph_stats"],
    instructions:
      "Never modify anything. Search first, read second, then answer with concrete references. " +
      "Return a compact report: what exists, where it lives, and anything surprising.",
    color: "cyan",
    hidden: false,
  },
  {
    id: "researcher",
    name: "Investigador",
    description: "Web researcher. Answers questions that need current or external information, with sources.",
    mode: "ask" as const,
    tools: ["web_search", "fetch_url", "read_file"],
    instructions:
      "Search before answering. Cite every non-obvious claim with its URL. " +
      "If sources disagree, say so instead of picking one.",
    color: "violet",
    hidden: false,
  },
  {
    id: "coder",
    name: "Implementador",
    description: "Writes and edits code, then verifies the result with a real build/test/typecheck command.",
    mode: "build" as const,
    tools: null,
    instructions:
      "Make the smallest change that satisfies the task and match the surrounding style. " +
      "Always verify with a real command before reporting success.",
    color: "emerald",
    hidden: false,
  },
  {
    id: "reviewer",
    name: "Revisor",
    description: "Reviews a diff or a set of files for correctness, security and regressions. Read-only.",
    mode: "ask" as const,
    tools: ["read_file", "execute_bash", "graph_query"],
    instructions:
      "Look for real defects: broken invariants, unhandled errors, injection paths, race conditions. " +
      "Rank findings by severity and cite file:line. Say 'no issues found' if that is the truth.",
    color: "amber",
    hidden: false,
  },
  {
    id: "orchestrator",
    name: "Orquestador",
    description: "Breaks a large goal into sub-tasks and delegates each one to the right subagent.",
    mode: "plan" as const,
    tools: null,
    instructions:
      "Decompose the goal, delegate each piece, then synthesise the results. Never do the delegated work yourself.",
    color: "rose",
    hidden: true,
  },
];

/** Built-in subagents, validated once at module load. */
export function defaultAgents(): AgentDefinition[] {
  return RAW_DEFAULTS.map((raw) => AgentDefinitionSchema.parse({ ...raw, model: null, builtin: true }));
}

/* ── Persistence (`.kli/agents.json`) ──────────────────────────────────── */

export const AgentsFileSchema = z.object({
  version: z.number().int().default(1),
  agents: z.array(AgentDefinitionSchema).default([]),
});

export type AgentsFile = z.infer<typeof AgentsFileSchema>;

/**
 * Merges user entries over the defaults. A user entry with the same id replaces
 * the built-in; `builtin` always stays true so the UI can still mark it as such.
 */
export function mergeAgents(base: AgentDefinition[], overrides: AgentDefinition[]): AgentDefinition[] {
  const merged = new Map(base.map((agent) => [agent.id, agent]));
  for (const override of overrides) {
    const previous = merged.get(override.id);
    merged.set(override.id, previous ? { ...previous, ...override, builtin: previous.builtin } : override);
  }
  return [...merged.values()];
}

/* ── Delegation tool ───────────────────────────────────────────────────── */

export interface DelegationDeps {
  /** Runs one subagent task to completion. */
  runAgent(
    agent: AgentDefinition,
    task: string,
    signal: AbortSignal,
    hooks: AgentRunHooks,
  ): Promise<AgentRunResult>;
  /** Agents the parent model may pick from (deduplicated across modes). */
  listAgents(): readonly AgentDefinition[];
}

const DelegationArgsSchema = z.object({
  agent: z.string().min(1).describe("id of the subagent to delegate to"),
  task: z.string().min(1).describe("self-contained instructions for the subagent"),
  context: z
    .string()
    .optional()
    .describe("extra context the subagent needs (file paths, prior findings)"),
});

export type DelegationArgs = z.infer<typeof DelegationArgsSchema>;

export interface DelegationToolOptions {
  /** Budget slice handed to each delegated run. */
  budget: Budget;
  /** Register the tool as `exclusive` so runs are serialised. */
  exclusive?: boolean;
}

/**
 * Builds the tool the parent model uses to spawn a subagent. The tool *name* is
 * supplied by the host so nothing here hard-codes a surface (Rule #7).
 */
export function createDelegationTool(
  name: string,
  deps: DelegationDeps,
  options: DelegationToolOptions,
): ToolDefinition<DelegationArgs> {
  const available = () => {
    const seen = new Map<string, AgentDefinition>();
    for (const agent of deps.listAgents()) {
      if (!agent.hidden) seen.set(agent.id, agent);
    }
    return [...seen.values()];
  };

  return {
    name,
    description:
      `Delegate a self-contained task to one of these subagents: ${available()
        .map((agent) => `${agent.id} (${agent.description})`)
        .join("; ")}. ` +
      "Use it for work that would flood your context (broad searches, long file dumps, independent subtasks). " +
      "You receive only the subagent's final report back.",
    schema: DelegationArgsSchema,
    capabilities: [],
    ...(options.exclusive === undefined ? {} : { exclusive: options.exclusive }),
    async execute(args, _ctx: PluginContext, signal: AbortSignal): Promise<ToolResult> {
      const agents = available();
      const agent = agents.find((candidate) => candidate.id === args.agent);
      if (!agent) {
        return {
          ok: false,
          error: `Unknown subagent "${args.agent}". Available: ${agents.map((a) => a.id).join(", ")}`,
          code: "NOT_FOUND",
        };
      }

      const prompt = args.context ? `${args.task}\n\nContext you need:\n${args.context}` : args.task;
      try {
        const result = await deps.runAgent(agent, prompt, signal, {
          onToolCall: () => undefined,
        });
        if (result.status === "error") {
          return {
            ok: false,
            error: result.error ?? `Subagent "${agent.id}" failed`,
            code: "EXECUTION_ERROR",
          };
        }
        return {
          ok: true,
          content: result.output || `(subagent "${agent.id}" produced no output)`,
          data: {
            agent: agent.id,
            steps: result.steps,
            toolCalls: result.toolCalls,
            tokensUsed: result.tokensUsed,
            costUsd: result.costUsd,
            durationMs: result.durationMs,
          },
        };
      } catch (error) {
        if (signal.aborted) return { ok: false, error: "Cancelado", code: "ABORTED" };
        return {
          ok: false,
          error: error instanceof Error ? error.message : "Subagent failed",
          code: "EXECUTION_ERROR",
        };
      }
    },
  };
}