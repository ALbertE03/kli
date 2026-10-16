# KLI — Agent Operating Instructions

KLI is a **plugin-first agentic coding harness**: thin kernel + plugins per capability. **TypeScript 5, ESM-only, pnpm workspace, Node ≥20, pnpm ≥10**.

Other sources worth reading (they can lag behind the code — trust config/scripts over prose):
`CONTRIBUTING.md` (plugin authoring + release checklist), `SPEC.md` (design spec),
`README.md` (setup/run), `TESTING.md`, `docs/connect-local-provider.md`.

---

## Structure

```
packages/
  api/      @kli/api     # Frozen Zod contracts (Rule #1: plugins import ONLY from here)
  kernel/   @kli/kernel  # Loop, registry, bus, loader, prompt/graph builders
  server/   @kli/server  # HTTP + SSE bridge for KLI Studio (entry: dist/serve.js)
  studio/   @kli/studio  # Web UI (Vite + React); talks ONLY to @kli/server
  runtime-subprocess/    # @kli/runtime-subprocess — subprocess runtime

plugins/
  tool-*       # read-file, edit-file, create-file, execute-bash, web-search, deep-search
  backend-*    # AST extractors: ts-morph, python-ast, tree-sitter (WIP), config
  context-*    # Graph tools, MCP bridge, skills, system prompt sections
  mode-*       # plan, build, ask (installed via registerMode)
  provider-*   # openai, anthropic
```

There is **no CLI**. The harness is driven by the Studio UI through `@kli/server`.
Some comments/docs still say `kli serve` or `@kli/cli` — that CLI was removed; `dist/serve.js` replaced it.

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

**Verification order**: `build → typecheck → eslint` (exactly what `.github/workflows/ci.yml` runs on PRs). There is **no unit-test runner**; `.scripts/smoke.sh` is **stale** (it still shells out to the removed `@kli/cli`, so it fails).

### Single-Package Build
```bash
pnpm --filter @kli/<package> build    # e.g., @kli/kernel, @kli/api, @kli/server, @kli/studio
```

**Critical**: Rebuild before running. The server and plugin loader import `dist/`, **never `src/`** — nothing hot-reloads.

### Run
```bash
pnpm --filter @kli/server start        # harness server on 127.0.0.1:4317
# or: node packages/server/dist/serve.js [--port <n>] [--host <h>] [--workspace <dir>]
pnpm --filter @kli/studio dev          # Studio UI on http://localhost:5173
./start.sh                             # both at once
```

---

## Harness Server (`@kli/server`)

The entrypoint is `packages/server/src/serve.ts` → `dist/serve.js`. It boots a
`KliServer` from `src/index.ts`; there is **no CLI**. All endpoints live in
`KliServer.handle`:

- `GET /api/health` — plugins, tools per mode, backends, skills, agents.
- `POST /api/chat` — SSE run; body `{ message, mode, provider, projectPath?, projectId? }`.
  `provider` is only an identity hint (`id`/`kind`/`baseUrl`/`model`); the API key
  is resolved server-side by `resolveProvider()` from env.
- `POST /api/provider/passthrough` — gateway for non-agent provider calls
  (chat, embeddings, images, audio, `/models`). Forwards to the resolved provider
  with the server env key; paths are whitelisted (`ALLOWED_PROVIDER_PATHS`).
- `GET /api/workspace`, `GET /api/tools`, `GET /api/models`.
- `GET|POST|DELETE /api/projects`, `GET|POST|DELETE /api/agents`.
- `POST /api/read`, `GET /api/fs/dirs` (folder picker), `GET|POST /api/graph`, `POST /api/reload`.

`serve.ts` loads the nearest `.env` walking up from the process cwd
(dependency-free, shell exports win) before booting — so `pnpm --filter
@kli/server start` still finds the repo-root `.env`. The server — not the
browser — holds `OPENAI_API_KEY` / `OPENAI_BASE_URL` / `ANTHROPIC_API_KEY`.

`projectPath` isolates a run inside a project folder (its own `Kernel`, `cwd`
and `workspaceRoot`); `projectId` is the stable project identifier threaded
through to `PluginContext`/`PromptContext`.

---

## Configuration

### Environment (`.env`)
All model/runtime config is **environment-only** (providers hardcode nothing) and
lives in the repo-root `.env`, which **only `@kli/server` reads**. The Studio
needs no `VITE_*` vars: it forwards provider calls and the server injects the key.

