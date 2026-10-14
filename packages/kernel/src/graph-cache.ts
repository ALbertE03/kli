/**
 * Graph cache — persisted code graph with per-file hash invalidation (§4.8).
 *
 * Path: <workspaceRoot>/.kli/graph.json (renamed from .kiln per the KLI rename)
 * Contents: serialized CodeGraph + fileHashes.
 */
import { existsSync, mkdirSync } from "node:fs";
import { writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { CodeGraph, SymbolNode, SymbolEdge, LanguageStats, BackendInfo } from "@kli/api";

export interface GraphCacheData {
  version: 1;
  graph: SerializedGraph;
  fileHashes: Record<string, string>;
}

interface SerializedGraph {
  version: 1;
  workspaceRoot: string;
  languageStats: Record<string, LanguageStats>;
  nodes: [string, SymbolNode][];
  edges: [string, SymbolEdge[]][];
  reverseEdges: [string, SymbolEdge[]][];
  fileIndex: [string, string[]][];
  fileLanguages: [string, string][];
  crossLanguageEdges: SymbolEdge[];
  builtAt: number;
  backends: BackendInfo[];
  warnings: string[];
}

export class GraphCache {
  private readonly cachePath: string;
  private readonly kliDir: string;

  constructor(private readonly workspaceRoot: string) {
    this.kliDir = join(workspaceRoot, ".kli");
    this.cachePath = join(this.kliDir, "graph.json");
  }

  async load(): Promise<GraphCacheData | null> {
    try {
      if (!existsSync(this.cachePath)) return null;
      const raw = await readFile(this.cachePath, "utf-8");
      return JSON.parse(raw) as GraphCacheData;
    } catch {
      return null;
    }
  }

  save(graph: CodeGraph, fileHashes: Record<string, string>): Promise<void> {
    const data: GraphCacheData = {
      version: 1,
      graph: this.serialize(graph),
      fileHashes,
    };
    ensureDirSync(this.kliDir);
    return writeFile(this.cachePath, JSON.stringify(data, null, 2), "utf-8");
  }

  /**
   * Determine which files are stale since the last cache load.
   * A file is stale if its hash differs from the cache or if it's new/deleted.
   */
  staleFiles(
    cache: GraphCacheData,
    fileHashes: Record<string, string>,
  ): string[] {
    const stale: string[] = [];
    for (const [file, hash] of Object.entries(fileHashes)) {
      const cached = cache.fileHashes[file];
      if (!cached || cached !== hash) {
        stale.push(file);
      }
    }
    for (const file of Object.keys(cache.fileHashes)) {
      if (!(file in fileHashes)) {
        stale.push(file);
      }
    }
    return stale;
  }

  /** Hash a file's contents from disk. */
  static async hashFile(path: string): Promise<string> {
    try {
      const content = await readFile(path);
      return createHash("sha256").update(content).digest("hex");
    } catch {
      return "";
    }
  }

  /** Hash an in-memory string (for testing / virtual files). */
  static hashContent(content: string | Buffer): string {
    return createHash("sha256").update(content).digest("hex");
  }

  private serialize(graph: CodeGraph): SerializedGraph {
    return {
      version: graph.version,
      workspaceRoot: graph.workspaceRoot,
      languageStats: graph.languageStats,
      nodes: [...graph.nodes.entries()],
      edges: [...graph.edges.entries()],
      reverseEdges: [...graph.reverseEdges.entries()],
      fileIndex: [...graph.fileIndex.entries()],
      fileLanguages: [...graph.fileLanguages.entries()],
      crossLanguageEdges: graph.crossLanguageEdges,
      builtAt: graph.builtAt,
      backends: graph.backends,
      warnings: graph.warnings,
    };
  }
}

function ensureDirSync(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}
