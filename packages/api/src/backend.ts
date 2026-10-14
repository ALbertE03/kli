/**
 * Backend contract — AST extractors for specific languages.
 * All backends produce a normalized CodeGraph (§3.6, Rule #5: false edges
 * are worse than missing edges).
 */

import { z } from "zod";

export const BackendCapabilitiesSchema = z.object({
  crossFile: z.boolean(),
  typeInfo: z.boolean(),
  incremental: z.boolean(),
  dynamicImports: z.boolean(),
});

export type BackendCapabilities = z.infer<typeof BackendCapabilitiesSchema>;

export const DetectionResultSchema = z.object({
  score: z.number().int().min(0).max(100),
  reason: z.string(),
  manifestFiles: z.array(z.string()),
});

export type DetectionResult = z.infer<typeof DetectionResultSchema>;

export const BuildOptionsSchema = z.object({
  files: z.array(z.string()).optional(),
  include: z.array(z.string()).optional(),
  exclude: z.array(z.string()).optional(),
});

export type BuildOptions = z.infer<typeof BuildOptionsSchema> & {
  signal?: AbortSignal;
  onProgress?: (pct: number, msg: string) => void;
};

export interface AstBackend {
  readonly id: string;
  readonly languages: readonly string[];
  readonly extensions: readonly string[];
  readonly contractVersion: 1;
  readonly capabilities: BackendCapabilities;

  detect(workspaceRoot: string): Promise<DetectionResult>;
  build(
    workspaceRoot: string,
    opts: BuildOptions,
  ): Promise<CodeGraph>;
  update?(
    graph: CodeGraph,
    changedFiles: string[],
  ): Promise<CodeGraph>;
}

/* --------------------------------------------------------------- *
 * Code graph — language-agnostic, unified model (§3.6)
 * --------------------------------------------------------------- */

export const SymbolKindSet = [
  "function",
  "method",
  "class",
  "interface",
  "type",
  "variable",
  "constant",
  "module",
  "namespace",
] as const;
export const SymbolKindSchema = z.enum(SymbolKindSet);
export type SymbolKind = (typeof SymbolKindSet)[number];

export const SymbolNodeSchema = z.object({
  id: z.string(),
  name: z.string(),
  qualifiedName: z.string(),
  kind: SymbolKindSchema,
  file: z.string(),
  line: z.number().int().min(1),
  column: z.number().min(0).optional(),
  signature: z.string().optional(),
  docstring: z.string().optional(),
  exported: z.boolean(),
  language: z.string(),
  metadata: z.record(z.unknown()).optional(),
});
export type SymbolNode = z.infer<typeof SymbolNodeSchema>;

export const EdgeKindSet = [
  "calls",
  "imports",
  "extends",
  "implements",
  "references",
  "instantiates",
  "decorates",
] as const;
export const EdgeKindSchema = z.enum(EdgeKindSet);
export type EdgeKind = (typeof EdgeKindSet)[number];

export const SymbolEdgeSchema = z.object({
  from: z.string(),
  to: z.string(),
  kind: EdgeKindSchema,
  line: z.number().int().min(1),
  external: z.string().optional(),
  confidence: z.enum(["exact", "inferred", "heuristic"]),
});
export type SymbolEdge = z.infer<typeof SymbolEdgeSchema>;

export const LanguageStatsSchema = z.object({
  language: z.string(),
  files: z.number().int().min(0),
  symbols: z.number().int().min(0),
  edges: z.number().int().min(0),
  backend: z.string(),
  buildMs: z.number().int().min(0),
  confidence: z.enum(["exact", "inferred", "heuristic"]),
});
export type LanguageStats = z.infer<typeof LanguageStatsSchema>;

export interface BackendInfo {
  readonly id: string;
  readonly languageCount: number;
}

export interface CodeGraph {
  version: 1;
  workspaceRoot: string;
  languageStats: Record<string, LanguageStats>;
  nodes: Map<string, SymbolNode>;
  edges: Map<string, SymbolEdge[]>;
  reverseEdges: Map<string, SymbolEdge[]>;
  fileIndex: Map<string, string[]>;
  fileLanguages: Map<string, string>;
  crossLanguageEdges: SymbolEdge[];
  builtAt: number;
  backends: BackendInfo[];
  warnings: string[];
}


