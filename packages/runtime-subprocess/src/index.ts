/**
 * @kli/runtime-subprocess — out-of-process plugin host
 *
 * Spawns a subprocess for each plugin, communicates via JSON-RPC.
 */
import { spawn } from "node:child_process";
import { join } from "node:path";
import type { PluginManifest } from "@kli/api";

export interface PluginHostOptions {
  manifest: PluginManifest;
  entrypoint: string;
  cwd: string;
  timeoutMs?: number;
}

export interface JsonRpcMessage {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

export class SubprocessPluginHost {
  private readonly proc: ReturnType<typeof spawn> & { stdin: NonNullable<ReturnType<typeof spawn>['stdin']>; stdout: NonNullable<ReturnType<typeof spawn>['stdout']>; stderr: NonNullable<ReturnType<typeof spawn>['stderr']> };
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  constructor(private readonly opts: PluginHostOptions) {
    this.proc = spawn("node", [entrypointToPath(opts.entrypoint, opts.cwd)], {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: opts.cwd,
    }) as unknown as (ReturnType<typeof spawn> & { stdin: NonNullable<ReturnType<typeof spawn>['stdin']>; stdout: NonNullable<ReturnType<typeof spawn>['stdout']>; stderr: NonNullable<ReturnType<typeof spawn>['stderr']> });

    let buffer = "";
    this.proc.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        this.handleLine(line);
      }
    });

    this.proc.stderr.on("data", (chunk: Buffer) => {
      console.error(`[plugin:${opts.manifest.id}] stderr: ${chunk}`);
    });
  }

  async call(method: string, params?: unknown): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const msg: JsonRpcMessage = { jsonrpc: "2.0", id, method, params };
      if (this.proc.stdin) {
        this.proc.stdin.write(JSON.stringify(msg) + "\n");
      }
      setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RPC timeout for ${method}`));
      }, this.opts.timeoutMs ?? 30000);
    });
  }

  stop(): void {
    this.proc.kill();
  }

  private handleLine(line: string): void {
    try {
      const msg = JSON.parse(line) as JsonRpcMessage;
      if (msg.id && this.pending.has(msg.id)) {
        const entry = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (!entry) return;
        if (msg.error) entry.reject(new Error(msg.error.message));
        else entry.resolve(msg.result);
      }
    } catch {
      // Ignore malformed lines
    }
  }
}

function entrypointToPath(entrypoint: string, cwd: string): string {
  if (entrypoint.startsWith(".")) {
    return join(cwd, entrypoint);
  }
  return join(cwd, entrypoint);
}