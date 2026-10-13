/**
 * @kli/provider-anthropic — Anthropic API provider
 */
import Anthropic from "@anthropic-ai/sdk";
import type { HarnessPlugin, Provider, TaskState, ToolDefinition, StepResult } from "@kli/api";

export const plugin: HarnessPlugin = {
  manifest: {
    id: "kli.provider.anthropic",
    version: "1.0.0",
    apiVersion: "1",
    kind: ["provider"] as Array<"tool" | "provider" | "context" | "policy">,
    entrypoint: "./dist/index.js",
    capabilities: ["model.call"],
    priority: 0,
    requires: ["kernel>=0.5 <1.0"],
  },
  register(_registry) {
    // Provider is instantiated at runtime, not registered
  },
};

export default plugin;

export class AnthropicProvider implements Provider {
  readonly name = "anthropic";
  private readonly client: Anthropic;
  private readonly model: string;

  constructor(apiKey?: string, model = "claude-sonnet-4-20250514") {
    this.client = new Anthropic({ apiKey: apiKey ?? process.env.ANTHROPIC_API_KEY });
    this.model = model;
  }

  async step(state: TaskState, tools: readonly ToolDefinition[], systemPrompt: string, signal: AbortSignal): Promise<StepResult> {
    // Convert tool definitions to Anthropic format
    const toolDefs: Array<{ name: string; description: string; input_schema: Record<string, unknown> }> =
      tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: { type: "object", properties: {} } as Record<string, unknown>,
      }));

    // Convert messages
    const messages = state.messages
      .filter((m) => m.role !== "system")
      .map((m) => ({
        role: m.role === "assistant" ? "assistant" : "user",
        content: m.content,
      }));

    try {
      const response = await (this.client.messages.create as any)(
        {
          model: this.model,
          max_tokens: 4096,
          system: systemPrompt,
          messages,
          tools: toolDefs.length > 0 ? toolDefs : undefined,
        },
        { signal },
      );

      const tokensIn = response.usage?.input_tokens ?? 0;
      const tokensOut = response.usage?.output_tokens ?? 0;
      const cost = estimateCost(this.model, tokensIn, tokensOut);

      // Extract tool calls
      const toolCalls = ((response.content as any[]) ?? [])
        .filter((c) => c.type === "tool_use")
        .map((c) => ({
          id: c.id,
          name: c.name,
          args: c.input ?? {},
        }));

      // Extract text content
      const textContent = ((response.content as any[]) ?? [])
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("\n");

      return {
        content: textContent || undefined,
        finishReason: response.stop_reason === "end_turn" ? "end_turn" : "stop",
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        tokensIn,
        tokensOut,
        cost,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { finishReason: "error", tokensIn: 0, tokensOut: 0, cost: 0 };
    }
  }

  countTokens(text: string): number {
    // Rough estimate: ~4 chars per token
    return Math.ceil(text.length / 4);
  }

  estimateCost(tokensIn: number, tokensOut: number): number {
    return tokensIn * 0.000003 + tokensOut * 0.000015;
  }
}

function estimateCost(_model: string, inTokens: number, outTokens: number): number {
  return inTokens * 0.000003 + outTokens * 0.000015;
}