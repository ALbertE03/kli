# KLI — Agent Operating Instructions

## Repo at a Glance

KLI is a plugin-first agentic coding harness. Everything beyond the kernel is a plugin; nothing in a plugin may import from `@kli/kernel`.

```
packages/
  api/      — @kli/api  frozen Zod contracts (Rule #1: plugins import only here)
  kernel/   — @kli/kernel loop, registry, bus, loader, prompt builder
  cli/      — @kli/cli  `kli` binary (entry: dist/cli.js)
plugins/
  tool-*/       — tools (read-file, edit-file, create-file, execute-bash, web-search)
  backend-*/    — AST extractors (ts-morph, python-ast, tree-sitter, config)
  context-*/    — graph queries, MCP bridge, skills
  mode-*/       — plan, build, ask mode policies
  provider-*/   — openai, anthropic
```

## Commands (verified)

```bash
pnpm install                          # install deps (Node ≥20, pnpm ≥10)
pnpm build                            # build everything in workspace order
pnpm typecheck                        # all packages — run after any type change
```

CI runs `build → typecheck` in that order. No test or lint step.

## Architecture Rules (non-negotiable)

1. **Plugin isolation** — plugins import only from `@kli/api`. Never from `@kli/kernel`.
2. **Capability enforcement** — every tool declares its capabilities; the kernel gates execution.
3. **Path safety** — all file paths must go through `ctx.resolve()`.
4. **Frozen registry per task** — a task sees one snapshot (§4.6). Do not mutate the registry mid-run.
5. **Event bus only** — plugins communicate via the bus, never direct calls.
6. **False edges worse than missing edges** — don't fabricate graph edges; empty is safer than wrong.

## CLI

```bash
# Tasks
kli run [--mode plan|build|ask] [--project <name>] "<task>"
kli repl [--mode plan|build|ask] [--project <name>]

# Projects & sessions
kli project create <name>
kli project list
kli session list [--project <name>]
kli session resume <id> [--project <name>]

# Misc
kli plugin list
```

Config is read at runtime from `.kli/config.ts` via `createRequire()` — no compiled config. Changes take effect on next `kli run`.

## Adding a New Plugin

```bash
mkdir -p plugins/<name>/src
# Copy package.json + tsconfig.json from an existing plugin, update name/scope
```

Every plugin **must** export:
```ts
export const plugin: HarnessPlugin = {
  manifest: { id, version: "1.0.0", apiVersion: "1", kind: [...], entrypoint: "./dist/index.js", capabilities: [...], priority: N },
  register(registry) { ... }
};
export default plugin;
```

Wire it into `.kli/config.ts`:
```ts
export default defineConfig({ plugins: { include: ["./plugins/<name>"] } });
```

## ts-morph Gotchas (backend-ts-morph)

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

`forEachDescendant` is available on `Node` in ts-morph 22 but the callback signature is `(node: Node) => void` — do not add extra params.

## Tree-Sitter Backend

`plugins/backend-tree-sitter/` is a stub. The `tree-sitter` npm package is installed but grammar packages (e.g. `tree-sitter-javascript`) are not. The backend currently detects files and populates `languageStats` but returns an empty graph. Fill in `parseFile()` when grammars are available.

## TypeScript Config Quirks

`tsconfig.base.json` sets `"types": ["node"]` globally. If a plugin needs to opt out (e.g. no Node globals), override in its own `tsconfig.json`:
```json
{"compilerOptions": {"types": []}}
```

## Non-Workspace TypeScript (e.g. .fixtures/)

Directories outside the pnpm workspace (like `.fixtures/integration/`) need their own `tsconfig.json` with `"types": ["node"]` **and** their own `package.json` declaring `@types/node` as a devDependency. They are not covered by the root workspace — run `npm install` inside them separately.
