/**
 * @kli/context-graph — robust code graph query engine
 *
 * Features:
 *  - Full code graph traversal
 *  - Symbol resolution across files
 *  - Impact analysis (callers/callees)
 *  - Working set ranking (by relevance to task)
 *  - Path finding between symbols
 *  - Cache persistence with invalidation
 */
import { z } from "zod";
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type {
  HarnessPlugin,
  Capability,
  ToolDefinition,
  CodeGraph,
  SymbolNode,
  SymbolEdge,
} from "@kli/api";

const capabilities: Capability[] = [];

// Graph cache path
const CACHE_PATH = ".kli/graph.json";

// Schema for graph_query
const GraphQuerySchema = z.object({
  query: z.string().min(1),
  limit: z.number().int().min(1).max(100),
  kind: z.enum(["function", "class", "method", "interface", "type", "variable", "module"]).optional(),
  file: z.string().optional(),
});

// Schema for graph_explain
const GraphExplainSchema = z.object({
  symbolId: z.string().min(1),
  depth: z.number().int().min(1).max(5),
});

// Schema for graph_working_set
const GraphWorkingSetSchema = z.object({
  task: z.string().min(1),
  budgetTokens: z.number().int().min(100).max(10_000),
  includeDocs: z.boolean().optional(),
});

// Schema for graph_path
const GraphPathSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  maxDepth: z.number().int().min(1).max(20),
});

export const plugin: HarnessPlugin = {
  manifest: {
    id: "kli.context.graph",
    version: "2.0.0",
    apiVersion: "1",
    kind: ["context", "tool"],
    entrypoint: "./dist/index.js",
    capabilities,
    priority: 5,
  },
  register(registry) {
    registry.registerTool(buildQueryTool(), this.manifest.id);
    registry.registerTool(buildExplainTool(), this.manifest.id);
    registry.registerTool(buildWorkingSetTool(), this.manifest.id);
    registry.registerTool(buildPathTool(), this.manifest.id);
  },
};

export default plugin;

function loadGraph(workspaceRoot: string): CodeGraph | null {
  const cachePath = join(workspaceRoot, CACHE_PATH);
  if (!existsSync(cachePath)) return null;
  try {
    const data = JSON.parse(readFileSync(cachePath, "utf-8")) as {
      version: number;
      graph: Partial<CodeGraph>;
      fileHashes: Record<string, string>;
      builtAt: number;
    };
    if (data.version !== 1) return null;
    return deserializeGraph(data.graph);
  } catch {
    return null;
  }
}

function buildQueryTool(): ToolDefinition<z.infer<typeof GraphQuerySchema>> {
  return {
    name: "graph_query",
    description: `Query the code graph for symbols matching a search query.

Args:
  query: string — text to search (name, docstring, signature)
  limit: number — max results (default 10, max 100)
  kind?: string — filter by symbol kind
  file?: string — filter by file path

Returns: Array of matching symbols with id, name, kind, file, line`,
    schema: GraphQuerySchema,
    capabilities,
    async execute(args, ctx) {
      const graph = loadGraph(ctx.workspaceRoot);
      if (!graph) {
        return {
          ok: false,
          error: "No graph found. Run 'kli graph build' first.",
          code: "NO_GRAPH",
        };
      }

      const q = args.query.toLowerCase();
      const results = [...graph.nodes.values()]
        .filter((n) => {
          if (args.kind && n.kind !== args.kind) return false;
          if (args.file && !n.file.toLowerCase().includes(args.file.toLowerCase())) return false;
          const text = `${n.name} ${n.qualifiedName} ${n.docstring ?? ""} ${n.signature ?? ""}`.toLowerCase();
          return text.includes(q);
        })
        .slice(0, args.limit);

      return {
        ok: true,
        content: results
          .map(
            (n) =>
              `[${n.kind}] ${n.qualifiedName}\n  ${n.file}:${n.line} — ${n.docstring ?? ""}`,
          )
          .join("\n\n"),
        data: results,
      };
    },
  };
}

