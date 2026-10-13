#!/usr/bin/env node
/**
 * KLI — Agentic Coding Harness
 */

import { createRequire } from "node:module";
import { Kernel } from "@kli/kernel";
import { readFileSync, existsSync, mkdirSync, writeFileSync, readdirSync } from "node:fs";
import { join, basename } from "node:path";

const createRequireForCli = createRequire(import.meta.url);

const HELP_TEXT = `KLI — Agentic Coding Harness

Usage:
  kli run [--mode plan|build|ask] [--project <name>] "<task>"
  kli repl [--mode plan|build|ask] [--project <name>]
  kli session list [--project <name>]
  kli session resume <id> [--project <name>]
  kli project create <name>
  kli project list
  kli plugin list
  kli graph build
  kli help

Modes:
  plan    Read-only exploration, outputs a numbered plan
  build   Implement, verify with tests, iterate
  ask     Answer questions about the codebase (no writes)

Projects:
  Sessions can be grouped into projects for organization.
  Use --project <name> to assign a session to a project.
`;

const SESSIONS_DIR = "sessions";
const PROJECTS_DIR = "projects";

interface SessionMeta {
  id: string;
  createdAt: number;
  updatedAt: number;
  workspaceRoot: string;
  mode: string;
  pluginCount: number;
  taskId: string;
  projectId?: string;
}

interface ProjectMeta {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  description?: string;
}

function loadConfig(workspaceRoot: string): Record<string, unknown> {
  const configPath = join(workspaceRoot, ".kli", "config.ts");
  if (!existsSync(configPath)) return {};
  try {
    const raw = readFileSync(configPath, "utf-8");
    if (/require\s*\(/.test(raw)) {
      console.error(`[KLI] config.ts must not use require() — using createRequire instead`);
      return {};
    }
    const mod = createRequireForCli(configPath);
    return (mod.default ?? mod) ?? {};
  } catch {
    return {};
  }
}

function projectDir(kliDir: string, projectId: string): string {
  return join(kliDir, PROJECTS_DIR, projectId);
}

function sessionDir(kliDir: string, sessionId: string, projectId?: string): string {
  if (projectId) {
    return join(kliDir, PROJECTS_DIR, projectId, SESSIONS_DIR, sessionId);
  }
  return join(kliDir, SESSIONS_DIR, sessionId);
}

function loadProjects(kliDir: string): ProjectMeta[] {
  const dir = join(kliDir, PROJECTS_DIR);
  if (!existsSync(dir)) return [];
  const entries = readdirSync(dir);
  const projects: ProjectMeta[] = [];
  for (const entry of entries) {
    const metaPath = join(dir, entry, "project.json");
    if (existsSync(metaPath)) {
      try {
        const data = JSON.parse(readFileSync(metaPath, "utf-8")) as ProjectMeta;
        projects.push(data);
      } catch { /* ignore corrupt projects */ }
    }
  }
  projects.sort((a, b) => b.updatedAt - a.updatedAt);
  return projects;
}

function saveProject(kliDir: string, project: ProjectMeta): void {
  const dir = projectDir(kliDir, project.id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "project.json"), JSON.stringify(project, null, 2), "utf-8");
}

function findProjectById(kliDir: string, id: string): ProjectMeta | undefined {
  const projects = loadProjects(kliDir);
  return projects.find((p) => p.id === id || p.name === id);
}

