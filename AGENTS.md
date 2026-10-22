# AGENTS.md — kliccode (KLI)

Harness agéntico: API FastAPI + TUI Textual. **El código, los comentarios y la documentación están en español: escribe en español.**

## Estructura (tres paquetes dentro de `src/`, no `src/kliccode`)

| paquete | qué es | entrypoint |
|---|---|---|
| `src/api` | servidor FastAPI, rutas en `api/routes/`, prefijo `/api/v1` | `api.main:app` |
| `src/harness` | núcleo: registro, kernel, streaming, storage, memoria, plugins | — |
| `src/cli` | TUI de Textual | `cli.app:main` → binario `kliccode` |

- `src/cli` **no importa `harness`**: es cliente puro de la API (SSE en `POST /api/v1/chat/stream`).
- `pytest` pone `src` en el path (`pyproject.toml`), así que los imports son `from api...`, `from harness...`, `from cli...`.

## Comandos

```bash
make install     # uv sync
make dev         # API en http://127.0.0.1:8000 (uvicorn api.main:app --reload --app-dir src)
make cli         # TUI
make lint        # ruff check src tests
make typecheck   # mypy src
make test        # pytest -q
```

- Un test suelto: `uv run pytest tests/test_cli.py::test_x -q`.
- Sin red: `uv run --offline …` o directamente `.venv/bin/python -m pytest -q`.
- **Orden de verificación: lint → typecheck → test.**
- **`make typecheck` (`mypy src`) está en rojo de base**: 7 errores preexistentes en `src/harness` (providers, models, memory, mcp/manager, plugins/tools). No son tuyos: `mypy src/cli` sí pasa limpio. No los "arregles" de paso, pero no los ignores al final.
- **`ruff format` no se usa** (38 de 60 ficheros se reformatarían): no lo ejecutes ni lo añadas a CI.
- No hay `[tool.ruff]`/`[tool.mypy]`: ambos usan sus defaults (mypy **no** es strict).
- `.github/workflows/ci.yml` es una plantilla de Node/pnpm que **no corresponde a este repo Python**: ignórala y no la "arregles".
- `uv.lock` existe en local pero está en `.gitignore` (`*.lock`).

## Tests

- `tests/conftest.py` aísla todo (tmpdir, backends `memory`, `API_KEYS=""`, `HARNESS_ENV=dev`): los tests no tocan tus datos.
- `tests/test_api.py` usa `TestClient(create_app())`; el fixture `client` es de módulo.
- `tests/test_cli.py` simula el stream SSE con `FakeClient`; el helper `_run()` da **un event loop nuevo por test**.
- **La TUI se conecta al servidor al montarse** (`on_mount` → `connect()`): en tests y scripts hay que inyectar el cliente falso **antes** de `run_test`, o intenta hablar con el servidor real.

## Harness

- `src/harness/plugins/**` se autoregistra: `load_plugins()` importa cada módulo al arrancar y cada uno llama a `registry.add_tool/add_skill/add_mode`. Para añadir una tool/skill/modo: crea el módulo en `plugins/` y autoregístrate — no hay lista que actualizar.
- Nombres de tool **reservados por deepagents** (registrarlos da conflicto): `task, write_todos, ls, read_file, write_file, edit_file, glob, grep, execute`.
- Un subagente nunca recibe más permisos que el modo activo; con proyecto, las tools de fs/terminal se confinan a su raíz (`_scope_project` en `kernel.py`).
- `harness/streaming.py` atribuye cada evento a su subagente: la tool `task` con `subagent_type` en el input hace que sus eventos hijos lleven `agent=<nombre>`.
- **El razonamiento se perdía**: el `ChatOpenAI` de LangChain tira los campos del delta que no conoce (`delta.reasoning_content` de los proxies). `harness/models.py` define `KliChatOpenAI`, que los rescata a `additional_kwargs`; `utils.split_chunk` los lee (bloques `reasoning`/`thinking` y los `summary` del API de Responses).
- `REASONING_EFFORT` (vacío = no mandar) **cambia de endpoint**: con valor, el harness usa el **API de Responses** (`reasoning={"effort":…, "summary":"auto"}`), que es el único que transmite el pensamiento (eventos `response.reasoning_summary_text.delta` → bloque `{"type":"reasoning","summary":[…]}`). Sin valor, se usa chat completions y solo se ve si el proxy manda `delta.reasoning_content`.
- `HARNESS_ENV=prod` exige `API_KEYS`; sin ellas (dev) el usuario va por la cabecera `X-User-Id`.

