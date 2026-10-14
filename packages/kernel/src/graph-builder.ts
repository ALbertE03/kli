/**
 * Graph builder — runs the registered AST backends and merges their output
 * into a single `CodeGraph`, then persists it through `GraphCache`.
 *
 * Selection (§3.6): every backend reports a detection score; backends below
 * `MIN_SCORE` are skipped. Language ownership is first-wins by descending
 * score so two backends never both claim the same language (Rule #6: prefer
 * missing edges over contradictory ones).
 */
import type { AstBackend, BuildOptions, CodeGraph, LanguageStats } from "@kli/api";
import { GraphCache } from "./graph-cache.js";

const MIN_SCORE = 10;

export interface BuildGraphResult {
  graph: CodeGraph;
  fileHashes: Record<string, string>;
  selectedBackends: string[];
}

export async function buildGraph(
  backends: readonly AstBackend[],
  workspaceRoot: string,
  cache: GraphCache,
  opts: BuildOptions = {},
): Promise<BuildGraphResult> {
  const scanned = await Promise.all(
    backends.map(async (b) => {
      let score = 0;
      try {
        score = (await b.detect(workspaceRoot)).score;
      } catch {
        score = 0;
      }
      return { backend: b, score };
    }),
  );

  const eligible = scanned
    .filter((s) => s.score >= MIN_SCORE)
    .sort((a, b) => b.score - a.score);

  const merged = emptyGraph(workspaceRoot);
  const languagesOwned = new Set<string>();
  const selectedBackends: string[] = [];
  const warnings: string[] = [];

  for (const { backend } of eligible) {
    // Skip a backend if every language it supports is already owned.
    const unowned = backend.languages.filter((l) => !languagesOwned.has(l));
    if (unowned.length === 0) continue;

    try {
      const graph = await backend.build(workspaceRoot, opts);
      mergeInto(merged, graph);
      for (const lang of Object.keys(graph.languageStats)) {
        languagesOwned.add(lang);
      }
      warnings.push(...graph.warnings);
      selectedBackends.push(backend.id);
    } catch (err) {
      warnings.push(
        `backend ${backend.id} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  if (selectedBackends.length === 0) {
    warnings.push(
      "No AST backend produced a graph (none scored high enough or none built successfully).",
    );
  }

  merged.builtAt = Date.now();
  merged.warnings = dedupe(warnings);

  const fileHashes: Record<string, string> = {};
  for (const file of merged.fileLanguages.keys()) {
    const abs = file.startsWith("/") ? file : `${workspaceRoot}/${file}`;
    const hash = await GraphCache.hashFile(abs);
    if (hash) fileHashes[file] = hash;
  }

  await cache.save(merged, fileHashes);
  return { graph: merged, fileHashes, selectedBackends };
}

function emptyGraph(workspaceRoot: string): CodeGraph {
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
    backends: [],
    warnings: [],
  };
}

function mergeInto(target: CodeGraph, source: CodeGraph): void {
  for (const [id, node] of source.nodes) {
    if (!target.nodes.has(id)) target.nodes.set(id, node);
  }

  for (const [from, list] of source.edges) {
    const existing = target.edges.get(from) ?? [];
    const seen = new Set(existing.map((e) => `${e.to}|${e.kind}`));
    for (const edge of list) {
      if (!seen.has(`${edge.to}|${edge.kind}`)) {
        existing.push(edge);
        seen.add(`${edge.to}|${edge.kind}`);
      }
    }
    target.edges.set(from, existing);
  }

  for (const [to, list] of source.reverseEdges) {
    const existing = target.reverseEdges.get(to) ?? [];
    const seen = new Set(existing.map((e) => `${e.from}|${e.kind}`));
    for (const edge of list) {
      if (!seen.has(`${edge.from}|${edge.kind}`)) {
        existing.push(edge);
        seen.add(`${edge.from}|${edge.kind}`);
      }
    }
    target.reverseEdges.set(to, existing);
  }

  for (const [file, ids] of source.fileIndex) {
    const existing = target.fileIndex.get(file) ?? [];
    for (const id of ids) if (!existing.includes(id)) existing.push(id);
    target.fileIndex.set(file, existing);
  }

  for (const [file, lang] of source.fileLanguages) {
    if (!target.fileLanguages.has(file)) target.fileLanguages.set(file, lang);
  }

  target.crossLanguageEdges.push(...source.crossLanguageEdges);

  for (const [lang, stats] of Object.entries(source.languageStats)) {
    if (!target.languageStats[lang]) target.languageStats[lang] = stats;
    else target.languageStats[lang] = mergeStats(target.languageStats[lang], stats);
  }

  for (const info of source.backends) {
    if (!target.backends.some((b) => b.id === info.id)) target.backends.push(info);
  }
}

function mergeStats(a: LanguageStats | undefined, b: LanguageStats): LanguageStats {
  if (!a) return b;
  return {
    language: a.language,
    files: a.files + b.files,
    symbols: a.symbols + b.symbols,
    edges: a.edges + b.edges,
    backend: a.backend === b.backend ? a.backend : `${a.backend}+${b.backend}`,
    buildMs: a.buildMs + b.buildMs,
    confidence: a.confidence === "exact" && b.confidence === "exact" ? "exact" : "heuristic",
  };
}

function dedupe(items: string[]): string[] {
  return [...new Set(items)];
}
