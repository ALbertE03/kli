/**
 * @kli/server — HTTP + SSE bridge that exposes the real KLI harness to KLI
 * Studio.
 *
 * The UI does NOT talk to the provider directly when a workspace is connected:
 * it talks to this server, which boots the kernel with every plugin from
 * `.kli/config.js`. That is what makes tools, skills, the code graph and
 * subagents work in the UI instead of being decorative.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFileSync, existsSync, mkdirSync, readdirSync, writeFileSync, rmSync, statSync } from "node:fs";
import { join, resolve as resolveFs, isAbsolute } from "node:path";
import { createRequire } from "node:module";
import {
  AgentDefinitionSchema,
  createDelegationTool,
  defaultAgents,
  mergeAgents,
} from "@kli/api";
import type {
  AgentDefinition,
  Capability,
  Mode,
  PluginContext,
  ToolDefinition,
} from "@kli/api";
import { Kernel, resolvePath } from "@kli/kernel";
import type { Provider } from "@kli/kernel";

export interface Logger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

export interface ServerOptions {
  port?: number;
  host?: string;
  /** Defaults to `process.cwd()`. */
  workspaceRoot?: string;
  logger?: Logger;
}

const require_ = createRequire(import.meta.url);

const silentLogger: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

const defaultLogger: Logger = {
  debug: () => {},
  info: (msg) => process.stderr.write(`[kli-server] ${msg}\n`),
  warn: (msg) => process.stderr.write(`[kli-server] WARN ${msg}\n`),
  error: (msg) => process.stderr.write(`[kli-server] ERROR ${msg}\n`),
};

const MODES: readonly Mode[] = ["plan", "build", "ask"];

const CAPABILITIES: readonly Capability[] = [
  "fs.read",
  "fs.write",
  "proc.exec",
  "net.http",
  "model.call",
  "secrets.read",
  "env.read",
];

/* ── Workspace state on disk ───────────────────────────────────────────── */

export interface ProjectMeta {
  id: string;
  name: string;
  path: string;
  createdAt: number;
  updatedAt: number;
}

export class Workspace {
  readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  get kliDir(): string {
    return join(this.root, ".kli");
  }

  get agentsPath(): string {
    return join(this.kliDir, "agents.json");
  }

