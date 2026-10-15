# KLI — Agent Operating Instructions

KLI is a **plugin-first agentic coding harness**: thin kernel + plugins per capability. **TypeScript 5, ESM-only, pnpm workspace, Node ≥20, pnpm ≥10**.

---

## Structure

```
packages/
  api/      @kli/api     # Frozen Zod contracts (Rule #1: plugins import ONLY from here)
  kernel/   @kli/kernel  # Loop, registry, bus, loader, prompt/graph builders
  cli/      @kli/cli     # `kli` binary (entry: dist/cli.js)
  server/   @kli/server  # HTTP + SSE bridge for KLI Studio
  studio/   @kli/studio  # Web UI (Vite + React), talks to @kli/server

plugins/
  tool-*       # read-file, edit-file, execute-bash, web-search, deep-search
  backend-*    # AST extractors: ts-morph, python-ast, tree-sitter (WIP), config
  context-*    # Graph tools, MCP bridge, skills, system prompt sections
  mode-*       # plan, build, ask (installed via registerMode)
  provider-*   # openai, anthropic
```

---

## Commands

### Core Workflow
```bash
pnpm install                          # Install deps (Node ≥20, pnpm ≥10)
pnpm build                            # Build all packages in workspace order
pnpm typecheck                        # Type-check all packages (run AFTER any type change)
pnpm exec eslint .                    # Lint (flat config at repo root)
pnpm clean                            # Remove dist/ + tsbuildinfo/ everywhere
```

**Verification order**: `build → typecheck → eslint`. **No test suite or CI config in repo.**

### Single-Package Build
```bash
pnpm --filter @kli/<package> build    # e.g., @kli/kernel, @kli/api, @kli/cli
```

**Critical**: Rebuild before running. The CLI/loader import `dist/`, **never `src/`** — nothing hot-reloads.

---

## CLI

### Commands
```bash
kli run [--mode plan|build|ask] [--project <name>] [--debug] [--quiet] "<task>"
kli repl [--mode plan|build|ask] [--project <name>]
kli prompt [--mode plan|build|ask] [--task "<task>"]  # Print assembled system prompt
kli tools [--mode plan|build|ask]                       # List visible tools + JSON Schemas
kli graph build | kli graph status                      # Build/show cached code graph
kli session list | kli session resume <id>
kli project create <name> | kli project list
kli agent list | kli agent show <id> | kli agent add <id> [flags] | kli agent rm <id>
kli serve [--port <n>] [--host <h>]                     # Harness server for KLI Studio
kli plugin list | kli model list | kli help
```

### Behavior
- `kli run` streams tokens to **stdout**; live tool/model activity and tokens/s go to **stderr**.
- `--quiet` silences the live log; `--debug` prints the system prompt.

---

## Configuration

### Environment (`.env`)
All model/runtime config is **environment-only** (providers hardcode nothing).

| Variable | Notes |
|----------|-------|
| `KLI_MODEL`, `KLI_TEMPERATURE` | Model ID (e.g., `auto`), sampling temp |
| `KLI_MAX_TOKENS` | **Whole-task token budget** |
| `KLI_MAX_OUTPUT_TOKENS` | **Per-response `max_tokens`** (default: 4096). **Do NOT send task budget as `max_tokens`** |
| `KLI_STREAM` | `0` disables streaming |
| `KLI_TOP_P`, `KLI_PRESENCE_PENALTY`, `KLI_FREQUENCY_PENALTY`, `KLI_SEED`, `KLI_STOP`, `KLI_REASONING_EFFORT` | Optional sampling |
| `KLI_COST_LIMIT`, `KLI_TIMEOUT`, `KLI_MAX_RETRIES` | Budget/deadline/retry limits |
| `OPENAI_API_KEY`, `OPENAI_BASE_URL` | OpenAI-compatible provider |
| `ANTHROPIC_API_KEY` | Anthropic provider |
| `TAVILY_KEY` | Required by `web_search`; `fetch_url` needs no key |

---

## Plugin System

### How the CLI Locates Plugins
- Workspace root = **`process.cwd()`** (not CLI install dir).
- Reads `<cwd>/.kli/config.js` (or `.ts`), auto-loads `<cwd>/.env` (dotenv).
- Plugin paths in config are **resolved relative to `cwd`**.
- `.kli/config.js` `plugins.include` must list **explicit `./plugins/<name>/dist/index.js` entries** (not directories).
- **Config must NOT use `require()`** (loader warns and returns `{}`).

### Adding a Plugin
1. Create the plugin package.
2. `pnpm install` (to install its deps).
3. `pnpm --filter @kli/<plugin> build`.
4. Add its `dist/index.js` to `.kli/config.js`.

### Plugin Rules
- **Rule #1**: Plugins import **only** from `@kli/api`. **Never** from `@kli/kernel`.
- **Rule #2**: Every tool declares `capabilities: readonly Capability[]`; kernel gates execution.
- **Rule #3**: Every file path **must** use `ctx.resolve()` (never `path.join`).
- **Rule #4**: `TaskRegistry` is a **read-only snapshot**; do not mutate mid-run.
- **Rule #5**: Plugins communicate **only** via the event bus (never direct calls).
- **Rule #6**: **False edges are worse than missing edges** — never fabricate graph edges.

---

## Subagents

