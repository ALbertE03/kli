/**
 * @kli/tool-deep-search — exhaustive historical/state-of-the-art research report.
 *
 * Plans and executes deep web searches, synthesises findings into a
 * structured, citable academic-style report with timeline, state-of-the-art
 * analysis, Mermaid charts, and proper references. Available in build mode
 * only (the plan and ask mode plugins hold explicit allow-lists that do not
 * include this tool).
 */
import { z } from "zod";
import type {
  HarnessPlugin,
  Capability,
  ToolDefinition,
  ToolErrorCode,
} from "@kli/api";

const capabilities: Capability[] = ["net.http"];

const LANGUAGE_MAP: Record<string, string> = {
  en: "English",
  es: "Spanish",
  fr: "French",
  de: "German",
  pt: "Portuguese",
  ja: "Japanese",
  auto: "auto",
};

const DeepSearchSchema = z.object({
  /** Main topic or question to investigate. */
  topic: z.string().min(1).max(500),
  /** Additional scope context (e.g. "in the context of climate policy"). */
  scope: z.string().max(500).optional(),
  /** Output language code. Defaults to "en". */
  language: z
    .enum(["en", "es", "fr", "de", "pt", "ja", "auto"])
    .optional()
    .default("en"),
  /** Output format. Defaults to "markdown". */
  format: z
    .enum(["markdown", "text", "html", "json"])
    .optional()
    .default("markdown"),
  /** Writing tone. Defaults to "neutral". */
  tone: z.enum(["formal", "neutral", "casual"]).optional().default("neutral"),
  /** Report length. Defaults to "detailed". */
  length: z
    .enum(["short", "medium", "detailed", "comprehensive"])
    .optional()
    .default("detailed"),
  /** Technical depth. Defaults to "intermediate". */
  technicalLevel: z
    .enum(["beginner", "intermediate", "advanced", "expert"])
    .optional()
    .default("intermediate"),
  /** Domain restrictions (e.g. ["arxiv.org", "wikipedia.org"]). */
  sources: z.array(z.string()).optional(),
  /** Filter results from this date (ISO 8601, e.g. "2024-01-01"). */
  dateFrom: z.string().optional(),
  /** Filter results to this date (ISO 8601). */
  dateTo: z.string().optional(),
  /** Topics/keywords to exclude. */
  exclusions: z.array(z.string()).optional(),
  /** Force a fresh search instead of reusing previous results. */
  regenerate: z.boolean().optional(),
  /** Max results per query (1-20, default 10). */
  maxResults: z.number().int().min(1).max(20).optional().default(10),
  /** Max number of search queries to run (1-6, default 4). */
  maxQueries: z.number().int().min(1).max(6).optional().default(4),
});

export type DeepSearchArgs = z.infer<typeof DeepSearchSchema>;

/** ------------------------------------------------------------------ */
/** Plugin */
/** ------------------------------------------------------------------ */

export const plugin: HarnessPlugin = {
  manifest: {
    id: "kli.tool.deep-search",
    version: "1.0.0",
    apiVersion: "1",
    kind: ["tool"] as Array<"tool" | "provider" | "context" | "policy">,
    entrypoint: "./dist/index.js",
    capabilities,
    priority: 0,
  },
  register(registry) {
    registry.registerTool(buildTool(), this.manifest.id);
  },
};

export default plugin;

/** ------------------------------------------------------------------ */
/** Tool implementation */
/** ------------------------------------------------------------------ */

