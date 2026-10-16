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
  Policy,
  TaskRegistry,
  PromptContext,
} from "@kli/api";
import type { Provider } from "./provider.js";
import { PromptBuilder } from "./prompt-builder.js";
import { hasCapabilities } from "./capability-gate.js";
import { resolvePath } from "./paths.js";

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
  projectId?: string;
  /** Capabilities available to this task (granted by the caller). */
  capabilities: ReadonlySet<Capability>;
  secrets?: Readonly<Record<string, string>>;
  config?: Readonly<Record<string, unknown>>;
  signal?: AbortSignal;
  maxRetries?: number;
  /** Called with each streamed assistant text delta, when the provider supports it. */
  onToken?: (delta: string) => void;
  /** Called with each streamed reasoning ("thinking") delta, when the model emits one. */
  onReasoning?: (delta: string) => void;
  /** Called as each tool call starts and finishes — used to drive live UI timelines. */
  onToolActivity?: (event: ToolActivity) => void;
}

export interface ToolActivity {
  phase: "start" | "end";
  name: string;
  args?: Record<string, unknown>;
  ok?: boolean;
  ms?: number;
  error?: string;
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
  constructor(
    private readonly opts: LoopOptions,
    private readonly promptBuilder: PromptBuilder,
  ) {}

  async run(): Promise<LoopResult> {
    const { taskId, mode, userMessage, registry, provider, bus, signal } =
      this.opts;
    const maxRetries = this.opts.maxRetries ?? MAX_RETRIES_DEFAULT;

    bus.emit({ type: "task.started", taskId, mode } as Event);

    let state: TaskState = this.initState(taskId, mode, userMessage);
    const toolCalls: LoopResult["toolCalls"] = [];
    let totalCost = 0;
    let fatalError = false;

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

      // 2c: assemble system prompt (reuse shared builder from kernel)
      const promptCtx = this.buildPromptContext(mode, visibleTools, userMessage);
      let systemPrompt = "";
      if (registry.fragments.length > 0) {
        systemPrompt = await this.promptBuilder.build(registry.fragments, promptCtx, visibleToolNames);
      }

      // 2d: provider step
      const stepStart = Date.now();
      try {
        const result: StepResult = await provider.step(
          state,
          visibleTools,
          systemPrompt,
          signal ?? new AbortController().signal,
          this.opts.onToken,
          {
            ...(this.opts.onToken ? { onToken: this.opts.onToken } : {}),
            ...(this.opts.onReasoning ? { onReasoning: this.opts.onReasoning } : {}),
          },
        );
        const stepMs = Date.now() - stepStart;

        state = this.updateBudget(state, result.tokensIn, result.tokensOut, result.cost);
        totalCost += result.cost;
        bus.emit({ type: "model.request", tokens: result.tokensIn } as Event);
        bus.emit({
          type: "model.response",
          tokens: result.tokensOut,
          cost: result.cost,
          ms: stepMs,
        } as Event);

        if (
          result.finishReason === "stop" ||
          result.finishReason === "end_turn" ||
          result.finishReason === "error"
        ) {
          if (result.finishReason === "error") fatalError = true;
          state = this.appendMessage(state, {
            role: "assistant",
            content: result.content ?? "",
          });
          state = this.markDone(state);
          break;
        }

        const calls = [...(result.toolCalls ?? [])];

        // Record the assistant turn that requested these tools. Providers
        // (OpenAI in particular) require the assistant `tool_calls` message to
        // precede the corresponding `tool` result messages.
        state = this.appendMessage(state, {
          role: "assistant",
          content: result.content ?? "",
          toolCalls: calls.map((c) => ({ id: c.id, name: c.name, args: c.args })),
        });

        if (calls.length === 0) {
          state = this.markDone(state);
          break;
        }

        // 2e: execute tool calls — non-exclusive in parallel, exclusive sequentially
        const parallelGroups = this.groupCallsByExclusivity(calls, visibleTools);
        for (const group of parallelGroups) {
          if (group.length === 1) {
            const first = group[0];
            if (!first) continue;
            const r = await this.runToolCall(first, state, registry, bus, maxRetries, signal);
            state = r.state;
            toolCalls.push(r.summary);
          } else {
            const results = await Promise.all(
              group.map((tc) => this.runToolCall(tc, state, registry, bus, maxRetries, signal)),
            );
            for (const r of results) {
              state = r.state;
              toolCalls.push(r.summary);
            }
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        fatalError = true;
        state = this.appendMessage(state, {
          role: "assistant",
          content: `Error: ${msg}`,
        });
        state = this.markDone(state);
      }

      state = { ...state, steps: state.steps + 1 };
    }

    const status = this.finalize(state, fatalError);
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

  /**
   * Group tool calls so that exclusive tools run sequentially and
   * non-exclusive tools run in parallel batches.
   */
  private groupCallsByExclusivity(
    calls: readonly { id: string; name: string; args: Record<string, unknown> }[],
    visibleTools: ToolDefinition[],
  ): Array<{ id: string; name: string; args: Record<string, unknown> }[]> {
    const toolMap = new Map(visibleTools.map((t) => [t.name, t]));
    const groups: Array<Array<{ id: string; name: string; args: Record<string, unknown> }>> = [];
    let currentGroup: typeof groups[0] = [];
    let hasExclusive = false;

    for (const tc of calls) {
      const tool = toolMap.get(tc.name);
      const isExclusive = tool?.exclusive === true;

      if (isExclusive) {
        // Flush current group, start a new one containing just this call
        if (currentGroup.length > 0) {
          groups.push(currentGroup);
          currentGroup = [];
        }
        groups.push([tc]);
      } else if (hasExclusive) {
        // After an exclusive call, start fresh group
        groups.push(currentGroup);
        currentGroup = [tc];
        hasExclusive = false;
      } else {
        currentGroup.push(tc);
      }
    }

    if (currentGroup.length > 0) {
      groups.push(currentGroup);
    }

    return groups.length > 0 ? groups : [[...calls]];
  }

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
      bus.emit({ type: "tool.completed", name: tc.name, ok: false, ms, error: result.error, code: result.code } as Event);
      return { state: next, summary: { name: tc.name, ok: false, ms } };
    }

    // Capability gate (Rule #2)
    if (!hasCapabilities(tool.capabilities, this.opts.capabilities)) {
      const missing = tool.capabilities.filter((c) => !this.opts.capabilities.has(c));
      const result: ToolResult = {
        ok: false,
        error: `Missing capabilities: ${missing.join(", ")}`,
        code: "CAPABILITY_DENIED",
      };
      const next = this.appendToolResult(state, tc.id, result);
      const ms = Date.now() - start;
      bus.emit({ type: "tool.completed", name: tc.name, ok: false, ms, error: result.error, code: result.code } as Event);
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
      bus.emit({ type: "tool.completed", name: tc.name, ok: false, ms, error: result.error, code: result.code } as Event);
      return { state: next, summary: { name: tc.name, ok: false, ms } };
    }

    // Per-call policy gate (§4.6 step 2e). Modes enforce read-only/bash rules here.
    const policyDecision = await this.policiesBeforeTool(
      tool.name,
      parsed.data as Record<string, unknown>,
      state,
      bus,
    );
    if (policyDecision.action === "veto" || policyDecision.action === "halt") {
      bus.emit({
        type: "policy.triggered",
        name: tool.name,
        reason: policyDecision.reason,
      } as Event);
      const result: ToolResult = {
        ok: false,
        error: policyDecision.reason,
        code: policyDecision.action === "veto" ? "POLICY_DENIED" : "POLICY_HALT",
      };
      const next = this.appendToolResult(state, tc.id, result);
      const ms = Date.now() - start;
      bus.emit({ type: "tool.completed", name: tc.name, ok: false, ms, error: result.error, code: result.code } as Event);
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
        args: tc.args,
      } as Event);
      this.opts.onToolActivity?.({ phase: "start", name: tool.name, args: tc.args });

