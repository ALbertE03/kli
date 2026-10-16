/**
 * Kernel public types.
 */
import type {
  Logger,
  Capability,
  Budget,
  Mode,
  Capabilities,
  GraphSummary,
  AgentDefinition,
} from "@kli/api";
import type { Provider } from "./provider.js";
import type { ToolActivity } from "./loop.js";

export interface KernelBootOptions {
  workspaceRoot?: string;
  capabilities?: Capabilities;
  logger?: Logger;
  config?: Record<string, unknown>;
  secrets?: Record<string, string>;
  sessionId?: string;
}

export interface SessionMetadata {
  id: string;
  createdAt: number;
  updatedAt: number;
  workspaceRoot: string;
  mode: Mode;
  pluginCount: number;
  taskId: string;
}

export interface TaskRunOptions {
  taskId?: string;
  mode: Mode;
  message: string;
  budget: Budget;
  provider: Provider;
  cwd?: string;
  capabilities: ReadonlySet<Capability>;
  secrets?: Readonly<Record<string, string>>;
  config?: Readonly<Record<string, unknown>>;
  signal?: AbortSignal;
  graph?: { summary?: GraphSummary };
  projectId?: string;
  /** Streamed assistant text deltas, when the provider supports streaming. */
  onToken?: (delta: string) => void;
  /** Streamed reasoning ("thinking") deltas from reasoning models. */
  onReasoning?: (delta: string) => void;
  /** Live tool-call timeline, for UIs. */
  onToolActivity?: (event: ToolActivity) => void;
}

export interface TaskRunResult {
  status: "ok" | "error" | "halted";
  messages: Array<{
    role: string;
    content: string;
    toolCallId?: string | undefined;
  }>;
  budget: Budget;
  steps: number;
  cost: number;
  toolCalls: Array<{ name: string; ok: boolean; ms: number }>;
}

export interface AgentRunOptions {
  /** Self-contained instructions handed to the subagent. */
  task: string;
  /** Agent to run. Its mode, model and tool allow-list are enforced. */
  agent: AgentDefinition;
  /** Model for the subagent. Defaults to the parent's provider. */
  provider: Provider;
  budget: Budget;
  capabilities: ReadonlySet<Capability>;
  cwd?: string;
  secrets?: Readonly<Record<string, string>>;
  config?: Readonly<Record<string, unknown>>;
  signal?: AbortSignal;
  graph?: { summary?: GraphSummary };
  /**
   * Tool names the subagent must never see, even if its own allow-list and the
   * mode filter permit them. Hosts use this to stop a subagent from recursively
   * re-entering the delegation tool. The kernel itself names no tool (Rule #7).
   */
  denyTools?: readonly string[];
  onToken?: (delta: string) => void;
  onReasoning?: (delta: string) => void;
  onToolActivity?: (event: ToolActivity) => void;
}
