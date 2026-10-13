/**
 * Agent loop — plan → act → observe → reflect (§4.6, §13).
 *
 * Kernel rules honored here:
 *  - no tool name is hardcoded (Rule #7)
 *  - capabilities checked before every call (Rule #2)
 *  - AbortSignal respected on every execute (Rule #8)
 *  - paths resolved via ctx.resolve (Rule #3)
 */

import type {
  TaskState,
  Message,
  Mode,
  ToolDefinition,
  ToolResult,
  PolicyDecision,
  Bus,
  Event,
  PluginContext,
  StepResult,
  Budget,
  GraphSummary,
  Capability,
} from "@kli/api";
import type { TaskRegistry } from "@kli/api";
import type { PromptContext } from "@kli/api";
import type { Provider } from "./provider.js";
import { PromptBuilder } from "./prompt-builder.js";
import { hasCapabilities } from "./capability-gate.js";
import { resolvePath } from "./paths.js";

type CapSet = ReadonlySet<string>;

export interface LoopOptions {
  taskId: string;
  mode: Mode;
  userMessage: string;
  budget: Budget;
  /** Frozen task registry (Rule #4). */
  registry: TaskRegistry;
  provider: Provider;
  bus: Bus;
  workspaceRoot: string;
  cwd: string;
  graph?: { summary?: GraphSummary };
  /** Capabilities available to this task (granted by the caller). */
  capabilities: ReadonlySet<string>;
  secrets?: Readonly<Record<string, string>>;
  config?: Readonly<Record<string, unknown>>;
  signal?: AbortSignal;
  maxRetries?: number;
}

export interface LoopResult {
  status: "ok" | "error" | "halted";
  messages: Message[];
  budget: Budget;
  steps: number;
  cost: number;
  toolCalls: Array<{ name: string; ok: boolean; ms: number }>;
}

const MAX_RETRIES_DEFAULT = 3;
const RETRYABLE_CODES = new Set(["STALE", "RATE_LIMIT", "TIMEOUT"]);

export class Loop {
  constructor(private readonly opts: LoopOptions) {}

