/**
 * @kli/backend-tree-sitter — Tree-sitter based AST backend.
 *
 * STATUS: WIP. The core `tree-sitter` runtime is installed but no grammar
 * packages (e.g. `tree-sitter-typescript`, `tree-sitter-python`) are. When a
 * grammar is missing `parseFile()` reports `available: false` and `build()`
 * degrades to a metadata-only graph (file/language stats) with a WIP warning —
 * it never fabricates symbols or edges (Rule #6).
 *
 * To enable real extraction, add the grammar packages as dependencies of this
 * plugin and rebuild; `parseFile()` will pick them up automatically.
 */
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, extname } from "node:path";
import type {
  AstBackend,
  DetectionResult,
  BuildOptions,
  CodeGraph,
  SymbolNode,
  SymbolEdge,
  SymbolKind,
  BackendCapabilities,
  LanguageStats,
} from "@kli/api";

const LANGUAGES = ["typescript", "javascript", "python", "java", "go", "rust", "c", "cpp"];

const Capabilities: BackendCapabilities = {
  crossFile: true,
  typeInfo: true,
  incremental: true,
  dynamicImports: true,
};

const requireFromHere = createRequire(import.meta.url);

/**
 * Grammar package + the node types that count as top-level symbols, per
 * language. Kept as data so `parseFile` is generic.
 */
interface GrammarSpec {
  package: string;
  /** Key on the imported module when a package exports several grammars. */
  exportKey?: string;
  symbolNodes: Record<string, SymbolKind>;
}

const GRAMMARS: Record<string, GrammarSpec> = {
  typescript: {
    package: "tree-sitter-typescript",
    exportKey: "typescript",
    symbolNodes: {
      function_declaration: "function",
      class_declaration: "class",
      interface_declaration: "interface",
      type_alias_declaration: "type",
      method_definition: "method",
    },
  },
  javascript: {
    package: "tree-sitter-javascript",
    symbolNodes: {
      function_declaration: "function",
      class_declaration: "class",
      method_definition: "method",
      variable_declarator: "variable",
    },
  },
  python: {
    package: "tree-sitter-python",
    symbolNodes: {
      function_definition: "function",
      class_definition: "class",
    },
  },
};

interface TsNode {
  type: string;
  text: string;
  startPosition: { row: number; column: number };
  endPosition: { row: number; column: number };
  childForFieldName(name: string): TsNode | null;
  namedChildren: TsNode[];
}

interface TsTree {
  rootNode: TsNode;
}

interface TsParser {
  setLanguage(grammar: unknown): void;
  parse(source: string): TsTree;
}

interface GrammarModule {
  [key: string]: unknown;
}

export interface ParseFileResult {
  /** False when the grammar package for this language is not installed. */
  available: boolean;
  /** Reason the grammar is unavailable, for diagnostics. */
  reason?: string;
  language: string;
  symbols: Array<Omit<SymbolNode, "id">>;
}

export class TreeSitterBackend implements AstBackend {
  readonly id = "backend.tree-sitter";
  readonly languages = LANGUAGES;
  readonly extensions: string[] = [".ts", ".tsx", ".js", ".jsx", ".py", ".java", ".go", ".rs", ".c", ".cpp"];
  readonly contractVersion = 1;
  readonly capabilities = Capabilities;
  /** True while grammar-based extraction is not fully wired up. */
  readonly wip = true;

  async detect(workspaceRoot: string): Promise<DetectionResult> {
    const sourceFiles = this.findSourceFiles(workspaceRoot);

    let score = 0;
    const reasonParts: string[] = [];

    const hasTsConfig = sourceFiles.some((f) => f.endsWith("tsconfig.json"));
    const hasPyproject = sourceFiles.some((f) => f.endsWith("pyproject.toml"));
    const hasPackageJson = sourceFiles.some((f) => f.endsWith("package.json"));

    if (hasTsConfig) {
      score += 30;
      reasonParts.push("tsconfig.json found");
    }
    if (hasPyproject) {
      score += 20;
      reasonParts.push("pyproject.toml found");
    }
    if (hasPackageJson) {
      score += 10;
      reasonParts.push("package.json found");
    }

    if (sourceFiles.length > 0) {
      const codeFiles = sourceFiles.filter((f) => !f.endsWith("json") && !f.endsWith("toml"));
      score += Math.min(40, codeFiles.length * 2);
      reasonParts.push(`${codeFiles.length} source files found`);
    }

    const scoreValue = Math.min(100, score);
    const reason = reasonParts.length > 0 ? reasonParts.join(", ") : "No recognized project indicators found";

    return {
      score: scoreValue,
      reason,
      manifestFiles: [
        ...(hasTsConfig ? [join(workspaceRoot, "tsconfig.json")] : []),
        ...(hasPyproject ? [join(workspaceRoot, "pyproject.toml")] : []),
        ...(hasPackageJson ? [join(workspaceRoot, "package.json")] : []),
        ...sourceFiles.slice(0, 10),
      ],
    };
  }

