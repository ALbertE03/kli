/**
 * @kli/context-system — contributes the operational system-prompt sections:
 *
 *  - capabilities: a live catalog of the tools visible in this turn, including
 *    the exact JSON Schema each tool's arguments must match
 *  - rules:        how to use tools safely and effectively
 *  - context:      workspace / mode / graph facts for the current turn
 *
 * The catalog is generated from `ctx.visibleTools`, so it never hardcodes a
 * tool name and always tracks the active mode's tool filter.
 */
import { toJsonSchema } from "@kli/api";
import type {
  HarnessPlugin,
  PromptContext,
  PromptFragment,
  ToolView,
} from "@kli/api";

function renderTool(tool: ToolView): string {
  const schema = toJsonSchema(tool.schema);
  return [
    `### \`${tool.name}\``,
    tool.description.trim(),
    "Argument JSON Schema:",
    "```json",
    JSON.stringify(schema, null, 2),
    "```",
  ].join("\n");
}

const CAPABILITIES_FRAGMENT: PromptFragment = {
  id: "system.capabilities",
  priority: 900,
  position: "capabilities",
  alwaysInclude: true,
  content: (ctx: PromptContext): string => {
    const tools = ctx.visibleTools;
    if (tools.length === 0) {
      return [
        "## Tools",
        "No tools are available in this mode. Answer from the conversation only",
        "and state clearly when you cannot verify something.",
      ].join("\n");
    }
    return [
      `## Tools available in ${ctx.mode} mode`,
      "",
      "You may ONLY call the tools listed below. Argument objects MUST match the",
      "given JSON Schema; unknown tools or extra properties are rejected by the",
      "harness before execution. Do not describe a tool call in prose — emit it.",
      "",
      tools.map(renderTool).join("\n\n"),
    ].join("\n");
  },
};

const RULES_FRAGMENT: PromptFragment = {
  id: "system.rules",
  priority: 800,
  position: "rules",
  alwaysInclude: true,
  content: [
    "## Operating rules",
    "",
    "1. Ground every claim in a tool result. If you have not observed it, say so.",
    "2. Read a file before you edit it, and prefer `edit_file` with the smallest",
    "   unambiguous `old` text. Paths are relative to the workspace root.",
    "3. Tool calls may fail. Read the error and retryable flag, then adapt — do",
    "   not repeat an identical failing call.",
    "4. Prefer parallel tool calls when steps are independent.",
    "5. When the task is complete, stop calling tools and give a concise summary",
    "   of what changed and how you verified it.",
    "6. Never expose secrets (API keys, tokens) in your response.",
  ].join("\n"),
};

const CONTEXT_FRAGMENT: PromptFragment = {
  id: "system.context",
  priority: 700,
  position: "context",
  alwaysInclude: true,
  content: (ctx: PromptContext): string => {
    const lines = [
      "## Current turn",
      `- Mode: ${ctx.mode}`,
      `- Workspace root: ${ctx.workspaceRoot}`,
      `- Working directory: ${ctx.cwd}`,
    ];
    if (ctx.graphSummary) {
      const g = ctx.graphSummary;
      lines.push(
        `- Code graph: ${g.nodes} symbols, ${g.edges} edges` +
          (g.languages.length ? ` (${g.languages.join(", ")})` : ""),
      );
    }
    if (ctx.skills && ctx.skills.length > 0) {
      lines.push(
        `- Active skills: ${ctx.skills.map((s) => s.id).join(", ")}`,
      );
    }
    if (ctx.mcpServers && ctx.mcpServers.length > 0) {
      lines.push(
        `- MCP servers: ${ctx.mcpServers.map((s) => `${s.name}(${s.toolCount})`).join(", ")}`,
      );
    }
    if (ctx.budget.tokensTotal > 0) {
      lines.push(
        `- Token budget: ${ctx.budget.tokensUsed}/${ctx.budget.tokensTotal}`,
      );
    }
    return lines.join("\n");
  },
};

export const plugin: HarnessPlugin = {
  manifest: {
    id: "kli.context.system",
    version: "1.0.0",
    apiVersion: "1",
    kind: ["context"],
    entrypoint: "./dist/index.js",
    capabilities: [],
    priority: 20,
  },
  register(registry) {
    registry.registerPromptFragment(CAPABILITIES_FRAGMENT, this.manifest.id);
    registry.registerPromptFragment(RULES_FRAGMENT, this.manifest.id);
    registry.registerPromptFragment(CONTEXT_FRAGMENT, this.manifest.id);
  },
};

export default plugin;
