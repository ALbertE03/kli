# klicode · KLI

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
make cli                # el TUI (o: uv run klicode)
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
| `$HOME` → `/host` | tu home del host, para importar carpetas existentes |

El `.env` se carga con `env_file` (claves, modelo, backends). Ojo: el formato de
`env_file` de Docker **no admite comentarios en línea**, así que en el `.env`
pon los comentarios en su propia línea (si no, el valor llega con el comentario
dentro y rompe la configuración). Para importar carpetas del host, descomenta el
volumen de ejemplo y añade la ruta a `PROJECTS_IMPORT_ROOTS`.

El TUI también corre dentro del contenedor:

```bash
docker compose run --rm cli          # abre KLI contra la API del compose
docker compose run --rm cli --help   # opciones del CLI
```

### Dónde se ve cada cosa

| cosa | dónde |
|---|---|
| **Swagger / OpenAPI** | <http://localhost:8000/docs> (interactivo) · `/redoc` · `/openapi.json` |
| **API** | <http://localhost:8000> (JSON + SSE) |
| **El CLI** | **es de terminal, no web**: se ve en tu terminal. `make cli` o `docker compose run --rm cli` |

Variables del cliente (en el host o dentro del contenedor):

| variable | por defecto | para qué |
|---|---|---|
| `KLI_API_URL` | `http://127.0.0.1:8000` | servidor al que conectarse |
| `KLI_USER` | `anonymous` | cabecera `X-User-Id` |
| `KLI_API_KEY` | — | `Authorization: Bearer` si el server exige `API_KEYS` |

También por línea de comandos: `klicode --url http://servidor:8000 --user ana`.

El CLI **lee el `.env` del proyecto** (si existe), así que ahí puedes dejar
`KLI_USER`, `KLI_API_URL` y `KLI_API_KEY` sin repetirlo cada vez.

## El CLI

```
  ◆ klicode  agentic harness    ● http://127.0.0.1:8000 · user anonymous · v0.1.0
────────────────────────────────────────────────────────────────────────────────────
                               │   chat
                               │────────────────────────────────────────────────────
 ┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈    │
 MODO                          │
   ◆ build                     │  ▌ corre los tests de la api y dime
                               │
 ┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈    │  ◆ assistant
 SKILLS                        │     ▶ razonamiento
   ✓ investigacion             │  ╭──────────────────────────────────────────╮
   · depuracion                │  │  ▼ ✓ terminal · listo                    │
                               │  │    $ pytest -q tests/test_api.py         │
 ┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈    │  │                                          │
 PROYECTO                      │  │  ........                     [100%]     │
   ◆ workspace por defecto     │  │  8 passed in 9.93s                       │
                               │  │                                          │
 ┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈    │  ╰──────────────────────────────────────────╯
 MODELO                        │
   anthropic / sonnet          │
                               │
 ┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈    │  ╭──────────────────────────────────────────────╮
 HERRAMIENTAS                  │  │❯  Escribe tu mensaje…   (/help)              │
   2  exec:1 · read:1          │  ╰──────────────────────────────────────────────╯
                               │
  ┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈    │
  WEB                           │
    ○ búsqueda web              │
                                │
● pensando…                                                hilo t1   ○ web
```

- **Streaming en vivo**: tokens del assistant, razonamiento plegable (`▶`),
  tarjetas de tool con argumentos legibles (nunca un volcado de dict) y la
  salida, con contador de tokens.
- **Markdown en vivo**: la respuesta, el razonamiento y la salida de las tools
  se dibujan como markdown (títulos, negritas, listas, tablas y bloques de
  código) mientras llegan, no en crudo al final.
- **Flujo de chat como el de un editor**: usuario → razonamiento → tools →
  respuesta, con cada llamada resumida en una línea (`✓ terminal  pytest -q`)
  y el detalle debajo.
- **El pensamiento se ve siempre**: el razonamiento del modelo llega al
  cliente (los proxies OpenAI-compatible lo mandan en `delta.reasoning_content`)
  y se muestra desplegado, sin cajas ni distractions.
- **Pantalla de inicio**: el logo `klicode` en grande, centrado, con una letra
  que late; al escribir, el chat empieza limpio.
- **Aprobaciones**: cuando el agente pide permiso, aparece una tarjeta con la
  tool y sus argumentos → *Aprobar* / *Rechazar* → la ejecución continúa.
- **Errores con salida**: un error nunca es una línea muerta: dice qué pasó, el
  código que devolvió el servidor y **qué hacer** (`401` → credenciales,
  `404` → no existe, `429` → espera, `5xx` → mira los logs).
- **Contexto lateral**: modo, skills activas, proyecto, modelo, tools por
  categoría, estado de la búsqueda web y tokens de la conversación.
- **Búsqueda web apagada de serie**: `web_search` y `deep_search` no se cargan
  en el prompt hasta que las pides (`/web` o la pastilla `○ web` de la barra
  inferior): se ahorran tokens de entrada en cada mensaje.
