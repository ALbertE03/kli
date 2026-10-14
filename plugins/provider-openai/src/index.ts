/**
 * @kli/provider-openai — OpenAI-compatible provider
 *
 * Connects to any OpenAI-compatible API (OpenAI, Ollama, LocalAI, vLLM, etc.)
 *
 * Usage:
 *   const provider = new OpenAiProvider({
 *     baseURL: "http://127.0.0.1:31415/v1",
 *     model: "llama-3",
 *     apiKey: "any-key", // local servers often don't require auth
 *   });
 */
import OpenAI from "openai";
import type {
  HarnessPlugin,
  Provider,
  TaskState,
  ToolDefinition,
  StepResult,
  ModelInfo,
} from "@kli/api";
import { toJsonSchema } from "@kli/api";

export interface OpenAiProviderOptions {
  apiKey?: string;
  model?: string;
  baseURL?: string;
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  presencePenalty?: number;
  frequencyPenalty?: number;
  stop?: string[];
  seed?: number;
  reasoningEffort?: string;
  stream?: boolean;
}

interface OpenAIToolFunction {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

interface OpenAIChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_call_id?: string;
  tool_calls?: OpenAIToolCall[];
}

interface OpenAIToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

interface OpenAIChoice {
  message?: OpenAIChatMessage;
  finish_reason: string | null;
}

interface OpenAIUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
}

interface OpenAIResponse {
  choices?: OpenAIChoice[];
  usage?: OpenAIUsage;
}

interface OpenAIModel {
  id: string;
  context_length?: number;
}

/** Streaming chunk shape (subset we care about). */
interface OpenAIStreamDelta {
  content?: string | null;
  reasoning_content?: string | null;
  tool_calls?: Array<{
    index: number;
    id?: string;
    function?: { name?: string; arguments?: string };
  }>;
}
interface OpenAIStreamChunk {
  choices?: Array<{ delta?: OpenAIStreamDelta; finish_reason?: string | null }>;
  usage?: OpenAIUsage | null;
}

export class OpenAiProvider implements Provider {
  readonly name = "openai";
  private readonly client: OpenAI;
  readonly model: string;
  private readonly temperature: number;
  private readonly maxTokens: number;
  private readonly topP?: number;
  private readonly presencePenalty?: number;
  private readonly frequencyPenalty?: number;
  private readonly stop?: string[];
  private readonly seed?: number;
  private readonly reasoningEffort?: string;
  private readonly stream: boolean;
  /** Last measured throughput, for CLI display. */
  lastTokensPerSecond = 0;

  constructor(opts: OpenAiProviderOptions = {}) {
    this.model = opts.model ?? process.env.KLI_MODEL ?? "auto";
    this.temperature = opts.temperature ?? envFloat("KLI_TEMPERATURE", 0.7);
    this.maxTokens = opts.maxTokens ?? envInt("KLI_MAX_OUTPUT_TOKENS", 4096);
    this.topP = opts.topP ?? envFloatOpt("KLI_TOP_P");
    this.presencePenalty = opts.presencePenalty ?? envFloatOpt("KLI_PRESENCE_PENALTY");
    this.frequencyPenalty = opts.frequencyPenalty ?? envFloatOpt("KLI_FREQUENCY_PENALTY");
    this.stop = opts.stop ?? envList("KLI_STOP");
    this.seed = opts.seed ?? envIntOpt("KLI_SEED");
    this.reasoningEffort = opts.reasoningEffort ?? process.env.KLI_REASONING_EFFORT;
    this.stream = opts.stream ?? process.env.KLI_STREAM !== "0";

    const apiKey = opts.apiKey ?? process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error(
        "OpenAI API key not configured. Pass apiKey or set OPENAI_API_KEY env var.",
      );
    }

    const clientOpts: ConstructorParameters<typeof OpenAI>[0] = {
      apiKey,
    };

    if (opts.baseURL) {
      clientOpts.baseURL = opts.baseURL;
    }