  async run(): Promise<LoopResult> {
    const { taskId, mode, userMessage, registry, provider, bus, signal } =
      this.opts;
    const maxRetries = this.opts.maxRetries ?? MAX_RETRIES_DEFAULT;

    bus.emit({ type: "task.started", taskId, mode } as Event);

    let state: TaskState = this.initState(taskId, mode, userMessage);
    const toolCalls: LoopResult["toolCalls"] = [];
    let totalCost = 0;

    while (!state.done && !(signal?.aborted ?? false)) {
      if (this.budgetExceeded(state.budget, signal)) {
        bus.emit({
          type: "policy.triggered",
          name: "budget",
          reason: "budget exhausted",
        } as Event);
        break;
      }

      // 2a: run policies beforeStep
      const decision = await this.policiesBeforeStep(state, bus);
      if (decision.action === "veto") {
        bus.emit({
          type: "policy.triggered",
          name: "veto",
          reason: decision.reason,
        } as Event);
        state = this.markDone(state);
        break;
      }
      if (decision.action === "halt") {
        bus.emit({
          type: "policy.triggered",
          name: "halt",
          reason: decision.reason,
        } as Event);
        state = this.markDone(state);
        break;
      }
      if (decision.action === "mutate") {
        state = { ...state, ...decision.patch } as TaskState;
      }

      // 2b: compute visible tools
      const ctx = this.makePluginContext(state);
      const visibleTools = registry.toolsFor(mode, ctx);
      const visibleToolNames = new Set(visibleTools.map((t) => t.name));

      // 2c: assemble system prompt
      const promptCtx = this.buildPromptContext(mode, visibleTools, userMessage);
      let systemPrompt = "";
      if (registry.fragments.length > 0) {
        const pb = new PromptBuilder();
        systemPrompt = await pb.build(registry.fragments, promptCtx, visibleToolNames);
      }

      // 2d: provider step
      try {
        const result: StepResult = await provider.step(
          state,
          visibleTools,
          systemPrompt,
          signal ?? new AbortController().signal,
        );

        state = this.updateBudget(state, result.tokensIn, result.tokensOut, result.cost);
        totalCost += result.cost;
        bus.emit({ type: "model.request", tokens: result.tokensIn } as Event);
        bus.emit({
          type: "model.response",
          tokens: result.tokensOut,
          cost: result.cost,
        } as Event);

        if (
          result.finishReason === "stop" ||
          result.finishReason === "end_turn" ||
          result.finishReason === "error"
        ) {
          state = this.appendMessage(state, {
            role: "assistant",
            content: result.content ?? "",
          });
          state = this.markDone(state);
          break;
        }

        const calls = result.toolCalls ?? [];
        if (calls.length === 0) {
          state = this.markDone(state);
          break;
        }

        // 2e: execute tool calls sequentially
        for (const tc of calls) {
          const r = await this.runToolCall(tc, state, registry, bus, maxRetries, signal);
          state = r.state;
          toolCalls.push(r.summary);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        state = this.appendMessage(state, {
          role: "assistant",
          content: `Error: ${msg}`,
        });
        state = this.markDone(state);
      }

      state = { ...state, steps: state.steps + 1 };
    }

    const status = this.finalize(state);
    bus.emit({ type: "task.finished", status, cost: totalCost } as Event);

    return {
      status,
      messages: [...state.messages],
      budget: state.budget,
      steps: state.steps,
      cost: totalCost,
      toolCalls,
    };
  }

  /* ----------------------------------------------------- *
   * Tool execution
   * ----------------------------------------------------- */

  private async runToolCall(
    tc: { id: string; name: string; args: Record<string, unknown> },
    state: TaskState,
    registry: TaskRegistry,
    bus: Bus,
    maxRetries: number,
    signal?: AbortSignal,
  ): Promise<{ state: TaskState; summary: { name: string; ok: boolean; ms: number } }> {
    const start = Date.now();

    let tool: ToolDefinition;
    try {
      tool = registry.get(tc.name);
    } catch {
      const result: ToolResult = {
        ok: false,
        error: `Unknown tool: ${tc.name}`,
        code: "UNKNOWN_TOOL",
      };
      const next = this.appendToolResult(state, tc.id, result);
      const ms = Date.now() - start;
      bus.emit({ type: "tool.completed", name: tc.name, ok: false, ms } as Event);
      return { state: next, summary: { name: tc.name, ok: false, ms } };
    }

    // Capability gate (Rule #2)
    const capSet = this.opts.capabilities as CapSet;
    if (!hasCapabilities(tool.capabilities as readonly Capability[], capSet)) {
      const missing = tool.capabilities.filter((c) => !capSet.has(c as string));
      const result: ToolResult = {
        ok: false,
        error: `Missing capabilities: ${missing.join(", ")}`,
        code: "CAPABILITY_DENIED",
      };
      const next = this.appendToolResult(state, tc.id, result);
      const ms = Date.now() - start;
      bus.emit({ type: "tool.completed", name: tc.name, ok: false, ms } as Event);
      return { state: next, summary: { name: tc.name, ok: false, ms } };
    }

    // Schema validation (§4.6 step 2e)
    const parsed = tool.schema.safeParse(tc.args);
    if (!parsed.success) {
      const result: ToolResult = {
        ok: false,
        error: `Schema validation failed: ${parsed.error.message}`,
        code: "SCHEMA_ERROR",
      };
      const next = this.appendToolResult(state, tc.id, result);
      const ms = Date.now() - start;
      bus.emit({ type: "tool.completed", name: tc.name, ok: false, ms } as Event);
      return { state: next, summary: { name: tc.name, ok: false, ms } };
    }

    // Execute with retry (§8)
    let attempt = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      bus.emit({
        type: "tool.called",
        name: tool.name,
        argsHash: hashArgs(tc.args),
      } as Event);

      const execCtx = this.makePluginContext(state);
      let execResult: ToolResult;
      try {
        execResult = await tool.execute(parsed.data, execCtx, signal!);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        execResult = { ok: false, error: msg, code: "EXECUTION_ERROR" };
      }

      const ms = Date.now() - start;
      bus.emit({
        type: "tool.completed",
        name: tool.name,
        ok: execResult.ok,
        ms,
      } as Event);

      const isRetryable =
        !execResult.ok &&
        (execResult.retryable === true ||
          (execResult.code != null && RETRYABLE_CODES.has(execResult.code)));

      if (isRetryable && attempt < maxRetries) {
        attempt++;
        await this.backoff(attempt);
        continue;
      }

      const next = this.appendToolResult(state, tc.id, execResult);
      return {
        state: next,
        summary: { name: tc.name, ok: execResult.ok, ms },
      };
    }
  }

