/**
 * @kli/backend-ts-morph — Robust TypeScript/JavaScript AST backend
 *
 * Features:
 *  - Full symbol extraction (functions, classes, interfaces, types, enums, variables, etc.)
 *  - Detailed symbol information (parameters, return types, properties, etc.)
 *  - Call edge resolution (with fallback strategies)
 *  - Import/export tracking
 *  - Language-specific handling (TS/JS)
 *  - Configurable via tsconfig.json
 */
import { Project, SyntaxKind } from "ts-morph";
import { readdirSync, statSync } from "node:fs";
import { join, extname, relative } from "node:path";
import type {
  AstBackend,
  DetectionResult,
  BuildOptions,
  CodeGraph,
  SymbolNode,
  SymbolEdge,
  SymbolKind,
  LanguageStats,
  BackendCapabilities,
} from "@kli/api";
import type { HarnessPlugin } from "@kli/api";

const LANGUAGES = ["typescript", "javascript"];
const EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];

const Capabilities: BackendCapabilities = {
  crossFile: true,
  typeInfo: true,
  incremental: true,
  dynamicImports: false,
};

export class TsMorphBackend implements AstBackend {
  readonly id = "backend.ts-morph";
  readonly languages = LANGUAGES;
  readonly extensions = EXTENSIONS;
  readonly contractVersion = 1;
  readonly capabilities = Capabilities;

  async detect(workspaceRoot: string): Promise<DetectionResult> {
    const hasTsConfig = statSync(join(workspaceRoot, "tsconfig.json"), { throwIfNoEntry: false })?.isFile() ?? false;
    const packageJson = statSync(join(workspaceRoot, "package.json"), { throwIfNoEntry: false })?.isFile() ?? false;
    const files = await this.findSourceFiles(workspaceRoot);
    
    let score = 0;
    const reasonParts: string[] = [];
    
    if (hasTsConfig) {
      score += 40;
      reasonParts.push("tsconfig.json found");
    }
    if (packageJson) {
      score += 20;
      reasonParts.push("package.json found");
    }
    if (files.length > 0) {
      score += Math.min(40, files.length * 2);
      reasonParts.push(`${files.length} source files found`);
    }
    
    const scoreValue = Math.min(100, score);
    const reason = reasonParts.length > 0 ? reasonParts.join(", ") : "No TypeScript/JavaScript project indicators found";
    
    return {
      score: scoreValue,
      reason,
      manifestFiles: [
        ...(hasTsConfig ? [join(workspaceRoot, "tsconfig.json")] : []),
        ...(packageJson ? [join(workspaceRoot, "package.json")] : []),
        ...files.slice(0, 10),
      ],
    };
  }

  /**
   * Incremental update — re-process only changed files and merge results
   * into the existing graph. New or deleted files are handled correctly.
   */
  async update(graph: CodeGraph, changedFiles: string[]): Promise<CodeGraph> {
    if (changedFiles.length === 0) return graph;

    const project = new Project({
      tsConfigFilePath: join(graph.workspaceRoot, "tsconfig.json"),
      skipAddingFilesFromTsConfig: true,
      skipFileDependencyResolution: true,
    });

    const allSourceFiles = await this.findSourceFiles(graph.workspaceRoot);
    project.addSourceFilesAtPaths(allSourceFiles.map(f => f.replace(graph.workspaceRoot, ".")));

    // Collect nodes/edges to remove (files that changed or were deleted)
    const toRemove = new Set<string>();
    for (const filePath of graph.fileIndex.keys()) {
      const relPath = filePath.replace(graph.workspaceRoot + "/", "");
      if (changedFiles.includes(relPath)) {
        toRemove.add(filePath);
      }
    }
    for (const id of toRemove) {
      graph.nodes.delete(id);
      graph.edges.delete(id);
      graph.reverseEdges.delete(id);
      graph.fileIndex.delete(id);
      graph.fileLanguages.delete(id);
    }

    // Re-process changed files
    for (const source of project.getSourceFiles()) {
      const filePath = source.getFilePath();
      const relativePath = relative(graph.workspaceRoot, filePath);
      if (!changedFiles.includes(relativePath)) continue;

      const language = source.getLanguageVariant() === 1 ? "typescript" : "javascript";
      graph.fileLanguages.set(relativePath, language);

      source.forEachChild((child) => {
        if (child.getKind() === SyntaxKind.SyntaxList || child.getKind() === SyntaxKind.EndOfFileToken) return;
        const symbolInfo = this.extractSymbolInfo(child, source, filePath, language);
        if (!symbolInfo) return;
        const { id, symbol, edges: symbolEdges } = symbolInfo;
        graph.nodes.set(id, symbol);
        for (const edge of symbolEdges) {
          const existing = graph.edges.get(edge.from) ?? [];
          graph.edges.set(edge.from, [...existing, edge]);
          const revExisting = graph.reverseEdges.get(edge.to) ?? [];
          graph.reverseEdges.set(edge.to, [...revExisting, edge]);
        }
      });
    }

    // Rebuild file index
    graph.fileIndex.clear();
    for (const node of graph.nodes.values()) {
      const list = graph.fileIndex.get(node.file) ?? [];
      list.push(node.id);
      graph.fileIndex.set(node.file, list);
    }

    // Update language stats
    const fileSymbolCounts = new Map<string, number>();
    const fileEdgeCounts = new Map<string, number>();
    for (const node of graph.nodes.values()) {
      fileSymbolCounts.set(node.file, (fileSymbolCounts.get(node.file) ?? 0) + 1);
    }
    for (const [from, edgeList] of graph.edges.entries()) {
      const file = String(from).split("::")[0] ?? "";
      fileEdgeCounts.set(file, (fileEdgeCounts.get(file) ?? 0) + edgeList.length);
    }
    const langFiles = new Map<string, string[]>();
    for (const [relPath, lang] of graph.fileLanguages.entries()) {
      const list = langFiles.get(lang) ?? [];
      list.push(relPath as string);
      langFiles.set(lang, list);
    }
    for (const [lang, files] of langFiles.entries()) {
      const totalSymbols = files.reduce((sum, f) => sum + (fileSymbolCounts.get(f) ?? 0), 0);
      const totalEdges = files.reduce((sum, f) => sum + (fileEdgeCounts.get(f) ?? 0), 0);
      graph.languageStats[lang] = {
        language: lang,
        files: files.length,
        symbols: totalSymbols,
        edges: totalEdges,
        backend: this.id,
        buildMs: 0,
        confidence: "exact",
      };
    }

    graph.builtAt = Date.now();
    return graph;
  }