- **Paleta de comandos** (`ctrl+p`): modos, skills, proyectos y acciones.
- **Autocompletado** (`tab`): completa comandos (`/mo` → `/mode`) y sus
  argumentos (`/mode ` → `plan`, `/skill ` → `investigacion`); repetido,
  recorre las opciones.
- **Un solo lenguaje de formas** (todo en grises, el color nunca decide):
  `▌` tú · `◆` agente · `◐` en curso · `✓` listo · `✗` error · `·` aviso ·
  `▶` plegable. Las pestañas son pastillas y la activa va invertida.
- **Ventanas de subagente**: cuando el agente lanza un subagente, se abre su
  propia pestaña (arriba, junto a `chat`). En la conversación original queda
  un aviso con spinner: al pulsarlo saltas a esa ventana, que hasta entonces
  permanece cerrada. Cada subagente habla en su ventana: su texto, su
  razonamiento y sus tools.

### Atajos

| atajo | acción |
|---|---|
| `tab` | completa el comando o su argumento (repetido, recorre opciones) |
| `ctrl+p` | paleta de comandos |
| `ctrl+n` | hilo nuevo |
| `ctrl+l` | limpiar la pantalla |
| `esc` | detener la respuesta en curso |
| `ctrl+q` | salir |
| `enter` | enviar · en la paleta, elegir |

### Comandos

El CLI es un cliente completo de la API: **todo lo que hace la API se hace desde
aquí**, y cada mensaje indica el endpoint que se está usando.

**Conversación**

| comando | endpoint |
|---|---|
| `/mode <plan\|build>` | `POST /api/v1/chat/stream` (`mode`) |
| `/model <modelo\|auto>` | `POST /api/v1/chat/stream` (`model`) |
| `/provider <nombre>` | `POST /api/v1/chat/stream` (`provider`) |
| `/skill <nombre>` | `POST /api/v1/chat/stream` (`skills`) |
| `/web` | `POST /api/v1/chat/stream` (`opt_in`) |
| `/project <nombre\|none>` | `POST /api/v1/chat/stream` (`project`) |
| `/user [nombre]` | cabecera `X-User-Id` |
| `/new` · `/clear` · `/quit` | — |

**Búsqueda web** (apagada hasta que la pides)

`web_search` y `deep_search` son tools **opt-in**: el servidor no las carga en el
prompt mientras no las actives, así que sus esquemas no gastan tokens de entrada
en cada mensaje. Se encienden con `/web on`, con la pastilla `web` de la barra
inferior (`○` apagada · `●` encendida) o automáticamente al activar una skill
que las necesita (`investigacion`). El estado se ve también en el panel lateral.

```bash
/web            → estado y explicación
/web on         → el chat empieza a mandar opt_in: ["web_search", "deep_search"]
/web off        → vuelven a quedar fuera del prompt
```

**Si no ves el razonamiento**

El pensamiento del modelo llega al TUI como un bloque plegable (*razonamiento*).
Si no aparece, el problema casi nunca es la TUI: es que el proveedor no lo manda.
El servidor avisa en su log cuando el modelo debía razonar y no dice nada, y
dice **qué bloques llegaron**:

```
WARNING  El modelo no ha enviado razonamiento (REASONING_EFFORT=low).
         Bloques vistos: text. Con el API de Responses debe mandar
         `response.reasoning_summary_text.delta`; con chat completions,
         `delta.reasoning_content`.
```

Según lo que diga el log:

| situation | qué hacer |
|---|---|
| `Bloques vistos: text` | el proveedor no manda el razonamiento: usa `REASONING_API=chat` si tu proxy manda `delta.reasoning_content` (DeepSeek, OpenRouter, Ollama…) |
| `Bloques vistos: reasoning` | el razonamiento llegó, pero sin texto: el resumen viene vacío (el proveedor no lo rellena) |
| no hay aviso en el log | el razonamiento llegó y se pintó: mira el panel *razonamiento* (puede estar plegado) |

**Proyectos** (el workspace del agente)

| comando | endpoint |
|---|---|
| `/projects` | `GET /api/v1/registry` |
| `/project create <nombre>` | `POST /api/v1/projects` → carpeta **nueva** en el workspace del servidor |
| `/project import <nombre> <ruta>` | `POST /api/v1/projects` → usa una carpeta **existente tal cual** |
| `/project browse [ruta]` | `GET /api/v1/projects/browse` → lista carpetas para elegir |
| `/project <nombre>` | activa el proyecto para el chat |
| `/project delete <nombre>` | `DELETE /api/v1/projects/{nombre}` |

Ejemplo real (carpeta del host `~/mi-repo` con `src/`, `docs/` y `README.md`):

```
/project browse /host                      → lista tus carpetas
/project import mi_repo /host/mi-repo      → esa carpeta ES el workspace del proyecto
/project mi_repo                           → el agente trabaja dentro de ella
```

