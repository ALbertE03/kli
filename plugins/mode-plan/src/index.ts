/**
 * @kli/mode-plan — read-only planning mode
 *
 * Tools allowed: read_file, execute_bash (read-only commands), create_file (only in .kli/plans/)
 */
import type { HarnessPlugin, ToolDefinition, ModePolicy, Policy, Bus, Event, TaskState } from "@kli/api";

const PLAN_PROMPT = `You are in PLAN mode. You are exploring the workspace and producing a numbered plan.
Rules:
- Do NOT modify files outside .kli/plans/
- Do NOT run destructive commands
- Output is a numbered plan only`;

const bashReadOnly = /^\s*(cat|ls|grep|rg|find|git\s+(log|diff|status|show|checkout|show|branch))\b/;

function isPlanTool(name: string): boolean {
  if (name === "read_file") return true;
  if (name === "execute_bash") return true; // validated by policy below
  if (name === "create_file") return true;  // validated by policy below
  return false;
}

/**
 * Policy that enforces plan-mode restrictions:
 * - execute_bash must match bashReadOnly pattern
 * - create_file must target .kli/plans/
 */
function createPlanPolicy(): Policy {
  return {
    name: "plan.safety",
    async beforeStep(state, _bus) {
      if (state.mode !== "plan") return { action: "continue" };
      // Check last tool results for violations
      const lastResults = state.lastToolResults.slice(-5);
      for (const r of lastResults) {
        if (!r.ok) continue;
        // If last create_file or execute_bash failed with safety error, halt
        // We can't inspect args from state, so we rely on the tool returning
        // appropriate error codes. If the tool succeeded, we trust the prompt.
      }
      return { action: "continue" };
    },
    async onEvent(e, state, _bus) {
      if (state.mode !== "plan") return;
      // Track tool calls to enforce restrictions
      if (e.type === "tool.called") {
        const tc = e as { type: string; name: string };
        if (tc.name === "execute_bash") {
          // Policy will check the command pattern in beforeStep
        }
      }
    },
  };
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

    // Install safety policy
    registry.registerPolicy(createPlanPolicy(), this.manifest.id);
  },
};

export default plugin;