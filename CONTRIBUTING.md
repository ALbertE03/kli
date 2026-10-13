# KLI Contribution Guide

## Plugin authoring

Every plugin exports a `const plugin: HarnessPlugin` from its entrypoint (or `export default plugin`).

### Manifest shape

```ts
export const manifest: PluginManifest = {
  id: "scope.name.subname",          // must be unique across the workspace
  version: "1.0.0",                  // semver
  apiVersion: "1",                   // fixed; increments when contracts break
  kind: ["tool" | "provider" | "context" | "policy"],
  entrypoint: "./dist/index.js",     // relative to workspace root of the plugin
  requires?: ["kernel>=0.5 <1.0"],   // optional semver constraints
  capabilities: ["fs.read"],         // declared capabilities (§3.1)
  priority?: 0,                      // conflict resolution; higher wins
};
```

### Lifecycle

```
load(spec)
  ├── dynamicImport(spec)
  ├── PluginManifestSchema.parse(plugin.manifest)
  ├── check apiVersion === "1"
  ├── check requires (semver)
  ├── build PluginContext (capabilities = plugin's declared caps)
  ├── plugin.setup(ctx)          (optional)
  └── emit plugin.loaded

Kernel.loadPlugins(specs)
  └── plugin.register(registry)  (optional, called after all plugins loaded)
```

### Tool plugin skeleton

```ts
import { z } from "zod";
import type { HarnessPlugin, ToolDefinition, Capability } from "@kli/api";

const Schema = z.object({ path: z.string() });

export const plugin: HarnessPlugin = {
  manifest: {
    id: "my.tool.foo",
    version: "1.0.0",
    apiVersion: "1",
    kind: ["tool"],
    entrypoint: "./dist/index.js",
    capabilities: ["fs.read"],
  },
  register(registry) {
    registry.registerTool(toolDef(), this.manifest.id);
  },
};

function toolDef(): ToolDefinition {
  return {
    name: "foo",
    description: "Do foo.",
    schema: Schema,
    capabilities: ["fs.read"],
    async execute(args, ctx, signal) {
      const resolved = ctx.resolve(args.path);  // Rule #3
      // …
      return { ok: true, content: "result" };
    },
  };
}
```

## Design rules to keep

- **Never** import from `@kli/kernel` inside a plugin. Violation is a lint error.
- **Always** use `ctx.resolve(p)` for paths — never `path.join` directly.
- **Always** accept and respect `AbortSignal`.
- **Never** put secrets in prompts (they're resolved in the harness, §6).
- **Never** mark a `heuristic` edge as `exact` confidence (§3.6).

## Adding a new mode

1. Create `plugins/mode-<name>/` with `package.json` pointing to `@kli/api`.
2. Implement `ModePolicy` and export a `HarnessPlugin`.
3. Register in `.``kli/config.ts`.`

## Adding an AST backend

1. Create `plugins/backend-<name>/`.
2. Implement `AstBackend` from `@kli/api/backend`.
3. Register via `registry.registerBackend(backend)`.
4. The graph orchestrator (kernel) auto-detects backends at workspace scan time.

## Testing conventions

Every plugin should ship:
- **Unit tests**: input validation, happy path, error path.
- **Contract tests**: plugin loads and registers cleanly against the registry.
- **Snapshot tests**: prompt fragments for each supported mode position.

Run:

```bash
pnpm test:unit   # fast unit surface
pnpm test:int    # integration via fixture repo
pnpm test:graph  # code graph extraction correctness
```

## Semver policy

`@kli/api` is frozen — major bumps break all plugins. When the API evolves:
- Add new fields only (never rename/remove existing ones).
- Bump `apiVersion` to `"2"` and mark the old version as deprecated.
- Maintain a migration guide in `MIGRATIONS.md`.

## Release checklist

- [ ] `@kli/api` passes all unit tests
- [ ] `@kli/kernel` passes all unit + integration tests
- [ ] All shipped plugins load successfully (`kli plugin list`)
- [ ] `klI run` on the example task completes end-to-end
- [ ] Benchmark: pass@1 ≥ target threshold