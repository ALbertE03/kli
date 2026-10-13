# KLI — Agentic Coding Harness

**KLI** is a plugin-first agentic coding harness. It orchestrates LLM agents
that read, edit, and execute code in a workspace.

- Spec: see [`SPEC.md`](./SPEC.md)
- TypeScript 5, ESM-only, pnpm workspace
- Kernel under 2500 LOC excluding tests (§4.1 target)

## Quickstart

```bash
# Install
pnpm install

# Typecheck & build everything
pnpm build

# Run a task (you need a provider configured)
./packages/cli/dist/cli.js run "Add a fibonacci function to src/math.ts"
```

## Architecture

```
kli/
  packages/
    api/          @kli/api          frozen contracts (PluginManifest, ToolDefinition, …)
    kernel/       @kli/kernel       loop, registry, bus, loader, prompt builder
    cli/          @kli/cli          `kli` binary
  plugins/
    tool-read-file   example tool plugin
    mode-plan/       mode plugins (plan, build, ask)
    backend-ts-morph/ AST extractors
    ...
```

### Core rules (non-negotiable)

1. **Plugin isolation** — plugins import only from `@kli/api`, never from kernel.
2. **Capability enforcement** — every tool call checks declared capabilities before executing.
3. **Path safety** — all file paths go through `ctx.resolve()` (§7 rules).
4. **Frozen registry per task** — a running task sees a single snapshot (§4.6).
5. **Event bus only** — plugins communicate via the bus, never direct calls.

## Packages

| Package | Status | Description |
|---------|--------|-------------|
| `@kli/api` | ✅ | Frozen public contracts (Zod schemas) |
| `@kli/kernel` | ✅ | Loop, Registry, EventBus, PluginLoader, PromptBuilder |
| `@kli/cli` | ✅ | `kli` binary |
| `@kli/tool-read-file` | ✅ | Example tool plugin |
| `@kli/tool-create-file` | ✅ | Create files |
| `@kli/tool-edit-file` | ✅ | Edit files |
| `@kli/tool-execute-bash` | ✅ | Execute bash commands |
| `@kli/backend-ts-morph` | ✅ | TypeScript AST backend |
| `@kli/backend-python-ast` | ✅ | Python AST backend |
| `@kli/backend-config` | ✅ | Config file backend |
| `@kli/context-graph` | ✅ | Graph query tools |
| `@kli/context-mcp` | ✅ | MCP server bridge |
| `@kli/context-skills` | ✅ | Built-in skills |
| `@kli/tool-web-search` | ✅ | Web search/fetch |
| `@kli/runtime-subprocess` | ✅ | Out-of-process plugin host |
| `@kli/provider-openai` | ✅ | OpenAI provider |
| `@kli/provider-anthropic` | ⏳ | Anthropic provider (in progress) |

## CLI

```
kli run [--mode plan|build|ask] [--skill <id>] "<task>"
kli plugin list
kli graph build
kli help
```

## Adding a plugin

Create a package with:

```ts
// src/index.ts
import { z } from "zod";
import type { HarnessPlugin, Capability, ToolDefinition } from "@kli/api";

const Schema = z.object({ /* your args */ });
const Capabilities: Capability[] = ["fs.read"];

export const plugin: HarnessPlugin = {
  manifest: {
    id: "my.tool.example",
    version: "1.0.0",
    apiVersion: "1",
    kind: ["tool"],
    entrypoint: "./dist/index.js",
    capabilities: Capabilities,
  },
  register(registry) {
    registry.registerTool(buildTool(), this.manifest.id);
  },
};

function buildTool(): ToolDefinition {
  return {
    name: "my_example_tool",
    description: "...",
    schema: Schema,
    capabilities: Capabilities,
    async execute(args, ctx, signal) {
      // Your logic here
    },
  };
}
```

Then wire it into `.kli/config.ts`:

```ts
export default defineConfig({
  plugins: { include: ["./plugins/my-tool"] },
});
```

## Testing

```bash
pnpm test            # unit + integration
pnpm test:benchmark  # pass@1 on benchmark suite
```

## Contributing

See [`CONTRIBUTING.md`](./CONTRIBUTING.md) for plugin authoring guide.

## License

MIT