/**
 * @kli/backend-ts-morph — TypeScript/JavaScript AST backend (simplified)
 */
import { Project, SyntaxKind } from "ts-morph";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type {
  AstBackend,
  DetectionResult,
  BuildOptions,
  CodeGraph,
  SymbolNode,
  SymbolEdge,
  EdgeKind,
  SymbolKind,
  LanguageStats,
  BackendCapabilities,
} from "@kli/api";

const LANGUAGES = ["typescript", "javascript"];
const EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];

const Capabilities: BackendCapabilities = {
  crossFile: true,
  typeInfo: true,
  incremental: false,
  dynamicImports: false,
};

function findFiles(root: string, extensions: string[]): string[] {
  const files: string[] = [];
  function walk(dir: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!entry.name.startsWith(".") && entry.name !== "node_modules") {
          walk(full);
        }
      } else if (extensions.includes(entry.name.slice(entry.name.lastIndexOf(".")))) {
        files.push(full);
      }
    }
  }
  walk(root);
  return files;
}

export class TsMorphBackend implements AstBackend {
  readonly id = "backend.ts-morph";
  readonly languages = LANGUAGES;
  readonly extensions = EXTENSIONS;
  readonly contractVersion = 1;
  readonly capabilities = Capabilities;

  async detect(workspaceRoot: string): Promise<DetectionResult> {
    const hasTsConfig = require("node:fs").existsSync(join(workspaceRoot, "tsconfig.json"));
    const files = findFiles(workspaceRoot, EXTENSIONS);
    return {
      score: hasTsConfig ? 95 : 70,
      reason: hasTsConfig ? "tsconfig.json found" : "TypeScript/JS files detected without tsconfig",
      manifestFiles: files.slice(0, 20),
    };
  }

  async build(workspaceRoot: string, _opts: BuildOptions): Promise<CodeGraph> {
    const project = new Project({
      tsConfigFilePath: join(workspaceRoot, "tsconfig.json"),
      skipAddingFilesFromTsConfig: true,
    });

    const files = findFiles(workspaceRoot, EXTENSIONS);
    project.addSourceFilesAtPaths(files.map((f) => f.replace(workspaceRoot, ".")));

    const nodes = new Map<string, SymbolNode>();
    const edges = new Map<string, SymbolEdge[]>();
    const reverseEdges = new Map<string, SymbolEdge[]>();

    for (const source of project.getSourceFiles()) {
      const file = source.getFilePath();
      const lang = source.getLanguageVariant() === 1 ? "typescript" : "javascript";

      source.forEachDescendant((node) => {
        if (
          node.isKind(SyntaxKind.FunctionDeclaration) ||
          node.isKind(SyntaxKind.ClassDeclaration) ||
          node.isKind(SyntaxKind.InterfaceDeclaration) ||
          node.isKind(SyntaxKind.TypeAliasDeclaration) ||
          node.isKind(SyntaxKind.EnumDeclaration)
        ) {
          const name = node.getFirstChildByKind(SyntaxKind.Identifier)?.getText() ?? "anonymous";
          const line = node.getStartLinePos() + 1;
          const kind = nodeIsFunction(node)
            ? "function"
            : nodeIsClass(node)
              ? "class"
              : nodeIsInterface(node)
                ? "interface"
                : nodeIsType(node)
                  ? "type"
                  : "module";

          const id = `${file}::${name}`;
          nodes.set(id, {
            id,
            name,
            qualifiedName: name,
            kind: kind as SymbolKind,
            file,
            line,
            exported: node.isExported(),
            language: lang,
          });

          // Track call edges
          node.forEachChild((child) => {
            if (child.isKind(SyntaxKind.CallExpression)) {
              const target = child.getFirstChildByKind(SyntaxKind.Identifier)?.getText();
              if (target && target !== name) {
                const edge: SymbolEdge = {
                  from: id,
                  to: `${file}::${target}`,
                  kind: "calls" as EdgeKind,
                  line: child.getStartLinePos() + 1,
                  confidence: "inferred",
                };
                appendEdge(edges, reverseEdges, edge);
              }
            }
          });
        }
      });
    }

    // Compute language stats
    const languageStats: Record<string, LanguageStats> = {};
    for (const lang of new Set([...nodes.values()].map((n) => n.language))) {
      const langNodes = [...nodes.values()].filter((n) => n.language === lang);
      const langEdges = [...edges.values()].flat().filter((e) => {
        const fromNode = nodes.get(e.from);
        return fromNode?.language === lang;
      });
      languageStats[lang] = {
        language: lang,
        files: new Set(langNodes.map((n) => n.file)).size,
        symbols: langNodes.length,
        edges: langEdges.length,
        backend: this.id,
        buildMs: 0,
        confidence: "inferred" as const,
      };
    }

    return {
      version: 1,
      workspaceRoot,
      languageStats,
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

function nodeIsFunction(n: any): boolean {
  return n.isKind?.(SyntaxKind.FunctionDeclaration) || n.isKind?.(SyntaxKind.MethodDeclaration);
}
function nodeIsClass(n: any): boolean { return n.isKind?.(SyntaxKind.ClassDeclaration); }
function nodeIsInterface(n: any): boolean { return n.isKind?.(SyntaxKind.InterfaceDeclaration); }
function nodeIsType(n: any): boolean { return n.isKind?.(SyntaxKind.TypeAliasDeclaration); }

function appendEdge(
  edges: Map<string, SymbolEdge[]>,
  rev: Map<string, SymbolEdge[]>,
  e: SymbolEdge,
) {
  const list = edges.get(e.from) ?? [];
  list.push(e);
  edges.set(e.from, list);
  const rlist = rev.get(e.to) ?? [];
  rlist.push(e);
  rev.set(e.to, rlist);
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
    id: "kli.backend.ts-morph",
    version: "1.0.0",
    apiVersion: "1" as const,
    kind: ["context"] as Array<"tool" | "provider" | "context" | "policy">,
    entrypoint: "./dist/index.js",
    capabilities: [],
  },
  register(registry: import("@kli/api").Registry) {
    registry.registerBackend(new TsMorphBackend());
  },
};

export default plugin;