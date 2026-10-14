/**
 * @kli/backend-config — config file backend (yaml, toml, json, etc.)
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type {
  AstBackend,
  DetectionResult,
  BuildOptions,
  CodeGraph,
  SymbolNode,
  SymbolEdge,
  BackendCapabilities,
} from "@kli/api";

const LANGUAGES = ["yaml", "toml", "json", "docker", "openapi"];
const EXTENSIONS = [".yaml", ".yml", ".toml", ".json", ".proto", ".graphql"];

const Capabilities: BackendCapabilities = {
  crossFile: false,
  typeInfo: false,
  incremental: false,
  dynamicImports: false,
};

export class ConfigBackend implements AstBackend {
  readonly id = "backend.config";
  readonly languages = LANGUAGES;
  readonly extensions = EXTENSIONS;
  readonly contractVersion = 1;
  readonly capabilities = Capabilities;

  async detect(workspaceRoot: string): Promise<DetectionResult> {
    const files = findConfigFiles(workspaceRoot);
    return {
      score: files.length > 0 ? 60 : 0,
      reason: files.length > 0 ? `${files.length} config files found` : "No config files detected",
      manifestFiles: files,
    };
  }

  async build(workspaceRoot: string, _opts: BuildOptions): Promise<CodeGraph> {
    const files = findConfigFiles(workspaceRoot);
    const nodes = new Map<string, SymbolNode>();
    const edges = new Map<string, SymbolEdge[]>();
    const reverseEdges = new Map<string, SymbolEdge[]>();

    for (const file of files) {
      try {
        const content = readFileSync(file, "utf-8");
        // Simple extraction: treat each top-level key as a module
        const lines = content.split("\n");
        for (const line of lines) {
          const match = line.match(/^(\w+)\s*[:=]/);
          if (match && match[1]) {
            const id = `${file}::${match[1]}`;
            nodes.set(id, {
              id,
              name: match[1],
              qualifiedName: match[1],
              kind: "module",
              file,
              line: lines.indexOf(line) + 1,
              exported: false,
              language: getLanguage(file),
            });
          }
        }
      } catch {
        // Ignore unreadable files
      }
    }

    return {
      version: 1,
      workspaceRoot,
      languageStats: {
        config: {
          language: "config",
          files: files.length,
          symbols: nodes.size,
          edges: 0,
          backend: this.id,
          buildMs: 0,
          confidence: "heuristic",
        },
      },
      nodes,
      edges,
      reverseEdges,
      fileIndex: buildFileIndex(nodes),
      fileLanguages: buildFileLanguages(nodes),
      crossLanguageEdges: [],
      builtAt: Date.now(),
      backends: [{ id: this.id, languageCount: LANGUAGES.length }],
      warnings: [],
    };
  }
}

function findConfigFiles(root: string): string[] {
  const files: string[] = [];
  function walk(dir: string) {
    try {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        const stat = statSync(full);
        if (stat.isDirectory()) {
          if (!entry.startsWith(".") && entry !== "node_modules") walk(full);
        } else if (EXTENSIONS.includes(entry.slice(entry.lastIndexOf(".")))) {
          files.push(full);
        }
      }
    } catch {
      // Ignore permission errors
    }
  }
  walk(root);
  return files;
}

function getLanguage(file: string): string {
  const ext = file.slice(file.lastIndexOf(".")).toLowerCase();
  const lang = { ".yaml": "yaml", ".yml": "yaml", ".toml": "toml", ".json": "json", ".proto": "protobuf", ".graphql": "graphql" }[ext];
  return lang ?? "config";
}

function buildFileIndex(nodes: Map<string, SymbolNode>): Map<string, string[]> {
  const idx = new Map<string, string[]>();
  for (const n of nodes.values()) {
    const list = idx.get(n.file) ?? [];
    list.push(n.id);
    idx.set(n.file, list);
  }
  return idx;
}

function buildFileLanguages(nodes: Map<string, SymbolNode>): Map<string, string> {
  const map = new Map<string, string>();
  for (const n of nodes.values()) map.set(n.file, n.language);
  return map;
}

export const plugin = {
  manifest: {
    id: "kli.backend.config",
    version: "1.0.0",
    apiVersion: "1" as const,
    kind: ["context"] as Array<"tool" | "provider" | "context" | "policy">,
    entrypoint: "./dist/index.js",
    capabilities: [],
  },
  register(registry: import("@kli/api").Registry) {
    registry.registerBackend(new ConfigBackend());
  },
};

export default plugin;