/**
 * Plugin loader — loads, validates, bootstraps plugins (§4.4).
 * Implements the 8-step sequence:
 * 1. import(spec) → expect `plugin: HarnessPlugin` or default
 * 2. validate manifest against Zod
 * 3. check apiVersion === "1"
 * 4. check requires semver
 * 5. build PluginContext with ONLY declared capabilities
 * 6. call setup(ctx)
 * 7. register(registry) called by Kernel after all plugins are loaded
 * 8. emit plugin.loaded / plugin.rejected
 *
 * Plugins must import ONLY from @kli/api (Rule #1) — enforced via lint, not
 * here, to avoid a hard Node import hook dependency in the unit-test path.
 */
import { createRequire } from "node:module";
import { PluginManifestSchema, validatePluginShape } from "@kli/api";
import type {
  PluginContext,
  Event,
  Logger,
  Bus,
  Capabilities,
  PluginManifest,
  Capability,
} from "@kli/api";
import { BudgetSchema } from "@kli/api";
import { resolvePath } from "./paths.js";

/** A parsed version plus whether it had a prerelease tag (`-x`). */
interface ParsedVersion {
  parts: [number, number, number];
  prerelease: string | null;
}

/**
 * Parse a semver string into its numeric parts. Returns null for malformed
 * strings. Leading `v`, a prerelease tag, and build metadata are tolerated.
 */
function parseSemver(v: string): ParsedVersion | null {
  const m = v
    .trim()
    .replace(/^v/, "")
    .match(/^(\d+)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/);
  if (!m) return null;
  const num = (s: string | undefined): number => {
    if (s === undefined || s === "x" || s === "*") return 0;
    return parseInt(s, 10);
  };
  const major = m[1];
  if (major === undefined) return null;
  return {
    parts: [parseInt(major, 10), num(m[2]), num(m[3])],
    prerelease: m[4] ?? null,
  };
}

function cmp(a: [number, number, number], b: [number, number, number]): number {
  for (let i = 0; i < 3; i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    if (av !== bv) return av < bv ? -1 : 1;
  }
  return 0;
}

/**
 * Check a single comparator, e.g. ">=1.0.0", "^1.2.3", "~1.2.0", "1.x", "*".
 * Supports caret and tilde ranges against the standard upper-bound rules.
 */
function satisfiesComparator(version: [number, number, number], raw: string): boolean {
  const c = raw.trim();
  if (c === "" || c === "*" || c === "x") return true;

  const caret = c.match(/^\^\s*(.+)$/);
  if (caret) {
    const target = parseSemver(caret[1] ?? "");
    if (!target) return false;
    const [maj, min, pat] = target.parts;
    const lower = cmp(version, target.parts) >= 0;
    let upper: [number, number, number];
    if (maj > 0) upper = [maj + 1, 0, 0];
    else if (min > 0) upper = [0, min + 1, 0];
    else upper = [0, 0, pat + 1];
    return lower && cmp(version, upper) < 0;
  }

  const tilde = c.match(/^~\s*(.+)$/);
  if (tilde) {
    const target = parseSemver(tilde[1] ?? "");
    if (!target) return false;
    const [maj, min] = target.parts;
    return (
      cmp(version, target.parts) >= 0 &&
      cmp(version, [maj, min + 1, 0]) < 0
    );
  }

  const op = c.match(/^(>=|<=|>|<|=)?\s*(.+)$/);
  if (!op) return false;
  const operator = op[1] ?? "=";
  const target = parseSemver(op[2] ?? "");
  if (!target) return false;
  const d = cmp(version, target.parts);
  switch (operator) {
    case ">=":
      return d >= 0;
    case "<=":
      return d <= 0;
    case ">":
      return d > 0;
    case "<":
      return d < 0;
    default:
      return d === 0;
  }
}

/**
 * Validate a requires constraint against the kernel version.
 *
 * Supports the common semver range grammar:
 *   - exact / partial: "1.2.3", "1.2", "1.x"
 *   - comparators: ">=1.0.0", "<2.0.0", "=1.2.3"
 *   - caret / tilde: "^1.2.3", "~1.2.0"
 *   - AND (space-separated): ">=0.5 <1.0"
 *   - OR ("||"): "^1.0.0 || ^2.0.0"
 */
function checkRequires(requires: string, kernelVersion: string): true | string {
  const parsedKernel = parseSemver(kernelVersion);
  if (!parsedKernel) return `Invalid kernel version: ${kernelVersion}`;
  const kernel = parsedKernel.parts;

  const alternatives = requires.split("||").map((s) => s.trim());
  for (const alt of alternatives) {
    const comparators = alt.split(/\s+/).filter(Boolean);
    if (comparators.length === 0) return `Empty required constraint: "${requires}"`;
    const ok = comparators.every((c) => satisfiesComparator(kernel, c));
    if (ok) return true;
  }
  return `Kernel ${kernelVersion} does not satisfy required constraint "${requires}"`;
}

export class PluginLoader {
  private readonly cwd: string;
  private readonly workspaceRoot: string;
  private readonly capabilities: Capabilities;
  private readonly logger: Logger;
  private readonly bus: Bus;
  private readonly config: Readonly<Record<string, unknown>>;
  private readonly secrets: Readonly<Record<string, string>>;
  private readonly loaded = new Map<string, LoadedPlugin>();

  constructor(opts: PluginLoaderOptions = {}) {
    this.cwd = opts.cwd ?? process.cwd();
    this.workspaceRoot = opts.workspaceRoot ?? this.cwd;
    this.logger = opts.logger ?? defaultLogger;
    this.bus = opts.bus ?? noopBus;
    this.config = opts.config ?? {};
    this.secrets = opts.secrets ?? {};
    this.capabilities = opts.capabilities ?? new Set<Capability>();
  }