      // Notify policies of the impending call (they may observe/annotate).
      await this.policiesOnToolCalled(tool.name, tc.args, state, bus);

      const execCtx = this.makePluginContext(state);
      let execResult: ToolResult;
      try {
        execResult = await tool.execute(parsed.data, execCtx, signal ?? new AbortController().signal);
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
        error: execResult.ok ? undefined : execResult.error,
        code: execResult.ok ? undefined : execResult.code,
      } as Event);
      this.opts.onToolActivity?.({
        phase: "end",
        name: tool.name,
        ok: execResult.ok,
        ms,
        ...(execResult.ok ? {} : { error: execResult.error }),
      });

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

  /**
   * Policies that apply to the current mode: global policies (no `mode`) plus
   * those explicitly scoped to the task's mode (e.g. plan-mode safety).
   */
  private activePolicies(state: TaskState): readonly Policy[] {
    return this.opts.registry.policies.filter(
      (p) => p.mode === undefined || p.mode === state.mode,
    );
  }

  private async policiesBeforeStep(state: TaskState, bus: Bus): Promise<PolicyDecision> {
    for (const p of this.activePolicies(state)) {
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

  /**
   * Ask every policy whether the tool call may proceed. First veto/halt wins.
   */
  private async policiesBeforeTool(
    name: string,
    args: Record<string, unknown>,
    state: TaskState,
    bus: Bus,
  ): Promise<PolicyDecision> {
    for (const p of this.activePolicies(state)) {
      try {
        if (p.beforeTool) {
          const d = await p.beforeTool({ name, args }, state, bus);
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

  /**
   * Notify all policies about an impending tool call. Policies observe via
   * `onEvent`; enforcement (veto/halt) happens through `beforeTool`/`beforeStep`.
   */
  private async policiesOnToolCalled(
    toolName: string,
    args: Record<string, unknown>,
    state: TaskState,
    bus: Bus,
  ): Promise<void> {
    for (const p of this.activePolicies(state)) {
      try {
        if (p.onEvent) {
          await p.onEvent(
            { type: "tool.called", name: toolName, argsHash: hashArgs(args), args } as Event,
            state,
            bus,
          );
        }
      } catch {
        // Policies must not crash the loop
      }
    }
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
      env: Object.freeze(sanitizeEnv()),
      userMessage,
      projectId: this.opts.projectId,
    };
  }

  private makePluginContext(state: TaskState): PluginContext {
    return {
      cwd: this.opts.cwd,
      workspaceRoot: this.opts.workspaceRoot,
      projectId: this.opts.projectId,
      budget: state.budget,
      capabilities: this.opts.capabilities,
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
  private finalize(state: TaskState, fatalError: boolean): "ok" | "error" | "halted" {
    if (!state.done) return "halted";
    // Tool-level failures are data the model handles; only a provider/harness
    // failure (bad response or thrown error) fails the task.
    if (fatalError) return "error";
    return "ok";
  }

  private async backoff(n: number): Promise<void> {
    const ms = Math.min(1000 * 2 ** (n - 1), 5000);
    await new Promise((r) => setTimeout(r, ms));
  }
}

function hashArgs(args: unknown): string {
  // Protect against circular references which would throw on JSON.stringify.
  const seen = new Set<unknown>();
  const stringify = (v: unknown): string => {
    if (v !== null && typeof v === "object") {
      if (seen.has(v)) return "[Circular]";
      seen.add(v);
    }
    return JSON.stringify(v);
  };
  let h = 0;
  try {
    const s = stringify(args);
    for (let i = 0; i < s.length; i++) {
      h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
    }
  } catch {
    return "err";
  }
  return Math.abs(h).toString(16);
}

/** Secrets that must never be exposed in prompts or logs. */
const SECRET_KEYS = new Set([
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "BRAVE_API_KEY",
  "GITHUB_TOKEN",
  "SLACK_TOKEN",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
]);

function sanitizeEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !SECRET_KEYS.has(k)) out[k] = v;
  }
  return out;
}