  /**
   * Parse a single file with tree-sitter. Returns `available: false` (rather
   * than throwing) when the grammar package is not installed, so callers can
   * fall back cleanly.
   */
  parseFile(filePath: string, language: string): ParseFileResult {
    const spec = GRAMMARS[language];
    if (!spec) {
      return { available: false, reason: `no grammar mapping for ${language}`, language, symbols: [] };
    }

    let grammar: unknown;
    try {
      const mod = requireFromHere(spec.package) as GrammarModule | { default?: GrammarModule };
      const resolved =
        spec.exportKey !== undefined
          ? (mod as GrammarModule)[spec.exportKey]
          : ((mod as { default?: GrammarModule }).default ?? mod);
      grammar = resolved;
      if (!grammar) throw new Error("grammar export missing");
    } catch (err) {
      return {
        available: false,
        reason: `grammar "${spec.package}" not installed (${
          err instanceof Error ? err.message : String(err)
        })`,
        language,
        symbols: [],
      };
    }

    try {
      const ParserCtor = (requireFromHere("tree-sitter") as { default?: unknown }).default ??
        requireFromHere("tree-sitter");
      const parser = new (ParserCtor as new () => TsParser)();
      parser.setLanguage(grammar);
      const source = readFileSync(filePath, "utf-8");
      const tree = parser.parse(source);
      const symbols = this.extractSymbols(tree.rootNode, filePath, language, source);
      return { available: true, language, symbols };
    } catch (err) {
      return {
        available: false,
        reason: err instanceof Error ? err.message : String(err),
        language,
        symbols: [],
      };
    }
  }

  private extractSymbols(
    root: TsNode,
    filePath: string,
    language: string,
    _source: string,
  ): Array<Omit<SymbolNode, "id">> {
    const spec = GRAMMARS[language];
    if (!spec) return [];
    const out: Array<Omit<SymbolNode, "id">> = [];

    const visit = (node: TsNode): void => {
      const kind = spec.symbolNodes[node.type];
      if (kind) {
        const nameNode = node.childForFieldName("name") ?? findName(node);
        if (nameNode) {
          out.push({
            name: nameNode.text,
            qualifiedName: nameNode.text,
            kind,
            file: filePath,
            line: node.startPosition.row + 1,
            column: node.startPosition.column,
            signature: firstLine(node.text),
            exported: false,
            language,
          });
        }
      }
      for (const child of node.namedChildren) visit(child);
    };

    visit(root);
    return out;
  }