    this.client = new OpenAI(clientOpts);
  }

  async step(
    state: TaskState,
    tools: readonly ToolDefinition[],
    systemPrompt: string,
    signal: AbortSignal,
    onToken?: (delta: string) => void,
  ): Promise<StepResult> {
    const toolDefs: OpenAIToolFunction[] = tools.map((t) => ({
      type: "function" as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: toJsonSchema(t.schema),
      },
    }));

    const messages: OpenAIChatMessage[] = [
      { role: "system", content: systemPrompt },
      ...state.messages.map(
        (m): OpenAIChatMessage => {
          const msg: OpenAIChatMessage = {
            role: m.role as OpenAIChatMessage["role"],
            content: m.content ?? "",
          };
          if (m.toolCallId) msg.tool_call_id = m.toolCallId;
          if (m.role === "assistant" && m.toolCalls?.length) {
            msg.tool_calls = m.toolCalls.map((tc) => ({
              id: tc.id,
              type: "function" as const,
              function: {
                name: tc.name,
                arguments:
                  typeof tc.args === "string" ? tc.args : JSON.stringify(tc.args),
              },
            }));
          }
          return msg;
        },
      ),
    ];

    const params: Record<string, unknown> = {
      model: this.model,
      messages,
    };
    if (toolDefs.length > 0) params.tools = toolDefs;
    if (this.temperature !== undefined) params.temperature = this.temperature;
    if (this.maxTokens !== undefined) params.max_tokens = this.maxTokens;
    if (this.topP !== undefined) params.top_p = this.topP;
    if (this.presencePenalty !== undefined) params.presence_penalty = this.presencePenalty;
    if (this.frequencyPenalty !== undefined) params.frequency_penalty = this.frequencyPenalty;
    if (this.stop && this.stop.length > 0) params.stop = this.stop;
    if (this.seed !== undefined) params.seed = this.seed;
    if (this.reasoningEffort !== undefined) params.reasoning_effort = this.reasoningEffort;

    try {
      if (this.stream && onToken) {
        let emitted = false;
        const trackToken = (delta: string): void => {
          emitted = true;
          onToken(delta);
        };
        try {
          return await this.streamStep(params, signal, trackToken);
        } catch (streamErr) {
          // Some OpenAI-compatible routers reject `stream_options`. Only fall
          // back if we have not already emitted partial output.
          if (emitted) throw streamErr;
          const msg = streamErr instanceof Error ? streamErr.message : String(streamErr);
          console.error(`OpenAI streaming failed, retrying buffered: ${msg}`);
        }
      }
      return await this.bufferedStep(params, signal);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`OpenAI provider error: ${msg}`);
      return { finishReason: "error", tokensIn: 0, tokensOut: 0, cost: 0 };
    }
  }

  private async bufferedStep(
    params: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<StepResult> {
    const response = (await this.client.chat.completions.create(
      params as unknown as Parameters<typeof this.client.chat.completions.create>[0],
      { signal },
    )) as unknown as OpenAIResponse;

    const choice = response.choices?.[0];
    if (!choice) {
      return { finishReason: "error", tokensIn: 0, tokensOut: 0, cost: 0 };
    }

    const msg = choice.message;
    const tokensIn = response.usage?.prompt_tokens ?? 0;
    const tokensOut = response.usage?.completion_tokens ?? 0;

    return {
      content: msg?.content || undefined,
      finishReason: mapFinishReason(choice.finish_reason),
      toolCalls: normaliseToolCalls(msg?.tool_calls),
      tokensIn,
      tokensOut,
      cost: this.estimateCost(tokensIn, tokensOut),
    };
  }

  /**
   * Streaming path. Emits text deltas through `onToken`, accumulates tool-call
   * fragments, and reports tokens/s via `lastTokensPerSecond`.
   */
  private async streamStep(
    params: Record<string, unknown>,
    signal: AbortSignal,
    onToken: (delta: string) => void,
  ): Promise<StepResult> {
    const started = Date.now();
    const stream = (await this.client.chat.completions.create(
      {
        ...params,
        stream: true,
        stream_options: { include_usage: true },
      } as unknown as Parameters<typeof this.client.chat.completions.create>[0],
      { signal },
    )) as unknown as AsyncIterable<OpenAIStreamChunk>;

    let content = "";
    let finishReason = "stop";
    let usage: OpenAIUsage | undefined;
    const toolAcc = new Map<number, { id: string; name: string; args: string }>();

    for await (const chunk of stream) {
      if (signal.aborted) break;
      const choice = chunk.choices?.[0];
      if (chunk.usage) usage = chunk.usage;
      if (!choice) continue;
      const delta = choice.delta;
      if (delta?.content) {
        content += delta.content;
        onToken(delta.content);
      }
      if (choice.finish_reason) finishReason = choice.finish_reason;
      for (const tc of delta?.tool_calls ?? []) {
        const acc = toolAcc.get(tc.index) ?? { id: "", name: "", args: "" };
        if (tc.id) acc.id = tc.id;
        if (tc.function?.name) acc.name = tc.function.name;
        if (tc.function?.arguments) acc.args += tc.function.arguments;
        toolAcc.set(tc.index, acc);
      }
    }

    const tokensOut = usage?.completion_tokens ?? this.countTokens(content);
    const tokensIn = usage?.prompt_tokens ?? 0;
    const elapsed = Math.max(1, Date.now() - started);
    this.lastTokensPerSecond = tokensOut / (elapsed / 1000);

    const toolCalls = [...toolAcc.values()]
      .filter((t) => t.name)
      .map((t) => ({
        id: t.id || `call_${Math.random().toString(36).slice(2)}`,
        name: t.name,
        args: safeParseArgs(t.args),
      }));

    return {
      content: content || undefined,
      finishReason: mapFinishReason(finishReason),
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      tokensIn,
      tokensOut,
      cost: this.estimateCost(tokensIn, tokensOut),
    };
  }

  async listModels(): Promise<ModelInfo[]> {
    try {
      const response = (await this.client.models.list()) as unknown as {
        data: OpenAIModel[];
      };
      return response.data.map((m) => ({
        id: m.id,
        context_window: m.context_length,
      }));
    } catch {
      return [];
    }
  }

  countTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  estimateCost(tokensIn: number, tokensOut: number): number {
    return tokensIn * 0.0000025 + tokensOut * 0.00001;
  }
}

