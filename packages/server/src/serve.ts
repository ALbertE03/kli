#!/usr/bin/env node
/**
 * Standalone entrypoint for the KLI harness server.
 *
 * This is what used to live behind `kli serve` in the (now removed) CLI. It
 * boots `KliServer`, binds it and keeps the process alive until SIGINT/SIGTERM.
 *
 * It also loads the workspace `.env` so the *server* — not the browser — is the
 * one that talks to the model provider (FreeLLMAPI, OpenAI, …). The Studio only
 * forwards requests; every credential stays here.
 *
 * Usage:
 *   node packages/server/dist/serve.js [--port <n>] [--host <h>] [--workspace <dir>]
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { KliServer } from "./index.js";

function readFlag(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index === -1) return undefined;
  const value = argv[index + 1];
  return value !== undefined && !value.startsWith("--") ? value : undefined;
}

/**
 * Finds the nearest `.env` at or above `startDir`. Walking up matters because
 * `pnpm --filter @kli/server start` runs with `cwd = packages/server`, while the
 * credentials live in the repo-root `.env`.
 */
function findEnvFile(startDir: string): string | null {
  let dir = resolve(startDir);
  for (let depth = 0; depth < 6; depth += 1) {
    const candidate = join(dir, ".env");
    if (existsSync(candidate)) return candidate;
    const parent = resolve(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Minimal `.env` loader (no dependency). Existing `process.env` values always
 * win, so shell exports override the file. Supports `KEY=value`, `#` comments
 * and single/double quoted values.
 */
function loadEnvFile(dir: string): void {
  const path = findEnvFile(dir);
  if (!path) return;
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return;
  }
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    if (key === "" || process.env[key] !== undefined) continue;
    let value = trimmed.slice(eq + 1).trim();
    const quoted =
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"));
    if (quoted && value.length >= 2) value = value.slice(1, -1);
    process.env[key] = value;
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  const portRaw = readFlag(argv, "--port");
  const port = portRaw !== undefined ? Number(portRaw) : undefined;
  const host = readFlag(argv, "--host");
  const workspaceArg = readFlag(argv, "--workspace");

  const workspaceRoot = workspaceArg !== undefined ? resolve(workspaceArg) : process.cwd();

  // Config is environment-only: load it before the server (or any plugin) reads
  // `process.env`. Both the launch directory and the workspace are searched so
  // `--workspace` runs pick up the project's own `.env` too (nearest wins).
  loadEnvFile(process.cwd());
  if (workspaceRoot !== process.cwd()) loadEnvFile(workspaceRoot);

  const server = new KliServer({
    workspaceRoot,
    ...(port !== undefined && Number.isFinite(port) ? { port } : {}),
    ...(host !== undefined ? { host } : {}),
  });

  const info = await server.listen();
  process.stdout.write(`KLI harness server listening on ${info.url}\n`);
  process.stdout.write(`Workspace: ${workspaceRoot}\n`);
  process.stdout.write("Point KLI Studio at it: Settings -> Conexion -> Servidor del harness.\n");

  const shutdown = (): void => {
    void server.close().then(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

void main().catch((err) => {
  process.stderr.write(
    `KLI harness server failed: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