function loadSessions(kliDir: string, projectId?: string): SessionMeta[] {
  if (projectId) {
    const dir = join(kliDir, PROJECTS_DIR, projectId, SESSIONS_DIR);
    if (!existsSync(dir)) return [];
    const entries = readdirSync(dir);
    const sessions: SessionMeta[] = [];
    for (const entry of entries) {
      const metaPath = join(dir, entry, "meta.json");
      if (existsSync(metaPath)) {
        try {
          const data = JSON.parse(readFileSync(metaPath, "utf-8")) as SessionMeta;
          sessions.push(data);
        } catch { /* ignore corrupt sessions */ }
      }
    }
    sessions.sort((a, b) => b.updatedAt - a.updatedAt);
    return sessions;
  }

  // Legacy: load from root sessions dir
  const dir = join(kliDir, SESSIONS_DIR);
  if (!existsSync(dir)) return [];
  const entries = readdirSync(dir);
  const sessions: SessionMeta[] = [];
  for (const entry of entries) {
    const metaPath = join(dir, entry, "meta.json");
    if (existsSync(metaPath)) {
      try {
        const data = JSON.parse(readFileSync(metaPath, "utf-8")) as SessionMeta;
        sessions.push(data);
      } catch { /* ignore corrupt sessions */ }
    }
  }
  sessions.sort((a, b) => b.updatedAt - a.updatedAt);
  return sessions;
}

function saveSession(kliDir: string, session: SessionMeta): void {
  const dir = sessionDir(kliDir, session.id, session.projectId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "meta.json"), JSON.stringify(session, null, 2), "utf-8");
}

