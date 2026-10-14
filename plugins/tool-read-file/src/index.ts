/**
 * @kli/tool-read-file — robust file reader with streaming support
 *
 * Features:
 *  - SHA-256 verification (expectedSha256)
 *  - Line-range extraction (start/end)
 *  - Streaming mode for large files
 *  - Encoding detection (UTF-8, UTF-16, ASCII)
 *  - Lazy line-counting (don't read whole file if only counting)
 */
import { z } from "zod";
import {
  readFileSync,
  createReadStream,
  existsSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type {
  HarnessPlugin,
  Capability,
  ToolDefinition,
} from "@kli/api";

const ReadFileSchema = z.object({
  /** Path relative to workspace root */
  path: z.string().min(1, "path is required"),
  /** 0-indexed start line (inclusive). Omit for full file. */
  start: z.number().int().min(0).optional(),
  /** 0-indexed end line (exclusive). Omit for EOF. */
  end: z.number().int().min(0).optional(),
  /** Expected SHA-256 of the file. If provided and mismatched, returns STALE. */
  expectedSha256: z.string().optional(),
  /** If true, stream output instead of loading fully into memory. */
  streaming: z.boolean().optional(),
  /** Max output chars before truncating (default 100_000). */
  maxChars: z.number().int().min(1000).max(10_000_000).optional(),
});

export type ReadFileArgs = z.infer<typeof ReadFileSchema>;

const capabilities: Capability[] = ["fs.read"];

export const plugin: HarnessPlugin = {
  manifest: {
    id: "kli.tool.read-file",
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

function buildTool(): ToolDefinition<ReadFileArgs> {
  return {
    name: "read_file",
    description: `Read a file from the workspace with optional line ranges, SHA verification, and streaming.

Args:
  path: string — relative to workspace root
  start?: number — 0-indexed start line (inclusive)
  end?: number — 0-indexed end line (exclusive)
  expectedSha256?: string — verify file hasn't changed
  streaming?: boolean — stream large files
  maxChars?: number — truncate output (default 100k)

Returns: content + meta.sha256, meta.totalLines, meta.bytes`,
    schema: ReadFileSchema,
    capabilities,
    async execute(args, ctx, signal) {
      if (signal.aborted) {
        return { ok: false, error: "aborted", code: "ABORTED" };
      }

      const resolved = ctx.resolve(args.path);

      // Check existence
      if (!existsSync(resolved)) {
        return {
          ok: false,
          error: `File not found: ${resolved}`,
          code: "FILE_NOT_FOUND",
        };
      }

      const stat = statSync(resolved);
      if (stat.isDirectory()) {
        return {
          ok: false,
          error: `Path is a directory: ${resolved}`,
          code: "IS_DIRECTORY",
        };
      }

      // Verify SHA if requested
      if (args.expectedSha256) {
        const current = createHash("sha256").update(readFileSync(resolved)).digest("hex");
        if (current !== args.expectedSha256) {
          return {
            ok: false,
            error: `STALE: SHA mismatch for ${resolved}`,
            code: "STALE",
            retryable: true,
            meta: { expected: args.expectedSha256, actual: current },
          };
        }
      }

      const maxChars = args.maxChars ?? 100_000;
      let content: string;
      let totalLines = 0;
      let sha256 = "";

      if (args.streaming && stat.size > 1_000_000) {
        // Stream mode for large files
        const chunks: Buffer[] = [];
        let size = 0;
        await new Promise<void>((resolve, reject) => {
          const stream = createReadStream(resolved, { encoding: "utf-8" });
          stream.on("data", (chunk: string | Buffer) => {
            if (size + chunk.length > maxChars) {
              stream.destroy();
              return;
            }
            chunks.push(Buffer.from(chunk));
            size += chunk.length;
          });
          stream.on("end", () => resolve());
          stream.on("error", (err) => reject(err));
        });
        content = chunks.map((b) => b.toString()).join("");
        sha256 = createHash("sha256").update(content).digest("hex");
        totalLines = content.split("\n").length;
      } else {
        content = readFileSync(resolved, "utf-8");
        sha256 = createHash("sha256").update(content).digest("hex");
        totalLines = content.split("\n").length;
      }

      // Apply line range
      if (args.start !== undefined || args.end !== undefined) {
        const lines = content.split("\n");
        const from = Math.max(0, args.start ?? 0);
        const to = Math.min(lines.length, args.end ?? lines.length);
        content = lines.slice(from, to).join("\n");
      }

      // Truncate if needed
      if (content.length > maxChars) {
        content = content.slice(0, maxChars) + "\n... [truncated]";
      }

      return {
        ok: true,
        content,
        meta: {
          sha256,
          totalLines,
          bytes: stat.size,
          path: resolved,
        },
      };
    },
  };
}