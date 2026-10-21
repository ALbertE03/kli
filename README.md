# kliccode · KLI

Harness agéntico con **API HTTP** (FastAPI) y una **TUI de terminal** (Textual)
que habla con esa API. El CLI es un cliente puro: no importa el runtime, así que
puede conectarse a un servidor remoto con `KLI_API_URL`.

```
┌─ API (FastAPI) ─────────────────┐       ┌─ KLI (Textual) ───────────────┐
│  POST /api/v1/chat/stream  (SSE) │◄─────►│  chat con streaming en vivo   │
│  POST /api/v1/chat/resume  (SSE) │       │  contexto lateral en vivo     │
│  POST /api/v1/chat/cancel        │       │  tools legibles (no dicts)    │
│  GET  /api/v1/registry           │       │  razonamiento plegable       │
│  GET  /api/v1/config             │       │  aprobaciones humano-a-huma  │
│  GET  /api/v1/threads …          │       │  paleta de comandos (ctrl+p) │
└───────────────────────────────────┘       └───────────────────────────────┘
```

## Arranque rápido

### Local

```bash
uv sync                 # dependencias (crea .venv)
cp .env.example .env    # y rellena OPENAI_API_KEY o ANTHROPIC_API_KEY
make dev                # API en http://127.0.0.1:8000
make cli                # el TUI (o: uv run kliccode)
```

### Docker (todo montado)

```bash
docker compose up --build      # API en http://127.0.0.1:8000
```

`docker compose up` levanta la API con **todo montado desde el host**:

| volumen | para qué |
|---|---|
| `./data` → `/app/data` | base de datos, checkpoints y memoria |
| `./workspace` → `/app/workspace` | workspace por defecto del agente |
| `./projects` → `/app/projects` | proyectos (sandbox por carpeta) |
| `./src` → `/app/src` | el código, para develops en caliente |
| `./README.md` → `/app/README.md` | requerido por el build del paquete |

El `.env` se carga con `env_file` (claves, modelo, backends). Para importar
carpetas del host, descomenta el volumen de ejemplo y añade la ruta a
`PROJECTS_IMPORT_ROOTS`.

El TUI también corre dentro del contenedor:

```bash
docker compose run --rm cli        # abre KLI contra la API del compose
```

Variables del cliente (en el host o dentro del contenedor):

| variable | por defecto | para qué |
|---|---|---|
| `KLI_API_URL` | `http://127.0.0.1:8000` | servidor al que conectarse |
| `KLI_USER` | `anonymous` | cabecera `X-User-Id` |
| `KLI_API_KEY` | — | `Authorization: Bearer` si el server exige `API_KEYS` |

## El CLI

```
◆ KLI  agentic harness        ● http://127.0.0.1:8000 · user alberto · v0.1.0
┌ contexto ─────────┐┌ conversación ───────────────────────────────┐
│ MODO              ││                                              │
│  ◆ build          ││  ▌corre los tests de la api y dime…          │
│ SKILLS            ││                                              │
│  ✓ investigacion  ││  ▶ 🧠 razonamiento                            │
│  · depuracion     ││                                              │
│ PROYECTO          ││  ▼ ✓ terminal  listo                         │
│  ◆ workspace      ││    $ uv run pytest -q tests/test_api.py       │
│ MODELO            ││    ........                     [100%]        │
│  anthropic/sonnet ││    8 passed in 9.93s                          │
│ HERRAMIENTAS      ││                                              │
│  21  read:12 …    ││  ▼ ✓ code_search  listo                      │
│ TOKENS            ││    pattern      def create_app                │
│  in 1842  out 96  ││    glob         *.py                         │
└───────────────────┘│                                              │
                     │ > Escribe tu mensaje…   /help                │
                     └──────────────────────────────────────────────┘
```

- **Streaming en vivo**: tokens del assistant, razonamiento plegable (`🧠`),
  tarjetas de tool con argumentos legibles (nunca un volcado de dict) y la
  salida, con contador de tokens.
- **Aprobaciones**: cuando el agente pide permiso, aparece una tarjeta con la
  tool y sus argumentos → *Aprobar* / *Rechazar* → la ejecución continúa.