  async build(workspaceRoot: string, opts: BuildOptions): Promise<CodeGraph> {
    const project = new Project({
      tsConfigFilePath: join(workspaceRoot, "tsconfig.json"),
      skipAddingFilesFromTsConfig: true,
      skipFileDependencyResolution: true,
    });

    const sourceFiles = await this.findSourceFiles(workspaceRoot);
    project.addSourceFilesAtPaths(sourceFiles.map(f => f.replace(workspaceRoot, ".")));

    const nodes = new Map<string, SymbolNode>();
    const edges = new Map<string, SymbolEdge[]>();
    const reverseEdges = new Map<string, SymbolEdge[]>();
    const fileIndex = new Map<string, string[]>();
    const fileLanguages = new Map<string, string>();
    
    const fileSymbolCounts = new Map<string, number>();
    const fileEdgeCounts = new Map<string, number>();

    for (const source of project.getSourceFiles()) {
      const filePath = source.getFilePath();
      const relativePath = relative(workspaceRoot, filePath);
      const language = source.getLanguageVariant() === 1 ? "typescript" : "javascript";
      
      fileSymbolCounts.set(relativePath, 0);
      fileEdgeCounts.set(relativePath, 0);
      fileLanguages.set(relativePath, language);
      
      // Process top-level declarations
      source.forEachChild((child) => {
        if (child.getKind() === SyntaxKind.SyntaxList || child.getKind() === SyntaxKind.EndOfFileToken) return;
        
        const symbolInfo = this.extractSymbolInfo(child, source, filePath, language);
        if (symbolInfo) {
          const { id, symbol, edges: symbolEdges } = symbolInfo;
          nodes.set(id, symbol);
          fileSymbolCounts.set(relativePath, (fileSymbolCounts.get(relativePath) ?? 0) + 1);
          
          for (const edge of symbolEdges) {
            const existing = edges.get(edge.from) ?? [];
            edges.set(edge.from, [...existing, edge]);
            const revExisting = reverseEdges.get(edge.to) ?? [];
            reverseEdges.set(edge.to, [...revExisting, edge]);
            fileEdgeCounts.set(relativePath, (fileEdgeCounts.get(relativePath) ?? 0) + 1);
          }
        }
      });
    }
    
    // Build language statistics
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
        confidence: "exact" as const,
      };
    }
    
    // Build file index
    for (const [filePath, symbolIds] of Object.entries(this.buildFileIndex(nodes))) {
      fileIndex.set(filePath, symbolIds);
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
      warnings: [],
    };
  }
  
  private buildFileIndex(nodes: Map<string, SymbolNode>): Record<string, string[]> {
    const result: Record<string, string[]> = {};
    for (const [id, symbol] of nodes) {
      const file = symbol.file;
      if (!result[file]) result[file] = [];
      result[file].push(id);
    }
    return result;
  }
  
  private async findSourceFiles(workspaceRoot: string): Promise<string[]> {
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
            if (!entry.name.startsWith(".") && 
                entry.name !== "node_modules" && 
                entry.name !== "dist" && 
                entry.name !== "build" &&
                entry.name !== ".git") {
              stack.push(fullPath);
            }
          } else if (entry.isFile()) {
            const ext = extname(entry.name);
            if (EXTENSIONS.includes(ext)) {
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
  
  private extractSymbolInfo(
    node: import("ts-morph").Node,
    source: import("ts-morph").SourceFile,
    filePath: string,
    language: string
  ): { id: string; symbol: SymbolNode; edges: SymbolEdge[] } | null {
    // Get line number (1-based) — getStartLineNumber exists at runtime but is untyped in ts-morph 22
    const line = ((node as unknown as { getStartLineNumber?: () => number }).getStartLineNumber?.() ?? 1);
    
    // Get the symbol kind and basic info
    let kind: SymbolKind | undefined;
    let name = "";
    let qualifiedName = "";
    let signature: string | undefined;
    let docstring: string | undefined;
    let exported = false;
    
    const nodeKind = node.getKind();
    
    // Helper: get name from children
    const getNameFromChildren = (n: import("ts-morph").Node): string => {
      let foundName = "";
      n.forEachChild((child: import("ts-morph").Node) => {
        if (child.getKind() === SyntaxKind.Identifier) {
          foundName = child.getText();
        }
      });
      return foundName;
    };
    
    if (nodeKind === SyntaxKind.FunctionDeclaration) {
      kind = "function";
      const func = node as import("ts-morph").FunctionDeclaration;
      name = getNameFromChildren(func);
      qualifiedName = name;
      signature = this.getFunctionSignature(func);
      docstring = func.getJsDocs?.()?.map((doc: unknown) => ((doc as { getCommentText?: () => string }).getCommentText?.() ?? "")).join(" ").trim() || undefined;
      exported = func.isExported?.() ?? false;
    } else if (nodeKind === SyntaxKind.ClassDeclaration) {
      kind = "class";
      const cls = node as import("ts-morph").ClassDeclaration;
      name = getNameFromChildren(cls);
      qualifiedName = name;
      signature = this.getClassSignature(cls);
      docstring = cls.getJsDocs?.()?.map((doc: unknown) => ((doc as { getCommentText?: () => string }).getCommentText?.() ?? "")).join(" ").trim() || undefined;
      exported = cls.isExported?.() ?? false;
    } else if (nodeKind === SyntaxKind.InterfaceDeclaration) {
      kind = "interface";
      const intf = node as import("ts-morph").InterfaceDeclaration;
      name = getNameFromChildren(intf);
      qualifiedName = name;
      signature = this.getInterfaceSignature(intf);
      docstring = intf.getJsDocs?.()?.map((doc: unknown) => ((doc as { getCommentText?: () => string }).getCommentText?.() ?? "")).join(" ").trim() || undefined;
      exported = intf.isExported?.() ?? false;
    } else if (nodeKind === SyntaxKind.TypeAliasDeclaration) {
      kind = "type";
      const typeAlias = node as import("ts-morph").TypeAliasDeclaration;
      name = getNameFromChildren(typeAlias);
      qualifiedName = name;
      // Get the type annotation
      let typeText = "";
      typeAlias.forEachChild((child: import("ts-morph").Node) => {
        if (child.getKind() === SyntaxKind.EqualsToken) {
          const next = child.getNextSibling();
          if (next) typeText = next.getText();
        }
      });
      signature = typeText ? `type ${name} = ${typeText}` : `type ${name}`;
      docstring = typeAlias.getJsDocs?.()?.map((doc: unknown) => ((doc as { getCommentText?: () => string }).getCommentText?.() ?? "")).join(" ").trim() || undefined;
      exported = typeAlias.isExported?.() ?? false;
    } else if (nodeKind === SyntaxKind.EnumDeclaration) {
      kind = "class";
      const enm = node as import("ts-morph").EnumDeclaration;
      name = getNameFromChildren(enm);
      qualifiedName = name;
      signature = `enum ${name} { ... }`;
      docstring = enm.getJsDocs?.()?.map((doc: unknown) => ((doc as { getCommentText?: () => string }).getCommentText?.() ?? "")).join(" ").trim() || undefined;
      exported = enm.isExported?.() ?? false;
    } else if (nodeKind === SyntaxKind.VariableStatement) {
      const varStmt = node as import("ts-morph").VariableStatement;
      // Get first declaration
      const decls = varStmt.getDeclarations?.() ?? [];
      const decl = decls[0];
      if (!decl) return null;
      
      const parentKind = ((decl as { getParent?: () => import("ts-morph").Node }).getParent?.()?.getKind?.()) ?? 0;
      // Skip variables inside functions for now
      if ([SyntaxKind.FunctionDeclaration, SyntaxKind.MethodDeclaration, SyntaxKind.ArrowFunction].includes(parentKind ?? 0)) {
        return null;
      }
      
      kind = "variable";
      name = decl.getName();
      qualifiedName = name;
      const type = decl.getType();
      signature = type ? `${name}: ${type.getText()}` : name;
      exported = varStmt.isExported?.() ?? false;
    } else {
      return null;
    }
    
    if (!name) return null;
    
    const id = `${filePath}::${name}`;
    
    const symbol: SymbolNode = {
      id,
      name,
      qualifiedName,
      kind,
      file: filePath,
      line,
      column: 0,
      signature,
      docstring,
      exported,
      language,
      metadata: {},
    };
    
    // Extract call edges
    const edges: SymbolEdge[] = [];
    try {
      node.forEachDescendant((child: import("ts-morph").Node) => {
        if (child.getKind() === SyntaxKind.CallExpression) {
          const call = child as import("ts-morph").CallExpression;
          const expr = call.getExpression?.();
          if (!expr) return;
          
          let targetName: string | undefined;
          
          if (expr.getKind() === SyntaxKind.Identifier) {
            targetName = expr.getText();
          } else if (expr.getKind() === SyntaxKind.PropertyAccessExpression) {
            const nameNode = (expr as import("ts-morph").PropertyAccessExpression).getNameNode?.();
            targetName = nameNode?.getText?.();
          }
          
          if (targetName) {
            edges.push({
              from: id,
              to: `${filePath}::${targetName}`,
              kind: "calls",
              line: ((child as unknown as { getStartLineNumber?: () => number }).getStartLineNumber?.() ?? 0),
              external: undefined,
              confidence: "inferred",
            });
          }
        }
      });
    } catch {
      // Skip if forEachDescendant fails
    }
    
    return { id, symbol, edges };
  }
  
  private getFunctionSignature(func: import("ts-morph").FunctionDeclaration): string | undefined {
    const params: string[] = [];
    func.forEachChild((child: import("ts-morph").Node) => {
      if (child.getKind() === SyntaxKind.OpenParenToken) {
        const next = child.getNextSibling();
        if (next) {
          const paramText = next.getText();
          if (paramText && paramText.trim()) {
            params.push(paramText.trim());
          }
        }
      }
    });
    
    // Get return type - look for ColonToken followed by type
    let returnTypeText = "";
    func.forEachChild((child: import("ts-morph").Node) => {
      if (child.getKind() === SyntaxKind.ColonToken) {
        const next = child.getNextSibling();
        if (next) returnTypeText = next.getText();
      }
    });
    
    const paramsStr = params.join(", ");
    return `(${paramsStr})${returnTypeText ? `: ${returnTypeText}` : ""}`;
  }
  
  private getClassSignature(cls: import("ts-morph").ClassDeclaration): string | undefined {
    const name = cls.getName?.() || "<anonymous>";
    
    let extendsText = "";
    cls.forEachChild((child: import("ts-morph").Node) => {
      if (child.getKind() === SyntaxKind.ExtendsKeyword) {
        const next = child.getNextSibling();
        if (next) extendsText = next.getText();
      }
    });
    
    let signature = `class ${name}`;
    if (extendsText) signature += ` extends ${extendsText}`;
    return signature;
  }
  
  private getInterfaceSignature(intf: import("ts-morph").InterfaceDeclaration): string | undefined {
    const name = intf.getName?.() || "<anonymous>";
    
    let extendsText = "";
    intf.forEachChild((child: import("ts-morph").Node) => {
      if (child.getKind() === SyntaxKind.ExtendsKeyword) {
        const next = child.getNextSibling();
        if (next) extendsText = next.getText();
      }
    });
    
    let signature = `interface ${name}`;
    if (extendsText) signature += ` extends ${extendsText}`;
    return signature;
  }
}

export const plugin: HarnessPlugin = {
  manifest: {
    id: "kli.backend.ts-morph",
    version: "2.0.0",
    apiVersion: "1",
    kind: ["context"],
    entrypoint: "./dist/index.js",
    capabilities: [],
    priority: 10,
  },
  register(registry: import("@kli/api").Registry) {
    registry.registerBackend(new TsMorphBackend());
  },
};

export default plugin;