Al importar, el proyecto apunta a la carpeta original (no se copia nada): las
tools `fs_*` quedan encerradas ahí, así que el agente **lee y escribe en tus
ficheros reales**. Solo se pueden importar carpetas dentro de
`PROJECTS_IMPORT_ROOTS` (el CLI te las muestra en `/projects` y en el error si
la ruta está fuera).

En Docker tu `$HOME` queda montada en `/host`, así que cualquier carpeta tuya se
importa con `/project import <nombre> /host/ruta/a/la/carpeta`. Para montar otra
raíz: `KLI_HOST_DIR=/ruta/que/quieras docker compose up`.

**Qué queda confinado y qué no**: las tools `fs_*` sí lo están (no salen de la
raíz del proyecto). `terminal` y `python_repl` ejecutan en el **host**: su
directorio de trabajo es la raíz del proyecto, pero el proceso ve la máquina
entera. En `HARNESS_ENV=prod` no se registran salvo `ALLOW_UNSANDBOXED_EXEC=true`,
y la tarjeta de aprobación lo dice antes de que ejecutes nada.

**Skills**

| comando | endpoint |
|---|---|
| `/skills` | `GET /api/v1/registry` |
| `/skill create <nombre> "<desc>" "<instrucciones>" [--tools a,b]` | `POST /api/v1/skills` |
| `/skill delete <nombre>` | `DELETE /api/v1/skills/{nombre}` |

**Proveedores y modelos**

| comando | endpoint |
|---|---|
| `/providers` | `GET /api/v1/registry` |
| `/provider create <nombre> <openai\|anthropic> [url] [modelo] [clave]` | `POST /api/v1/providers` |
| `/provider delete <nombre>` | `DELETE /api/v1/providers/{nombre}` |
| `/models [proveedor]` | `GET /api/v1/models?provider=` |

**Herramientas propias**

| comando | endpoint |
|---|---|
| `/tools` | `GET /api/v1/registry` |
| `/http` | `GET /api/v1/tools/http` |
| `/http add <nombre> "<desc>" <url> [host]` | `POST /api/v1/tools/http` |
| `/http delete <nombre>` | `DELETE /api/v1/tools/http/{nombre}` |
| `/mcp` | `GET /api/v1/mcp` |
| `/mcp add <nombre> <url>` | `POST /api/v1/mcp` |
| `/mcp delete <nombre>` | `DELETE /api/v1/mcp/{nombre}` |

**Memoria e hilos**

| comando | endpoint |
|---|---|
| `/memories` | `GET /api/v1/memories` |
| `/memory delete <clave>` | `DELETE /api/v1/memories/{clave}` |
| `/threads` | `GET /api/v1/threads` |
| `/thread open <id>` | `GET /api/v1/threads/{id}/messages` |
| `/thread delete <id>` | `DELETE /api/v1/threads/{id}` |

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
| `OPENAI_MODEL` / `ANTHROPIC_MODEL` | modelo por defecto (p. ej. `gpt-6-luna`) |
| `TEMPERATURE` | vacío = **no mandarlo** (gpt-6-luna y otros modelos lo rechazan) |
| `REASONING_EFFORT` | `low`\|`medium`\|`high`; vacío = no mandarlo. Con valor se usa el API de Responses y el cliente muestra el resumen del pensamiento |
| `REASONING_API` | `responses`\|`chat`; por dónde se pide el razonamiento. `chat` es para los proxies que no implementan el API de Responses (mandan `delta.reasoning_content`) |
| `SECRET_KEY` | clave Fernet (32 bytes url-safe base64) para cifrar lo que se guarda. Genera una con `python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"` |
| `CHECKPOINT_BACKEND` · `STORE_BACKEND` | `memory` \| `sqlite` \| `postgres` |
| `ENABLE_EXEC` | habilita `terminal`, `python_repl` y `run_tests` (aprobación humana) |
| `ALLOW_UNSANDBOXED_EXEC` | en `HARNESS_ENV=prod` hace falta para registrar el exec: **no está aislado** (solo el directorio de trabajo queda confinado a la raíz del proyecto) |
| `API_KEYS` | `clave1:alice,clave2:bob`; vacío = desarrollo, el usuario va por cabecera |
| `KLI_USER` | usuario que manda el CLI en `X-User-Id` (por defecto `anonymous`) |
| `KLI_API_URL` · `KLI_API_KEY` | a qué servidor se conecta el CLI y con qué clave |

### Por qué sale `anonymous`

El CLI manda la cabecera `X-User-Id` y, si no le dices otra cosa, vale
`anonymous` (el servidor la usa para separar hilos, memoria, skills y
proyectos de cada usuario). Se cambia de tres maneras:

```bash
KLI_USER=tu-usuario make cli      # al arrancar
klicode --user tu-usuario        # en la línea de comandos
```

y en caliente, desde la conversación:

```
/user                 # muestra con qué usuario estás
/user tu-usuario     # cambia el usuario de las siguientes peticiones
```

Si el servidor tiene `API_KEYS` configuradas, manda la clave Bearer y el
usuario lo decide el servidor (la cabecera se ignora).

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