function mapFinishReason(
  reason: string | null | undefined,
): StepResult["finishReason"] {
  if (reason === "tool_calls") return "tool_use";
  if (reason === "length" || reason === "content_filter") return "error";
  return "stop";
}

function safeParseArgs(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw || "{}") as unknown;
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function normaliseToolCalls(
  calls: OpenAIToolCall[] | undefined,
): Array<{ id: string; name: string; args: Record<string, unknown> }> | undefined {
  if (!calls || calls.length === 0) return undefined;
  return calls.map((tc) => ({
    id: tc.id,
    name: tc.function.name,
    args: safeParseArgs(tc.function.arguments ?? "{}"),
  }));
}

function envFloat(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === "") return fallback;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) ? n : fallback;
}

function envFloatOpt(key: string): number | undefined {
  const raw = process.env[key];
  if (raw === undefined || raw === "") return undefined;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) ? n : undefined;
}

function envInt(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === "") return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

function envIntOpt(key: string): number | undefined {
  const raw = process.env[key];
  if (raw === undefined || raw === "") return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : undefined;
}

function envList(key: string): string[] | undefined {
  const raw = process.env[key];
  if (!raw) return undefined;
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export const plugin: HarnessPlugin = {
  manifest: {
    id: "kli.provider.openai",
    version: "2.0.0",
    apiVersion: "1",
    kind: ["provider"],
    entrypoint: "./dist/index.js",
    capabilities: ["model.call"],
    priority: 0,
  },
  register(_registry) {
    // Provider instantiated at runtime
  },
};

export default plugin;