| Variable | Notes |
|----------|-------|
| `KLI_MODEL`, `KLI_TEMPERATURE` | Model ID (e.g., `auto`), sampling temp |
| `KLI_MAX_TOKENS` | **Whole-task token budget** |
| `KLI_MAX_OUTPUT_TOKENS` | **Per-response `max_tokens`** (default: 4096). **Do NOT send task budget as `max_tokens`** |
| `KLI_STREAM` | `0` disables streaming |
| `KLI_TOP_P`, `KLI_PRESENCE_PENALTY`, `KLI_FREQUENCY_PENALTY`, `KLI_SEED`, `KLI_STOP`, `KLI_REASONING_EFFORT` | Optional sampling |
| `KLI_COST_LIMIT`, `KLI_TIMEOUT`, `KLI_MAX_RETRIES` | Budget/deadline/retry limits |
| `OPENAI_BASE_URL` / `OPENAI_API_KEY` | OpenAI-compatible provider (FreeLLMAPI by default) |
| `ANTHROPIC_API_KEY` | Anthropic provider |
| `TAVILY_KEY`, `JIRO_KEY` | `web_search` / `deep-search`; `fetch_url` needs no key |

---

## Plugin System

### How Plugins Are Located
- `@kli/server`'s `Workspace` reads `<workspaceRoot>/.kli/config.js` (or `.ts`).
- `plugins.include` must list **explicit `./plugins/<name>/dist/index.js` paths** (not directories); relative entries resolve against the **host** workspace root, never a project folder.
- **`config.js` must NOT call `require()`** — the loader detects it and returns `{}` (so nothing loads).
- `.env` is loaded by `serve.ts`, **not** by the plugin loader; providers/tools read `process.env`.

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
- **Rule #7**: The kernel hard-codes **no** tool, mode, provider or agent name; hosts supply the surface (see `packages/kernel/src/identity.ts`).

---

## Subagents

- Defined in `@kli/api` (`AgentDefinitionSchema`): `id`, `name`, `description`, `mode`, `model`, `tools`, `instructions`, `hidden`, `builtin`.
- Built-ins: `explorer`, `researcher`, `coder`, `reviewer`, `orchestrator` (hidden).
- Overrides live in `<workspaceRoot>/.kli/agents.json` (layered over defaults via `mergeAgents()`).
- The Studio UI writes overrides to `agents.json` (via `POST/DELETE /api/agents`).
- Delegation:
  - `createDelegationTool(name, deps, options)` builds the tool to spawn subagents.
  - **Tool name is caller’s choice** (`"task"` in the server); the kernel hard-codes **no** tool name (Rule #7).
  - `Kernel.runAgent()` scopes a registry snapshot to the agent (mode filter ∩ `agent.tools` + `agentPromptFragment`).
  - Delegation tool is **per-run** (closes over live `Provider`), `priority: 100`, `exclusive: true`.
  - Modes must include delegation tool name (e.g., `"task"`) in `allowTools` or parent **cannot** delegate.
  - `Kernel.runAgent` accepts `denyTools`; hosts pass `["task"]` to prevent recursion.

---

## KLI Studio (`packages/studio`)

- **5 modes**: `agent` (full harness via `@kli/server`), `chat`, `image`, `embeddings`, `audio`.
- **Provider routing**: **no mode calls a provider directly.** `lib/api.ts` funnels every call (chat, images, embeddings, audio, `/models`) through `POST /api/provider/passthrough`; `@kli/server` resolves base URL + API key from env and forwards upstream. The `provider` field in requests is only an identity hint. The server URL comes from `src/lib/gateway.ts`, kept in sync with `harnessUrl`.
- **Agent mode**:
  - Client: `src/lib/harness.ts` (for `@kli/server`).
  - Gated on `GET /api/health` (returns plugins, tools per mode, backends, skills).
  - Server streams SSE events: `start`, `reasoning`, `token`, `tool.start`, `tool.end`, `agent.start`, `agent.tool`, `agent.end`, `done`, `error`.
  - Reasoning deltas come from `reasoning_content` in OpenAI provider (shown as "Razonamiento" in UI).
- **Build**: `pnpm --filter @kli/studio build` (runs `vite build` + `typecheck`).
- **State**: Persists to `localStorage` (`kli-studio-storage`, zustand `version: 2`); Settings-typed API keys in `sessionStorage` (`kli-studio-secrets`) are only a fallback (server env wins).
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
