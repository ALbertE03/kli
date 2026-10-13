/**
 * @kli/mode-build — implementation mode with test verification
 */
import type { HarnessPlugin } from "@kli/api";

const BUILD_PROMPT = `You are in BUILD mode. Implement the task, verify with tests, iterate until green.
Rules:
- Write clean, tested code
- Run tests after each change
- Iterate until all tests pass`;

export const plugin: HarnessPlugin = {
  manifest: {
    id: "kli.mode.build",
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
        id: "mode.build",
        priority: 100,
        position: "mode",
        content: BUILD_PROMPT,
      },
      this.manifest.id,
    );
    // No filter — all tools visible in build mode
  },
};

export default plugin;