- Defined in `@kli/api` (`AgentDefinitionSchema`): `id`, `name`, `description`, `mode`, `model`, `tools`, `instructions`, `hidden`, `builtin`.
- Built-ins: `explorer`, `researcher`, `coder`, `reviewer`, `orchestrator` (hidden).
- Overrides live in `<workspaceRoot>/.kli/agents.json` (layered over defaults via `mergeAgents()`).
- `kli agent add|rm` and Studio UI write to `agents.json`.
- Delegation:
  - `createDelegationTool(name, deps, options)` builds the tool to spawn subagents.
  - **Tool name is caller’s choice** (`"task"` in CLI/server); kernel hard-codes **no** tool name (Rule #7).
  - `Kernel.runAgent()` scopes a registry snapshot to the agent (mode filter ∩ `agent.tools` + `agentPromptFragment`).
  - Delegation tool is **per-run** (closes over live `Provider`), `priority: 100`, `exclusive: true`.
  - Modes must include delegation tool name (e.g., `"task"`) in `allowTools` or parent **cannot** delegate.
  - `Kernel.runAgent` accepts `denyTools`; hosts pass `["task"]` to prevent recursion.

---

## KLI Studio (`packages/studio`)

- **5 modes**: `agent` (uses harness), `chat`, `image`, `embeddings`, `audio` (talk directly to provider).
- **Agent mode**:
  - Client: `src/lib/harness.ts` (for `@kli/server`).
  - Gated on `GET /api/health` (returns plugins, tools per mode, backends, skills).
  - Server streams SSE events: `start`, `reasoning`, `token`, `tool.start`, `tool.end`, `agent.start`, `agent.tool`, `agent.end`, `done`, `error`.
  - Reasoning deltas come from `reasoning_content` in OpenAI provider (shown as "Razonamiento" in UI).
- **Provider switching**: `@kli/server` rebuilds a `Provider` **per request** from UI’s `{ baseUrl, apiKey, model }`.
- **Build**: `pnpm --filter @kli/studio build` (runs `vite build` + `typecheck`).
- **State**: Persists to `localStorage` (`kli-studio-storage`, zustand `version: 2`); API keys in `sessionStorage` (`kli-studio-secrets`).
- **TypeScript**: Stricter `tsconfig.json` (`noEmit`, `moduleResolution: "bundler"`, `jsx: react-jsx`, `noUnusedLocals/Parameters`).
- **Tailwind**: Tokens in `src/index.css` are **space-separated RGB triplets** (e.g., `--border: 226 226 232`). **Never** use hex/hsl or opacity modifiers (e.g., `bg-primary/10` breaks).

---

## Contracts & Tool Gotchas

- **Schemas**: `ToolDefinition.schema` is a **Zod schema**. Harness converts to JSON Schema via `toJsonSchema()` from `@kli/api` (Zod 3.x has no `.jsonSchema()`). **Never call schema methods directly.**
- **Execution**: `execute(args, ctx, signal)` receives **pre-validated** args. Return:
  ```ts
  { ok: true, content, data?, meta? } | { ok: false, error, code?, retryable? }
  ```
- **Error codes**: Use typed `ToolErrorCode` from `@kli/api` (see `ToolErrorCodeSet`). **Never** use ad-hoc strings.
- **Modes**: Are plugins. Build with:
  ```ts
  defineModePolicy({ mode, allowTools, promptFragment, policy? })
  ```
  Install via `registry.registerMode(policy, source)`. Scopes fragment + tool filter to mode.
- **Plugin manifest**: Requires `entrypoint: "./dist/index.js"`. Loader validates `requires` against `KLI_KERNEL_VERSION` (default: `1.0.0`).
- **Capabilities**: Fixed string literals (e.g., `"fs.read"`, `"proc.exec"`). Type as:
  - `readonly Capability[]` (`ToolDefinition.capabilities`)
  - `ReadonlySet<Capability>` (kernel enforcement set)
  **Never** `string[]` or `ReadonlySet<string>`.

---

## ESLint

- `@typescript-eslint/no-explicit-any`: **Error** (use `unknown` + narrow cast).
- `no-non-null-assertion`: Warning (prefer guards).
- `no-unused-vars`: **Disabled** (relaxed).
- **Ignores**: `**/dist/**`, `**/*.d.ts`, `.kli/**`, and **only** `**/*.ts` (`.tsx` is **not** linted; `tsc` is the gate).

---

## ts-morph (backend-ts-morph, ts-morph ^22)

API changes from older versions:

| Old (Wrong) | New (Correct) |
|-------------|----------------|
| `node.isKind(SyntaxKind.X)` | `node.getKind() === SyntaxKind.X` |
| `node.getStartLineNumber()` | `(node as any).getStartLineNumber()` |
| `func.name?.getText()` | Find `Identifier` child via `forEachChild` |
| `source.isExported(node)` | `node.isExported()` |
| `node.getParent()` | `(node as any).getParent()` |
| `func.parameters` | Find `SyntaxList` child manually |
| `cls.getHeritageClauses()` | Walk children for keyword tokens |
| `obj.getExpression()` | `obj.expression` |
| `obj.getNameNode()` | `(obj as any).getNameNode?.()` |

- `forEachDescendant` callback: `(node: Node) => void` (no extra params).

---

## Tree-Sitter Backend

- `plugins/backend-tree-sitter/`: **WIP stub**. `tree-sitter` npm package is installed, but grammar packages (e.g., `tree-sitter-javascript`) are **not**.
- Currently detects files and populates `languageStats` but returns an **empty graph**. Fill in `parseFile()` when grammars are available.

---

## TypeScript Config Quirks

- `tsconfig.base.json`: `strict`, `noUncheckedIndexedAccess`, `module: NodeNext`, `"types": ["node"]`.
- Plugins avoiding Node globals: Override with `{"compilerOptions": {"types": []}}` in their `tsconfig.json`.
- Directories **outside** pnpm workspace (e.g., `.fixtures/`):
  1. Add their own `tsconfig.json` (`"types": ["node"]`).
  2. Add `package.json` declaring `@types/node`.
  3. Run `npm install` **inside** them separately.
