/**
 * @kli/tool-read-file — read_file tool
 *
 * Reads files from the workspace and returns their content with
 * optional line range support.
 *
 * Args:
 *   path: string            — relative to workspaceRoot (Rule #3)
 *   start?: number          — 0-indexed, inclusive
 *   end?: number            — 0-indexed, exclusive
 *
 * Returns:
 *   { ok: true; content: string; meta?: { sha256: string; totalLines: number } }
 *   { ok: false; error: string; code: string }
 */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { HarnessPlugin, Capability, ToolDefinition } from "@kli/api";

const Schema = z.object({
  path: z.string(),
  start: z.number().int().min(0).optional(),
  end: z.number().int().min(0).optional(),
});

export type Args = z.infer<typeof Schema>;

const capabilities: Capability[] = ["fs.read"];

const Manifest = {
  id: "cli.tool.read-file",
  version: "1.0.0",
  apiVersion: "1" as const,
  kind: ["tool"] as Array<"tool" | "provider" | "context" | "policy">,
  entrypoint: "./dist/index.js",
  capabilities,
  priority: 0,
};

function buildTool(): ToolDefinition<Args> {
  return {
    name: "read_file",
    description:
      "Read the contents of a file from the workspace. Returns the text " +
      "with optional line range.",
    schema: Schema,
    capabilities,
    async execute(args, ctx, signal) {
      if (signal.aborted) {
        return {
          ok: false,
          error: "aborted",
        };
      }

      // Resolve via ctx.resolve (Rule #3)
      const resolvedPath: string = ctx.resolve(args.path);

      try {
        const content = readFileSync(resolvedPath, "utf-8");
        const sha256 = createHash("sha256").update(content).digest("hex");
        const lines = content.split("\n");
        const totalLines = lines.length;

        // Apply line range
        let output = content;
        if (args.start !== undefined || args.end !== undefined) {
          const from = args.start ?? 0;
          const to = args.end ?? totalLines;
          output = lines.slice(from, to).join("\n");
        }

        return {
          ok: true,
          content: output,
          meta: { sha256, totalLines },
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          ok: false,
          error: `read_file: ${msg}`,
          code: "FILE_READ_ERROR",
        };
      }
    },
  };
}

const plugin: HarnessPlugin = {
  manifest: Manifest,
  register(registry) {
    registry.registerTool(buildTool(), Manifest.id);
  },
};

export default plugin;