function resolveProject(args: string[]): { projectId?: string; remaining: string[] } {
  const result: string[] = [];
  let projectId: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--project" && i + 1 < args.length) {
      projectId = args[++i];
    } else if (a !== undefined) {
      result.push(a);
    }
  }
  return { projectId, remaining: result };
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
    const { projectId, remaining } = resolveProject(rest);
    await handleRun(kernel, remaining, config, kliDir, undefined, projectId);
    return;
  }

  if (cmd === "repl") {
    const { projectId, remaining } = resolveProject(rest);
    await handleRepl(kernel, remaining, config, kliDir, undefined, projectId);
    return;
  }

  if (cmd === "session") {
    if (subcmd === "list") {
      const { projectId, remaining } = resolveProject(rest);
      const sessions = loadSessions(kliDir, projectId);
      console.log("Sessions:");
      if (sessions.length === 0) {
        console.log("  (none)");
      } else {
        for (const s of sessions) {
          const date = new Date(s.updatedAt).toLocaleString();
          const proj = s.projectId ? `[${s.projectId}] ` : "";
          console.log(`  ${proj}${s.id.padEnd(36)} ${s.mode.padEnd(6)} ${date}  plugins:${s.pluginCount}`);
        }
      }
      return;
    }
    if (subcmd === "resume") {
      const sessionId = rest[0];
      if (!sessionId) {
        console.error("Error: session id required. Use: kli session resume <id>");
        process.exit(1);
      }
      const { projectId } = resolveProject(rest.slice(1));
      const sessDir = sessionDir(kliDir, sessionId, projectId);
      const metaPath = join(sessDir, "meta.json");
      if (!existsSync(metaPath)) {
        console.error(`Session not found: ${sessionId}`);
        process.exit(1);
      }
      const meta = JSON.parse(readFileSync(metaPath, "utf-8")) as SessionMeta;
      const historyPath = join(sessDir, "history.json");
      let lastMessage = "";
      if (existsSync(historyPath)) {
        const history = JSON.parse(readFileSync(historyPath, "utf-8")) as Array<{ role: string; content: string }>;
        const lastUser = [...history].reverse().find((m) => m.role === "user");
        lastMessage = lastUser?.content ?? "";
      }
      if (!lastMessage) {
        console.error("No messages found in session. Use 'kli run' instead.");
        process.exit(1);
      }
      console.log(`Resuming session ${sessionId} (${meta.mode} mode)`);
      await handleRun(kernel, [lastMessage], config, kliDir, sessionId, meta.projectId);
      return;
    }
    console.log("Session commands: list, resume <id>");
    return;
  }

  if (cmd === "project") {
    if (subcmd === "create") {
      const name = rest[0];
      if (!name) {
        console.error("Error: project name required. Use: kli project create <name>");
        process.exit(1);
      }
      const id = name.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
      if (!id) {
        console.error("Error: invalid project name.");
        process.exit(1);
      }
      if (findProjectById(kliDir, id)) {
        console.error(`Project already exists: ${id}`);
        process.exit(1);
      }
      const project: ProjectMeta = {
        id,
        name,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      saveProject(kliDir, project);
      console.log(`Project created: ${name} (${id})`);
      return;
    }
    if (subcmd === "list") {
      const projects = loadProjects(kliDir);
      console.log("Projects:");
      if (projects.length === 0) {
        console.log("  (none)");
      } else {
        for (const p of projects) {
          const sessions = loadSessions(kliDir, p.id);
          console.log(`  ${p.id.padEnd(36)} ${p.name.padEnd(20)} sessions:${sessions.length}  ${new Date(p.updatedAt).toLocaleString()}`);
        }
      }
      return;
    }
    console.log("Project commands: create <name>, list");
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

async function handleRun(
  kernel: Kernel,
  args: string[],
  config: Record<string, unknown>,
  kliDir: string,
  resumeSessionId?: string,
  projectId?: string,
): Promise<void> {
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

  // Load plugins from config
  const pluginSpecs = ((config.plugins as Record<string, unknown>)?.include ?? []) as string[];
  await kernel.loadPlugins(pluginSpecs);

  // Detect provider from env
  const provider = await detectProvider();
  if (!provider) {
    console.log("ℹ️  No LLM provider configured.");
    console.log("ℹ️  Set OPENAI_API_KEY or ANTHROPIC_API_KEY and install a provider plugin.");
    console.log("ℹ️  Add provider plugins to .kli/config.ts → plugins.include");
    return;
  }

  const budget = {
    tokensTotal: 0,
    tokensUsed: 0,
    costUsd: 0,
    costLimitUsd: 0,
    deadlineMs: 0,
  };

  const sessionId = resumeSessionId ?? `session_${Date.now()}`;

  const projectLabel = projectId ? ` [project: ${projectId}]` : "";

  console.log(`\nKLI running in "${mode}" mode:${projectLabel}`);
  console.log(`  "${message}"`);
  console.log(`  Provider: ${provider.name}`);
  console.log(`  Plugins loaded: ${kernel.loader.getLoaded().length}\n`);

  const result = await kernel.run({
    taskId: sessionId,
    mode,
    message,
    budget,
    provider,
    capabilities: new Set(["fs.read", "fs.write", "proc.exec", "net.http", "model.call", "secrets.read", "env.read"]),
    config,
  });

  // Save session
  const sessionMeta: import("@kli/kernel").SessionMetadata = {
    id: sessionId,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    workspaceRoot: kernel.workspaceRoot,
    mode,
    pluginCount: kernel.loader.getLoaded().length,
    taskId: sessionId,
  };
  const sessionWithProject: SessionMeta = { ...sessionMeta, projectId };
  saveSession(kliDir, sessionWithProject);

  console.log(`\n✅ Task completed:`);
  console.log(`   Status: ${result.status}`);
  console.log(`   Steps: ${result.steps}`);
  console.log(`   Cost: $${result.cost.toFixed(6)}`);
  console.log(`   Tokens: ${budget.tokensUsed} / ${budget.tokensTotal || "∞"}`);
  if (result.toolCalls.length > 0) {
    console.log(`   Tool calls: ${result.toolCalls.map((tc) => `${tc.name}(${tc.ok ? "✓" : "✗"})`).join(", ")}`);
  }
}

async function handleRepl(
  kernel: Kernel,
  args: string[],
  config: Record<string, unknown>,
  kliDir: string,
  resumeSessionId?: string,
  projectId?: string,
): Promise<void> {
  let mode: "plan" | "build" | "ask" = "build";
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--mode") {
      const val = args[++i] as "plan" | "build" | "ask";
      if (!["plan", "build", "ask"].includes(val)) {
        console.error(`Invalid mode: ${val}. Use plan|build|ask.`);
        process.exit(1);
      }
      mode = val;
    }
  }

  const provider = await detectProvider();
  if (!provider) {
    console.log("ℹ️  No LLM provider configured. Set OPENAI_API_KEY or ANTHROPIC_API_KEY.");
    return;
  }

  const pluginSpecs = ((config.plugins as Record<string, unknown>)?.include ?? []) as string[];
  await kernel.loadPlugins(pluginSpecs);

  // Session for REPL
  const sessionId = resumeSessionId ?? `repl_${Date.now()}`;
  const budget = {
    tokensTotal: 0,
    tokensUsed: 0,
    costUsd: 0,
    costLimitUsd: 0,
    deadlineMs: 0,
  };

  const projectLabel = projectId ? ` [project: ${projectId}]` : "";
  console.log(`\nKLI REPL — ${mode} mode${projectLabel} (type "exit" to quit)`);
  console.log(`  Provider: ${provider.name}`);
  console.log(`  Plugins: ${kernel.loader.getLoaded().length}\n`);

  const historyPath = join(sessionDir(kliDir, sessionId, projectId), "history.json");
  let history: Array<{ role: string; content: string }> = [];
  if (existsSync(historyPath)) {
    try {
      history = JSON.parse(readFileSync(historyPath, "utf-8")) as Array<{ role: string; content: string }>;
    } catch { /* ignore corrupt history */ }
  }

  const readline = await import("node:readline");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  const ask = (prompt: string): Promise<string> =>
    new Promise((resolve) => rl.question(prompt, resolve));

  while (true) {
    const input = await ask(`\n> `);
    const trimmed = input.trim();
    if (!trimmed) continue;
    if (trimmed === "exit" || trimmed === "quit") break;
    if (trimmed === "clear") {
      history = [];
      console.log("History cleared.");
      continue;
    }
    if (trimmed === "sessions") {
      const sessions = loadSessions(kliDir, projectId);
      console.log("Sessions:");
      for (const s of sessions.slice(0, 5)) {
        console.log(`  ${s.id}  ${s.mode}  ${new Date(s.updatedAt).toLocaleString()}`);
      }
      continue;
    }

    // Run the task
    const result = await kernel.run({
      taskId: sessionId,
      mode,
      message: trimmed,
      budget,
      provider,
      capabilities: new Set(["fs.read", "fs.write", "proc.exec", "net.http", "model.call", "secrets.read", "env.read"]),
      config,
    });

    // Append to history
    history.push({ role: "user", content: trimmed });
    // Get last assistant message
    const lastMsg = result.messages[result.messages.length - 1];
    if (lastMsg && lastMsg.role === "assistant") {
      history.push({ role: "assistant", content: lastMsg.content });
    }

    // Print result
    const assistantMsg = result.messages.find((m) => m.role === "assistant" && m.content.trim());
    if (assistantMsg) {
      console.log(assistantMsg.content);
    }

    console.log(`  [steps:${result.steps} cost:$${result.cost.toFixed(6)}]`);

    // Save session periodically
    const sessionMeta: import("@kli/kernel").SessionMetadata = {
      id: sessionId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      workspaceRoot: kernel.workspaceRoot,
      mode,
      pluginCount: kernel.loader.getLoaded().length,
      taskId: sessionId,
    };
    const sessionWithProject: SessionMeta = { ...sessionMeta, projectId };
    saveSession(kliDir, sessionWithProject);
    writeFileSync(historyPath, JSON.stringify(history, null, 2), "utf-8");
  }

  rl.close();
}

/** Secrets that must never be exposed in prompts or logs. */
const SECRET_KEYS = new Set([
  "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "BRAVE_API_KEY",
  "GITHUB_TOKEN", "SLACK_TOKEN", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY",
]);

async function detectProvider(): Promise<import("@kli/kernel").Provider | null> {
  if (process.env.ANTHROPIC_API_KEY) {
    const mod = await import("@kli/provider-anthropic");
    return new mod.AnthropicProvider();
  }
  if (process.env.OPENAI_API_KEY) {
    const mod = await import("@kli/provider-openai");
    return new mod.OpenAiProvider();
  }
  return null;
}

main().catch((err) => {
  console.error("KLI error:", err);
  process.exit(1);
});
