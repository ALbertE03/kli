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
} from "@kli/api";
import { BudgetSchema } from "@kli/api";
import { resolvePath } from "./paths.js";

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
    this.capabilities = opts.capabilities ?? new Set();
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
  debug: (m, meta) => console.debug(`[DEBUG] ${m}`, meta ?? ""),
  info: (m, meta) => console.info(`[INFO]  ${m}`, meta ?? ""),
  warn: (m, meta) => console.warn(`[WARN]  ${m}`, meta ?? ""),
  error: (m, meta) => console.error(`[ERROR] ${m}`, meta ?? ""),
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