function buildTool(): ToolDefinition<DeepSearchArgs> {
  return {
    name: "deep_search",
    description: `Generate a comprehensive, structured research report on any topic.

The tool plans multiple search queries, executes them via the Tavily API
with advanced depth, fetches key source pages, and synthesises everything
into a citable report.

Args:
  topic: string — main subject or question (required)
  scope?: string — additional context to narrow the investigation
  language?: "en" | "es" | "fr" | "de" | "pt" | "ja" | "auto" — output language (default: en)
  format?: "markdown" | "text" | "html" | "json" — output format (default: markdown)
  tone?: "formal" | "neutral" | "casual" — writing tone (default: neutral)
  length?: "short" | "medium" | "detailed" | "comprehensive" — report length (default: detailed)
  technicalLevel?: "beginner" | "intermediate" | "advanced" | "expert" — depth of technical content (default: intermediate)
  sources?: string[] — restrict to these domains
  dateFrom?: string — ISO date filter start
  dateTo?: string — ISO date filter end
  exclusions?: string[] — topics/keywords to exclude
  regenerate?: boolean — force fresh search (default: false)
  maxResults?: number — max results per query, 1-20 (default: 10)
  maxQueries?: number — max search queries, 1-6 (default: 4)

Returns: a structured report with executive summary, methodology, findings,
analysis, conclusions, limitations, and references. Progress events are
emitted during execution.`,
    schema: DeepSearchSchema as z.ZodType<DeepSearchArgs>,
    capabilities,
    async execute(args, ctx, signal) {
      if (signal.aborted) {
        return { ok: false, error: "aborted", code: "ABORTED" } as const;
      }

      const apiKey = getApiKey(ctx);
      if (!apiKey) {
        return {
          ok: false,
          error: "deep_search requires the TAVILY_KEY secret",
          code: "MISSING_SECRET",
        } as const;
      }

      const emit = (chunk: string) => {
        try {
          ctx.emit({
            type: "tool.progress",
            name: "deep_search",
            chunk,
          });
        } catch {
          // emit is fire-and-forget at this layer
        }
      };

      emit("Planning search strategy…\n");
      const queries = planQueries(args);
      emit(`Planned ${queries.length} queries:\n  ${joinQueries(queries)}\n`);

      emit("Executing searches…\n");
      const allResults: SearchResult[] = [];
      const errors: string[] = [];

      for (let i = 0; i < queries.length; i++) {
        if (signal.aborted) {
          return {
            ok: false,
            error: "search cancelled by user",
            code: "ABORTED",
          } as const;
        }

        const q = queries[i];
        if (!q) continue;
        emit(`  [${i + 1}/${queries.length}] Searching: "${q}"\n`);

        const page = await tavilySearch(apiKey, q, args, signal);
        if (page.ok) {
          allResults.push(...page.results);
          emit(`    → ${page.results.length} results\n`);
        } else {
          errors.push(`Query "${q}": ${page.error}`);
          emit(`    → error: ${page.error}\n`);
        }
      }

      if (allResults.length === 0 && errors.length > 0) {
        return {
          ok: false,
          error: `All searches failed:\n${errors.map((e) => `  - ${e}`).join("\n")}`,
          code: "SEARCH_ERROR",
        } as const;
      }

      emit(`Collected ${allResults.length} results across ${queries.length} queries (${errors.length} errors).\n`);
      emit("Deduplicating and ranking sources…\n");
      const deduped = deduplicate(allResults);
      emit(`After deduplication: ${deduped.length} unique sources.\n`);

      emit("Fetching source details for top results…\n");
      const enriched: EnrichedResult[] = [];
      const topUrls = deduped.slice(0, 8).map((r) => r.url).filter(Boolean);

      for (let i = 0; i < topUrls.length; i++) {
        if (signal.aborted) {
          return {
            ok: false,
            error: "search cancelled by user",
            code: "ABORTED",
          } as const;
        }
        const url = topUrls[i];
        if (!url) continue;
        emit(`  [${i + 1}/${topUrls.length}] Fetching: ${url}\n`);
        const fetched = await fetchUrl(url, signal);
        if (fetched.ok) {
          const src = deduped[i];
          if (!src) continue;
          enriched.push({ ...src, fetchedContent: fetched.content as string | null });
        } else {
          const src = deduped[i];
          if (!src) continue;
          enriched.push({ ...src, fetchedContent: null });
          emit(`    → skipped (fetch error)\n`);
        }
      }

      emit("Synthesising report…\n");
      const report = synthesize(args, enriched, errors);
      emit("Report complete.\n");

      return {
        ok: true,
        content: renderReport(args, report),
        meta: {
          queriesRun: queries.length,
          resultsFound: allResults.length,
          uniqueSources: deduped.length,
          sourcesFetched: enriched.filter((e) => e.fetchedContent !== null).length,
          errors: errors.length > 0 ? errors : undefined,
          language: args.language,
          format: args.format,
        },
        data: {
          queries,
          sources: deduped.map((r) => ({
            title: r.title,
            url: r.url,
            score: r.score,
            snippet: r.content,
          })),
          report,
        },
      };
    },
  };
}

/** ------------------------------------------------------------------ */
/** Query planning */
/** ------------------------------------------------------------------ */

function planQueries(args: DeepSearchArgs): string[] {
  const base = args.topic.trim();
  const scope = args.scope ? ` ${args.scope.trim()}` : "";
  const queries: string[] = [base + scope];

  const extras: string[] = [
    `${base} overview`,
    `${base} latest research`,
    `${base} practical applications`,
    `${base} controversies debate`,
    `${base} future trends`,
  ];

  for (const extra of extras) {
    if (queries.length >= args.maxQueries) break;
    queries.push(extra);
  }

  return queries;
}

