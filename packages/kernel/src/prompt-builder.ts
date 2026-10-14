/**
 * Prompt builder — assembles fragments into a system prompt.
 *
 * §4.7:
 *  - Fragments grouped by POSITION in fixed order
 *  - Each position sorted by priority (higher first)
 *  - Conditional fragments (id "tools.<src>.<name>") included only if that
 *    source tool is visible
 *  - Cache keyed by context hash, invalidated on mode/tool/skill change
 */
import type {
  PromptFragment,
  PromptPosition,
  PromptContext,
  ToolView,
  GraphSummary,
} from "@kli/api";
import type { Mode } from "@kli/api";

const POSITION_ORDER: PromptPosition[] = [
  "identity",
  "capabilities",
  "mode",
  "skills",
  "context",
  "rules",
  "examples",
  "epilogue",
];

export class PromptBuilder {
  private cache = new Map<string, string>();
  private generation = 0;
  /** Max entries before evicting the oldest (LRU-like). */
  private readonly maxCacheSize = 512;
  /** Time-to-live in ms (default 5 min). */
  private readonly ttlMs = 5 * 60 * 1000;
  private readonly cacheTimestamps = new Map<string, number>();

  /**
   * Build the full system prompt. Results are memoized per context hash.
   * Call `clearCache()` after mode/toolset/skill changes.
   */
  async build(
    fragments: readonly PromptFragment[],
    ctx: PromptContext,
    visibleToolNames: Set<string>,
  ): Promise<string> {
    const key = this.hash(ctx, visibleToolNames);

    // Evict expired entries and enforce max size
    const now = Date.now();
    for (const [k, ts] of this.cacheTimestamps) {
      if (now - ts > this.ttlMs) {
        this.cache.delete(k);
        this.cacheTimestamps.delete(k);
      }
    }
    while (this.cache.size > this.maxCacheSize) {
      const oldest = this.cacheTimestamps.entries().next().value as [string, number] | undefined;
      if (!oldest) break;
      this.cache.delete(oldest[0]);
      this.cacheTimestamps.delete(oldest[0]);
    }

    const cached = this.cache.get(key);
    if (cached !== undefined) return cached;

    const prompt = await this.assemble(fragments, ctx, visibleToolNames);
    this.cache.set(key, prompt);
    this.cacheTimestamps.set(key, now);
    return prompt;
  }

  /** Invalidate after mode / toolset / skill changes. */
  clearCache(): void {
    this.cache.clear();
    this.cacheTimestamps.clear();
    this.generation++;
  }

  get cacheSize(): number {
    return this.cache.size;
  }
  get generationId(): number {
    return this.generation;
  }

  private async assemble(
    fragments: readonly PromptFragment[],
    ctx: PromptContext,
    visibleToolNames: Set<string>,
  ): Promise<string> {
    const sections: string[] = [];

    for (const position of POSITION_ORDER) {
      const slot = fragments
        .filter((f) => f.position === position)
        .filter((f) => this.include(f, visibleToolNames, ctx))
        .sort((a, b) => b.priority - a.priority);

      for (const f of slot) {
        const out =
          typeof f.content === "function"
            ? await f.content(ctx)
            : f.content;
        if (out?.trim()) sections.push(out.trim());
      }
    }
    return sections.join("\n\n");
  }

  private include(
    f: PromptFragment,
    visibleToolNames: Set<string>,
    ctx: PromptContext,
  ): boolean {
    // Mode-scoped fragments never leak into other modes.
    if (f.modes && !f.modes.includes(ctx.mode)) return false;
    if (f.alwaysInclude) return true;
    // Conditional fragment pattern: tools.<sourceTool>.<name>
    if (f.id.startsWith("tools.")) {
      const parts = f.id.split(".");
      if (parts.length >= 3) {
        return visibleToolNames.has(parts[2] ?? "");
      }
      return false;
    }
    return true;
  }

  private hash(
    ctx: PromptContext,
    visibleToolNames: Set<string>,
  ): string {
    const parts: string[] = [
      ctx.workspaceRoot,
      ctx.cwd,
      ctx.mode,
      ctx.userMessage,
      ctx.budget.tokensUsed.toString(),
      ctx.budget.deadlineMs.toString(),
      [...visibleToolNames].sort().join(","),
      this.graphSummaryKey(ctx.graphSummary),
      ctx.skills ? ctx.skills.map((s) => s.id).sort().join(",") : "none",
    ];
    return this.simpleHash(parts.join("|"));
  }

  private graphSummaryKey(g?: GraphSummary): string {
    if (!g) return "none";
    return `${g.nodes}:${g.edges}:${g.backends?.join(",") ?? ""}`;
  }

  private simpleHash(s: string): string {
    let h = 0;
    for (let i = 0; i < s.length; i++) {
      h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
    }
    return `${Math.abs(h).toString(36)}:${this.generation}`;
  }
}
