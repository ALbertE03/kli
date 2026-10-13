/**
 * @kli/tool-create-file — create_file tool
 */
import { z } from "zod";
import { writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { HarnessPlugin, Capability, ToolDefinition } from "@kli/api";

const Schema = z.object({
  path: z.string(),
  content: z.string(),
  overwrite: z.boolean().optional(),
});
type Args = z.infer<typeof Schema>;

const capabilities: Capability[] = ["fs.write"];

export const plugin: HarnessPlugin = {
  manifest: {
    id: "kli.tool.create-file",
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
    name: "create_file",
    description: "Create a new file or overwrite an existing one.",
    schema: Schema,
    capabilities,
    async execute(args, ctx, signal) {
      if (signal.aborted) return { ok: false, error: "aborted" };

      const resolved = ctx.resolve(args.path);
      if (existsSync(resolved) && !args.overwrite) {
        return { ok: false, error: `File exists: ${resolved}. Use overwrite=true to replace.` };
      }

      try {
        mkdirSync(dirname(resolved), { recursive: true });
        writeFileSync(resolved, args.content, "utf-8");
        return { ok: true, content: `Created: ${resolved}` };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false, error: `create_file: ${msg}`, code: "WRITE_ERROR" };
      }
    },
  };
}