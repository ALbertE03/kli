/**
 * @kli/tool-web-search — web search (Tavily) and URL fetch tools.
 */
import { z } from "zod";
import type { HarnessPlugin, Capability, ToolDefinition } from "@kli/api";

const capabilities: Capability[] = ["net.http"];

const WebSearchSchema = z.object({
  query: z.string(),
  maxResults: z.number().int().min(1).max(20),
  recency: z.enum(["any", "day", "week", "month"]),
  domains: z.array(z.string()).optional(),
});

const FetchUrlSchema = z.object({
  url: z.string().url(),
  extract: z.enum(["markdown", "text", "html"]),
});

/** Map the harness recency enum onto Tavily's `days` window. */
const RECENCY_DAYS: Record<z.infer<typeof WebSearchSchema>["recency"], number | undefined> = {
  any: undefined,
  day: 1,
  week: 7,
  month: 30,
};

interface TavilyResult {
  title?: string;
  url?: string;
  content?: string;
  score?: number;
}

interface TavilyResponse {
  answer?: string;
  results?: TavilyResult[];
}

export const plugin: HarnessPlugin = {
  manifest: {
    id: "kli.tool.web-search",
    version: "2.0.0",
    apiVersion: "1",
    kind: ["tool"] as Array<"tool" | "provider" | "context" | "policy">,
    entrypoint: "./dist/index.js",
    capabilities,
    priority: 0,
  },
  register(registry) {
    registry.registerTool(buildSearchTool(), this.manifest.id);
    registry.registerTool(buildFetchTool(), this.manifest.id);
  },
};

export default plugin;

function tavilyKey(ctx: { secrets: Readonly<Record<string, string>> }): string | undefined {
  return ctx.secrets["TAVILY_KEY"] ?? process.env.TAVILY_KEY ?? process.env.TAVILY_API_KEY;
}

function buildSearchTool(): ToolDefinition<z.infer<typeof WebSearchSchema>> {
  return {
    name: "web_search",
    description: `Search the web using the Tavily Search API.

Args:
  query: string — the search query
  maxResults: number — max results to return (1-20)
  recency: "any" | "day" | "week" | "month" — restrict to recent results
  domains?: string[] — restrict results to these domains

Returns: numbered results with title, url, and a content snippet.`,
    schema: WebSearchSchema,
    capabilities,
    async execute(args, ctx, signal) {
      if (signal.aborted) return { ok: false, error: "aborted" };
      const apiKey = tavilyKey(ctx);
      if (!apiKey) {
        return {
          ok: false,
          error: "web_search requires the TAVILY_KEY secret",
          code: "MISSING_SECRET",
        };
      }

      const body: Record<string, unknown> = {
        query: args.query,
        max_results: args.maxResults,
        search_depth: "basic",
        topic: "general",
      };
      const days = RECENCY_DAYS[args.recency];
      if (days !== undefined) body["days"] = days;
      if (args.domains && args.domains.length > 0) body["include_domains"] = args.domains;

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
            error: `web_search: Tavily returned ${resp.status} ${resp.statusText}${detail ? ` — ${detail.slice(0, 300)}` : ""}`,
            code: "SEARCH_ERROR",
            retryable: resp.status >= 500 || resp.status === 429,
          };
        }

        const data = (await resp.json()) as TavilyResponse;
        const results = (data.results ?? []).slice(0, args.maxResults);
        if (results.length === 0) {
          return { ok: true, content: `No results for "${args.query}".`, data: [] };
        }
        const rendered = results
          .map((r, i) => `${i + 1}. ${r.title ?? "(untitled)"}\n   ${r.url ?? ""}\n   ${r.content ?? ""}`)
          .join("\n\n");
        const content = data.answer ? `Answer: ${data.answer}\n\n${rendered}` : rendered;
        return { ok: true, content, data: results };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false, error: `web_search: ${msg}`, code: "SEARCH_ERROR" };
      }
    },
  };
}

function buildFetchTool(): ToolDefinition<z.infer<typeof FetchUrlSchema>> {
  return {
    name: "fetch_url",
    description: "Fetch a URL and extract its content (truncated).",
    schema: FetchUrlSchema,
    capabilities,
    async execute(args, _ctx, signal) {
      if (signal.aborted) return { ok: false, error: "aborted" };
      try {
        const resp = await fetch(args.url, { signal });
        const html = await resp.text();
        // Truncate to 8000 chars
        const content = html.slice(0, 8000);
        return {
          ok: true,
          content,
          meta: { source: args.url, trusted: false },
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false, error: `fetch_url: ${msg}`, code: "FETCH_ERROR" };
      }
    },
  };
}