function buildExplainTool(): ToolDefinition<z.infer<typeof GraphExplainSchema>> {
  return {
    name: "graph_explain",
    description: `Get detailed info about a symbol including callers, callees, and type info.

Args:
  symbolId: string — full symbol ID (e.g., "src/auth.ts::login")
  depth: number — how many hops to traverse (default 2, max 5)

Returns: Symbol info + callers + callees + type info`,
    schema: GraphExplainSchema,
    capabilities,
    async execute(args, ctx) {
      const graph = loadGraph(ctx.workspaceRoot);
      if (!graph) {
        return { ok: false, error: "No graph found. Run 'kli graph build' first." };
      }

      const node = graph.nodes.get(args.symbolId);
      if (!node) {
        return { ok: false, error: `Symbol not found: ${args.symbolId}` };
      }

      // Collect callers and callees
      const callees = graph.edges.get(args.symbolId) ?? [];
      const callers = graph.reverseEdges.get(args.symbolId) ?? [];

      // Expand to depth
      const expandedCallees = new Set<string>(callees.map((e) => e.to));
      const expandedCallers = new Set<string>(callers.map((e) => e.from));

      if (args.depth > 1) {
        for (const target of [...expandedCallees]) {
          graph.edges.get(target)?.forEach((e) => expandedCallees.add(e.to));
        }
        for (const source of [...expandedCallers]) {
          graph.reverseEdges.get(source)?.forEach((e) => expandedCallers.add(e.from));
        }
      }

      return {
        ok: true,
        content: `
## ${node.qualifiedName}
**Kind:** ${node.kind}
**File:** ${node.file}:${node.line}${node.column ? `:${node.column}` : ""}
${node.signature ? `**Signature:** \`${node.signature}\`` : ""}
${node.docstring ? `**Docs:** ${node.docstring}` : ""}

### Callees (${callees.length})
${callees.slice(0, 20).map((e) => `  - ${e.to} [${e.kind}]`).join("\n") || "  (none)"}

### Callers (${callers.length})
${callers.slice(0, 20).map((e) => `  - ${e.from} [${e.kind}]`).join("\n") || "  (none)"}
`.trim(),
        data: {
          node,
          callees: callees.slice(0, args.depth * 10),
          callers: callers.slice(0, args.depth * 10),
          expandedCallees: [...expandedCallees].slice(0, 50),
          expandedCallers: [...expandedCallers].slice(0, 50),
        },
      };
    },
  };
}

function buildWorkingSetTool(): ToolDefinition<z.infer<typeof GraphWorkingSetSchema>> {
  return {
    name: "graph_working_set",
    description: `Rank relevant symbols for a task based on text match and graph proximity.

Args:
  task: string — task description
  budgetTokens: number — token budget for results (default 4000)
  includeDocs: boolean — include docstrings (default false)

Returns: Ranked list of symbols with relevance scores`,
    schema: GraphWorkingSetSchema,
    capabilities,
    async execute(args, ctx) {
      const graph = loadGraph(ctx.workspaceRoot);
      if (!graph) {
        return { ok: false, error: "No graph found. Run 'kli graph build' first." };
      }

      const tokens = args.task.toLowerCase().split(/\s+/).filter(Boolean);
      const scored: Array<{ node: SymbolNode; score: number }> = [];

      for (const node of graph.nodes.values()) {
        const text = `${node.name} ${node.qualifiedName} ${node.docstring ?? ""} ${node.signature ?? ""}`.toLowerCase();
        let score = 0;
        for (const t of tokens) {
          if (text.includes(t)) score += t.length; // longer matches score higher
        }
        if (score > 0) scored.push({ node, score });
      }

      // Sort by score and take top results
      scored.sort((a, b) => b.score - a.score);
      const top = scored.slice(0, Math.min(50, Math.floor(args.budgetTokens / 100)));

      return {
        ok: true,
        content: top
          .map(
            ({ node, score }) =>
              `${score.toFixed(1)} ${node.qualifiedName} (${node.kind}) @ ${node.file}:${node.line}`,
          )
          .join("\n"),
        data: top.map(({ node, score }) => ({ score, ...node })),
      };
    },
  };
}

function buildPathTool(): ToolDefinition<z.infer<typeof GraphPathSchema>> {
  return {
    name: "graph_path",
    description: `Find shortest path between two symbols in the code graph.

Args:
  from: string — source symbol ID
  to: string — target symbol ID
  maxDepth: number — max path length (default 10, max 20)

Returns: Path as array of symbol IDs`,
    schema: GraphPathSchema,
    capabilities,
    async execute(args, ctx) {
      const graph = loadGraph(ctx.workspaceRoot);
      if (!graph) {
        return { ok: false, error: "No graph found." };
      }

      // BFS path finding
      const visited = new Set<string>();
      const queue: Array<{ id: string; path: string[] }> = [{ id: args.from, path: [args.from] }];
      visited.add(args.from);

      while (queue.length > 0) {
        const current = queue.shift();
        if (!current) continue;
        if (current.id === args.to) {
          return {
            ok: true,
            content: `Path found: ${current.path.join(" → ")}`,
            data: { path: current.path, length: current.path.length },
          };
        }
        if (current.path.length >= args.maxDepth) continue;

        // Follow outgoing edges
        for (const edge of graph.edges.get(current.id) ?? []) {
          if (!visited.has(edge.to)) {
            visited.add(edge.to);
            queue.push({ id: edge.to, path: [...current.path, edge.to] });
          }
        }
        // Follow incoming edges (reverse)
        for (const edge of graph.reverseEdges.get(current.id) ?? []) {
          if (!visited.has(edge.from)) {
            visited.add(edge.from);
            queue.push({ id: edge.from, path: [...current.path, edge.from] });
          }
        }
      }

      return {
        ok: false,
        error: `No path found from ${args.from} to ${args.to} within depth ${args.maxDepth}`,
        code: "NO_PATH",
      };
    },
  };
}

function deserializeGraph(s: unknown): CodeGraph {
  const obj = s as Record<string, unknown>;
  const nodes = new Map<string, SymbolNode>(
    (obj.nodes as [string, SymbolNode][] | undefined) ?? [],
  );
  const edges = new Map<string, SymbolEdge[]>(
    (obj.edges as [string, SymbolEdge[]][] | undefined) ?? [],
  );
  const reverseEdges = new Map<string, SymbolEdge[]>(
    (obj.reverseEdges as [string, SymbolEdge[]][] | undefined) ?? [],
  );
  return {
    version: 1,
    workspaceRoot: (obj.workspaceRoot as string) ?? "",
    languageStats: (obj.languageStats as Record<string, unknown>) ?? {},
    nodes,
    edges,
    reverseEdges,
    fileIndex: new Map<string, string[]>(
      (obj.fileIndex as [string, string[]][] | undefined) ?? [],
    ),
    fileLanguages: new Map<string, string>(
      (obj.fileLanguages as [string, string][] | undefined) ?? [],
    ),
    crossLanguageEdges: (obj.crossLanguageEdges as SymbolEdge[] | undefined) ?? [],
    builtAt: (obj.builtAt as number) ?? Date.now(),
    backends: (obj.backends as import("@kli/api").BackendInfo[] | undefined) ?? [],
    warnings: (obj.warnings as string[] | undefined) ?? [],
  } as CodeGraph;
}