- **Contexto lateral**: modo, skills activas, proyecto, modelo, tools por
  categoría y tokens de la conversación.
- **Paleta de comandos** (`ctrl+p`): modos, skills, proyectos y acciones.

### Atajos

| atajo | acción |
|---|---|
| `ctrl+p` | paleta de comandos |
| `ctrl+n` | hilo nuevo |
| `ctrl+l` | limpiar la pantalla |
| `esc` | detener la respuesta en curso |
| `ctrl+q` | salir |
| `enter` | enviar · en la paleta, elegir |

### Comandos

| comando | qué hace |
|---|---|
| `/help` | ayuda |
| `/mode <plan\|build>` | cambia el modo de trabajo |
| `/skill <nombre>` | activa o desactiva una skill |
| `/skills` | lista las skills |
| `/model <modelo>` | fija el modelo (`auto` para el de por defecto) |
| `/provider <nombre>` | cambia de proveedor |
| `/project <nombre\|none>` | fija el proyecto activo |
| `/projects` | lista los proyectos |
| `/tools` | lista las herramientas por categoría |
| `/threads` | lista los hilos guardados |
| `/new` · `/clear` · `/quit` | hilo nuevo · limpiar · salir |

## API

Base: `/api/v1` (todo acepta `X-User-Id` y, si hay `API_KEYS`, `Authorization: Bearer`).

| endpoint | qué hace |
|---|---|
| `GET /health` | estado y versión |
| `GET /api/v1/config` | capacidades del servidor (versión, proveedor, límites) |
| `GET /api/v1/registry` | modos, skills, tools, MCP, proveedores y proyectos |
| `POST /api/v1/chat/stream` | mensaje del usuario → stream SSE |
| `POST /api/v1/chat/resume` | reanuda un hilo pausado (aprobación) |
| `POST /api/v1/chat/cancel` | corta la generación en curso |
| `GET /api/v1/threads` · `GET /api/v1/threads/{id}/messages` | historial |
| `DELETE /api/v1/threads/{id}` | borra un hilo |
| `GET /api/v1/models?provider=` | modelos de un proveedor |
| `GET/POST/DELETE /api/v1/projects` | proyectos (sandbox por carpeta) |
| `GET/POST/DELETE /api/v1/skills` | skills y subagentes del usuario |
| `GET/POST/DELETE /api/v1/providers` | proveedores de modelos |
| `GET/POST/DELETE /api/v1/mcp` · `/api/v1/tools/http` | MCP y tools HTTP |
| `GET/DELETE /api/v1/memories` | memoria a largo plazo |

Eventos del stream SSE: `meta`, `token`, `reasoning`, `tool_start`, `tool_end`,
`tool_error`, `usage`, `interrupt`, `error`, `done`.

```bash
curl -N http://127.0.0.1:8000/api/v1/chat/stream \
  -H 'Content-Type: application/json' -H 'X-User-Id: alice' \
  -d '{"message": "hola", "mode": "plan", "skills": []}'
```

## Configuración

Todo se configura por variables de entorno o `.env` (ver `.env.example`).
Lo imprescindible:

| variable | para qué |
|---|---|
| `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` | credenciales del proveedor |
| `SECRET_KEY` | clave Fernet (32 bytes url-safe base64) para cifrar lo que se guarda. Genera una con `python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"` |
| `CHECKPOINT_BACKEND` · `STORE_BACKEND` | `memory` \| `sqlite` \| `postgres` |
| `ENABLE_EXEC` | habilita `terminal`, `python_repl` y `run_tests` (aprobación humana) |
| `API_KEYS` | `clave1:alice,clave2:bob`; vacío = desarrollo, el usuario va por cabecera |

## Desarrollo

```bash
make install     # uv sync
make dev         # API con --reload
make cli         # TUI
make test        # pytest
make lint        # ruff
make typecheck   # mypy
```

## Estructura

```
src/api/       servidor FastAPI (rutas, esquemas, SSE)
src/harness/   kernel, registro, memoria, plugins, streaming, storage
src/cli/       TUI de Textual (cliente HTTP, widgets, tema, comandos)
tests/         pytest (API, CLI, harness)
```

## Licencia

MIT.
