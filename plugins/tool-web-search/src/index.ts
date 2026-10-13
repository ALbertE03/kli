/**
 * @kli/tool-web-search — web search and fetch tools
 */
import { z } from "zod";
import type { HarnessPlugin, Capability, ToolDefinition } from "@kli/api";

const capabilities: Capability[] = ["net.http"];

const WebSearchSchema = z.object({
  query: z.string(),
  maxResults: z.number().int().min(1).max(20).default(5),
  recency: z.enum(["any", "day", "week", "month"]).default("any"),
  domains: z.array(z.string()).optional(),
});

const FetchUrlSchema = z.object({
  url: z.string().url(),
  extract: z.enum(["markdown", "text", "html"]).default("markdown"),
});

export const plugin: HarnessPlugin = {
  manifest: {
    id: "kli.tool.web-search",
    version: "1.0.0",
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

function buildSearchTool(): ToolDefinition<z.infer<typeof WebSearchSchema>> {
  return {
    name: "web_search",
    description: "Search the web using Brave Search API.",
    schema: WebSearchSchema,
    capabilities,
    async execute(args, ctx, signal) {
      if (signal.aborted) return { ok: false, error: "aborted" };
      const apiKey = ctx.secrets["BRAVE_API_KEY"] ?? process.env.BRAVE_API_KEY;
      if (!apiKey) {
        return {
          ok: false,
          error: "web_search requires BRAVE_API_KEY secret",
          code: "MISSING_SECRET",
        };
      }

      try {
        const resp = await fetch(
          `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(args.query)}&count=${args.maxResults}`,
          {
            headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
            signal,
          },
        );
        const data = await resp.json() as { web: { results: Array<{ title: string; url: string; description: string }> } };
        const results = (data.web?.results ?? []).slice(0, args.maxResults);
        return {
          ok: true,
          content: results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.description}`).join("\n\n"),
          data: results,
        };
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
    description: "Fetch a URL and extract content.",
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