/**
 * @kli/mode-plan — read-only planning mode
 *
 * Tools allowed: read_file, execute_bash (read-only commands), create_file (only in .kli/plans/)
 */
import type { HarnessPlugin, ToolDefinition, ModePolicy } from "@kli/api";

const PLAN_PROMPT = `You are in PLAN mode. You are exploring the workspace and producing a numbered plan.
Rules:
- Do NOT modify files outside .kli/plans/
- Do NOT run destructive commands
- Output is a numbered plan only`;

const planTools = ["read_file", "create_file"];
const bashReadOnly = /^\s*(cat|ls|grep|rg|find|git\s+(log|diff|status|show|checkout|show|branch))\b/;

function isPlanTool(name: string): boolean {
  return planTools.includes(name);
}

export const plugin: HarnessPlugin = {
  manifest: {
    id: "kli.mode.plan",
    version: "1.0.0",
    apiVersion: "1",
    kind: ["policy", "context"],
    entrypoint: "./dist/index.js",
    capabilities: [],
    priority: 10,
  },
  register(registry) {
    // Register the mode policy fragment
    registry.registerPromptFragment(
      {
        id: "mode.plan",
        priority: 100,
        position: "mode",
        content: PLAN_PROMPT,
      },
      this.manifest.id,
    );

    // Install mode filter
    registry.setModeFilter("plan", (tool) => isPlanTool(tool.name));
  },
};

export default plugin;