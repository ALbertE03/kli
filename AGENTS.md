# KLI — Agent Operating Instructions

KLI is a plugin-first agentic coding harness: a thin kernel plus a plugin per
capability. TypeScript 5, ESM-only, pnpm workspace, Node ≥20, pnpm ≥10.

```
packages/
  api/      @kli/api     frozen Zod contracts (Rule #1: plugins import only here)
  kernel/   @kli/kernel  loop, registry, bus, loader, prompt builder, graph builder
  cli/      @kli/cli     `kli` binary (entry: dist/cli.js)
plugins/
  tool-*       read-file, edit-file, create-file, execute-bash, web-search
  backend-*    AST extractors: ts-morph, python-ast, tree-sitter (WIP), config
  context-*    graph tools, MCP bridge, skills, system prompt sections
  mode-*       plan, build, ask (installed via registerMode)
  provider-*   openai, anthropic
```

## Commands (verified)

```bash
pnpm install                          # install deps (Node ≥20, pnpm ≥10)
pnpm build                            # build everything in workspace order
pnpm typecheck                        # all packages — run after any type change
pnpm exec eslint .                    # lint (flat config at repo root)
```

CI runs `build → typecheck → eslint` in that order. No test suite exists.

Build a single package after editing it:
```bash
pnpm --filter @kli/kernel build       # or @kli/api, @kli/cli, @kli/<plugin>
```

**Rebuild before running.** The CLI and loader import `dist/`, never `src/` —
nothing hot-reloads. After editing any package or plugin you must rebuild
before `kli run` sees it.

## How the CLI locates things (easy to get wrong)

- The workspace root is **`process.cwd()`**, not the CLI's install dir.
- It reads `<cwd>/.kli/config.js` (or `.ts`), auto-loads `<cwd>/.env` (dotenv),
  and resolves the plugin paths in the config **relative to cwd**.
- `.kli/config.js` `plugins.include` lists explicit
  `./plugins/<name>/dist/index.js` entries — not directories.
- Config must not use `require()`; the loader warns and silently returns `{}`.
- Adding a plugin means: create the package, `pnpm install`, build, then add
  its `dist/index.js` to `.kli/config.js`.

## CLI

```
kli run [--mode plan|build|ask] [--project <name>] [--debug] [--quiet] "<task>"
kli repl [--mode plan|build|ask] [--project <name>]
kli prompt [--mode plan|build|ask] [--task "<task>"]   # print the assembled system prompt
kli tools  [--mode plan|build|ask]                      # visible tools + JSON Schemas
kli graph build | kli graph status                      # build/show the cached code graph
kli session list | kli session resume <id>
kli project create <name> | kli project list
kli plugin list | kli model list | kli help
```

`kli run` streams tokens to stdout; live tool/model activity and tokens/s go
to stderr. `--quiet` silences the live log, `--debug` also prints the system
prompt.

## Configuration (`.env`)

All model/runtime config is read from the environment; providers hardcode
nothing.

| Variable | Notes |
|----------|-------|
| `KLI_MODEL`, `KLI_TEMPERATURE` | model id (e.g. `auto`), sampling temp |
| `KLI_MAX_TOKENS` | **whole-task token budget** |
| `KLI_MAX_OUTPUT_TOKENS` | **per-response `max_tokens`** (default 4096). Do not send the task budget as `max_tokens` |
| `KLI_STREAM` | `0` disables streaming |
| `KLI_TOP_P`, `KLI_PRESENCE_PENALTY`, `KLI_FREQUENCY_PENALTY`, `KLI_SEED`, `KLI_STOP`, `KLI_REASONING_EFFORT` | optional sampling |
| `KLI_COST_LIMIT`, `KLI_TIMEOUT`, `KLI_MAX_RETRIES` | budget/deadline/retry limits |
| `OPENAI_API_KEY`, `OPENAI_BASE_URL` | OpenAI-compatible provider |
| `ANTHROPIC_API_KEY` | Anthropic provider |
| `TAVILY_KEY` | required by `web_search`; `fetch_url` needs no key |

## Architecture rules (non-negotiable)

