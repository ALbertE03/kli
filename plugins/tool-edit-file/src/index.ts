/**
 * @kli/tool-edit-file — edit_file tool (atomic: old→new replacement)
 */
import { z } from "zod";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname } from "node:path";
import type { HarnessPlugin, Capability, ToolDefinition } from "@kli/api";

const Schema = z.object({
  path: z.string(),
  old: z.string(),
  new: z.string(),
  expectedSha256: z.string().optional(),
  occurrence: z.number().int().min(1).optional(),
});
type Args = z.infer<typeof Schema>;

const capabilities: Capability[] = ["fs.read", "fs.write"];

export const plugin: HarnessPlugin = {
  manifest: {
    id: "kli.tool.edit-file",
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
    name: "edit_file",
    description: "Replace old text with new text in a file. Atomic write with SHA validation.",
    schema: Schema,
    capabilities,
    async execute(args, ctx, signal) {
      if (signal.aborted) return { ok: false, error: "aborted" };

      const resolved = ctx.resolve(args.path);

      // Read and validate SHA if provided
      let content = "";
      try {
        content = readFileSync(resolved, "utf-8");
      } catch {
        return { ok: false, error: `File not found: ${resolved}` };
      }

      const currentSha = createHash("sha256").update(content).digest("hex");
      if (args.expectedSha256 && currentSha !== args.expectedSha256) {
        return {
          ok: false,
          error: `STALE: file hash mismatch. Expected ${args.expectedSha256}, got ${currentSha}`,
          code: "STALE",
          retryable: true,
        };
      }

      // Count occurrences
      const matches = content.split(args.old).length - 1;
      if (matches === 0) {
        return { ok: false, error: `old text not found in ${resolved}` };
      }
      const occurrence = args.occurrence ?? 1;
      if (matches > 1 && !args.occurrence) {
        return { ok: false, error: `old text appears ${matches} times; specify occurrence: ${matches}` };
      }

      // Perform replacement
      let replaced: string;
      if (occurrence && occurrence > 1) {
        // Replace only the nth occurrence
        const regex = new RegExp(args.old.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g");
        let count = 0;
        replaced = content.replace(regex, (match) => {
          count++;
          return count === occurrence ? args.new : match;
        });
      } else {
        replaced = content.split(args.old).join(args.new);
      }

      // Atomic write
      try {
        mkdirSync(dirname(resolved), { recursive: true });
        const tmp = resolved + ".tmp";
        writeFileSync(tmp, replaced, "utf-8");
        // Rename (atomic on POSIX)
        const { renameSync } = await import("node:fs");
        renameSync(tmp, resolved);
        const newSha = createHash("sha256").update(replaced).digest("hex");
        return {
          ok: true,
          content: `Edited: ${resolved}`,
          data: { sha256: newSha },
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false, error: `edit_file: ${msg}`, code: "WRITE_ERROR" };
      }
    },
  };
}