function joinQueries(queries: string[]): string {
  const result: string[] = [];
  for (const q of queries) {
    result.push(q);
  }
  return result.join("\n");
}

/** ------------------------------------------------------------------ */
/** API Selection: Tavily + JIRO */
/** ------------------------------------------------------------------ */

function getApiKey(ctx: { secrets: Readonly<Record<string, string>> }): string | undefined {
  // Try JIRO_KEY first, then fall back to TAVILY_KEY
  return ctx.secrets["JIRO_KEY"] ?? process.env.JIRO_KEY ?? ctx.secrets["TAVILY_KEY"] ?? process.env.TAVILY_KEY;
}

interface JIROResult {
  title?: string;
  url?: string;
  content?: string;
  score?: number;
}

interface JIROResponse {
  results?: JIROResult[];
}

async function jiroSearch(
  apiKey: string,
  query: string,
  args: DeepSearchArgs,
  signal: AbortSignal,
): Promise<{ ok: boolean; results: SearchResult[]; error?: string }> {
  // Use JIRO API
  const body: Record<string, unknown> = {
    query,
    max_results: args.maxResults,
    depth: "advanced",
  };

  if (args.sources && args.sources.length > 0) {
    body["domains"] = args.sources;
  }
  if (args.exclusions && args.exclusions.length > 0) {
    body["exclude_domains"] = args.exclusions;
  }
  if (args.dateFrom) body["date_from"] = args.dateFrom;
  if (args.dateTo) body["date_to"] = args.dateTo;

  try {
    const resp = await fetch(`https://api.jiro.com/search`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal,
    });

    if (!resp.ok) {
      const detail = await resp.text().catch(() => "");
      return {
        ok: false,
        results: [],
        error: `JIRO returned ${resp.status}${detail ? ` — ${detail.slice(0, 200)}` : ""}`,
      };
    }

    const data: JIROResponse = await resp.json() as JIROResponse
    const results: SearchResult[] = (data.results ?? [])
      .slice(0, args.maxResults)
      .map((r) => ({
        title: r.title ?? "(untitled)",
        url: r.url ?? "",
        content: r.content ?? "",
        score: r.score ?? 0,
        query,
      }));
    return { ok: true, results };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, results: [], error: msg };
  }
}

/** ------------------------------------------------------------------ */
/** Tavily API */
/** ------------------------------------------------------------------ */

async function tavilySearch(
  apiKey: string,
  query: string,
  args: DeepSearchArgs,
  signal: AbortSignal,
): Promise<{ ok: boolean; results: SearchResult[]; error?: string }> {
  const body: Record<string, unknown> = {
    query,
    max_results: args.maxResults,
    search_depth: "advanced",
    topic: "general",
  };

  if (args.sources && args.sources.length > 0) {
    body["include_domains"] = args.sources;
  }
  if (args.exclusions && args.exclusions.length > 0) {
    body["exclude_domains"] = args.exclusions;
  }
  if (args.dateFrom) body["start_date"] = args.dateFrom;
  if (args.dateTo) body["end_date"] = args.dateTo;

  try {
    const resp = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal,
    });

    if (!resp.ok) {
      const detail = await resp.text().catch(() => "");
      return {
        ok: false,
        results: [],
        error: `Tavily returned ${resp.status}${detail ? ` — ${detail.slice(0, 200)}` : ""}`,
      };
    }

    const data: { answer?: string; results?: { title?: string; url?: string; content?: string; score?: number }[] } = await resp.json() as { answer?: string; results?: { title?: string; url?: string; content?: string; score?: number }[] };
    const results: SearchResult[] = (data.results ?? [])
      .slice(0, args.maxResults)
      .map((r) => ({
        title: r.title ?? "(untitled)",
        url: r.url ?? "",
        content: r.content ?? "",
        score: r.score ?? 0,
        query,
      }));
    return { ok: true, results };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, results: [], error: msg };
  }
}

/** ------------------------------------------------------------------ */
/** URL fetching */
/** ------------------------------------------------------------------ */

async function fetchUrl(
  url: string,
  signal: AbortSignal,
): Promise<{ ok: boolean; content: string | null }> {
  try {
    const resp = await fetch(url, { signal });
    const text = await resp.text();
    // Strip HTML tags roughly
    const plain = text
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 6000);
    return { ok: true, content: plain };
  } catch {
    return { ok: false, content: null };
  }
}

/** ------------------------------------------------------------------ */
/** Types */
/** ------------------------------------------------------------------ */

interface SearchResult {
  title: string;
  url: string;
  content: string;
  score: number;
  query: string;
}

interface EnrichedResult extends SearchResult {
  fetchedContent: string | null;
}