## CLI: reglas de la interfaz

- **Acromática**: solo blanco/negro/gris. Un estado se marca por **forma** (peso, glifo, inversión), nunca por color.
- **Sin emojis**: solo símbolos de texto monocromos (`◆ ✓ ✗ ▸ ▾ ● ○`).
- **Un solo lenguaje de formas** (no introduzcas otros glifos al azar): `▌` usuario · `◆` agente · `◐` en curso · `✓` listo · `✗` error · `·` aviso del sistema · `▶`/`▼` plegable · `⠋⠙⠹…` spinner. El chat usa un rail de 2 columnas (marca a la izquierda, contenido a la derecha).
- El usuario viaja en `X-User-Id` (por defecto `anonymous`; lo cambian `KLI_USER` o `--user`, y en caliente `/user`). Con `API_KEYS` en el servidor manda la clave Bearer y el usuario lo decide el servidor (la cabecera se ignora).
- Los errores se emiten con `add_error(titulo, detalle, pistas)` / `add_api_error(exc, accion)`: **un error siempre dice qué hacer**. Los hints por código HTTP están en `_api_hints()`.
- Autocompletado: `CommandSuggester` (comandos + argumentos) + `Prompt.accept_suggestion` liga `tab`; la lista de comandos vive en `KliApp.SLASH_COMMANDS` (no en `App.COMMANDS`, que es de Textual).

## Gotchas de Textual 8.2.8 (comprobados)

- `App._flush` ya existe: no lo redefinas (usa `_flush_conversation`).
- `Widget._name` está reservado (es el `name` del widget): usa `_agent_name`.
- `mount()` sobre un widget **no montado** lanza `MountError`: monta primero el panel (`await panes.add_content(pane)`) y después sus hijos.
- `ContentSwitcher` exige ids únicos y un hijo recién añadido queda oculto hasta que cambia `current`.
- `Static` recibe `Click`: úsalo para los avisos clicables.
- `Static` con `height: N` incluye borde y padding: con `border-bottom` necesitas `height: 2` para una fila de contenido.
- El widget `Markdown` de Textual **hay que montarlo antes de actualizarlo** (`await chat.mount(panel)`): si actualizas sin montar, el `AwaitComplete` falla en silencio y el panel queda vacío. Además reparsea el documento entero en cada `update()` → no atualices por token (usa `ReasoningPanel.append`, que regula a 8 veces/s).
- `MarkdownBody.set_markdown()` pinta en un worker: si el widget no está montado el worker no arranca y el texto se pierde. Monta siempre antes de actualizar (`await chat.mount(card)` en el `tool_start`).
- El orden del chat lo marca el *cuándo* se monta cada cosa: la respuesta se monta con el primer texto (así queda detrás de las tools), el razonamiento y las tools cuando llegan.
- `LoadingIndicator` de Textual trae `width: 100%`: dentro de un `Horizontal` se come la fila (fíjala con `#status LoadingIndicator { width: 2; }`).
- No uses `Table.grid(expand=True)` con columnas `ratio` para una cabecera: Rich reparte el ancho de forma que las celdas se parten en dos líneas. Para cabecera usa dos `Static` en un `Horizontal` (`#brand` auto + `#conn` 1fr con `text-overflow: ellipsis`).

## Estilo

- Comentarios y docstrings en español, concisos; explica el **porqué**, no el qué.
- El servidor y el CLI comparten el vocabulario de la API: los mensajes del CLI suelen mencionar el endpoint que se está usando.