  config(): Record<string, unknown> {
    const js = join(this.kliDir, "config.js");
    const ts = join(this.kliDir, "config.ts");
    const path = existsSync(js) ? js : ts;
    if (!existsSync(path)) return {};
    try {
      const raw = readFileSync(path, "utf-8");
      if (/require\s*\(/.test(raw)) return {};
      const mod = require_(path) as { default?: unknown };
      return ((mod.default ?? mod) ?? {}) as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  pluginSpecs(): string[] {
    const plugins = this.config()["plugins"] as { include?: unknown } | undefined;
    return Array.isArray(plugins?.include) ? (plugins.include as string[]) : [];
  }

  /** Built-in agents merged with user overrides from `.kli/agents.json`. */
  agents(): AgentDefinition[] {
    return mergeAgents(defaultAgents(), this.userAgents());
  }

  userAgents(): AgentDefinition[] {
    if (!existsSync(this.agentsPath)) return [];
    try {
      const parsed = JSON.parse(readFileSync(this.agentsPath, "utf-8")) as { agents?: unknown };
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

  saveAgents(agents: AgentDefinition[]): void {
    mkdirSync(this.kliDir, { recursive: true });
    writeFileSync(this.agentsPath, JSON.stringify({ version: 1, agents }, null, 2), "utf-8");
  }

  upsertAgent(agent: AgentDefinition): AgentDefinition[] {
    const current = this.userAgents();
    const next = current.some((item) => item.id === agent.id)
      ? current.map((item) => (item.id === agent.id ? agent : item))
      : [...current, agent];
    this.saveAgents(next);
    return this.agents();
  }

  deleteAgent(id: string): AgentDefinition[] {
    if (defaultAgents().some((agent) => agent.id === id)) {
      throw new Error(`"${id}" is a built-in agent and cannot be deleted`);
    }
    this.saveAgents(this.userAgents().filter((agent) => agent.id !== id));
    return this.agents();
  }

  projects(): ProjectMeta[] {
    const dir = join(this.kliDir, "projects");
    if (!existsSync(dir)) return [];
    const out: ProjectMeta[] = [];
    for (const entry of readdirSync(dir)) {
      const metaPath = join(dir, entry, "project.json");
      if (!existsSync(metaPath)) continue;
      try {
        const meta = JSON.parse(readFileSync(metaPath, "utf-8")) as Omit<ProjectMeta, "path"> & {
          path?: string;
        };
        // The CLI writes projects without a `path`; those simply use the
        // workspace root. Only an explicit path that has since vanished is
        // considered stale.
        if (!meta.path) {
          out.push({ ...meta, path: this.root });
        } else if (existsSync(meta.path)) {
          out.push({ ...meta, path: meta.path });
        }
      } catch {
        /* skip corrupt */
      }
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  createProject(name: string, path?: string): ProjectMeta {
    const id = name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    if (!id) throw new Error("Invalid project name");
    // A project's path is the directory the agent works in. Without an explicit
    // path it is simply the current workspace root — exactly what the CLI does,
    // and it means a fresh project is never "stale". An explicit path is
    // resolved inside the workspace and created if it does not exist yet.
    const explicit = path !== undefined && path.trim() !== "";
    const target = !explicit
      ? this.root
      : isAbsolute(path)
        ? (path as string)
        : resolveFs(this.root, path as string);
    if (explicit) mkdirSync(target, { recursive: true });
    const meta: ProjectMeta = {
      id,
      name: name.trim(),
      path: target,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const dir = join(this.kliDir, "projects", id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "project.json"), JSON.stringify(meta, null, 2), "utf-8");
    return meta;
  }

  deleteProject(id: string): void {
    const dir = join(this.kliDir, "projects", id);
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }

  /** Resolves a path inside the workspace, honouring Rule #3. */
  safeResolve(p: string): string {
    return resolvePath(p, this.root);
  }
}

/* ── Provider construction ─────────────────────────────────────────────── */

export interface ProviderRequest {
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
}

/**
 * Builds a provider from the *client's* configuration. The UI owns provider
 * selection at runtime, so the server creates providers per request instead of
 * pinning one at boot.
 */
export async function createProvider(req: ProviderRequest): Promise<Provider> {
  const mod = await import("@kli/provider-openai");
  return new mod.OpenAiProvider({
    apiKey: req.apiKey || "not-needed",
    baseURL: req.baseUrl,
    model: req.model,
    temperature: req.temperature ?? 0.7,
    maxTokens: req.maxTokens ?? 4096,
    stream: true,
  });
}

function collectSecrets(): Record<string, string> {
  const keys = [
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "TAVILY_KEY",
    "TAVILY_API_KEY",
    "BRAVE_API_KEY",
    "GITHUB_TOKEN",
    "JIRO_KEY",
  ];
  const out: Record<string, string> = {};
  for (const key of keys) {
    const value = process.env[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/* ── Server ────────────────────────────────────────────────────────────── */

interface ChatRequest {
  message?: string;
  mode?: Mode;
  provider?: ProviderRequest;
  budget?: { tokensTotal?: number; costLimitUsd?: number; deadlineMs?: number };
}

export class KliServer {
  private readonly workspace: Workspace;
  private readonly logger: Logger;
  private readonly host: string;
  private readonly port: number;
  private readonly server: Server;
  private readonly running = new Set<AbortController>();
  private kernel: Kernel | null = null;
  private kernelSignature = "";

  constructor(opts: ServerOptions = {}) {
    this.workspace = new Workspace(opts.workspaceRoot ?? process.cwd());
    this.logger = opts.logger ?? defaultLogger;
    this.host = opts.host ?? "127.0.0.1";
    this.port = opts.port ?? 4317;
    this.server = createServer((req, res) => {
      void this.handle(req, res).catch((err) => {
        this.logger.error(`unhandled: ${err instanceof Error ? err.message : String(err)}`);
        if (!res.headersSent) this.json(res, 500, { error: String(err) });
        else res.end();
      });
    });
  }

  listen(): Promise<{ port: number; host: string; url: string }> {
    return new Promise((ok, fail) => {
      this.server.once("error", fail);
      this.server.listen(this.port, this.host, () => {
        const url = `http://${this.host}:${this.port}`;
        this.logger.info(`listening on ${url}`);
        this.logger.info(`workspace ${this.workspace.root}`);
        ok({ port: this.port, host: this.host, url });
      });
    });
  }

  close(): Promise<void> {
    for (const controller of this.running) controller.abort();
    return new Promise((done) => this.server.close(() => done()));
  }

  /** Boots (or reuses) the kernel for the current plugin/agent configuration. */
  private async ensureKernel(): Promise<Kernel> {
    const specs = this.workspace.pluginSpecs();
    const signature = JSON.stringify({ specs, agents: this.workspace.userAgents() });
    if (this.kernel && this.kernelSignature === signature) return this.kernel;

    const kernel = new Kernel({
      workspaceRoot: this.workspace.root,
      logger: silentLogger,
      capabilities: new Set<Capability>(CAPABILITIES),
    });
    for (const agent of this.workspace.agents()) kernel.registry.registerAgent(agent, "workspace");
    await kernel.loadPlugins(specs);

    this.kernel = kernel;
    this.kernelSignature = signature;
    return kernel;
  }

  /** Drops the cached kernel so the next call re-reads config and agents. */
  async reload(): Promise<Kernel> {
    this.kernelSignature = "";
    this.kernel = null;
    return this.ensureKernel();
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const path = url.pathname;

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (!path.startsWith("/api/")) return this.json(res, 404, { error: "Not found" });

    const route = `${req.method} ${path}`;
    switch (route) {
      case "GET /api/health":
        return this.json(res, 200, await this.health());
      case "GET /api/workspace":
        return this.json(res, 200, {
          root: this.workspace.root,
          plugins: this.workspace.pluginSpecs(),
          config: this.workspace.config(),
        });
      case "GET /api/tools":
        return this.tools(res);
      case "GET /api/agents":
        return this.json(res, 200, { agents: (await this.ensureKernel()).listAgents() });
      case "POST /api/agents":
        return this.upsertAgent(req, res);
      case "GET /api/projects":
        return this.json(res, 200, { projects: this.workspace.projects() });
      case "POST /api/projects":
        return this.createProject(req, res);
      case "POST /api/reload":
        await this.reload();
        return this.json(res, 200, { ok: true });
      case "POST /api/chat":
        return this.chat(req, res);
      case "POST /api/read":
        return this.read(req, res);
      case "GET /api/models":
        return this.listModels(req, res);
      case "GET /api/graph":
        return this.graph(res);
      case "POST /api/graph":
        return this.buildGraph(res);
      default:
        if (req.method === "DELETE" && path.startsWith("/api/agents/")) {
          return this.deleteAgent(res, decodeURIComponent(path.slice("/api/agents/".length)));
        }
        if (req.method === "DELETE" && path === "/api/projects") {
          const id = url.searchParams.get("id");
          if (!id) return this.json(res, 400, { error: "id is required" });
          this.workspace.deleteProject(id);
          return this.json(res, 200, { projects: this.workspace.projects() });
        }
        return this.json(res, 404, { error: `No route for ${route}` });
    }
  }

  /* ── Endpoints ───────────────────────────────────────────────────────── */

  private async health(): Promise<unknown> {
    try {
      const kernel = await this.ensureKernel();
      const snapshot = kernel.registry.snapshot();
      const ctx = stubContext(this.workspace.root);
      const loaded = kernel.loader.getLoaded();
      return {
        ok: true,
        workspaceRoot: this.workspace.root,
        plugins: loaded.map((plugin) => ({
          id: plugin.manifest.id,
          version: plugin.manifest.version,
          kind: plugin.manifest.kind,
        })),
        pluginCount: loaded.length,
        tools: snapshot.tools.size,
        toolsByMode: Object.fromEntries(
          MODES.map((mode) => [mode, snapshot.toolsFor(mode, ctx).map((tool) => tool.name)]),
        ),
        backends: snapshot.backends.map((backend) => backend.id),
        skills: snapshot.skills.map((skill) => ({ id: skill.id, name: skill.name })),
        agents: kernel.listAgents().length,
        projects: this.workspace.projects().length,
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private async tools(res: ServerResponse): Promise<void> {
    const kernel = await this.ensureKernel();
    const ctx = stubContext(this.workspace.root);
    const snapshot = kernel.registry.snapshot();
    const tools = MODES.flatMap((mode) =>
      snapshot.toolsFor(mode, ctx).map((tool) => ({
        name: tool.name,
        description: tool.description,
        mode,
        capabilities: tool.capabilities,
        schema: tool.schema,
      })),
    );
    const unique = new Map(tools.map((tool) => [`${tool.mode}:${tool.name}`, tool]));
    this.json(res, 200, { tools: [...unique.values()] });
  }

  private async upsertAgent(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const parsed = AgentDefinitionSchema.safeParse(await this.body(req));
    if (!parsed.success) {
      return this.json(res, 400, {
        error: "Invalid agent",
        issues: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
      });
    }
    const agents = this.workspace.upsertAgent(parsed.data);
    await this.reload();
    this.json(res, 200, { agents });
  }

  private async deleteAgent(res: ServerResponse, id: string): Promise<void> {
    try {
      const agents = this.workspace.deleteAgent(id);
      await this.reload();
      this.json(res, 200, { agents });
    } catch (err) {
      this.json(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  private async createProject(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = (await this.body(req)) as { name?: string; path?: string };
    if (!body.name?.trim()) return this.json(res, 400, { error: "name is required" });
    try {
      const project = this.workspace.createProject(body.name, body.path);
      this.json(res, 200, { project, projects: this.workspace.projects() });
    } catch (err) {
      this.json(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  private async read(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = (await this.body(req)) as { path?: string };
    if (!body.path) return this.json(res, 400, { error: "path is required" });
    try {
      const abs = this.workspace.safeResolve(body.path);
      if (!existsSync(abs)) return this.json(res, 404, { error: "File not found" });
      if (statSync(abs).isDirectory()) return this.json(res, 400, { error: "Path is a directory" });
      const content = readFileSync(abs, "utf-8");
      const max = 200_000;
      this.json(res, 200, {
        path: body.path,
        name: body.path.split("/").pop() ?? body.path,
        content: content.length > max ? `${content.slice(0, max)}\n…[truncated]` : content,
        truncated: content.length > max,
      });
    } catch (err) {
      this.json(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  private async listModels(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = (await this.body(req)) as ProviderRequest;
    if (!body.baseUrl) return this.json(res, 400, { error: "baseUrl is required" });
    try {
      const provider = await createProvider({ ...body, model: body.model || "auto" });
      const models = (await provider.listModels?.()) ?? [];
      this.json(res, 200, { models });
    } catch (err) {
      this.json(res, 502, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  private async graph(res: ServerResponse): Promise<void> {
    const kernel = await this.ensureKernel();
    const cached = await kernel.graphCache.load();
    this.json(res, 200, {
      graph: cached
        ? {
            nodes: cached.graph.nodes.length,
            edges: cached.graph.edges.length,
            languages: Object.keys(cached.graph.languageStats ?? {}),
            backends: cached.graph.backends.map((backend) => backend.id),
            builtAt: cached.graph.builtAt,
          }
        : null,
    });
  }

  private async buildGraph(res: ServerResponse): Promise<void> {
    const kernel = await this.ensureKernel();
    const result = await kernel.buildCodeGraph({});
    this.json(res, 200, {
      graph: {
        nodes: result.graph.nodes.size,
        edges: result.graph.edges.size,
        languages: Object.keys(result.graph.languageStats ?? {}),
        backends: result.selectedBackends,
      },
    });
  }

  /* ── Chat: SSE ───────────────────────────────────────────────────────── */

  private async chat(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = (await this.body(req)) as ChatRequest;
    if (!body.message?.trim()) return this.json(res, 400, { error: "message is required" });
    const requestedProvider = body.provider;
    if (!requestedProvider?.baseUrl || !requestedProvider.model) {
      return this.json(res, 400, { error: "provider.baseUrl and provider.model are required" });
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    const send = (event: string, data: unknown): void => {
      if (res.writableEnded) return;
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    const runId = `run_${Date.now().toString(36)}`;
    const controller = new AbortController();
    this.running.add(controller);
    req.on("close", () => {
      controller.abort();
      this.running.delete(controller);
    });

    try {
      const kernel = await this.ensureKernel();
      const provider = await createProvider(requestedProvider);
      const mode: Mode = MODES.includes(body.mode as Mode) ? (body.mode as Mode) : "build";
      const config = this.workspace.config();
      const secrets = collectSecrets();

      const makeBudget = () => ({
        tokensTotal: body.budget?.tokensTotal ?? 200_000,
        tokensUsed: 0,
        costUsd: 0,
        costLimitUsd: body.budget?.costLimitUsd ?? 10,
        deadlineMs: body.budget?.deadlineMs ?? Date.now() + 600_000,
      });

      // Subagents inherit the request's provider; the delegation tool is
      // registered per run so it always closes over the live provider.
      //
      // `task` runs exclusively, so a single "current subagent" slot is enough
      // to tag nested tool activity with the right timeline block.
      let agentCounter = 0;
      let currentAgentBlockId: string | null = null;
      const delegation: ToolDefinition = createDelegationTool(
        "task",
        {
          listAgents: () => kernel.listAgents(),
          runAgent: async (agent, task, signal, hooks) =>
            kernel.runAgent({
              agent,
              task,
              signal,
              // The subagent must not re-enter the delegation tool.
              denyTools: ["task"],
              // An agent may pin its own model; otherwise it inherits the request's.
              provider: agent.model
                ? await createProvider({ ...requestedProvider, model: agent.model })
                : provider,
              budget: makeBudget(),
              capabilities: new Set<Capability>(CAPABILITIES),
              secrets,
              config,
              ...(hooks.onToken ? { onToken: hooks.onToken } : {}),
              ...(hooks.onReasoning ? { onReasoning: hooks.onReasoning } : {}),
              onToolActivity: (activity) => {
                // Only report completed nested tools; the card shows a single
                // "working…" state while the subagent is running.
                if (activity.phase !== "end") return;
                send("agent.tool", {
                  id: currentAgentBlockId,
                  agent: agent.id,
                  name: activity.name,
                  ok: activity.ok,
                  ms: activity.ms,
                });
              },
            }),
        },
        { budget: makeBudget(), exclusive: true },
      );
      kernel.registry.registerTool(delegation, "kli.server:agents", 100);

      send("start", {
        runId,
        mode,
        model: requestedProvider.model,
        agents: kernel.listAgents().filter((agent) => !agent.hidden).map((agent) => agent.id),
        tools: kernel.registry.snapshot().toolsFor(mode, stubContext(this.workspace.root)).length,
      });

      const result = await kernel.run({
        taskId: runId,
        mode,
        message: body.message,
        budget: makeBudget(),
        provider,
        capabilities: new Set<Capability>(CAPABILITIES),
        secrets,
        config,
        signal: controller.signal,
        onToken: (delta) => send("token", { delta }),
        onReasoning: (delta) => send("reasoning", { delta }),
        onToolActivity: (activity) => {
          if (activity.name === "task") {
            if (activity.phase === "start") {
              agentCounter += 1;
              currentAgentBlockId = `${runId}-agent-${agentCounter}`;
              send("agent.start", {
                id: currentAgentBlockId,
                agent:
                  typeof activity.args?.["agent"] === "string" ? activity.args["agent"] : "agent",
                task: typeof activity.args?.["task"] === "string" ? activity.args["task"] : "",
              });
            } else {
              send("agent.end", {
                id: currentAgentBlockId ?? `${runId}-agent-${agentCounter}`,
                agent: "",
                ok: activity.ok ?? false,
                error: activity.error,
              });
              currentAgentBlockId = null;
            }
            return;
          }
          if (activity.phase === "start") {
            send("tool.start", { name: activity.name, args: activity.args ?? {} });
          } else {
            send("tool.end", {
              name: activity.name,
              ok: activity.ok ?? false,
              ms: activity.ms ?? 0,
              error: activity.error,
            });
          }
        },
      });

      send("done", {
        status: result.status,
        steps: result.steps,
        cost: result.cost,
        tokensUsed: result.budget.tokensUsed,
        toolCalls: result.toolCalls,
      });
    } catch (err) {
      this.logger.error(`chat failed: ${err instanceof Error ? err.message : String(err)}`);
      send("error", { message: err instanceof Error ? err.message : String(err) });
    } finally {
      this.running.delete(controller);
      if (!res.writableEnded) res.end();
    }
  }

  private async body(req: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString("utf-8");
    if (!raw) return {};
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      return {};
    }
  }

  private json(res: ServerResponse, status: number, payload: unknown): void {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(payload));
  }
}

function stubContext(root: string): PluginContext {
  return {
    cwd: root,
    workspaceRoot: root,
    budget: { tokensTotal: 0, tokensUsed: 0, costUsd: 0, costLimitUsd: 0, deadlineMs: 0 },
    capabilities: new Set<Capability>(CAPABILITIES),
    logger: silentLogger,
    emit: () => {},
    secrets: {},
    config: {},
    resolve: (p: string) => resolvePath(p, root),
  };
}