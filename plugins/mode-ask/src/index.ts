/**
 * @kli/mode-ask — read-only Q&A over the codebase.
 *
 * The tool set is intentionally small: reading files and querying the code
 * graph. No writes, no shell. The fragment is scoped to `ask` via
 * `registerMode`, so it can never leak into another mode's system prompt.
 */
import { defineModePolicy } from "@kli/api";
import type { HarnessPlugin } from "@kli/api";

const ASK_PROMPT = `You are in ASK mode: answer questions about this codebase.

Rules:
- Read-only. Use read_file to inspect sources and the graph_* tools to find and
  explain symbols. Never write, edit, or execute shell commands.
- Ground every answer in something you actually read or queried; cite
  \`path:line\` for each claim.
- If the answer is not in the workspace, say so plainly instead of guessing.
- Be concise: lead with the direct answer, then supporting detail.`;

export const plugin: HarnessPlugin = {
  manifest: {
    id: "kli.mode.ask",
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
        mode: "ask",
        allowTools: [
          "read_file",
          "graph_query",
          "graph_explain",
          "graph_working_set",
          "graph_path",
          // Delegation: the parent may hand read-only scouting to a subagent.
          "task",
        ],
        promptFragment: {
          id: "mode.ask",
          priority: 100,
          position: "mode",
          content: ASK_PROMPT,
        },
      }),
      this.manifest.id,
    );
  },
};

export default plugin;
