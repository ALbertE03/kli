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
} from "@kli/api";
import type { Provider } from "./provider.js";

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
  /** Streamed assistant text deltas, when the provider supports streaming. */
  onToken?: (delta: string) => void;
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