  async build(workspaceRoot: string, _opts: BuildOptions): Promise<CodeGraph> {
    const sourceFiles = this.findSourceFiles(workspaceRoot);

    const nodes = new Map<string, SymbolNode>();
    const edges = new Map<string, SymbolEdge[]>();
    const reverseEdges = new Map<string, SymbolEdge[]>();
    const fileIndex = new Map<string, string[]>();
    const fileLanguages = new Map<string, string>();
    const fileSymbolCounts = new Map<string, number>();
    const fileEdgeCounts = new Map<string, number>();
    const warnings: string[] = [];
    let grammarFiles = 0;
    let parsedFiles = 0;

    for (const filePath of sourceFiles) {
      const relativePath = filePath.replace(workspaceRoot + "/", "");
      const ext = filePath.slice(filePath.lastIndexOf(".")).toLowerCase();
      const language = this.getLanguageFromExt(ext);
      if (!language) continue;

      fileLanguages.set(relativePath, language);
      fileSymbolCounts.set(relativePath, 0);
      fileEdgeCounts.set(relativePath, 0);
      fileIndex.set(relativePath, []);

      const parsed = this.parseFile(filePath, language);
      if (!parsed.available) {
        if (parsed.reason && warnings.length < 3) warnings.push(parsed.reason);
        continue;
      }
      grammarFiles++;
      for (const symbol of parsed.symbols) {
        const id = `${relativePath}::${symbol.qualifiedName}`;
        nodes.set(id, { ...symbol, id, file: relativePath });
        const ids = fileIndex.get(relativePath) ?? [];
        ids.push(id);
        fileIndex.set(relativePath, ids);
        fileSymbolCounts.set(relativePath, (fileSymbolCounts.get(relativePath) ?? 0) + 1);
        parsedFiles++;
      }
    }

    const languageStats: Record<string, LanguageStats> = {};
    for (const lang of new Set([...fileLanguages.values()])) {
      const langFiles = [...fileLanguages.entries()].filter(([, l]) => l === lang).map(([file]) => file);
      const totalSymbols = langFiles.reduce((sum, file) => sum + (fileSymbolCounts.get(file) ?? 0), 0);
      const totalEdges = langFiles.reduce((sum, file) => sum + (fileEdgeCounts.get(file) ?? 0), 0);
      languageStats[lang] = {
        language: lang,
        files: langFiles.length,
        symbols: totalSymbols,
        edges: totalEdges,
        backend: this.id,
        buildMs: 0,
        confidence: nodes.size > 0 ? "exact" : "heuristic",
      };
    }

    if (nodes.size === 0) {
      warnings.unshift(
        "WIP: tree-sitter grammars not installed — returning metadata-only graph. " +
          "Add tree-sitter-<lang> packages to enable symbol extraction.",
      );
    } else if (parsedFiles > 0 && grammarFiles < fileLanguages.size) {
      warnings.unshift(
        `WIP: parsed ${grammarFiles}/${fileLanguages.size} files with available grammars.`,
      );
    }

    return {
      version: 1,
      workspaceRoot,
      languageStats,
      nodes,
      edges,
      reverseEdges,
      fileIndex,
      fileLanguages,
      crossLanguageEdges: [],
      builtAt: Date.now(),
      backends: [{ id: this.id, languageCount: LANGUAGES.length }],
      warnings,
    };
  }

  private findSourceFiles(workspaceRoot: string): string[] {
    const files: string[] = [];
    const stack = [workspaceRoot];

    while (stack.length > 0) {
      const dir = stack.pop();
      if (!dir) continue;
      try {
        const entries = readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = join(dir, entry.name);
          if (entry.isDirectory()) {
            if (
              !entry.name.startsWith(".") &&
              entry.name !== "node_modules" &&
              entry.name !== "dist" &&
              entry.name !== "build" &&
              entry.name !== ".git"
            ) {
              stack.push(fullPath);
            }
          } else if (entry.isFile()) {
            const ext = extname(entry.name).toLowerCase();
            if (this.extensions.includes(ext)) {
              files.push(fullPath);
            }
          }
        }
      } catch {
        continue;
      }
    }

    return files;
  }

  private getLanguageFromExt(ext: string): string | undefined {
    const map: Record<string, string> = {
      ".ts": "typescript",
      ".tsx": "typescript",
      ".js": "javascript",
      ".jsx": "javascript",
      ".py": "python",
      ".java": "java",
      ".go": "go",
      ".rs": "rust",
      ".c": "c",
      ".cpp": "cpp",
    };
    return map[ext];
  }
}

function findName(node: TsNode): TsNode | null {
  for (const child of node.namedChildren) {
    if (child.type === "identifier" || child.type === "property_identifier") {
      return child;
    }
  }
  return null;
}

function firstLine(text: string): string {
  const nl = text.indexOf("\n");
  return (nl === -1 ? text : text.slice(0, nl)).trim();
}

export const plugin = {
  manifest: {
    id: "kli.backend.tree-sitter",
    version: "1.0.0",
    apiVersion: "1",
    kind: ["context"],
    entrypoint: "./dist/index.js",
    capabilities: [],
    priority: 10,
  },
  register(registry: import("@kli/api").Registry) {
    registry.registerBackend(new TreeSitterBackend());
  },
};

export default plugin;
