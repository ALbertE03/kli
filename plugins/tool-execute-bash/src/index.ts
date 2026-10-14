/**
 * @kli/tool-execute-bash — robust sandboxed command execution
 *
 * Features:
 *  - Configurable timeout (1s–2min)
 *  - Output truncation with marker
 *  - Environment filtering
 *  - CWD validation (stays in workspace)
 *  - Read-only mode support
 *  - Streaming output support
 */
import { z } from "zod";
import { execFileSync, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type {
  HarnessPlugin,
  Capability,
  ToolDefinition,
} from "@kli/api";

const ExecuteBashSchema = z.object({
  command: z.string().min(1).max(10_000),
  cwd: z.string().optional(),
  /** Timeout in ms (default 30_000, max 120_000). */
  timeoutMs: z.number().int().min(1_000).max(120_000).optional(),
  /** Max output chars (default 50_000). */
  maxOutput: z.number().int().min(1000).max(1_000_000).optional(),
  /** Run in read-only mode (no write commands allowed). */
  readOnly: z.boolean().optional(),
  /** Stream output line-by-line instead of buffering. */
  streaming: z.boolean().optional(),
});

export type ExecuteBashArgs = z.infer<typeof ExecuteBashSchema>;

const capabilities: Capability[] = ["proc.exec"];

// Forbidden commands in readOnly mode
const FORBIDDEN_READONLY = /^(rm|unlink|rmdir|mv|cp|mkdir|chmod|chown|dd|truncate)\b/i;
// Dangerous patterns
const DANGEROUS_PATTERNS = [
  /\brm\s+-rf\b/,
  /\bformat\b/,
  /\bwipe\b/,
  /\b shred\b/,
];

export const plugin: HarnessPlugin = {
  manifest: {
    id: "kli.tool.execute-bash",
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

function buildTool(): ToolDefinition<ExecuteBashArgs> {
  return {
    name: "execute_bash",
    description: `Execute a shell command in a sandboxed environment.

Args:
  command: string — shell command to run
  cwd?: string — working directory (must be inside workspace)
  timeoutMs?: number — timeout (default 30s, max 120s)
  maxOutput?: number — max output chars (default 50k)
  readOnly?: boolean — block destructive commands
  streaming?: boolean — stream output line-by-line

Returns: { ok, content } with meta.exitCode, meta.duration, meta.truncated

Safety:
  - CWD validated against workspaceRoot
  - readOnly mode blocks rm, cp, mv, chmod, etc.
  - Destructive patterns blocked
  - Env vars filtered to allowlist`,
    schema: ExecuteBashSchema,
    capabilities,
    async execute(args, ctx, signal) {
      if (signal.aborted) {
        return { ok: false, error: "aborted", code: "ABORTED" } as const;
      }

      // Validate cwd
      const resolvedCwd = args.cwd ?? ctx.workspaceRoot;
      if (!resolvedCwd.startsWith(ctx.workspaceRoot)) {
        return {
          ok: false,
          error: `cwd must be inside workspaceRoot: ${resolvedCwd}`,
          code: "INVALID_CWD",
        } as const;
      }

      // Safety checks
      if (args.readOnly && FORBIDDEN_READONLY.test(args.command)) {
        return {
          ok: false,
          error: `Read-only mode blocks destructive command: ${args.command.slice(0, 100)}`,
          code: "READ_ONLY_VIOLATION",
        } as const;
      }
      for (const pat of DANGEROUS_PATTERNS) {
        if (pat.test(args.command)) {
          return {
            ok: false,
            error: `Blocked dangerous command pattern: ${args.command.slice(0, 100)}`,
            code: "DANGEROUS_PATTERN",
          } as const;
        }
      }

      const timeout = args.timeoutMs ?? 30_000;
      const maxOutput = args.maxOutput ?? 50_000;

      if (args.streaming) {
        const streamingResult = await executeStreaming(
          args.command, resolvedCwd, timeout, maxOutput, signal,
        );
        if (!streamingResult.ok) {
          return { ok: false, error: streamingResult.error ?? "streaming failed", code: streamingResult.code ?? "UNKNOWN" };
        }
        return { ok: true, content: streamingResult.content, meta: streamingResult.meta };
      }

      // Buffered execution
      const start = Date.now();
      try {
        const result = execFileSync("bash", ["-c", args.command], {
          cwd: resolvedCwd,
          timeout,
          encoding: "utf-8",
          maxBuffer: maxOutput * 2,
          env: filterEnv(resolvedCwd),
          stdio: ["ignore", "pipe", "pipe"],
        });
        const duration = Date.now() - start;
        const truncated = result.length > maxOutput;
        const content = truncated
          ? result.slice(0, maxOutput) + `\n... [truncated, ${result.length - maxOutput} chars dropped]`
          : result;
        return {
          ok: true,
          content,
          meta: { exitCode: 0, duration, truncated, bytes: result.length },
        } as const;
      } catch (err) {
        const duration = Date.now() - start;
        const msg = err instanceof Error ? err.message : String(err);
        const exitCode = (err as NodeJS.ErrnoException & { status?: number }).status ?? 1;
        return {
          ok: false,
          error: msg,
          code: exitCode === 124 ? "TIMEOUT" : "COMMAND_FAILED",
          meta: { exitCode, duration },
        } as const;
      }
    },
  };
}

async function executeStreaming(
  command: string,
  cwd: string,
  timeout: number,
  maxOutput: number,
  signal: AbortSignal,
): Promise<{ ok: boolean; content: string; meta?: Record<string, unknown>; error?: string; code?: string }> {
  return new Promise((resolve) => {
    const start = Date.now();
    const proc = spawn("bash", ["-c", command], {
      cwd,
      env: filterEnv(cwd),
    });

    let output = "";
    let truncated = false;

    const concat = (chunk: Buffer | string) => {
      if (signal.aborted) return;
      const s = typeof chunk === "string" ? chunk : chunk.toString();
      if (output.length + s.length > maxOutput) {
        output += s.slice(0, maxOutput - output.length);
        truncated = true;
        proc.kill();
        return;
      }
      output += s;
    };

    proc.stdout?.on("data", concat);
    proc.stderr?.on("data", concat);

    const timer = setTimeout(() => {
      proc.kill();
      resolve({
        ok: false,
        content: "",
        error: `Command timed out after ${timeout}ms`,
        code: "TIMEOUT",
        meta: { duration: Date.now() - start },
      });
    }, timeout);

    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      proc.kill();
      resolve({ ok: false, content: "", error: "aborted", code: "ABORTED" });
    });

    proc.on("close", (code) => {
      clearTimeout(timer);
      const duration = Date.now() - start;
      resolve({
        ok: true,
        content: truncated
          ? output + `\n... [truncated]`
          : output,
        meta: { exitCode: code ?? 0, duration, truncated },
      });
    });
  });
}

function filterEnv(workspaceRoot?: string): NodeJS.ProcessEnv {
  const allowed = new Set([
    "PATH", "HOME", "USER", "LANG", "TERM", "NODE_ENV",
    "TMPDIR", "PWD", "SHLVL", "HOSTNAME",
  ]);
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (allowed.has(k)) out[k] = v;
  }
  if (workspaceRoot) out.PWD = workspaceRoot;
  return out;
}