/**
 * The plugin interface — what every plugin module exports.
 *
 * A plugin module must export `const plugin: HarnessPlugin` (or default it).
 * The manifest is validated with Zod at load time; the interface itself is
 * plain TypeScript (functions cannot be meaningfully schema-validated).
 */

import { PluginManifestSchema, type PluginManifest } from "./manifest.js";
import type { PluginContext } from "./context.js";
import type { Registry } from "./registry.js";

export interface HarnessPlugin {
  manifest: PluginManifest;
  setup?(ctx: PluginContext): Promise<void>;
  teardown?(): Promise<void>;
  register?(registry: Registry): void;
}

/**
 * Runtime validator for the boundary between kernel and plugin modules.
 */
export function validatePluginShape(value: unknown): HarnessPlugin {
  if (typeof value !== "object" || value === null) {
    throw new Error("Plugin export must be an object");
  }
  const candidate = value as Partial<HarnessPlugin>;
  if (!candidate.manifest) {
    throw new Error("Plugin is missing 'manifest'");
  }
  const manifest = PluginManifestSchema.parse(candidate.manifest);
  if (candidate.setup !== undefined && typeof candidate.setup !== "function") {
    throw new Error("Plugin 'setup' must be a function");
  }
  if (
    candidate.teardown !== undefined &&
    typeof candidate.teardown !== "function"
  ) {
    throw new Error("Plugin 'teardown' must be a function");
  }
  if (
    candidate.register !== undefined &&
    typeof candidate.register !== "function"
  ) {
    throw new Error("Plugin 'register' must be a function");
  }
  return {
    manifest,
    ...(candidate.setup ? { setup: candidate.setup } : {}),
    ...(candidate.teardown ? { teardown: candidate.teardown } : {}),
    ...(candidate.register ? { register: candidate.register } : {}),
  };
}
