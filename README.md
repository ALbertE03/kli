# KLI — Agentic Coding Harness

**KLI** is a plugin-first agentic coding harness. It orchestrates LLM agents
that read, edit, and execute code in a workspace.

- Spec: see [`SPEC.md`](./SPEC.md)
- TypeScript 5, ESM-only, pnpm workspace
- Kernel under 2500 LOC (§4.1 target)

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
| `@kli/context-system` | ✅ | System-prompt sections (tool catalog, rules, context) |
| `@kli/context-mcp` | ✅ | MCP server bridge |
| `@kli/context-skills` | ✅ | Built-in skills |
| `@kli/backend-tree-sitter` | ⏳ | Tree-sitter backend (WIP; grammars not bundled) |
| `@kli/tool-web-search` | ✅ | Web search/fetch |
| `@kli/runtime-subprocess` | ✅ | Out-of-process plugin host |
| `@kli/provider-openai` | ✅ | OpenAI provider |
| `@kli/provider-anthropic` | ⏳ | Anthropic provider (in progress) |

## CLI

```
kli run [--mode plan|build|ask] [--project <name>] [--debug] [--quiet] "<task>"
kli repl [--mode plan|build|ask] [--project <name>]
kli prompt [--mode plan|build|ask] [--task "<task>"]   # print the assembled system prompt
kli tools  [--mode plan|build|ask]                      # list visible tools + JSON Schemas
kli graph build                                        # build the code graph (AST backends)
kli graph status                                       # show the cached graph summary
kli session list | kli session resume <id>
kli project create <name> | kli project list
kli plugin list
kli model list
kli help
```

`kli run` streams assistant tokens as they arrive and prints live tool/model
activity plus tokens/s to stderr. `--quiet` suppresses the live logs;
`--debug` also prints the assembled system prompt.

## Configuration (`.env`)

All model/runtime configuration is read from the environment (`.env` is loaded
automatically). Nothing is hardcoded in the providers.

| Variable | Default | Purpose |
|----------|---------|---------|
| `KLI_MODEL` | `auto` | Model id passed to the provider |
| `KLI_TEMPERATURE` | `0.7` | Sampling temperature |
| `KLI_MAX_TOKENS` | — | Task token **budget** (CLI) |
| `KLI_MAX_OUTPUT_TOKENS` | `4096` | Per-response completion cap (`max_tokens`) |
| `KLI_STREAM` | `1` | Stream tokens (`0` disables) |
| `KLI_TOP_P`, `KLI_PRESENCE_PENALTY`, `KLI_FREQUENCY_PENALTY`, `KLI_SEED` | — | Optional sampling |
| `KLI_STOP` | — | Comma-separated stop sequences |
| `KLI_REASONING_EFFORT` | — | Reasoning effort, when supported |
| `KLI_COST_LIMIT` | `5.0` | USD cost ceiling per task |
| `KLI_TIMEOUT` | `120000` | Task deadline (ms) |
| `KLI_MAX_RETRIES` | `3` | Retry attempts for retryable tool errors |
| `OPENAI_API_KEY` / `OPENAI_BASE_URL` | — | OpenAI-compatible provider |
| `ANTHROPIC_API_KEY` | — | Anthropic provider |
| `TAVILY_KEY` | — | Required by `web_search` (`fetch_url` needs no key) |


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

Then wire it into `.kli/config.js`:

```js
export default {
  plugins: { include: ["./plugins/my-tool/dist/index.js"] },
};
```

Config is read at runtime from `.kli/config.js` (or `.kli/config.ts` if you
compile it yourself) via `createRequire()` — no build step for config changes.

## Contributing

See [`CONTRIBUTING.md`](./CONTRIBUTING.md) for plugin authoring guide.

## License

MIT