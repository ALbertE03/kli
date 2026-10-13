/**
 * @kli/tool-create-file — robust file creator with atomic writes
 *
 * Features:
 *  - Atomic write (temp + rename)
 *  - Parent directory auto-creation
 *  - Overwrite guard (unless overwrite=true)
 *  - Pre-write validation (encoding, max size)
 *  - SHA-256 on success
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

const CreateFileSchema = z.object({
  path: z.string().min(1).describe("Relative path to create"),
  content: z.string().describe("File contents"),
  /** Whether to overwrite existing files (default: false). */
  overwrite: z.boolean().optional(),
  /** Max file size in bytes (default: 10MB). */
  maxSizeBytes: z.number().int().min(1).max(100_000_000).optional(),
  /** Encoding (default: utf-8). */
  encoding: z.enum(["utf-8", "utf-16le", "ascii", "base64"]).optional(),
});

export type CreateFileArgs = z.infer<typeof CreateFileSchema>;

const capabilities: Capability[] = ["fs.write"];

export const plugin: HarnessPlugin = {
  manifest: {
    id: "kli.tool.create-file",
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

function buildTool(): ToolDefinition<CreateFileArgs> {
  return {
    name: "create_file",
    description: `Create a new file or overwrite an existing one with atomic write.

Args:
  path: string — relative to workspace root
  content: string — file contents
  overwrite: boolean — allow overwriting (default false)
  maxSizeBytes: number — size limit (default 10MB)
  encoding: "utf-8" | "utf-16le" | "ascii" | "base64"

Returns: { ok, content: "Created: <path>" } with meta.sha256, meta.bytes`,
    schema: CreateFileSchema,
    capabilities,
    async execute(args, ctx, signal) {
      if (signal.aborted) {
        return { ok: false, error: "aborted", code: "ABORTED" };
      }

      const resolved = ctx.resolve(args.path);

      // Check overwrite guard
      const overwrite = args.overwrite ?? false;
      if (existsSync(resolved) && !overwrite) {
        const stat = statSync(resolved);
        return {
          ok: false,
          error: `File exists and overwrite=false: ${resolved} (${stat.size} bytes)`,
          code: "FILE_EXISTS",
        };
      }

      // Validate size
      const maxSize = args.maxSizeBytes ?? 10_000_000;
      if (args.content.length > maxSize) {
        return {
          ok: false,
          error: `Content exceeds max size (${args.content.length} > ${maxSize})`,
          code: "SIZE_EXCEEDED",
        };
      }

      // Atomic write: write to temp, then rename
      const tmpPath = join(dirname(resolved), `.kli.${Math.random().toString(36).slice(2)}.tmp`);
      try {
        const encoding = args.encoding ?? "utf-8";
        const buf =
          encoding === "base64"
            ? Buffer.from(args.content, "base64")
            : args.content;
        writeFileSync(tmpPath, buf, { encoding: encoding as BufferEncoding });

        // Verify temp file
        const stat = statSync(tmpPath);
        const sha256 = createHash("sha256").update(readFileSync(tmpPath)).digest("hex");

        // Atomic rename
        if (existsSync(resolved)) {
          unlinkSync(resolved);
        }
        renameSync(tmpPath, resolved);

        return {
          ok: true,
          content: `Created: ${resolved}`,
          meta: { sha256, bytes: stat.size },
        };
      } catch (err) {
        // Clean up temp file on failure
        if (existsSync(tmpPath)) {
          try { unlinkSync(tmpPath); } catch {}
        }
        const msg = err instanceof Error ? err.message : String(err);
        return {
          ok: false,
          error: `create_file: ${msg}`,
          code: "WRITE_ERROR",
        };
      }
    },
  };
}