1. **Plugin isolation** — plugins import only from `@kli/api`. Never from `@kli/kernel`.
2. **Capability enforcement** — every tool declares `capabilities` (`CapabilitySet`); the kernel gates execution.
3. **Path safety** — every file path goes through `ctx.resolve()`, never `path.join` (Rule #3).
4. **Frozen registry per task** — `TaskRegistry` is a read-only snapshot; do not mutate the registry mid-run.
5. **Event bus only** — plugins communicate via the bus, never direct calls.
6. **False edges worse than missing edges** — don't fabricate graph edges; an empty graph is safer than a wrong one.

## Contracts & tool gotchas

- `ToolDefinition.schema` is a **Zod schema**. The harness converts it to
  JSON Schema with `toJsonSchema()` from `@kli/api` (Zod is pinned at 3.x
  and has no `.jsonSchema()`); never call schema methods itself.
- `execute(args, ctx, signal)` receives already-validated, typed args. Return
  the discriminated `ToolResult`: `{ ok: true, content, data?, meta? }` or
  `{ ok: false, error, code?, retryable? }`.
- Use the typed `ToolErrorCode` from `@kli/api` for the `code` field — see
  `ToolErrorCodeSet`. Never use ad-hoc string codes.
- Modes are plugins. Build one with
  `defineModePolicy({ mode, allowTools, promptFragment, policy? })` and
  install via `registry.registerMode(policy, source)`. This scopes the
  fragment + tool filter to that mode; a bare fragment would leak. Policies
  can be scoped with `Policy.mode`, and `Policy.beforeTool` can veto a
  specific call.
- `PluginManifest` needs `entrypoint: "./dist/index.js"`. Loader validates
  semver `requires` against `KLI_KERNEL_VERSION` (default `1.0.0`).
- `Capability` is a union of fixed string literals (`"fs.read"`, `"proc.exec"`, etc.),
  not arbitrary strings. `ReadonlySet<string>` is wrong for capability sets —
  use `ReadonlySet<Capability>` or `Capabilities` (the exported alias).

## ESLint

- `@typescript-eslint/no-explicit-any` is an **error** — use `unknown` plus a narrow cast.
- `no-non-null-assertion` is a warning; prefer guards.
- `no-unused-vars` is **disabled** (relaxed convention).
- Config ignores `**/dist/**`, `**/*.d.ts`, `.kli/**`.

## ts-morph gotchas (backend-ts-morph, ts-morph ^22)

ts-morph 22 diverges from the older API used in early drafts:

| Old (wrong)              | New (correct)                    |
|--------------------------|----------------------------------|
| `node.isKind(SyntaxKind.X)` | `node.getKind() === SyntaxKind.X` |
| `node.getStartLineNumber()` | `(node as any).getStartLineNumber()` |
| `func.name?.getText()`   | find `Identifier` child via `forEachChild` |
| `source.isExported(node)`| `node.isExported()`                |
| `node.getParent()`       | `(node as any).getParent()`        |
| `func.parameters`        | find `SyntaxList` child manually   |
| `cls.getHeritageClauses()`| walk children for keyword tokens   |
| `obj.getExpression()`    | `obj.expression`                   |
| `obj.getNameNode()`      | `(obj as any).getNameNode?.()`     |

`forEachDescendant` exists on `Node` but its callback is
`(node: Node) => void` — do not add extra params.

## Tree-Sitter backend

`plugins/backend-tree-sitter/` is a WIP stub. The `tree-sitter` npm package is
installed but grammar packages (e.g. `tree-sitter-javascript`) are not. The
backend currently detects files and populates `languageStats` but returns an
empty graph. Fill in `parseFile()` when grammars are available.

## TypeScript config quirks

`tsconfig.base.json` sets `strict`, `noUncheckedIndexedAccess`,
`module(NodeNext)`, and `"types": ["node"]` globally. A plugin that must avoid
Node globals overrides in its own `tsconfig.json`:

```json
{"compilerOptions": {"types": []}}
```

Directories outside the pnpm workspace (e.g. `.fixtures/`) are not covered by
the root workspace — give them their own `tsconfig.json`
(`"types": ["node"]`) and `package.json` declaring `@types/node`, then run
`npm install` inside them separately.
