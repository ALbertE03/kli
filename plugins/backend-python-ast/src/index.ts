/**
 * @kli/backend-python-ast — Python AST backend
 */
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type {
  AstBackend,
  DetectionResult,
  BuildOptions,
  CodeGraph,
  SymbolNode,
  BackendCapabilities,
} from "@kli/api";

const LANGUAGES = ["python"];
const EXTENSIONS = [".py"];

const Capabilities: BackendCapabilities = {
  crossFile: true,
  typeInfo: false,
  incremental: false,
  dynamicImports: false,
};

export class PythonAstBackend implements AstBackend {
  readonly id = "backend.python-ast";
  readonly languages = LANGUAGES;
  readonly extensions = EXTENSIONS;
  readonly contractVersion = 1;
  readonly capabilities = Capabilities;

  async detect(workspaceRoot: string): Promise<DetectionResult> {
    const hasPython = existsSync(join(workspaceRoot, "pyproject.toml")) ||
      existsSync(join(workspaceRoot, "setup.py"));
    return {
      score: hasPython ? 90 : 60,
      reason: hasPython ? "Python project detected" : "Python files found without project config",
      manifestFiles: [],
    };
  }

  async build(workspaceRoot: string, _opts: BuildOptions): Promise<CodeGraph> {
    // Spawn Python extractor
    try {
      const result = execSync(
        `python3 -c "
import ast, sys, json
from pathlib import Path
files = list(Path(sys.argv[1]).rglob('*.py'))[:100]
nodes = []
for f in files:
    try:
        tree = ast.parse(f.read_text())
        for node in ast.walk(tree):
            if isinstance(node, (ast.FunctionDef, ast.ClassDef, ast.AsyncFunctionDef)):
                nodes.append({
                    'id': f'{f}::{node.name}',
                    'name': node.name,
                    'qualifiedName': node.name,
                    'kind': 'function' if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) else 'class',
                    'file': str(f),
                    'line': node.lineno,
                    'exported': any(isinstance(d, ast.Import) or isinstance(d, ast.ImportFrom) for d in getattr(node, 'decorator_list', [])),
                    'language': 'python'
                })
    except: pass
print(json.dumps(nodes))
" "${workspaceRoot}"`,
        { encoding: "utf-8", timeout: 60000 },
      );
      const parsed = JSON.parse(result) as Array<Omit<SymbolNode, "column" | "signature" | "docstring" | "metadata"> & Partial<Pick<SymbolNode, "column" | "signature" | "docstring" | "metadata">>>;

      const nodes = new Map<string, SymbolNode>();
      for (const n of parsed) {
        nodes.set(n.id, { ...n, column: undefined, signature: undefined, docstring: undefined, metadata: undefined } as SymbolNode);
      }

      return {
        version: 1,
        workspaceRoot,
        languageStats: {
          python: {
            language: "python",
            files: new Set(parsed.map((n) => n.file)).size,
            symbols: parsed.length,
            edges: 0,
            backend: this.id,
            buildMs: 0,
            confidence: "inferred",
          },
        },
        nodes,
        edges: new Map(),
        reverseEdges: new Map(),
        fileIndex: buildFileIndex(nodes),
        fileLanguages: buildFileLanguages(nodes),
        crossLanguageEdges: [],
        builtAt: Date.now(),
        backends: [{ id: this.id, languageCount: 1 }],
        warnings: [],
      };
    } catch (err) {
      return {
        version: 1,
        workspaceRoot,
        languageStats: {},
        nodes: new Map(),
        edges: new Map(),
        reverseEdges: new Map(),
        fileIndex: new Map(),
        fileLanguages: new Map(),
        crossLanguageEdges: [],
        builtAt: Date.now(),
        backends: [{ id: this.id, languageCount: 1 }],
        warnings: [err instanceof Error ? err.message : String(err)],
      };
    }
  }
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
    id: "kli.backend.python-ast",
    version: "1.0.0",
    apiVersion: "1" as const,
    kind: ["context"] as Array<"tool" | "provider" | "context" | "policy">,
    entrypoint: "./dist/index.js",
    capabilities: [],
  },
  register(registry: import("@kli/api").Registry) {
    registry.registerBackend(new PythonAstBackend());
  },
};

export default plugin;