  private appendToolResult(
    state: TaskState,
    toolCallId: string,
    result: ToolResult,
  ): TaskState {
    const content = result.ok ? result.content : JSON.stringify(result);
    return {
      ...state,
      messages: [
        ...state.messages,
        { role: "tool", content, toolCallId },
      ],
      lastToolResults: [
        ...state.lastToolResults,
        { name: toolCallId, ok: result.ok, step: state.steps },
      ],
    };
  }

  private appendMessage(state: TaskState, msg: Message): TaskState {
    return { ...state, messages: [...state.messages, msg] };
  }

  /* ----------------------------------------------------- *
   * Lifecycle helpers
   * ----------------------------------------------------- */

  private initState(taskId: string, mode: Mode, userMessage: string): TaskState {
    return {
      taskId,
      mode,
      messages: [{ role: "user", content: userMessage }],
      budget: { ...this.opts.budget },
      steps: 0,
      done: false,
      verificationPassed: false,
      lastToolResults: [],
    };
  }

  private markDone(state: TaskState): TaskState {
    return { ...state, done: true };
  }

  private budgetExceeded(b: Budget, signal?: AbortSignal): boolean {
    if (signal?.aborted) return true;
    if (b.tokensTotal > 0 && b.tokensUsed >= b.tokensTotal) return true;
    if (b.costLimitUsd > 0 && b.costUsd >= b.costLimitUsd) return true;
    if (b.deadlineMs > 0 && Date.now() >= b.deadlineMs) return true;
    return false;
  }

  private updateBudget(
    state: TaskState,
    inTokens: number,
    outTokens: number,
    cost: number,
  ): TaskState {
    return {
      ...state,
      budget: {
        ...state.budget,
        tokensUsed: state.budget.tokensUsed + inTokens + outTokens,
        costUsd: state.budget.costUsd + cost,
      },
    };
  }

  private async policiesBeforeStep(state: TaskState, bus: Bus): Promise<PolicyDecision> {
    for (const p of this.opts.registry.policies) {
      try {
        if (p.beforeStep) {
          const d = await p.beforeStep(state, bus);
          if (d.action !== "continue") return d;
        }
      } catch (err) {
        bus.emit({
          type: "policy.triggered",
          name: p.name,
          reason: err instanceof Error ? err.message : String(err),
        } as Event);
      }
    }
    return { action: "continue" };
  }

  private buildPromptContext(
    mode: Mode,
    visibleTools: ToolDefinition[],
    userMessage: string,
  ): PromptContext {
    return {
      workspaceRoot: this.opts.workspaceRoot,
      cwd: this.opts.cwd,
      mode,
      visibleTools: visibleTools.map((t) => ({
        name: t.name,
        description: t.description,
        schema: t.schema,
      })),
      budget: {
        tokensTotal: this.opts.budget.tokensTotal,
        tokensUsed: this.opts.budget.tokensUsed,
        costLimitUsd: this.opts.budget.costLimitUsd,
        costUsd: this.opts.budget.costUsd,
        deadlineMs: this.opts.budget.deadlineMs,
      },
      graphSummary: this.opts.graph?.summary,
      env: process.env as Record<string, string>,
      userMessage,
    };
  }

  private makePluginContext(state: TaskState): PluginContext {
    return {
      cwd: this.opts.cwd,
      workspaceRoot: this.opts.workspaceRoot,
      budget: state.budget,
      capabilities: this.opts.capabilities as ReadonlySet<Capability>,
      logger: {
        debug: console.debug,
        info: console.info,
        warn: console.warn,
        error: console.error,
      },
      emit: (e: Event) => this.opts.bus.emit(e),
      secrets: this.opts.secrets ?? {},
      config: this.opts.config ?? {},
      resolve: (p: string) => resolvePath(p, this.opts.workspaceRoot),
    };
  }

  /**
   * §13 Definition of Done.
   *  - plan & ask: model self-declares done + policies continued
   *  - build: also requires ok tool result in last 3 steps
   */
  private finalize(state: TaskState): "ok" | "error" | "halted" {
    if (!state.done) return "halted";
    if (state.mode === "build") {
      const tail = state.lastToolResults.slice(-3);
      if (!tail.some((r) => r.ok)) {
        return "error";
      }
    }
    return "ok";
  }

  private async backoff(n: number): Promise<void> {
    const ms = Math.min(1000 * 2 ** (n - 1), 5000);
    await new Promise((r) => setTimeout(r, ms));
  }
}

function hashArgs(args: unknown): string {
  const s = JSON.stringify(args);
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h).toString(16);
}