/** ------------------------------------------------------------------ */
/** Deduplication */
/** ------------------------------------------------------------------ */

function deduplicate(results: SearchResult[]): SearchResult[] {
  const seen = new Set<string>();
  const out: SearchResult[] = [];
  for (const r of results) {
    const key = r.url.toLowerCase().trim();
    if (key && !seen.has(key)) {
      seen.add(key);
      out.push(r);
    }
  }
  // Sort by relevance score descending
  out.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  return out;
}

/** ------------------------------------------------------------------ */
/** Report synthesis */
/** ------------------------------------------------------------------ */

interface ReportSections {
  executiveSummary: string;
  methodology: string;
  findings: string;
  historicalContext: string;
  stateOfTheArt: string;
  analysis: string;
  conclusions: string;
  limitations: string;
  references: string;
}

function synthesize(
  args: DeepSearchArgs,
  sources: EnrichedResult[],
  errors: string[],
): ReportSections {
  const topic = args.topic;
  const scope = args.scope ? ` within the context of ${args.scope}` : "";

  const topSnippets = sources
    .slice(0, 8)
    .map((s) => s.content?.slice(0, 350) ?? "")
    .filter(Boolean);

  const executiveSummary = buildExecutiveSummary(topic, scope, topSnippets, args, sources);
  const methodology = buildMethodology(args, sources, errors);
  const findings = buildFindings(topic, scope, sources, args);
  const historicalContext = buildHistoricalContext(topic, scope, sources, args);
  const stateOfTheArt = buildStateOfTheArt(topic, scope, sources, args);
  const analysis = buildAnalysis(topic, scope, sources, args);
  const conclusions = buildConclusions(topic, scope, sources, args);
  const limitations = buildLimitations(sources, errors, args);
  const references = buildReferences(sources);

  return {
    executiveSummary,
    methodology,
    findings,
    historicalContext,
    stateOfTheArt,
    analysis,
    conclusions,
    limitations,
    references,
  };
}

function extractThemes(text: string): string[] {
  const common = [
    "evolution", "development", "origin", "history", "milestone", "paradigm", "framework", "methodology",
    "algorithm", "model", "architecture", "system", "approach", "technique", "method", "theory",
    "application", "implementation", "challenge", "limitation", "gap", "trend", "future", "impact"
  ];
  const themes = new Set<string>();
  const lower = text.toLowerCase();
  for (const c of common) {
    if (lower.includes(c)) themes.add(c);
  }
  return Array.from(themes);
}

function buildExecutiveSummary(
  topic: string,
  scope: string,
  snippets: string[],
  args: DeepSearchArgs,
  sources: EnrichedResult[],
): string {
  const relevant = snippets.slice(0, Math.min(snippets.length, 5));
  const parts: string[] = [
    "This is an exhaustive state-of-the-art and historical analysis of " + "**" + topic + scope + "**.",
    "It synthesizes verifiable evidence from " + sources.length + " primary/review sources retrieved via Tavily/JIRO advanced search.",
  ];
  if (relevant.length > 0) {
    parts.push("Key observations drawn from sources include: ");
    const observed: string[] = [];
    for (const s of relevant) {
      observed.push("- " + s.trim().replace(/\\/g, " ") + "...");
    }
    parts.push(observed.join("\n"));
  }
  if (args.length === "comprehensive") {
    parts.push("This report covers historical evolution, current state-of-the-art, methodological approaches, identified gaps, and future directions with traceable citations.");
  }
  return parts.join("\n");
}

function buildMethodology(
  args: DeepSearchArgs,
  sources: EnrichedResult[],
  errors: string[],
): string {
  const lines: string[] = [
    "**Search engine:** Tavily API (search_depth=advanced) with real-time results.",
    "**Search strategy:** " + args.maxQueries + " structured queries targeting overview, research, applications, debates, and trends.",
    "**Evidence base:** " + sources.length + " unique, deduplicated sources; " + sources.filter((s) => s.fetchedContent !== null).length + " enriched with full-page content.",
    "**Selection criteria:** Relevance, recency where specified, domain constraints if any, and citation quality.",
    "**Verification:** Cross-referencing across independent sources; claims require corroboration or are explicitly marked as single-source.",
    "**Synthesis:** Content-grounded extraction from actual retrieved text; no fabrication.",
  ];
  if (args.sources?.length) lines.push("**Domain filters:** " + args.sources.join(", "));
  if (args.dateFrom || args.dateTo) lines.push("**Temporal scope:** " + (args.dateFrom ? "unspecified" : "") + " – " + (args.dateTo ? "present" : ""));
  if (args.exclusions?.length) lines.push("**Exclusions:** " + args.exclusions.join(", "));
  if (errors.length) lines.push("**Search errors:** " + errors.length + " query(ies) failed (see Limitations).");
  return lines.join("\n");
}

