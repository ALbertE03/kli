/**
 * @kli/provider-openai — OpenAI API provider
 */
import OpenAI from "openai";
import type { HarnessPlugin, Provider, TaskState, ToolDefinition, StepResult } from "@kli/api";

export const plugin: HarnessPlugin = {
  manifest: {
    id: "kli.provider.openai",
    version: "1.0.0",
    apiVersion: "1",
    kind: ["provider"] as Array<"tool" | "provider" | "context" | "policy">,
    entrypoint: "./dist/index.js",
    capabilities: ["model.call"],
    priority: 0,
    requires: ["kernel>=0.5 <1.0"],
  },
  register(_registry) {
    // Provider is instantiated at runtime
  },
};

export default plugin;

export class OpenAiProvider implements Provider {
  readonly name = "openai";
  private readonly client: OpenAI;
  private readonly model: string;

  constructor(apiKey?: string, model = "gpt-4o") {
    this.client = new OpenAI({ apiKey: apiKey ?? process.env.OPENAI_API_KEY });
    this.model = model;
  }

  async step(state: TaskState, tools: readonly ToolDefinition[], systemPrompt: string, signal: AbortSignal): Promise<StepResult> {
    const toolDefs = tools.map((t) => ({
      type: "function" as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: (t.schema as any)?.jsonSchema ?? { type: "object", properties: {} },
      },
    }));

    // Convert messages to OpenAI format
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
          temperature: 0.7,
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
      const cost = estimateCost(this.model, tokensIn, tokensOut);

      // Map finish reason
      let finishReason: StepResult["finishReason"] = "stop";
      if (choice.finish_reason === "tool_calls") finishReason = "tool_use";
      else if (choice.finish_reason === "length" || choice.finish_reason === "content_filter") finishReason = "error";

      // Extract tool calls
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
      console.error(`OpenAI error: ${msg}`);
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

function estimateCost(model: string, inTokens: number, outTokens: number): number {
  const prices: Record<string, { input: number; output: number }> = {
    "gpt-4o": { input: 0.0000025, output: 0.00001 },
    "gpt-4o-mini": { input: 0.00000015, output: 0.0000006 },
  };
  const p = prices[model];
  if (!p) return inTokens * 0.0000025 + outTokens * 0.00001;
  return inTokens * p.input + outTokens * p.output;
}
