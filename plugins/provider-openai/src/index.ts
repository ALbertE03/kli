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
} from "@kli/api";

export interface OpenAiProviderOptions {
  apiKey?: string;
  model?: string;
  baseURL?: string;
  temperature?: number;
  maxTokens?: number;
}

export class OpenAiProvider implements Provider {
  readonly name = "openai";
  private readonly client: OpenAI;
  readonly model: string;
  private readonly temperature: number;
  private readonly maxTokens: number;

  constructor(opts: OpenAiProviderOptions = {}) {
    this.model = opts.model ?? process.env.KLI_MODEL ?? "gpt-4o";
    this.temperature = opts.temperature ?? 0.7;
    this.maxTokens = opts.maxTokens ?? 4096;

    const clientOpts: any = {
      apiKey: opts.apiKey ?? process.env.OPENAI_API_KEY ?? "sk-any-key",
      maxLength: this.maxTokens,
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
  ): Promise<StepResult> {
    const toolDefs = tools.map((t) => ({
      type: "function" as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: (t.schema as any)?.jsonSchema ?? { type: "object", properties: {} },
      },
    }));

    const messages: any[] = [
      { role: "system", content: systemPrompt },
      ...state.messages.map((m) => {
        const base: any = { role: m.role, content: m.content };
        if (m.toolCallId) base.tool_call_id = m.toolCallId;
        return base;
      }),
    ];

    try {
      const response = await (this.client.chat.completions.create as any)(
        {
          model: this.model,
          messages,
          tools: toolDefs.length > 0 ? toolDefs : undefined,
          temperature: this.temperature,
          max_tokens: this.maxTokens,
        },
        { signal },
      );

      const choice = response.choices?.[0];
      if (!choice) {
        return { finishReason: "error", tokensIn: 0, tokensOut: 0, cost: 0 };
      }

      const msg = choice.message;
      const tokensIn = response.usage?.prompt_tokens ?? 0;
      const tokensOut = response.usage?.completion_tokens ?? 0;
      const cost = this.estimateCost(tokensIn, tokensOut);

      let finishReason: StepResult["finishReason"] = "stop";
      if (choice.finish_reason === "tool_calls") finishReason = "tool_use";
      else if (choice.finish_reason === "length" || choice.finish_reason === "content_filter") finishReason = "error";

      const toolCalls = msg?.tool_calls?.map((tc: any) => ({
        id: tc.id,
        name: tc.function.name,
        args: JSON.parse(tc.function.arguments ?? "{}"),
      })) ?? [];

      return {
        content: msg?.content ?? undefined,
        finishReason,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        tokensIn,
        tokensOut,
        cost,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`OpenAI provider error: ${msg}`);
      return { finishReason: "error", tokensIn: 0, tokensOut: 0, cost: 0 };
    }
  }

  countTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  estimateCost(tokensIn: number, tokensOut: number): number {
    return tokensIn * 0.0000025 + tokensOut * 0.00001;
  }
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