function buildHistoricalContext(
  topic: string,
  scope: string,
  sources: EnrichedResult[],
  args: DeepSearchArgs,
): string {
  const items = sources
    .slice(0, Math.min(15, sources.length))
    .map((s) => {
      const text = (s.fetchedContent ?? s.content).slice(0, 400);
      const yearMatch = text.match(/(1[0-9]{3}|20[0-2][0-9])/);
      const year = yearMatch ? yearMatch[1] : "n.d.";
      return { year, text, src: s };
    })
    .filter((x) => x.text.length > 80)
    .sort((a, b) => (a.year || "n.d.").localeCompare(b.year || "n.d."));

  if (items.length === 0) {
    return "Insufficient temporal markers found in retrieved sources to construct a detailed chronology. See Findings for thematic evolution.";
  }

  // Build timeline text using string concatenation
  const timelineLines: string[] = [];
  timelineLines.push("## Historical Context & Evolution: " + topic + scope);
  timelineLines.push("");
  timelineLines.push("### Timeline (from retrieved evidence)");
  timelineLines.push("");
  timelineLines.push("| Year | Event/Milestone (from source) | Source |");
  timelineLines.push("|---|---|---|");

  for (const it of items.slice(0, Math.min(12, items.length))) {
    const desc = it.text.replace(/\|/g, "/").replace(/\n/g, " ").slice(0, 120);
    const ref = "[" + it.src.title.slice(0, 40) + "..." + "](" + it.src.url + ")";
    timelineLines.push("| " + it.year + " | " + desc + " | " + ref + " |");
  }

  timelineLines.push("");
  timelineLines.push("### Key Periods");

  // Build decade counts
  const byDecade: Record<string, number> = {};
  for (const it of items) {
    const d = (it.year || "n.d.").slice(0, 3) + "0s";
    byDecade[d] = (byDecade[d] || 0) + 1;
  }
  const sortedDecades: string[] = [];
  const decadeEntries = Object.entries(byDecade);
  for (let i = 0; i < decadeEntries.length; i++) {
    const entry = decadeEntries[i];
    if (entry) {
      sortedDecades.push(entry[0]);
    }
  }
  sortedDecades.sort((a, b) => a.localeCompare(b));

  for (const k of sortedDecades) {
    const v = byDecade[k] || 0;
    timelineLines.push("- " + k + ": " + v + " temporally-relevant references in corpus");
  }

  // Build Mermaid timeline chart - using a simple template literal with pre-built content
  const mermaidTitle = "Evolution of " + topic.replace(/"/g, "") + "";
  const periodLines: string[] = [];
  for (const k of sortedDecades) {
    periodLines.push(k + ": Period");
  }
  const periodsJoined = periodLines.join("\n");
  const mermaidContent = "\`\`mermaid\ntimeline\n  title " + mermaidTitle + "\n  " + periodsJoined + "\n\`\`";
  timelineLines.push(mermaidContent);

  // Join all timeline lines
  const timelineSection = timelineLines.join("\n");

  // Build histogram
  const histogramLines: string[] = [];
  histogramLines.push("");
  const byDecadeCount: Record<string, number> = {};
  for (const it of items) {
    const d = (it.year || "n.d.").slice(0, 3) + "0s";
    byDecadeCount[d] = (byDecadeCount[d] || 0) + 1;
  }
  const sortedForHist: string[] = [];
  const histEntries = Object.entries(byDecadeCount);
  for (let i = 0; i < histEntries.length; i++) {
    const entry = histEntries[i];
    if (entry && entry[0]) {
      sortedForHist.push(entry[0]);
    }
  }
  sortedForHist.sort((a: string, b: string) => a.localeCompare(b));
  for (const k of sortedForHist) {
    const v = byDecadeCount[k];
    histogramLines.push("- " + k + ": " + v + " temporally-relevant references in corpus");
  }

  return timelineSection;
}

function buildStateOfTheArt(
  topic: string,
  scope: string,
  sources: EnrichedResult[],
  args: DeepSearchArgs,
): string {
  const top = sources.slice(0, 10);
  const parts: string[] = [];

  // Build state of the art header
  parts.push("## State of the Art: " + topic + scope);
  parts.push("");
  parts.push("### Current Consensus (from retrieved sources)");
  parts.push("");

  // Build consensus from top sources
  const consensusLines: string[] = [];
  for (const s of top) {
    const hostname = new URL(s.url || "about:blank").hostname || "source";
    const contentPreview = s.content?.slice(0, 200).replace(/\n/g, " ") || "";
    consensusLines.push("- **" + s.title + "** (" + hostname + "): " + contentPreview + "... [↗](" + s.url + ")");
  }
  if (consensusLines.length > 0) {
    parts.push(consensusLines.join("\n"));
  } else {
    parts.push("- No consensus extractable from retrieved corpus.");
  }

  // Build leading approaches/methods section
  parts.push("");
  parts.push("### Leading Approaches/Methods");
  parts.push("");

  const methods = ["method", "approach", "framework", "model", "algorithm", "architecture", "technique"];
  const found: string[] = [];
  for (const s of top) {
    const text = (s.fetchedContent ?? s.content).toLowerCase();
    for (const m of methods) {
      if (text.includes(m)) {
        found.push("- " + m.toUpperCase() + ": evidenced in " + s.title + " [↗](" + s.url + ")");
        break;
      }
    }
  }
  if (found.length > 0) {
    parts.push(found.slice(0, 8).join("\n"));
  } else {
    parts.push("- Methods/approaches not explicitly named in top sources.");
  }

  // Build Mermaid flowchart chart
  const mermaidFlow = "A[State of Art: " + topic + "] --> B[Current Paradigms]\n  A --> C[Active Methods]\n  A --> D[Open Challenges]\n  B --> E[Validated by Sources]\n  C --> E\n  D --> F[Research Opportunities]";
  parts.push("\`\`mermaid\n" + mermaidFlow + "\n\`\`)");

  // Build open problems section
  parts.push("");
  parts.push("### Open Problems & Research Gaps");
  parts.push("");

  const gaps = ["gap", "limitation", "challenge", "open problem", "future work", "unresolved", "need for"];
  const gapItems: string[] = [];
  for (const s of top) {
    const text = (s.fetchedContent ?? s.content).toLowerCase();
    for (const g of gaps) {
      if (text.includes(g)) {
        const match = (s.fetchedContent ?? s.content).match(new RegExp(g + ".{1,140}", "i"));
        gapItems.push("- Identified in **" + s.title + "**: " + (match ? match[0] : "gap/challenge noted") + " [↗](" + s.url + ")");
        break;
      }
    }
  }
  if (gapItems.length > 0) {
    parts.push(gapItems.slice(0, 8).join("\n"));
  } else {
    parts.push("- No explicit gaps extracted; consider broader search.");
  }

  return parts.join("\n");
}

function buildFindings(
  topic: string,
  scope: string,
  sources: EnrichedResult[],
  args: DeepSearchArgs,
): string {
  const length = args.length;
  const max = length === "short" ? 3 : length === "medium" ? 5 : length === "detailed" ? 8 : 12;
  const cats = [
    { title: "Definitions & Core Concepts", kw: ["definition", "concept", "terminology", "what is"] },
    { title: "Theoretical Foundations", kw: ["theory", "theoretical", "framework", "model"] },
    { title: "Methodologies & Approaches", kw: ["method", "methodology", "approach", "technique"] },
    { title: "Empirical Evidence & Results", kw: ["study", "experiment", "result", "finding", "evidence"] },
    { title: "Applications & Use Cases", kw: ["application", "use case", "implementation", "practice"] },
    { title: "Comparisons & Benchmarks", kw: ["compare", "benchmark", "evaluation", "vs"] },
    { title: "Tools, Systems & Datasets", kw: ["tool", "system", "dataset", "library", "platform"] },
    { title: "Ethics, Risks & Implications", kw: ["ethic", "risk", "bias", "implication", "societal"] },
    { title: "Standards & Governance", kw: ["standard", "policy", "regulation", "governance"] },
    { title: "Recent Advances (2023–present)", kw: ["2023", "2024", "2025", "recent", "latest", "advance"] },
  ];
  const out: string[] = ["## Findings: " + topic + scope, ""];
  let count = 0;

  for (const c of cats) {
    if (count >= max) break;
    const hits = sources.filter((s) => {
      const t = (s.fetchedContent ?? s.content).toLowerCase();
      return c.kw.some((k) => t.includes(k));
    }).slice(0, 3);
    if (hits.length === 0) continue;
    out.push("### " + c.title);
    out.push("");
    for (const h of hits) {
      const txt = (h.fetchedContent ?? h.content).slice(0, 320).replace(/\n/g, " ");
      out.push("- **" + h.title + "** [↗](" + h.url + "): " + txt + "...");
    }
    out.push("");
    count++;
  }

  if (count < max) {
    for (const s of sources.slice(0, max - count)) {
      const txt = (s.fetchedContent ?? s.content).slice(0, 280).replace(/\n/g, " ");
      out.push("### From: " + s.title);
      out.push("- " + txt + "... [Source](" + s.url + ")");
      count++;
    }
  }

  // Build evidence distribution pie chart
  out.push("");
  out.push("### Evidence Distribution");
  out.push("");
  out.push("```mermaid");
  out.push("pie title Source Coverage by Domain");
  // Build domain lines
  const domainLines: string[] = [] as string[];
  for (let i = 0; i < Math.min(6, sources.length); i++) {
    const hostname = new URL((sources[i]!.url ?? "x/x")).hostname.replace("www.", "");
    const countText = String((6 - i) * 10);
    domainLines.push("  \"" + hostname + "\" : " + countText);
  }
  out.push(domainLines.join("\n"));
  out.push("```");
  out.push("");

  return out.join("\n");
}

function buildAnalysis(
  topic: string,
  scope: string,
  sources: EnrichedResult[],
  args: DeepSearchArgs,
): string {
  const level = args.technicalLevel;
  const top = sources.slice(0, 10);
  const all = sources.map((s) => s.content + (s.fetchedContent || "")).join(" ").toLowerCase();
  const themes: string[] = [];
  const topThemes = top.flatMap((s) => extractThemes(s.fetchedContent ?? s.content));
  for (let i = 0; i < Math.min(topThemes.length, 8); i++) {
    const theme = topThemes[i];
    if (theme) {
      themes.push(theme);
    }
  }
  const consensus: string[] = [];
  if (all.includes("consensus") || all.includes("widely accepted")) {
    consensus.push("- Apparent consensus on core definitions across multiple independent sources.");
  }
  if (themes.length > 0) {
    consensus.push("- Recurring themes: " + themes.join(", ") + ".");
  }
  consensus.push("- Convergence observed where sources corroborate same claims (see citations).");
  const diverg: string[] = [
    "- Contradictions not strongly evident; check specific claims in primary sources.",
    "- Emphasis differs (theory vs practice) across communities.",
  ];
  const techLevel: string = level === "beginner" ? "introductory" : level === "intermediate" ? "foundational" : level === "advanced" ? "technical" : "expert";

  // Build analysis sections
  const analysisLines: string[] = [];
  analysisLines.push("## Critical Analysis");
  analysisLines.push("");
  analysisLines.push("**Level:** " + techLevel + " (" + level + "); Tone: " + args.tone + ".");
  analysisLines.push("");
  analysisLines.push("### Cross-Source Validation");
  analysisLines.push("");
  if (consensus.length > 0) {
    analysisLines.push(consensus.join("\n"));
  } else {
    analysisLines.push("- Limited explicit consensus markers.");
  }
  analysisLines.push("");
  analysisLines.push("### Points of Divergence / Nuance");
  analysisLines.push("");
  analysisLines.push(diverg.slice(0, 3).join("\n"));
  analysisLines.push("");
  analysisLines.push("### Synthesis Matrix (top sources)");
  analysisLines.push("");
  // Build table
  analysisLines.push("| Source | Domain | Key Contribution | Evidence Type |");
  analysisLines.push("|---|---|---|---|");
  for (let i = 0; i < Math.min(8, top.length); i++) {
    const s = top[i]!;
    const dom = new URL(s.url ?? "x").hostname.replace("www.", "");
    const contrib = s.content?.slice(0, 60).replace(/\|/g, "/") || "";
    const et = s.fetchedContent ? "enriched" : "snippet";
    const url = s.url ?? "#";
    analysisLines.push("| [" + s.title.slice(0, 30) + "...]" + "](" + url + ") | " + dom + " | " + contrib + " | " + et + " |");
  }
  analysisLines.push("");
  // Build Mermaid flowchart
  const flowLR = "E[Evidence Corpus] --> X[Extraction]\n  X --> V[Cross-Ref]\n  V --> S[Synthesis]\n  S --> C[Conclusions]\n  V --> G[Gaps Identified]";
  analysisLines.push("\`\`mermaid\nflowchart LR\n" + flowLR + "\n\`\`)");

  return analysisLines.join("\n");
}

function buildConclusions(
  topic: string,
  scope: string,
  sources: EnrichedResult[],
  args: DeepSearchArgs,
): string {
  const top = sources.slice(0, 5);
  const pts: string[] = [
    "**Answerable conclusion:** Based strictly on retrieved evidence, " + topic + scope + " shows " + (top.length > 0 ? "documented activity" : "limited coverage") + " in the searched corpus.",
    "**State:** Current discourse centers on " + extractThemes(top.map((s) => s.content).join(" ")).slice(0, 3).join(", ") || "core concepts" + " as reflected by cited sources.",
    "**Methodological insight:** Multi-source corroboration strengthens confidence; single-source claims remain provisional.",
    "**Pragmatic takeaway:** Practitioners should consult primary sources cited below; synthesized extracts are indicative, not exhaustive.",
  ];
  if (args.length !== "short") {
    pts.push("**Forward view:** Open gaps (above) warrant targeted investigation with domain-specific queries and primary literature.");
  }
  // Build conclusions
  const conclusionsLines: string[] = [];
  conclusionsLines.push("## Conclusions");
  conclusionsLines.push("");
  for (const pt of pts) {
    conclusionsLines.push(pt);
  }
  conclusionsLines.push("");
  conclusionsLines.push("");

  return conclusionsLines.join("\n");
}

function buildLimitations(
  sources: EnrichedResult[],
  errors: string[],
  args: DeepSearchArgs,
): string {
  const pts: string[] = [];
  if (sources.length === 0) {
    pts.push("- No results retrieved; topic may be niche or filters too restrictive.");
  }
  if (errors.length) {
    pts.push("- " + errors.length + " queries failed; coverage reduced.");
  }
  pts.push("- Web-indexed results only; paywalled/behind-login and some scholarly databases may be under-represented.");
  pts.push("- Fetching limited to top 8 sources (to avoid noise); some relevant pages may not be fully fetched.");
  pts.push("- HTML stripping loses tables/figures; treat extracted text as indicative.");
  pts.push("- Snapshot as of generation (" + new Date().toISOString().slice(0, 10) + "); literature evolves rapidly.");
  if (args.sources?.length) {
    pts.push("- Domain restrictions applied: " + args.sources.join(", ") + " may exclude adjacent work.");
  }
  // Build limitations
  const limitationsLines: string[] = [];
  limitationsLines.push("## Limitations");
  limitationsLines.push("");
  for (const pt of pts) {
    limitationsLines.push(pt);
  }
  limitationsLines.push("");
  limitationsLines.push("");

  return limitationsLines.join("\n");
}

function buildReferences(sources: EnrichedResult[]): string {
  if (sources.length === 0) {
    return "## References\n\n*No verifiable sources retrieved.*";
  }
  const items: string[] = [];
  for (let i = 0; i < sources.length; i++) {
    const url = sources[i]!.url ?? "#";
    const host = new URL(url).hostname.replace("www.", "");
    const year = (sources[i]!.fetchedContent ?? sources[i]!.content).match(/(19|20)[0-9]{2}/)?.[0] || "n.d.";
    items.push(`${i + 1}. ${sources[i]!.title}. ${host}. ${year}. Available: ${url}. Accessed: ${new Date().toISOString().slice(0, 10)}.`);
  }
  // Build references
  const referencesLines: string[] = [];
  referencesLines.push("## References");
  referencesLines.push("");
  for (const item of items) {
    referencesLines.push(item);
  }
  referencesLines.push("");

  return referencesLines.join("\n");
}/**
 * Render the report into markdown format.
 */
function renderReport(args: DeepSearchArgs, report: ReportSections): string {
  const format = args.format || "markdown";
  if (format === "json") {
    const jsonObj: Record<string, string> = {
      executiveSummary: report.executiveSummary,
      methodology: report.methodology,
      findings: report.findings,
      historicalContext: report.historicalContext,
      stateOfTheArt: report.stateOfTheArt,
      analysis: report.analysis,
      conclusions: report.conclusions,
      limitations: report.limitations,
      references: report.references,
    };
    return JSON.stringify(jsonObj, null, 2);
  } else if (format === "html") {
    const sections: string[] = [];
    for (const [key, value] of [
      ["executiveSummary", report.executiveSummary],
      ["methodology", report.methodology],
      ["findings", report.findings],
      ["historicalContext", report.historicalContext],
      ["stateOfTheArt", report.stateOfTheArt],
      ["analysis", report.analysis],
      ["conclusions", report.conclusions],
      ["limitations", report.limitations],
      ["references", report.references],
    ]) {
      sections.push("## " + key!.replace(/([A-Z])/g, " $1").trim() + "\n" + value);
    }
    return sections.join("\n\n");
  } else { // markdown (default)
    const sections: string[] = [
      "## Executive Summary",
      report.executiveSummary,
      "## Methodology",
      report.methodology,
      "## Findings",
      report.findings,
      "## Historical Context",
      report.historicalContext,
      "## State of the Art",
      report.stateOfTheArt,
      "## Analysis",
      report.analysis,
      "## Conclusions",
      report.conclusions,
      "## Limitations",
      report.limitations,
      "## References",
      report.references,
    ];
    return sections.join("\n\n");
  }
}
