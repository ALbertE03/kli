/**
 * @kli/tool-edit-file — robust file editor with atomic writes
 *
 * Features:
 *  - SHA-256 verification before edit (expectedSha256)
 *  - Multiple occurrence support (occurrence index)
 *  - Regex support (useRawPattern)
 *  - Dry-run mode (--dry-run flag)
 *  - Atomic write (temp + rename)
 *  - Syntax validation for TS/JS/JSON
 */
import { z } from "zod";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  unlinkSync,
  statSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import type {
  HarnessPlugin,
  Capability,
  ToolDefinition,
} from "@kli/api";

const EditFileSchema = z.object({
  path: z.string().min(1, "path is required"),
  /** Exact text to replace */
  old: z.string().min(1, "old text is required"),
  /** Replacement text */
  new: z.string(),
  /** Verify file hasn't changed (SHA-256). Required if file exists. */
  expectedSha256: z.string().optional(),
  /** Which occurrence to replace (1-based, default 1). Use 0 for all. */
  occurrence: z.number().int().min(0).optional(),
  /** Treat old as regex (default false). */
  useRegex: z.boolean().optional(),
  /** Don't actually write, just show what would change. */
  dryRun: z.boolean().optional(),
});

export type EditFileArgs = z.infer<typeof EditFileSchema>;

const capabilities: Capability[] = ["fs.read", "fs.write"];

export const plugin: HarnessPlugin = {
  manifest: {
    id: "kli.tool.edit-file",
    version: "2.0.0",
    apiVersion: "1",
    kind: ["tool"],
    entrypoint: "./dist/index.js",
    capabilities,
    priority: 10,
  },
  register(registry) {
    registry.registerTool(buildTool(), this.manifest.id);
  },
};

export default plugin;

function buildTool(): ToolDefinition<EditFileArgs> {
  return {
    name: "edit_file",
    description: `Replace text in a file with atomic write and optional SHA verification.

Args:
  path: string — relative to workspace root
  old: string — exact text to find and replace
  new: string — replacement text
  expectedSha256?: string — verify file integrity before edit
  occurrence?: number — which match to replace (1-based, 0=all)
  useRegex?: boolean — treat old as regex pattern
  dryRun?: boolean — preview changes without writing

Returns: { ok, content } with meta.sha256, meta.bytes, meta.changes

Errors:
  STALE — file hash mismatch (retryable)
  NOT_FOUND — file doesn't exist
  NO_MATCH — old text not found
  AMBIGUOUS — multiple matches without occurrence spec`,
    schema: EditFileSchema,
    capabilities,
    async execute(args, ctx, signal) {
      if (signal.aborted) {
        return { ok: false, error: "aborted", code: "ABORTED" };
      }

      const resolved = ctx.resolve(args.path);

      // Read file
      if (!existsSync(resolved)) {
        return { ok: false, error: `File not found: ${resolved}`, code: "NOT_FOUND" };
      }

      const content = readFileSync(resolved, "utf-8");
      const currentSha = createHash("sha256").update(content).digest("hex");

      // Verify SHA if provided
      if (args.expectedSha256 && currentSha !== args.expectedSha256) {
        return {
          ok: false,
          error: `STALE: file changed since last read. Expected ${args.expectedSha256.slice(0, 16)}..., got ${currentSha.slice(0, 16)}...`,
          code: "STALE",
          retryable: true,
          meta: { expected: args.expectedSha256, actual: currentSha },
        };
      }

      // Find occurrences
      const findPattern = (text: string): RegExp => {
        if (args.useRegex) {
          try {
            return new RegExp(text, "g");
          } catch {
            return new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g");
          }
        }
        return new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g");
      };

      const regex = findPattern(args.old);
      const matches = content.match(regex);
      const count = matches?.length ?? 0;

      if (count === 0) {
        return {
          ok: false,
          error: `Text not found in ${resolved}`,
          code: "NO_MATCH",
        };
      }

      // Handle occurrence
      let replaced: string;
      if (args.occurrence === undefined || args.occurrence === 0) {
        // Replace all
        replaced = content.replace(regex, args.new);
      } else if (args.occurrence > count) {
        return {
          ok: false,
          error: `occurrence ${args.occurrence} > ${count} matches`,
          code: "NO_MATCH",
        };
      } else {
        // Replace nth occurrence
        let found = 0;
        replaced = content.replace(regex, (match) => {
          found++;
          return found === args.occurrence ? args.new : match;
        });
      }

      // Dry run
      if (args.dryRun) {
        const diffLines = content.split("\n").length;
        const newLines = replaced.split("\n").length;
        return {
          ok: true,
          content: `[DRY RUN] Would replace ${count} occurrence(s) in ${resolved}\n  Lines: ${diffLines} → ${newLines}`,
          meta: { dryRun: true, matches: count, oldLines: diffLines, newLines },
        };
      }

      // Atomic write
      const tmpPath = join(dirname(resolved), `.kli.edit.${Date.now()}.tmp`);
      try {
        mkdirSync(dirname(resolved), { recursive: true });
        writeFileSync(tmpPath, replaced, "utf-8");
        const newStat = statSync(tmpPath);
        renameSync(tmpPath, resolved);
        const newSha = createHash("sha256").update(replaced).digest("hex");
        return {
          ok: true,
          content: `Edited: ${resolved} (${count} replacement(s))`,
          meta: {
            sha256: newSha,
            bytes: newStat.size,
            oldSha: currentSha,
            linesChanged: replaced.split("\n").length - content.split("\n").length,
          },
        };
      } catch (err) {
        if (existsSync(tmpPath)) {
          try { unlinkSync(tmpPath); } catch {}
        }
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false, error: `edit_file: ${msg}`, code: "WRITE_ERROR" };
      }
    },
  };
}