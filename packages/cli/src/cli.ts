#!/usr/bin/env node
/**
 * KLI — Agentic Coding Harness (CLI)
 */

import { createRequire } from "node:module";
import { Kernel, resolvePath } from "@kli/kernel";
import { AgentDefinitionSchema, createDelegationTool, defaultAgents, mergeAgents, toJsonSchema } from "@kli/api";
import type {
  AgentDefinition,
  Bus,
  Capability,
  GraphSummary,
  Mode,
  PluginContext,
  PromptContext,
  ToolDefinition,
  ToolView,
} from "@kli/api";
import { readFileSync, existsSync, mkdirSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { config as loadEnv } from "dotenv";

// Load .env file if it exists
const envResult = loadEnv();
if (envResult.error) {
  process.stderr.write(`[KLI] Note: no .env loaded (${envResult.error.message})\n`);
}

const requireForCli = createRequire(import.meta.url);

const HELP_TEXT = `KLI — Agentic Coding Harness

Usage:
  kli run [--mode plan|build|ask] [--project <name>] [--debug] [--quiet] "<task>"
  kli repl [--mode plan|build|ask] [--project <name>] [--debug]
  kli prompt [--mode plan|build|ask] [--task "<task>"]   Show the system prompt for this project
  kli tools [--mode plan|build|ask]                       List tools visible in a mode (with JSON Schemas)
  kli graph build                                         Build the code graph (AST backends)
  kli graph status                                        Show the cached code graph summary
  kli session list [--project <name>]
  kli session resume <id> [--project <name>]
  kli project create <name>
  kli project list
  kli agent list
  kli agent show <id>
  kli agent add <id> --name <name> --description <text> [--mode plan|build|ask] [--model <id>] [--tools a,b,c] [--instructions <text>]
  kli agent rm <id>
  kli serve [--port <n>] [--host <h>]      Harness server for KLI Studio
  kli plugin list
  kli model list
  kli help

Modes:
  plan    Read-only exploration, outputs a numbered plan
  build   Implement, verify, iterate (all tools)
  ask     Answer questions about the codebase (read-only)

Agents:
  Subagents the main model delegates to through the "task" tool.
  Definitions live in .kli/agents.json and override the built-ins.

Options:
  --debug   Also show the assembled system prompt and full step info
  --quiet   Suppress live event/tool/model logs (final summary only)

Environment (see .env):
  KLI_MODEL, KLI_MAX_TOKENS, KLI_TEMPERATURE, KLI_STREAM, KLI_COST_LIMIT, ...
  OPENAI_API_KEY, OPENAI_BASE_URL, ANTHROPIC_API_KEY, BRAVE_API_KEY
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

/* ------------------------------------------------------------------ *
 * Tiny ANSI helpers (no runtime color dependency needed)
 * ------------------------------------------------------------------ */
const colorEnabled = process.stdout.isTTY === true && process.env.NO_COLOR === undefined;
function wrap(code: number, s: string): string {
  return colorEnabled ? `\u001b[${code}m${s}\u001b[0m` : s;
}
const c = {
  bold: (s: string) => wrap(1, s),
  dim: (s: string) => wrap(2, s),
  red: (s: string) => wrap(31, s),
  green: (s: string) => wrap(32, s),
  yellow: (s: string) => wrap(33, s),
  cyan: (s: string) => wrap(36, s),
  magenta: (s: string) => wrap(35, s),
};

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/* ------------------------------------------------------------------ *
 * Live event reporter — shows what the harness is doing in real time
 * ------------------------------------------------------------------ */
class CliReporter {
  private lastRequestAt = 0;
  private streamed = false;

  constructor(private readonly quiet: boolean) {}

  attach(bus: Bus): void {
    if (this.quiet) return;
    bus.on("task.started", (e) => {
      process.stderr.write(`${c.dim("▶ task")} ${e.taskId} ${c.dim(`(${e.mode})`)}\n`);
    });
    bus.on("tool.called", (e) => {
      const args = e.args ? clip(JSON.stringify(e.args), 200) : "";
      process.stderr.write(`${c.cyan("→")} ${c.bold(e.name)} ${c.dim(args)}\n`);
    });
    bus.on("tool.completed", (e) => {
      const mark = e.ok ? c.green("✓") : c.red("✗");
      const detail = e.ok ? c.dim(`(${e.ms}ms)`) : c.red(clip(e.error ?? `(${e.ms}ms)`, 200));
      process.stderr.write(`${mark} ${e.name} ${detail}\n`);
    });
    bus.on("model.request", (e) => {
      this.lastRequestAt = Date.now();
      process.stderr.write(`${c.magenta("⇢")} model ${c.dim(`${e.tokens} tokens in`)}\n`);
    });
    bus.on("model.response", (e) => {
      const elapsed = e.ms !== undefined ? e.ms / 1000 : this.lastRequestAt ? (Date.now() - this.lastRequestAt) / 1000 : 0;
      const rate = elapsed > 0 ? `${(e.tokens / elapsed).toFixed(1)} tok/s` : "n/a";
      process.stderr.write(
        `${c.magenta("⇠")} model ${c.dim(`${e.tokens} tokens out · ${rate} · $${e.cost.toFixed(6)}`)}\n`,
      );
    });
    bus.on("policy.triggered", (e) => {
      process.stderr.write(`${c.yellow("⚠")} policy ${e.name}: ${e.reason}\n`);
    });
  }

  /** Streaming writer: echoes assistant text to stdout as it arrives. */
  tokenWriter(): (delta: string) => void {
    return (delta: string) => {
      this.streamed = true;
      process.stdout.write(delta);
    };
  }

  get didStream(): boolean {
    return this.streamed;
  }
}

/* ------------------------------------------------------------------ *
 * Config / env
 * ------------------------------------------------------------------ */
function envNum(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function loadConfig(workspaceRoot: string): Record<string, unknown> {
  const jsPath = join(workspaceRoot, ".kli", "config.js");
  const tsPath = join(workspaceRoot, ".kli", "config.ts");
  const configPath = existsSync(jsPath) ? jsPath : tsPath;
  if (!existsSync(configPath)) return {};
  try {
    const raw = readFileSync(configPath, "utf-8");
    if (/require\s*\(/.test(raw)) {
      process.stderr.write(`[KLI] config.ts must not use require() — using createRequire instead\n`);
      return {};
    }
    const mod = requireForCli(configPath) as { default?: unknown };
    const cfg = mod.default ?? mod;
    return (cfg ?? {}) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function pluginSpecsFromConfig(config: Record<string, unknown>): string[] {
  const plugins = config["plugins"] as { include?: unknown } | undefined;
  const include = plugins?.include;
  return Array.isArray(include) ? (include as string[]) : [];
}

/* ------------------------------------------------------------------ *
 * Agent helpers (.kli/agents.json)
 * ------------------------------------------------------------------ */
function agentsPath(kliDir: string): string {
  return join(kliDir, "agents.json");
}

function loadUserAgents(kliDir: string): AgentDefinition[] {
  const path = agentsPath(kliDir);
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as { agents?: unknown };
    if (!Array.isArray(parsed.agents)) return [];
    const out: AgentDefinition[] = [];
    for (const raw of parsed.agents) {
      const result = AgentDefinitionSchema.safeParse(raw);
      if (result.success) out.push(result.data);
    }
    return out;
  } catch {
    return [];
  }
}

function saveUserAgents(kliDir: string, agents: AgentDefinition[]): void {
  mkdirSync(kliDir, { recursive: true });
  writeFileSync(agentsPath(kliDir), JSON.stringify({ version: 1, agents }, null, 2), "utf-8");
}

/** Built-in agents merged with the user's overrides. */
function allAgents(kliDir: string): AgentDefinition[] {
  return mergeAgents(defaultAgents(), loadUserAgents(kliDir));
}

/* ------------------------------------------------------------------ *
 * Project / session helpers
 * ------------------------------------------------------------------ */
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
  const projects: ProjectMeta[] = [];
  for (const entry of readdirSync(dir)) {
    const metaPath = join(dir, entry, "project.json");
    if (existsSync(metaPath)) {
      try {
        projects.push(JSON.parse(readFileSync(metaPath, "utf-8")) as ProjectMeta);
      } catch {
        /* ignore corrupt projects */
      }
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
  return loadProjects(kliDir).find((p) => p.id === id || p.name === id);
}

function loadSessions(kliDir: string, projectId?: string): SessionMeta[] {
  const dir = projectId
    ? join(kliDir, PROJECTS_DIR, projectId, SESSIONS_DIR)
    : join(kliDir, SESSIONS_DIR);
  if (!existsSync(dir)) return [];
  const sessions: SessionMeta[] = [];
  for (const entry of readdirSync(dir)) {
    const metaPath = join(dir, entry, "meta.json");
    if (existsSync(metaPath)) {
      try {
        sessions.push(JSON.parse(readFileSync(metaPath, "utf-8")) as SessionMeta);
      } catch {
        /* ignore corrupt sessions */
      }
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
  const remaining: string[] = [];
  let projectId: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--project" && i + 1 < args.length) {
      projectId = args[++i];
    } else if (a !== undefined) {
      remaining.push(a);
    }
  }
  return { projectId, remaining };
}

function parseMode(args: string[]): { mode: Mode; remaining: string[] } {
  let mode: Mode = "build";
  const remaining: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--mode") {
      const val = args[++i];
      if (val !== "plan" && val !== "build" && val !== "ask") {
        process.stderr.write(`Invalid mode: ${val}. Use plan|build|ask.\n`);
        process.exit(1);
      }
      mode = val;
    } else if (a !== undefined) {
      remaining.push(a);
    }
  }
  return { mode, remaining };
}

/* ------------------------------------------------------------------ *
 * Entry point
 * ------------------------------------------------------------------ */
export async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 0 || args[0] === "help" || args[0] === "-h" || args[0] === "--help") {
    console.log(HELP_TEXT);
    return;
  }

  const workspaceRoot = process.cwd();
  const kliDir = join(workspaceRoot, ".kli");
  if (!existsSync(kliDir)) mkdirSync(kliDir, { recursive: true });

  const config = loadConfig(workspaceRoot);
  const kernel = new Kernel({ workspaceRoot, config });
  const pluginSpecs = pluginSpecsFromConfig(config);

  const cmd = args[0];
  const subcmd = args[1];
  // Commands without a subcommand receive every token after the command name.
  const rest = args.slice(1);
  // Commands with a subcommand receive tokens after `<cmd> <subcommand>`.
  const subArgs = args.slice(2);

  if (cmd === "run") {
    const { projectId, remaining } = resolveProject(rest);
    const debug = remaining.includes("--debug");
    const quiet = remaining.includes("--quiet");
    const taskArgs = remaining.filter((a) => a !== "--debug" && a !== "--quiet");
    await handleRun(kernel, taskArgs, config, kliDir, pluginSpecs, undefined, projectId, debug, quiet);
    return;
  }

  if (cmd === "repl") {
    const { projectId, remaining } = resolveProject(rest);
    const debug = remaining.includes("--debug");
    const taskArgs = remaining.filter((a) => a !== "--debug");
    await handleRepl(kernel, taskArgs, config, kliDir, pluginSpecs, undefined, projectId, debug);
    return;
  }

  if (cmd === "prompt") {
    const { mode, remaining } = parseMode(rest);
    const taskIdx = remaining.indexOf("--task");
    const task = taskIdx >= 0 ? remaining[taskIdx + 1] : undefined;
    await kernel.loadPlugins(pluginSpecs);
    await handlePrompt(kernel, config, mode, task);
    return;
  }

  if (cmd === "tools") {
    const { mode } = parseMode(rest);
    await kernel.loadPlugins(pluginSpecs);
    handleTools(kernel, config, mode);
    return;
  }

  if (cmd === "graph") {
    await kernel.loadPlugins(pluginSpecs);
    if (subcmd === "build") {
      await handleGraphBuild(kernel);
      return;
    }
    if (subcmd === "status") {
      await handleGraphStatus(kernel);
      return;
    }
    console.log("Graph commands: build, status");
    return;
  }

  if (cmd === "session") {
    if (subcmd === "list") {
      const { projectId } = resolveProject(subArgs);
      const sessions = loadSessions(kliDir, projectId);
      console.log("Sessions:");
      if (sessions.length === 0) {
        console.log("  (none)");
      } else {
        for (const s of sessions) {
          const proj = s.projectId ? `[${s.projectId}] ` : "";
          console.log(
            `  ${proj}${s.id.padEnd(36)} ${s.mode.padEnd(6)} ${new Date(s.updatedAt).toLocaleString()}  plugins:${s.pluginCount}`,
          );
        }
      }
      return;
    }
    if (subcmd === "resume") {
      const sessionId = subArgs[0];
      if (!sessionId) {
        process.stderr.write("Error: session id required. Use: kli session resume <id>\n");
        process.exit(1);
      }
      const { projectId } = resolveProject(subArgs.slice(1));
      const sessDir = sessionDir(kliDir, sessionId, projectId);
      const metaPath = join(sessDir, "meta.json");
      if (!existsSync(metaPath)) {
        process.stderr.write(`Session not found: ${sessionId}\n`);
        process.exit(1);
      }
      const meta = JSON.parse(readFileSync(metaPath, "utf-8")) as SessionMeta;
      const historyPath = join(sessDir, "history.json");
      let lastMessage = "";
      if (existsSync(historyPath)) {
        const history = JSON.parse(readFileSync(historyPath, "utf-8")) as Array<{ role: string; content: string }>;
        lastMessage = [...history].reverse().find((m) => m.role === "user")?.content ?? "";
      }
      if (!lastMessage) {
        process.stderr.write("No messages found in session. Use 'kli run' instead.\n");
        process.exit(1);
      }
      console.log(`Resuming session ${sessionId} (${meta.mode} mode)`);
      await handleRun(kernel, [lastMessage], config, kliDir, pluginSpecs, sessionId, meta.projectId);
      return;
    }
    console.log("Session commands: list, resume <id>");
    return;
  }

  if (cmd === "project") {
    if (subcmd === "create") {
      const name = subArgs[0];
      if (!name) {
        process.stderr.write("Error: project name required. Use: kli project create <name>\n");
        process.exit(1);
      }
      const id = name.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
      if (!id) {
        process.stderr.write("Error: invalid project name.\n");
        process.exit(1);
      }
      if (findProjectById(kliDir, id)) {
        process.stderr.write(`Project already exists: ${id}\n`);
        process.exit(1);
      }
      saveProject(kliDir, { id, name, createdAt: Date.now(), updatedAt: Date.now() });
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
          console.log(
            `  ${p.id.padEnd(36)} ${p.name.padEnd(20)} sessions:${sessions.length}  ${new Date(p.updatedAt).toLocaleString()}`,
          );
        }
      }
      return;
    }
    console.log("Project commands: create <name>, list");
    return;
  }

  if (cmd === "agent") {
    if (subcmd === "list") {
      const agents = allAgents(kliDir);
      console.log("Subagents:");
      for (const agent of agents) {
        const tag = agent.builtin ? "built-in" : "custom  ";
        const hidden = agent.hidden ? " hidden" : "";
        console.log(
          `  ${agent.id.padEnd(16)} ${tag}${hidden}  [${agent.mode}]  ${agent.model ?? "(parent model)"}`,
        );
        console.log(`    ${agent.description}`);
      }
      return;
    }

    if (subcmd === "show") {
      const id = subArgs[0];
      const agent = allAgents(kliDir).find((a) => a.id === id);
      if (!agent) {
        process.stderr.write(`Unknown agent: ${id}\n`);
        process.exit(1);
      }
      console.log(JSON.stringify(agent, null, 2));
      return;
    }

    if (subcmd === "add") {
      const id = subArgs[0];
      if (!id) {
        process.stderr.write("Error: agent id required. Use: kli agent add <id> --name <name> --description <text>\n");
        process.exit(1);
      }
      const flag = (name: string): string | undefined => {
        const index = subArgs.indexOf(`--${name}`);
        return index >= 0 ? subArgs[index + 1] : undefined;
      };
      const name = flag("name") ?? id;
      const description = flag("description") ?? `Custom subagent "${name}".`;
      const mode = (flag("mode") ?? "build") as Mode;
      const model = flag("model");
      const toolsRaw = flag("tools");
      const instructions = flag("instructions") ?? "";
      const hidden = subArgs.includes("--hidden");

      const candidate = {
        id,
        name,
        description,
        mode,
        model: model ?? null,
        tools: toolsRaw ? toolsRaw.split(",").map((t) => t.trim()).filter(Boolean) : null,
        instructions,
        hidden,
        builtin: false,
      };
      const parsed = AgentDefinitionSchema.safeParse(candidate);
      if (!parsed.success) {
        process.stderr.write(
          `Invalid agent: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}\n`,
        );
        process.exit(1);
      }
      const existing = loadUserAgents(kliDir);
      const next = existing.some((a) => a.id === parsed.data.id)
        ? existing.map((a) => (a.id === parsed.data.id ? parsed.data : a))
        : [...existing, parsed.data];
      saveUserAgents(kliDir, next);
      console.log(`Agent saved: ${parsed.data.id} (${parsed.data.mode})`);
      return;
    }

    if (subcmd === "rm" || subcmd === "remove") {
      const id = subArgs[0];
      if (!id) {
        process.stderr.write("Error: agent id required. Use: kli agent rm <id>\n");
        process.exit(1);
      }
      if (defaultAgents().some((a) => a.id === id)) {
        process.stderr.write(`"${id}" is a built-in agent; add an override instead of deleting it.\n`);
        process.exit(1);
      }
      saveUserAgents(kliDir, loadUserAgents(kliDir).filter((a) => a.id !== id));
      console.log(`Agent removed: ${id}`);
      return;
    }

    console.log("Agent commands: list, show <id>, add <id> [...], rm <id>");
    return;
  }

  if (cmd === "serve") {
    const portIndex = rest.indexOf("--port");
    const hostIndex = rest.indexOf("--host");
    const port = portIndex >= 0 ? Number(rest[portIndex + 1]) : undefined;
    const host = hostIndex >= 0 ? rest[hostIndex + 1] : undefined;
    const mod = (await import("@kli/server")) as typeof import("@kli/server");
    const server = new mod.KliServer({
      workspaceRoot,
      ...(port !== undefined && Number.isFinite(port) ? { port } : {}),
      ...(host !== undefined ? { host } : {}),
    });
    const info = await server.listen();
    console.log(`KLI harness server listening on ${info.url}`);
    console.log(`Workspace: ${workspaceRoot}`);
    console.log("Point KLI Studio at it: Settings → Conexión → Servidor del harness.");
    const shutdown = (): void => {
      void server.close().then(() => process.exit(0));
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    return;
  }

  if (cmd === "plugin") {
    if (subcmd === "list") {
      await kernel.loadPlugins(pluginSpecs);
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
    console.log("Plugin commands: list");
    return;
  }

  if (cmd === "model") {
    if (subcmd === "list") {
      await kernel.loadPlugins(pluginSpecs);
      const provider = await detectProvider();
      if (!provider) {
        console.log("No provider configured.");
        return;
      }
      try {
        const models = provider.listModels ? await provider.listModels() : [];
        console.log("Available models:");
        if (models.length === 0) {
          console.log("  (none)");
        } else {
          for (const m of models) {
            console.log(`  ${m.id}  (context: ${m.context_window ?? "N/A"})`);
          }
        }
      } catch (e) {
        process.stderr.write(`Error listing models: ${e instanceof Error ? e.message : String(e)}\n`);
      }
      return;
    }
    console.log("Model commands: list");
    return;
  }

  console.log(HELP_TEXT);
}

/* ------------------------------------------------------------------ *
 * run
 * ------------------------------------------------------------------ */
async function handleRun(
  kernel: Kernel,
  args: string[],
  config: Record<string, unknown>,
  kliDir: string,
  pluginSpecs: string[],
  resumeSessionId?: string,
  projectId?: string,
  debug = false,
  quiet = false,
): Promise<void> {
  const { mode, remaining } = parseMode(args);
  const message = remaining.join(" ").trim();

  if (!message) {
    process.stderr.write("Error: no task specified. Use: kli run <task>\n");
    process.exit(1);
  }

  await kernel.loadPlugins(pluginSpecs);

  // User-defined subagent overrides from .kli/agents.json.
  for (const agent of allAgents(kliDir)) kernel.registry.registerAgent(agent, "cli");

  const provider = await detectProvider();
  if (!provider) {
    console.log("ℹ️  No LLM provider configured.");
    console.log("ℹ️  Set OPENAI_API_KEY or ANTHROPIC_API_KEY (see .env).");
    console.log("ℹ️  Add provider plugins to .kli/config.js → plugins.include");
    return;
  }

  const budget = {
    tokensTotal: envNum("KLI_TOKEN_BUDGET", envNum("KLI_MAX_TOKENS", 100_000)),
    tokensUsed: 0,
    costUsd: 0,
    costLimitUsd: envNum("KLI_COST_LIMIT", 5.0),
    deadlineMs: Date.now() + envNum("KLI_TIMEOUT", 120_000),
  };

  const runCapabilities = new Set<Capability>([
    "fs.read",
    "fs.write",
    "proc.exec",
    "net.http",
    "model.call",
    "secrets.read",
    "env.read",
  ]);

  // The agent the model delegates to through the `task` tool. Registered per
  // run so it always closes over the live provider.
  kernel.registry.registerTool(
    createDelegationTool(
      "task",
      {
        listAgents: () => kernel.listAgents(),
        runAgent: (agent, task, signal, hooks) =>
          kernel.runAgent({
            agent,
            task,
            signal,
            // The subagent must not re-enter the delegation tool.
            denyTools: ["task"],
            provider,
            budget: { ...budget },
            capabilities: runCapabilities,
            secrets: collectSecrets(),
            config,
            ...(hooks.onToken ? { onToken: hooks.onToken } : {}),
            ...(hooks.onReasoning ? { onReasoning: hooks.onReasoning } : {}),
          }),
      },
      { budget: { ...budget }, exclusive: true },
    ),
    "kli.cli:agents",
    100,
  );

  const sessionId = resumeSessionId ?? `session_${Date.now()}`;
  const projectLabel = projectId ? ` [project: ${projectId}]` : "";
  const loaded = kernel.loader.getLoaded();
  const toolCount = kernel.registry.snapshot().tools.size;
  const graphSummary = await loadGraphSummary(kernel);

  console.log(`\n${"═".repeat(64)}`);
  console.log(`  ${c.bold("KLI Agentic Coding Harness")}`);
  console.log(`${"═".repeat(64)}`);
  console.log(`  Mode:        ${mode}`);
  console.log(`  Model:       ${process.env.KLI_MODEL ?? "auto"}`);
  console.log(`  Task budget: ${process.env.KLI_MAX_TOKENS ?? "100000"} tokens`);
  console.log(`  Max output:  ${process.env.KLI_MAX_OUTPUT_TOKENS ?? "4096"} tokens/response`);
  console.log(`  Temperature: ${process.env.KLI_TEMPERATURE ?? "0.7"}`);
  console.log(`  Stream:      ${process.env.KLI_STREAM !== "0" ? "on" : "off"}`);
  console.log(`  Provider:    ${provider.name}`);
  console.log(`  Plugins:     ${loaded.length} loaded · ${toolCount} tools registered`);
  if (graphSummary) {
    console.log(`  Graph:       ${graphSummary.nodes} symbols · ${graphSummary.edges} edges`);
  }
  console.log(`  Task:        "${message}"${projectLabel}`);
  console.log(`${"─".repeat(64)}\n`);

  const reporter = new CliReporter(quiet);
  reporter.attach(kernel.bus);

  if (debug) {
    const prompt = await buildSystemPrompt(kernel, config, mode, message);
    console.log(`${c.dim("── system prompt ──")}`);
    console.log(prompt);
    console.log(`${c.dim("── end system prompt ──")}\n`);
  }

  const streaming = process.env.KLI_STREAM !== "0";
  const result = await kernel.run({
    taskId: sessionId,
    mode,
    message,
    budget,
    provider,
    capabilities: new Set(["fs.read", "fs.write", "proc.exec", "net.http", "model.call", "secrets.read", "env.read"]),
    secrets: collectSecrets(),
    config,
    graph: graphSummary ? { summary: graphSummary } : undefined,
    onToken: streaming ? reporter.tokenWriter() : undefined,
  });

  if (reporter.didStream) process.stdout.write("\n");

  saveSession(kliDir, {
    id: sessionId,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    workspaceRoot: kernel.workspaceRoot,
    mode,
    pluginCount: loaded.length,
    taskId: sessionId,
    projectId,
  });

  console.log(`\n${"═".repeat(64)}`);
  console.log(`  ${c.bold("Task completed")}`);
  console.log(`${"═".repeat(64)}`);
  console.log(`  Status:  ${result.status}`);
  console.log(`  Steps:   ${result.steps}`);
  console.log(`  Cost:    $${result.cost.toFixed(6)}`);
  console.log(`  Tokens:  ${result.budget.tokensUsed} / ${result.budget.tokensTotal || "∞"}`);
  if (result.toolCalls.length > 0) {
    console.log(`  Tools:`);
    for (const tc of result.toolCalls) {
      console.log(`    ${tc.ok ? c.green("✓") : c.red("✗")} ${tc.name} ${c.dim(`(${tc.ms}ms)`)}`);
    }
  }

  // If we didn't stream, print the final assistant message.
  if (!reporter.didStream) {
    const lastMsg = [...result.messages].reverse().find((m) => m.role === "assistant" && m.content.trim());
    if (lastMsg) {
      console.log(`${"─".repeat(64)}`);
      console.log(lastMsg.content);
    }
  }
  console.log(`${"═".repeat(64)}\n`);
}

/* ------------------------------------------------------------------ *
 * prompt / tools
 * ------------------------------------------------------------------ */
function makePluginContext(kernel: Kernel, config: Record<string, unknown>): PluginContext {
  return {
    cwd: process.cwd(),
    workspaceRoot: kernel.workspaceRoot,
    budget: { tokensTotal: 0, tokensUsed: 0, costUsd: 0, costLimitUsd: 0, deadlineMs: 0 },
    capabilities: new Set<Capability>(),
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    emit() {},
    secrets: collectSecrets(),
    config,
    resolve: (p: string) => resolvePath(p, kernel.workspaceRoot),
  };
}

async function buildSystemPrompt(
  kernel: Kernel,
  config: Record<string, unknown>,
  mode: Mode,
  userMessage: string,
): Promise<string> {
  const snapshot = kernel.registry.snapshot();
  const pluginCtx = makePluginContext(kernel, config);
  const visibleTools = snapshot.toolsFor(mode, pluginCtx);
  const visibleToolNames = new Set(visibleTools.map((t) => t.name));
  const ctx: PromptContext = {
    workspaceRoot: kernel.workspaceRoot,
    cwd: process.cwd(),
    mode,
    visibleTools: visibleTools.map(toToolView),
    budget: { tokensTotal: 0, tokensUsed: 0, costLimitUsd: 0, costUsd: 0, deadlineMs: 0 },
    graphSummary: await loadGraphSummary(kernel),
    skills: snapshot.skills.map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description,
      tools: s.tools,
      prompt: s.prompt,
    })),
    mcpServers: [],
    env: {},
    userMessage,
  };
  if (snapshot.fragments.length === 0) return "(no prompt fragments loaded)";
  return kernel.promptBuilder.build(snapshot.fragments, ctx, visibleToolNames);
}

function toToolView(t: ToolDefinition): ToolView {
  return { name: t.name, description: t.description, schema: t.schema };
}

async function handlePrompt(
  kernel: Kernel,
  config: Record<string, unknown>,
  mode: Mode,
  task?: string,
): Promise<void> {
  const snapshot = kernel.registry.snapshot();
  const pluginCtx = makePluginContext(kernel, config);
  const visibleTools = snapshot.toolsFor(mode, pluginCtx);
  const prompt = await buildSystemPrompt(kernel, config, mode, task ?? "");
  console.log(`${c.dim("Project:")} ${kernel.workspaceRoot}`);
  console.log(
    `${c.dim("Mode:")} ${mode} · ${c.dim("fragments:")} ${snapshot.fragments.length} · ${c.dim("visible tools:")} ${visibleTools.length}`,
  );
  console.log(`${"═".repeat(64)}`);
  console.log(prompt);
  console.log(`${"═".repeat(64)}`);
}

function handleTools(kernel: Kernel, config: Record<string, unknown>, mode: Mode): void {
  const snapshot = kernel.registry.snapshot();
  const pluginCtx = makePluginContext(kernel, config);
  const visible = snapshot.toolsFor(mode, pluginCtx);
  console.log(`Tools visible in ${c.bold(mode)} mode (${visible.length}):\n`);
  for (const t of visible) {
    console.log(`${c.cyan(t.name)}`);
    console.log(`  ${t.description.split("\n")[0] ?? ""}`);
    console.log(`  ${c.dim(JSON.stringify(toJsonSchema(t.schema)))}`);
    console.log("");
  }
}

/* ------------------------------------------------------------------ *
 * graph
 * ------------------------------------------------------------------ */
async function handleGraphBuild(kernel: Kernel): Promise<void> {
  console.log(`Building code graph for ${kernel.workspaceRoot} ...`);
  const started = Date.now();
  const result = await kernel.buildCodeGraph();
  const g = result.graph;
  let edges = 0;
  for (const [, list] of g.edges) edges += list.length;

  console.log(`${c.dim("Backends used:")} ${result.selectedBackends.join(", ") || "(none)"}`);
  console.log(`${c.dim("Languages:")}    ${Object.keys(g.languageStats).join(", ") || "(none)"}`);
  console.log(`${c.dim("Symbols:")}      ${g.nodes.size}`);
  console.log(`${c.dim("Edges:")}        ${edges}`);
  console.log(`${c.dim("Files:")}        ${g.fileLanguages.size}`);
  console.log(`${c.dim("Duration:")}     ${Date.now() - started}ms`);
  if (g.warnings.length > 0) {
    console.log(`${c.yellow("Warnings:")}`);
    for (const w of g.warnings) console.log(`  ⚠ ${w}`);
  }
  console.log(`\nSaved to ${join(kernel.workspaceRoot, ".kli", "graph.json")}`);
}

async function handleGraphStatus(kernel: Kernel): Promise<void> {
  const data = await kernel.graphCache.load();
  if (!data) {
    console.log("No graph built yet. Run: kli graph build");
    return;
  }
  const g = data.graph;
  let edges = 0;
  for (const [, list] of g.edges) edges += list.length;
  console.log("Code graph status:");
  console.log(`  Nodes:    ${g.nodes.length}`);
  console.log(`  Edges:    ${edges}`);
  console.log(`  Files:    ${g.fileLanguages.length}`);
  console.log(`  Built:    ${new Date(g.builtAt).toLocaleString()}`);
  console.log(`  Backends: ${g.backends.map((b) => b.id).join(", ") || "(none)"}`);
  if (g.warnings.length > 0) {
    console.log("  Warnings:");
    for (const w of g.warnings) console.log(`    ⚠ ${w}`);
  }
}

/* ------------------------------------------------------------------ *
 * repl
 * ------------------------------------------------------------------ */
async function handleRepl(
  kernel: Kernel,
  args: string[],
  config: Record<string, unknown>,
  kliDir: string,
  pluginSpecs: string[],
  resumeSessionId?: string,
  projectId?: string,
  debug = false,
): Promise<void> {
  const { mode } = parseMode(args);

  const provider = await detectProvider();
  if (!provider) {
    console.log("ℹ️  No LLM provider configured. Set OPENAI_API_KEY or ANTHROPIC_API_KEY.");
    return;
  }

  await kernel.loadPlugins(pluginSpecs);

  const sessionId = resumeSessionId ?? `repl_${Date.now()}`;
  const budget = {
    tokensTotal: envNum("KLI_TOKEN_BUDGET", envNum("KLI_MAX_TOKENS", 100_000)),
    tokensUsed: 0,
    costUsd: 0,
    costLimitUsd: envNum("KLI_COST_LIMIT", 5.0),
    deadlineMs: Date.now() + envNum("KLI_TIMEOUT", 120_000),
  };

  const projectLabel = projectId ? ` [project: ${projectId}]` : "";
  const loaded = kernel.loader.getLoaded();
  console.log(`\n${"═".repeat(64)}`);
  console.log(`  KLI REPL — ${mode} mode${projectLabel}`);
  console.log(`  Model: ${process.env.KLI_MODEL ?? "auto"} | Provider: ${provider.name} | Plugins: ${loaded.length}`);
  console.log(`  Commands: "prompt" (system prompt), "tools", "clear", "sessions", "exit"`);
  console.log(`${"═".repeat(64)}\n`);

  const historyPath = join(sessionDir(kliDir, sessionId, projectId), "history.json");
  const history: Array<{ role: string; content: string }> = [];
  if (existsSync(historyPath)) {
    try {
      history.push(...(JSON.parse(readFileSync(historyPath, "utf-8")) as Array<{ role: string; content: string }>));
    } catch {
      /* ignore corrupt history */
    }
  }

  const readline = await import("node:readline");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (prompt: string): Promise<string> => new Promise((resolve) => rl.question(prompt, resolve));

  const reporter = new CliReporter(false);
  reporter.attach(kernel.bus);

  while (true) {
    const input = await ask(`\n${c.cyan(">")} `);
    const trimmed = input.trim();
    if (!trimmed) continue;
    if (trimmed === "exit" || trimmed === "quit") break;
    if (trimmed === "clear") {
      history.length = 0;
      console.log("History cleared.");
      continue;
    }
    if (trimmed === "sessions") {
      for (const s of loadSessions(kliDir, projectId).slice(0, 5)) {
        console.log(`  ${s.id}  ${s.mode}  ${new Date(s.updatedAt).toLocaleString()}`);
      }
      continue;
    }
    if (trimmed === "prompt") {
      await handlePrompt(kernel, config, mode);
      continue;
    }
    if (trimmed === "tools") {
      handleTools(kernel, config, mode);
      continue;
    }

    const graphSummary = await loadGraphSummary(kernel);
    const result = await kernel.run({
      taskId: sessionId,
      mode,
      message: trimmed,
      budget,
      provider,
      capabilities: new Set(["fs.read", "fs.write", "proc.exec", "net.http", "model.call", "secrets.read", "env.read"]),
      secrets: collectSecrets(),
      config,
      graph: graphSummary ? { summary: graphSummary } : undefined,
      onToken: process.env.KLI_STREAM !== "0" ? reporter.tokenWriter() : undefined,
    });

    if (reporter.didStream) process.stdout.write("\n");

    history.push({ role: "user", content: trimmed });
    const lastMsg = [...result.messages].reverse().find((m) => m.role === "assistant");
    if (lastMsg) history.push({ role: "assistant", content: lastMsg.content });

    if (!reporter.didStream && lastMsg && lastMsg.content.trim()) {
      console.log(lastMsg.content);
    }
    console.log(c.dim(`  [steps:${result.steps} cost:$${result.cost.toFixed(6)}]`));

    saveSession(kliDir, {
      id: sessionId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      workspaceRoot: kernel.workspaceRoot,
      mode,
      pluginCount: loaded.length,
      taskId: sessionId,
      projectId,
    });
    writeFileSync(historyPath, JSON.stringify(history, null, 2), "utf-8");
  }

  rl.close();
}

/* ------------------------------------------------------------------ *
 * Provider + helpers
 * ------------------------------------------------------------------ */
async function loadGraphSummary(kernel: Kernel): Promise<GraphSummary | undefined> {
  const data = await kernel.graphCache.load();
  if (!data) return undefined;
  const g = data.graph;
  let edges = 0;
  for (const [, list] of g.edges) edges += list.length;
  return {
    nodes: g.nodes.length,
    edges,
    languages: Object.keys(g.languageStats),
    backends: g.backends.map((b) => b.id),
  };
}

function collectSecrets(): Readonly<Record<string, string>> {
  const keys = [
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "TAVILY_KEY",
    "TAVILY_API_KEY",
    "BRAVE_API_KEY",
    "GITHUB_TOKEN",
  ];
  const out: Record<string, string> = {};
  for (const k of keys) {
    const v = process.env[k];
    if (v !== undefined) out[k] = v;
  }
  return out;
}

async function detectProvider(): Promise<import("@kli/kernel").Provider | null> {
  if (process.env.ANTHROPIC_API_KEY && !process.env.OPENAI_API_KEY) {
    const mod = await import("@kli/provider-anthropic");
    return new mod.AnthropicProvider(process.env.ANTHROPIC_API_KEY, process.env.KLI_MODEL ?? "claude-sonnet-4-20250514");
  }
  if (process.env.OPENAI_API_KEY) {
    const mod = await import("@kli/provider-openai");
    return new mod.OpenAiProvider({
      apiKey: process.env.OPENAI_API_KEY,
      baseURL: process.env.OPENAI_BASE_URL,
      model: process.env.KLI_MODEL ?? "auto",
      temperature: envNum("KLI_TEMPERATURE", 0.7),
      maxTokens: envNum("KLI_MAX_OUTPUT_TOKENS", 4096),
      topP: process.env.KLI_TOP_P ? envNum("KLI_TOP_P", 1) : undefined,
      presencePenalty: process.env.KLI_PRESENCE_PENALTY ? envNum("KLI_PRESENCE_PENALTY", 0) : undefined,
      frequencyPenalty: process.env.KLI_FREQUENCY_PENALTY ? envNum("KLI_FREQUENCY_PENALTY", 0) : undefined,
      seed: process.env.KLI_SEED ? envNum("KLI_SEED", 0) : undefined,
      reasoningEffort: process.env.KLI_REASONING_EFFORT,
      stream: process.env.KLI_STREAM !== "0",
    });
  }
  return null;
}

main().catch((err) => {
  process.stderr.write(`KLI error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
