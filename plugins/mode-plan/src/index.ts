/**
 * @kli/mode-plan — read-only planning mode.
 *
 * Visible tools: read_file, execute_bash, create_file, and the graph_* tools.
 * Safety is enforced per-call by a `beforeTool` policy:
 *  - execute_bash only accepts read-only commands
 *  - create_file may only write inside `.kli/plans/`
 */
import { defineModePolicy } from "@kli/api";
import type { HarnessPlugin, Policy, PolicyDecision, TaskState, Bus, ToolCallView } from "@kli/api";

const PLAN_PROMPT = `You are in PLAN mode: explore the workspace and produce a plan.

Rules:
- Read-only. You may read files, run read-only shell commands, and query the
  code graph. You may write a plan file, but only under .kli/plans/.
- Do NOT modify project files and do NOT run anything that changes state
  (no installs, no writes, no git commits).
- Finish with a numbered, actionable plan. For each step, name the files that
  will change and how it will be verified.`;

const READ_ONLY_COMMANDS =
  /^\s*(cat|bat|ls|dir|grep|rg|find|fd|tree|pwd|wc|head|tail|sed\s+-n|awk|cut|sort|uniq|tr|column|echo|which|type|node\s+(-v|--version)|pnpm\s+(-v|--version)|npm\s+(-v|--version)|git\s+(log|diff|status|show|branch|remote|describe|rev-parse|ls-files|grep|blame|shortlog)|python3?\s+-c\s+['"]?(print|import))/;

const WRITE_MARKERS = /(^|[^\\])(>>?|\|\s*tee\b)|\brm\b|\bmv\b|\bcp\b|\bmkdir\b|\btouch\b|\bchmod\b|\bchown\b|\bsed\s+-i\b|\bdd\b|\btruncate\b|\bnpm\s+(install|i|add)\b|\bpnpm\s+(install|add|remove)\b/;

function planPolicy(): Policy {
  return {
    name: "plan.safety",
    async beforeTool(
      call: ToolCallView,
      _state: TaskState,
      _bus: Bus,
    ): Promise<PolicyDecision> {
      if (call.name === "execute_bash") {
        const command = String(call.args["command"] ?? "");
        if (WRITE_MARKERS.test(command) || !READ_ONLY_COMMANDS.test(command)) {
          return {
            action: "veto",
            reason:
              "PLAN mode only allows read-only shell commands (no writes/installs/redirections).",
          };
        }
      }
      if (call.name === "create_file") {
        const path = String(call.args["path"] ?? "");
        if (!path.replace(/^\.\//, "").startsWith(".kli/plans/")) {
          return {
            action: "veto",
            reason: "PLAN mode may only write files under .kli/plans/.",
          };
        }
      }
      return { action: "continue" };
    },
  };
}

export const plugin: HarnessPlugin = {
  manifest: {
    id: "kli.mode.plan",
    version: "1.1.0",
    apiVersion: "1",
    kind: ["policy", "context"],
    entrypoint: "./dist/index.js",
    capabilities: [],
    priority: 10,
  },
  register(registry) {
    registry.registerMode(
      defineModePolicy({
        mode: "plan",
        allowTools: [
          "read_file",
          "execute_bash",
          "create_file",
          "graph_query",
          "graph_explain",
          "graph_working_set",
          "graph_path",
        ],
        promptFragment: {
          id: "mode.plan",
          priority: 100,
          position: "mode",
          content: PLAN_PROMPT,
        },
        policy: planPolicy(),
      }),
      this.manifest.id,
    );
  },
};

export default plugin;
