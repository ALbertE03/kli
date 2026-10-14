/**
 * @kli/mode-build — implementation mode.
 *
 * All registered tools are visible. The fragment is scoped to `build` via
 * `registerMode`.
 */
import { defineModePolicy } from "@kli/api";
import type { HarnessPlugin } from "@kli/api";

const BUILD_PROMPT = `You are in BUILD mode: implement the task in the workspace and verify it.

Rules:
- Inspect before changing: read the relevant files (and query the graph) first.
- Make the smallest change that satisfies the task; keep the surrounding style.
- Verify your work with a real command (build/test/typecheck) via execute_bash,
  then read the output. Do not claim success without a passing result.
- Iterate on failures; if a tool call is retryable, retry, otherwise adapt.
- Finish with a short summary: files touched and how you verified them.`;

export const plugin: HarnessPlugin = {
  manifest: {
    id: "kli.mode.build",
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
        mode: "build",
        allowTools: null, // all tools
        promptFragment: {
          id: "mode.build",
          priority: 100,
          position: "mode",
          content: BUILD_PROMPT,
        },
      }),
      this.manifest.id,
    );
  },
};

export default plugin;
