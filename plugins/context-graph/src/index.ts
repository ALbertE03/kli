/**
 * @kli/context-graph — graph query tools
 */
import { z } from "zod";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { HarnessPlugin, Capability, ToolDefinition, CodeGraph } from "@kli/api";

const capabilities: Capability[] = [];

interface GraphCacheData {
  version: 1;
  graph: {
    nodes: [string, any][];
    edges: [string, any[]][];
    reverseEdges: [string, any[]][];
    workspaceRoot: string;
    languageStats: Record<string, any>;
    fileIndex: [string, string[]][];
    fileLanguages: [string, string][];
    crossLanguageEdges: any[];
    builtAt: number;
    backends: { id: string; languageCount: number }[];
    warnings: string[];
  };
  fileHashes: Record<string, string>;
}

const GraphQuerySchema = z.object({
  query: z.string(),
  limit: z.number().int().min(1).max(100),
});

const GraphExplainSchema = z.object({
  symbolId: z.string(),
});

const GraphWorkingSetSchema = z.object({
  task: z.string(),
  budgetTokens: z.number().int().min(100).max(10000),
});

export const plugin: HarnessPlugin = {
  manifest: {
    id: "kli.context.graph",
    version: "1.0.0",
    apiVersion: "1",
    kind: ["context", "tool"] as Array<"tool" | "provider" | "context" | "policy">,
    entrypoint: "./dist/index.js",
    capabilities,
    priority: 5,
  },
  register(registry) {
    registry.registerTool(buildQueryTool(), this.manifest.id);
    registry.registerTool(buildExplainTool(), this.manifest.id);
    registry.registerTool(buildWorkingSetTool(), this.manifest.id);
  },
};

export default plugin;

function loadGraph(workspaceRoot: string): CodeGraph | null {
  const cachePath = join(workspaceRoot, ".kli", "graph.json");
  if (!existsSync(cachePath)) return null;
  try {
    const data = JSON.parse(readFileSync(cachePath, "utf-8")) as GraphCacheData;
    return deserializeGraph(data.graph);
  } catch {
    return null;
  }
}

function buildQueryTool(): ToolDefinition<z.infer<typeof GraphQuerySchema>> {
  return {
    name: "graph_query",
    description: "Query the code graph for symbols matching a text query.",
    schema: GraphQuerySchema,
    capabilities,
    async execute(args, ctx, signal) {
      if (signal.aborted) return { ok: false, error: "aborted" };
      const graph = loadGraph(ctx.workspaceRoot);
      if (!graph) return { ok: false, error: "No graph found. Run 'kli graph build' first." };

      const results = [...graph.nodes.values()]
        .filter((n: any) =>
          n.name.toLowerCase().includes(args.query.toLowerCase()) ||
          (n.docstring ?? "").toLowerCase().includes(args.query.toLowerCase()),
        )
        .slice(0, args.limit);

      return {
        ok: true,
        content: results.map((n: any) => `${n.id}: ${n.name} (${n.kind}) @ ${n.file}:${n.line}`).join("\n"),
        data: results,
      };
    },
  };
}

function buildExplainTool(): ToolDefinition<z.infer<typeof GraphExplainSchema>> {
  return {
    name: "graph_explain",
    description: "Get callers and callees for a symbol.",
    schema: GraphExplainSchema,
    capabilities,
    async execute(args, ctx, signal) {
      if (signal.aborted) return { ok: false, error: "aborted" };
      const graph = loadGraph(ctx.workspaceRoot);
      if (!graph) return { ok: false, error: "No graph found." };

      const node = graph.nodes.get(args.symbolId);
      if (!node) return { ok: false, error: `Symbol not found: ${args.symbolId}` };

      const callers = graph.reverseEdges.get(args.symbolId) ?? [];
      const callees = graph.edges.get(args.symbolId) ?? [];

      return {
        ok: true,
        content: `Symbol: ${node.qualifiedName}\nType: ${node.kind}\nLocation: ${node.file}:${node.line}\n\nCallers (${callers.length}):\n${callers.map((e: any) => `  - ${e.from} (${e.kind})`).join("\n") || "  (none)"}`,
        data: { node, callers, callees },
      };
    },
  };
}

function buildWorkingSetTool(): ToolDefinition<z.infer<typeof GraphWorkingSetSchema>> {
  return {
    name: "graph_working_set",
    description: "Rank relevant symbols for a task based on text match.",
    schema: GraphWorkingSetSchema,
    capabilities,
    async execute(args, ctx, signal) {
      if (signal.aborted) return { ok: false, error: "aborted" };
      const graph = loadGraph(ctx.workspaceRoot);
      if (!graph) return { ok: false, error: "No graph found." };

      const tokens = args.task.toLowerCase().split(/\s+/);
      const scored = [...graph.nodes.values()]
        .map((n: any) => {
          const text = `${n.name} ${n.qualifiedName} ${(n.docstring ?? "")}`.toLowerCase();
          const score = tokens.filter((t) => text.includes(t)).length;
          return { node: n, score };
        })
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, Math.max(1, Math.floor(args.budgetTokens / 100)));

      return {
        ok: true,
        content: scored.map((x) => `${x.node.id}: ${x.node.name} (score: ${x.score})`).join("\n"),
        data: scored.map((x) => x.node),
      };
    },
  };
}

function deserializeGraph(s: any): CodeGraph {
  const nodes = new Map(s.nodes ?? []);
  const edges = new Map(s.edges ?? []);
  const reverseEdges = new Map(s.reverseEdges ?? []);
  return {
    version: 1,
    workspaceRoot: s.workspaceRoot,
    languageStats: s.languageStats ?? {},
    nodes,
    edges,
    reverseEdges,
    fileIndex: new Map(s.fileIndex ?? []),
    fileLanguages: new Map(s.fileLanguages ?? []),
    crossLanguageEdges: s.crossLanguageEdges ?? [],
    builtAt: s.builtAt ?? Date.now(),
    backends: s.backends ?? [],
    warnings: s.warnings ?? [],
  } as unknown as CodeGraph;
}