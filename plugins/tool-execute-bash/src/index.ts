/**
 * @kli/tool-execute-bash — execute bash commands (sandboxed)
 */
import { z } from "zod";
import { execFileSync } from "node:child_process";
import type { HarnessPlugin, Capability, ToolDefinition } from "@kli/api";

const Schema = z.object({
  command: z.string(),
  cwd: z.string().optional(),
  timeoutMs: z.number().int().min(1000).max(120000).optional(),
  readOnly: z.boolean().optional(),
});
type Args = z.infer<typeof Schema>;

const capabilities: Capability[] = ["proc.exec"];

export const plugin: HarnessPlugin = {
  manifest: {
    id: "kli.tool.execute-bash",
    version: "1.0.0",
    apiVersion: "1",
    kind: ["tool"] as Array<"tool" | "provider" | "context" | "policy">,
    entrypoint: "./dist/index.js",
    capabilities,
    priority: 0,
  },
  register(registry) {
    registry.registerTool(buildTool(), this.manifest.id);
  },
};

export default plugin;

function buildTool(): ToolDefinition<Args> {
  return {
    name: "execute_bash",
    description: "Execute a shell command in a sandboxed environment.",
    schema: Schema,
    capabilities,
    async execute(args, ctx, signal) {
      if (signal.aborted) return { ok: false, error: "aborted" };

      // Resolve cwd
      let resolvedCwd = args.cwd ?? ctx.workspaceRoot;
      if (!resolvedCwd.startsWith(ctx.workspaceRoot)) {
        return { ok: false, error: `cwd must be inside workspaceRoot` };
      }

      try {
        const maxOutput = 20000;
        const timeout = args.timeoutMs ?? 30000;
        const result = execFileSync(
          "bash",
          ["-c", args.command],
          {
            cwd: resolvedCwd,
          timeout,
            encoding: "utf-8",
            maxBuffer: maxOutput * 2, // allow some headroom
            env: filterEnv(),
          },
        );
        const truncated = result.slice(0, maxOutput);
        return {
          ok: true,
          content: truncated,
          meta: { exitCode: 0 },
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const exitCode = (err as NodeJS.ErrnoException).status ?? 1;
        return {
          ok: false,
          error: msg,
          code: "COMMAND_FAILED",
          retryable: false,
        };
      }
    },
  };
}

function filterEnv(): NodeJS.ProcessEnv {
  const allowed = new Set(["PATH", "HOME", "USER", "LANG", "TERM", "NODE_ENV"]);
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (allowed.has(k)) out[k] = v;
  }
  return out;
}