  async load(spec: string): Promise<LoadedPlugin | null> {
    try {
      this.logger.info(`plugin: loading "${spec}"`);
      const mod = await this.dynamicImport(spec);
      const raw: { plugin?: unknown; default?: unknown } =
        typeof mod === "object" && mod !== null
          ? (mod as Record<string, unknown>)
          : {};
      const candidate = raw.plugin ?? raw.default;
      if (!candidate) {
        throw new Error(`Plugin "${spec}" does not export 'plugin' or 'default'`);
      }
      const parsed = validatePluginShape(candidate);
      const manifest = PluginManifestSchema.parse(parsed.manifest);

      // Validate requires against kernel version
      if (manifest.requires?.length) {
        const kernelVersion = process.env.KLI_KERNEL_VERSION ?? "1.0.0";
        for (const req of manifest.requires) {
          const result = checkRequires(req, kernelVersion);
          if (result !== true) {
            throw new Error(`Plugin "${manifest.id}" rejected: ${result}`);
          }
        }
      }

      await this.callSetup(parsed, manifest);

      this.bus.emit({
        type: "plugin.loaded",
        id: manifest.id,
        version: manifest.version,
        kind: manifest.kind,
      } as Event);
      this.logger.info(`plugin: loaded ${manifest.id}@${manifest.version}`);
      const loaded: LoadedPlugin = { manifest, instance: parsed };
      this.loaded.set(manifest.id, loaded);
      return loaded;
    } catch (err) {
      const reason =
        err instanceof Error
          ? err.message
          : typeof err === "object" && err !== null
            ? (err as { message?: string }).message ?? String(err)
            : String(err);
      this.bus.emit({ type: "plugin.rejected", id: spec, reason } as Event);
      this.logger.error(`plugin: rejected "${spec}"`, { reason });
      return null;
    }
  }

  async loadAll(specs: string[]): Promise<LoadedPlugin[]> {
    const out: LoadedPlugin[] = [];
    for (const s of specs) {
      const r = await this.load(s);
      if (r) out.push(r);
    }
    return out;
  }

  async reload(id: string): Promise<void> {
    const prev = this.loaded.get(id);
    if (!prev) throw new Error(`Plugin not loaded: ${id}`);
    if (prev.instance.teardown) await prev.instance.teardown();
    await this.load(prev.instance.manifest.entrypoint);
    this.bus.emit({ type: "plugin.reloaded", id } as Event);
  }

  async unload(id: string): Promise<void> {
    const prev = this.loaded.get(id);
    if (!prev) return;
    if (prev.instance.teardown) await prev.instance.teardown();
    this.loaded.delete(id);
  }

  getLoaded(): LoadedPlugin[] {
    return [...this.loaded.values()];
  }

  find(specOrId: string): LoadedPlugin | undefined {
    return this.loaded.get(specOrId);
  }

  private async callSetup(
    plugin: { setup?: (ctx: PluginContext) => Promise<void> },
    manifest: PluginManifest,
  ): Promise<void> {
    if (!plugin.setup) return;
    const ctx = this.makeContext(new Set(manifest.capabilities));
    await plugin.setup(ctx);
  }

  private makeContext(pluginCaps: Capabilities): PluginContext {
    return {
      cwd: this.cwd,
      workspaceRoot: this.workspaceRoot,
      budget: BudgetSchema.parse({
        tokensTotal: 0,
        tokensUsed: 0,
        costUsd: 0,
        costLimitUsd: 0,
        deadlineMs: 0,
      }),
      capabilities: pluginCaps,
      logger: this.logger,
      emit: (e: Event) => this.bus.emit(e),
      secrets: this.secrets,
      config: this.config,
      resolve: (p: string) => resolvePath(p, this.workspaceRoot),
    };
  }

  private async dynamicImport(spec: string): Promise<Record<string, unknown>> {
    const target = toImportUrl(spec, this.cwd);
    const mod = await import(target);
    return mod as Record<string, unknown>;
  }
}

export interface PluginLoaderOptions {
  cwd?: string;
  workspaceRoot?: string;
  capabilities?: Capabilities;
  logger?: Logger;
  bus?: Bus;
  config?: Record<string, unknown>;
  secrets?: Record<string, string>;
}

export interface LoadedPlugin {
  manifest: PluginManifest;
  instance: {
    manifest: PluginManifest;
    setup?: (ctx: PluginContext) => Promise<void>;
    teardown?(): Promise<void>;
    register?(registry: import("@kli/api").Registry): void;
  };
}

const defaultLogger: Logger = {
  // Logs go to stderr so stdout stays reserved for assistant output / command results.
  debug: (m, meta) => process.stderr.write(`[DEBUG] ${m} ${meta ? JSON.stringify(meta) : ""}\n`),
  info: (m, meta) => process.stderr.write(`[INFO]  ${m} ${meta ? JSON.stringify(meta) : ""}\n`),
  warn: (m, meta) => process.stderr.write(`[WARN]  ${m} ${meta ? JSON.stringify(meta) : ""}\n`),
  error: (m, meta) => process.stderr.write(`[ERROR] ${m} ${meta ? JSON.stringify(meta) : ""}\n`),
};

const noopBus: Bus = { emit: () => {}, on: () => () => {} };

function toImportUrl(spec: string, cwd: string): string {
  if (spec.startsWith(".") || spec.startsWith("/") || spec.startsWith("file:")) {
    return new URL(spec, `file://${cwd}/`).href;
  }
  const require = createRequire(import.meta.url);
  const resolved = require.resolve(spec);
  return new URL(resolved, "file:///").href;
}
