#!/usr/bin/env node
/**
 * KLI — Agentic Coding Harness
 */

import { Kernel } from "@kli/kernel";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const HELP_TEXT = `KLI — Agentic Coding Harness

Usage:
  kli run [--mode plan|build|ask] [--skill <id>] "<task>"
  kli plugin list
  kli graph build
  kli help

Modes:
  plan    Read-only exploration, outputs a numbered plan
  build   Implement, verify with tests, iterate
  ask     Answer questions about the codebase (no writes)
`;

function loadConfig(workspaceRoot: string): Record<string, unknown> {
  const configPath = join(workspaceRoot, ".kli", "config.ts");
  if (!existsSync(configPath)) return {};
  try {
    const raw = readFileSync(configPath, "utf-8");
    // eslint-disable-next-line no-eval
    const mod = eval(`(${raw})`);
    return mod ?? {};
  } catch {
    return {};
  }
}

export async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 0 || args[0] === "help" || args[0] === "-h" || args[0] === "--help") {
    console.log(HELP_TEXT);
    return;
  }

  const workspaceRoot = process.cwd();
  const kliDir = join(workspaceRoot, ".kli");
  if (!existsSync(kliDir)) {
    mkdirSync(kliDir, { recursive: true });
  }

  const config = loadConfig(workspaceRoot);
  const kernel = new Kernel({ workspaceRoot, config });

  const cmd = args[0];
  const subcmd = args[1];
  const rest = args.slice(2);

  if (cmd === "run") {
    await handleRun(kernel, rest);
    return;
  }

  if (cmd === "plugin") {
    if (subcmd === "list") {
      const loaded = kernel.loader.getLoaded();
      console.log("Installed plugins:");
      if (loaded.length === 0) {
        console.log("  (none)");
      } else {
        for (const p of loaded) {
          console.log(`  ${p.manifest.id}@${p.manifest.version} (${p.manifest.kind.join(", ")})`);
        }
      }
      return;
    }
    console.log("Plugin commands: list, add, dev");
    return;
  }

  if (cmd === "graph") {
    console.log("Graph commands: build, query");
    return;
  }

  console.log(HELP_TEXT);
}

async function handleRun(kernel: Kernel, args: string[]): Promise<void> {
  let mode: "plan" | "build" | "ask" = "build";
  let message = "";
  let i = 0;
  while (i < args.length) {
    const a = args[i];
    if (a === "--mode") {
      const val = args[++i] as "plan" | "build" | "ask";
      if (!["plan", "build", "ask"].includes(val)) {
        console.error(`Invalid mode: ${val}. Use plan|build|ask.`);
        process.exit(1);
      }
      mode = val;
    } else {
      message += (message ? " " : "") + a;
    }
    i++;
  }

  if (!message) {
    console.error("Error: no task specified. Use: kli run <task>");
    console.log("");
    console.log(HELP_TEXT);
    process.exit(1);
  }

  console.log(`\nKLI running in "${mode}" mode:`);
  console.log(`  "${message}"\n`);
  console.log("ℹ️  No LLM provider configured.");
  console.log("ℹ️  Set OPENAI_API_KEY or ANTHROPIC_API_KEY and install a provider plugin.");
}

main().catch((err) => {
  console.error("KLI error:", err);
  process.exit(1);
});