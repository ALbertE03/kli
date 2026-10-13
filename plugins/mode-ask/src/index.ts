/**
 * @kli/mode-ask — Q&A mode, no writes
 */
import type { HarnessPlugin } from "@kli/api";

const ASK_PROMPT = `You are in ASK mode. Answer questions about the codebase.
Rules:
- Read-only: you may use graph_query, graph_explain, read_file
- Do NOT write or execute anything
- Cite symbols when answering`;

export const plugin: HarnessPlugin = {
  manifest: {
    id: "kli.mode.ask",
    version: "1.0.0",
    apiVersion: "1",
    kind: ["policy", "context"],
    entrypoint: "./dist/index.js",
    capabilities: [],
    priority: 10,
  },
  register(registry) {
    registry.registerPromptFragment(
      {
        id: "mode.ask",
        priority: 100,
        position: "mode",
        content: ASK_PROMPT,
      },
      this.manifest.id,
    );
    registry.setModeFilter("ask", (tool) =>
      ["read_file", "graph_query", "graph_explain", "graph_working_set"].includes(tool.name),
    );
  },
};

export default plugin;