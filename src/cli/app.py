"""KLI: TUI de chat para el harness.

El CLI es un cliente puro de la API: pide el registro, manda mensajes y consume
el stream SSE. No importa nada de `harness` (salvo los tipos del cliente), así
que puede hablar con un servidor remoto sin tocar el código.
"""

from __future__ import annotations

import argparse
import asyncio
import shlex
import sys
import time
from collections.abc import Sequence
from dataclasses import dataclass, field, replace
from typing import Any, ClassVar

from rich.text import Text
from textual import on, work
from textual.app import App, ComposeResult
from textual.binding import Binding
from textual.containers import Container, Horizontal, Vertical, VerticalScroll
from textual.css.query import NoMatches
from textual.screen import ModalScreen
from textual.widgets import ContentSwitcher, Input, OptionList, Static
from textual.widgets.option_list import Option

from cli import __version__, theme
from cli.client import ApiError, HarnessClient, ServerEvent
from cli.config import CliConfig, load_config
from cli.widgets import (
    AgentMessage,
    ApprovalPanel,
    CommandSuggester,
    ContextPanel,
    ErrorNote,
    Prompt,
    ReasoningPanel,
    StatusBar,
    SubagentLoader,
    SystemNote,
    TabChip,
    TabStrip,
    ToolCard,
    TopBar,
    UserMessage,
    WelcomeSplash,
)

__all__ = ["KliApp", "main"]


def _slug(text: str) -> str:
    """Convierte un nombre en un id válido de widget."""
    out = "".join(ch if ch.isalnum() else "-" for ch in text.lower())
    return out.strip("-") or "subagent"


def _api_hints(exc: ApiError) -> list[str]:
    """Pistas según el código de respuesta: un error siempre dice qué hacer."""
    status = exc.status
    if status in (401, 403):
        return [
            "Tu credencial no vale: revisa `KLI_API_KEY` o las `API_KEYS` del servidor.",
            "En modo dev (sin `API_KEYS`) el usuario va en `X-User-Id`: `--user <nombre>`.",
        ]
    if status == 404:
        return ["Ese recurso no existe en el servidor (o no es tuyo)."]
    if status == 409:
        return ["Ya existe algo con ese nombre: bórralo o usa otro."]
    if status == 422:
        return ["Los datos no son válidos: revisa el formato del comando."]
    if status == 429:
        return ["Te has pasado de peticiones: espera un momento y reinténtalo."]
    if status >= 500:
        return ["El servidor ha fallado por su lado: mira sus logs."]
    return []


def _error_hints(text: str) -> list[str]:
    """Pistas según lo que dice el error del servidor."""
    lowered = text.lower()
    if "reasoning_effort" in lowered:
        return [
            (
                "El modelo no acepta `REASONING_EFFORT`: quítalo (o déjalo vacío) en el "
                "`.env` del servidor y vuelve a arrancar la API."
            )
        ]
    if "temperature" in lowered:
        return [
            "El modelo no acepta `TEMPERATURE`: déjalo vacío en el `.env` del servidor."
        ]
    if "context_length" in lowered or "too long" in lowered:
        return [
            "El hilo se ha llenado: empieza uno nuevo con `/new` o reduce lo que mandas."
        ]
    return []


@dataclass
class _Conversation:
    """Estado de una conversación en curso: la principal o la de un subagente."""

    container: VerticalScroll | None = None
    pane_id: str = ""
    label: str = "assistant"
    reply: AgentMessage | None = None
    reasoning: ReasoningPanel | None = None
    text: str = ""
    dirty: bool = False
    last_flush: float = 0.0
    cards: dict[str, ToolCard] = field(default_factory=dict)
    running: bool = False


HELP = """### kliccode · comandos

Todo lo que hace la API se puede hacer desde aquí. Cada comando indica su endpoint.

**Conversación**
| comando | endpoint |
|---|---|
| `/mode <plan\\|build>` | `POST /api/v1/chat/stream` (`mode`) |
| `/model <modelo\\|auto>` | `POST /api/v1/chat/stream` (`model`) |
| `/provider <nombre>` | `POST /api/v1/chat/stream` (`provider`) |
| `/skill <nombre>` | `POST /api/v1/chat/stream` (`skills`) |
| `/project <nombre\\|none>` | `POST /api/v1/chat/stream` (`project`) |
| `/user [nombre]` | cabecera `X-User-Id` |
| `/new` · `/clear` · `/quit` | — |

**Subagentes**
Cuando el agente lanza un subagente se abre una pestaña propia con su conversación.
En el chat principal queda un aviso con spinner: al pulsarlo vas a esa ventana.
La tira de pestañas (arriba) permite saltar entre la conversación y los subagentes.

**Proyectos** (carpetas en el host)
| comando | endpoint |
|---|---|
| `/projects` | `GET /api/v1/registry` |
| `/project create <nombre>` | `POST /api/v1/projects` (carpeta nueva) |
| `/project import <nombre> <ruta>` | `POST /api/v1/projects` (usa esa carpeta tal cual) |
| `/project browse [ruta]` | `GET /api/v1/projects/browse` (listar carpetas) |
| `/project <nombre>` | activa el proyecto para el chat |
| `/project delete <nombre>` | `DELETE /api/v1/projects/{nombre}` |

**Skills**
| comando | endpoint |
|---|---|
| `/skills` | `GET /api/v1/registry` |
| `/skill create <nombre> "<desc>" "<instrucciones>" [tools]` | `POST /api/v1/skills` |
| `/skill delete <nombre>` | `DELETE /api/v1/skills/{nombre}` |

**Proveedores y modelos**
| comando | endpoint |
|---|---|
| `/providers` | `GET /api/v1/registry` |
| `/provider create <nombre> <openai\\|anthropic> [url] [modelo] [clave]` | `POST /api/v1/providers` |
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

Atajos: `ctrl+p` paleta de comandos · `ctrl+n` hilo nuevo · `ctrl+l` limpiar ·
`tab` completa el comando o su argumento · `esc` detener · `ctrl+q` salir.
"""


class PaletteScreen(ModalScreen[str | None]):
    """Paleta de comandos: modos, skills, proyectos y acciones."""

    def __init__(self, items: list[tuple[str, str, str]]) -> None:
        """`items` = [(id, etiqueta, detalle)]."""
        super().__init__()
        self._items = items

    def compose(self) -> ComposeResult:
        with Container(id="palette-bg"), Vertical(id="palette-box"):
            yield Static("ctrl+p  comandos", id="palette-title")
            yield Input(placeholder="escribe para filtrar…", id="palette-input")
            yield OptionList(id="palette-list")
            yield Static("enter aplica · esc cierra", id="palette-hint")

    def on_mount(self) -> None:
        self._fill("")
        self.query_one("#palette-input", Input).focus()

    def _fill(self, query: str) -> None:
        options = self.query_one("#palette-list", OptionList)
        options.clear_options()
        needle = query.strip().lower()
        for ident, label, detail in self._items:
            haystack = f"{label} {detail}".lower()
            if needle and needle not in haystack:
                continue
            # el detalle se recorta: si no, la opción se parte en dos líneas
            short = detail if len(detail) <= 38 else detail[:37] + "…"
            options.add_option(Option(f"{label}  [dim]{short}[/]", id=ident))
        # la primera opción queda seleccionada: se ve de un vistazo por dónde
        # se va a aplicar la acción al pulsar enter
        if options.option_count:
            options.highlighted = 0

    @on(Input.Changed, "#palette-input")
    def _on_change(self, event: Input.Changed) -> None:
        self._fill(event.value)

    @on(OptionList.OptionSelected, "#palette-list")
    def _on_select(self, event: OptionList.OptionSelected) -> None:
        self.dismiss(event.option.id)

    def on_key(self, event: Any) -> None:
        if event.key == "escape":
            event.stop()
            self.dismiss(None)


class KliApp(App[None]):
    """Aplicación de terminal: chat con el agente, con contexto visible."""

    CSS = theme.CSS
    TITLE = "kliccode"
    SUB_TITLE = "agentic harness"
    # el CLI tiene su propia paleta de comandos (ctrl+p): la de Textual se
    # apaga para que no se robe el atajo (su binding es prioritario).
    ENABLE_COMMAND_PALETTE = False

    # Comandos slash: es la lista que usa el autocompletado del prompt.
    SLASH_COMMANDS: ClassVar[tuple[str, ...]] = (
        "/help",
        "/mode",
        "/model",
        "/models",
        "/provider",
        "/providers",
        "/skill",
        "/skills",
        "/project",
        "/projects",
        "/mcp",
        "/http",
        "/memories",
        "/memory",
        "/threads",
        "/thread",
        "/tools",
        "/user",
        "/new",
        "/clear",
        "/quit",
    )

    BINDINGS: ClassVar[list[Binding | tuple[str, str] | tuple[str, str, str]]] = [
        Binding("ctrl+q", "quit", "Salir"),
        Binding("ctrl+p", "palette", "Comandos"),
        Binding("ctrl+n", "new_thread", "Nuevo hilo"),
        Binding("ctrl+l", "clear_chat", "Limpiar"),
        Binding("f1", "help", "Ayuda"),
        Binding("escape", "stop", "Detener", show=False),
    ]

    def __init__(self, config: CliConfig | None = None) -> None:
        super().__init__()
        self.register_theme(theme.TEXTUAL_THEME)
        self.theme = theme.TEXTUAL_THEME.name
        self.config = config or load_config()
        self.client = HarnessClient(self.config)
        self.registry: dict[str, Any] = {}
        self.server: dict[str, Any] = {}
        self.mode = "plan"
        self.skills: set[str] = set()
        self.provider: str | None = None
        self.model: str | None = None
        self.project: str | None = None
        self.thread_id: str | None = None
        self.usage: dict[str, int] = {}
        self._busy = False
        self._main = _Conversation()
        # subagentes: cada uno tiene su propia ventana (pestaña) y su aviso
        # en el chat principal.
        self._subagents: dict[str, _Conversation] = {}
        self._loaders: dict[str, SubagentLoader] = {}
        self._task_runs: dict[str, str] = {}
        self._pane_ids: dict[str, str] = {}
        self._tab = "chat"
        self._welcome: WelcomeSplash | None = None

    # ---------------- propiedades de compatibilidad ----------------
    @property
    def _reply(self) -> AgentMessage | None:
        return self._main.reply

    @_reply.setter
    def _reply(self, value: AgentMessage | None) -> None:
        self._main.reply = value

    @property
    def _reasoning(self) -> ReasoningPanel | None:
        return self._main.reasoning

    @_reasoning.setter
    def _reasoning(self, value: ReasoningPanel | None) -> None:
        self._main.reasoning = value

    @property
    def _cards(self) -> dict[str, ToolCard]:
        return self._main.cards

    @_cards.setter
    def _cards(self, value: dict[str, ToolCard]) -> None:
        self._main.cards = value

    @property
    def _text(self) -> str:
        return self._main.text

    @_text.setter
    def _text(self, value: str) -> None:
        self._main.text = value

    @property
    def _dirty(self) -> bool:
        return self._main.dirty

    @_dirty.setter
    def _dirty(self, value: bool) -> None:
        self._main.dirty = value

    @property
    def _last_flush(self) -> float:
        return self._main.last_flush

    @_last_flush.setter
    def _last_flush(self, value: float) -> None:
        self._main.last_flush = value

    # ---------------- layout ----------------
    def compose(self) -> ComposeResult:
        yield TopBar(id="topbar")
        with Horizontal(id="body"):
            yield ContextPanel(id="context")
            with Vertical(id="chat-col"):
                yield TabStrip(id="tab-strip")
                with ContentSwitcher(id="panes", initial="chat"):
                    yield VerticalScroll(id="chat")
                with Horizontal(id="prompt-row"):
                    yield Static("❯", id="prompt-mark")
                    yield Prompt(
                        id="prompt",
                        placeholder="Escribe tu mensaje…   (tab completa · /help)",
                        suggester=CommandSuggester(self),
                    )
                    yield Static("", id="prompt-note")
        yield StatusBar(id="status")

    async def on_mount(self) -> None:
        self._main.container = self.chat
        self._focus_prompt()
        self.set_status("conectando con el servidor…", theme.STYLE_WARN)
        await self.connect()

    # ---------------- conexiones ----------------
    async def connect(self) -> None:
        try:
            health = await self.client.health()
            self.server = await self.client.server_config()
            self.registry = await self.client.registry()
        except ApiError as exc:
            self.set_status("sin conexión", theme.STYLE_ERR)
            self.query_one(TopBar).set_disconnected("sin conexión")
            self.add_error(
                "No se pudo conectar con el servidor",
                f"`{self.config.base_url}` respondió **{exc.status}**: {exc.detail}",
                [
                    "Arranca la API: `make dev` (o `docker compose up`)",
                    "O apunta a otro servidor: `kliccode --url http://otro:8000`",
                    "Si el servidor pide clave: `kliccode --api-key <clave>`",
                ],
            )
            return
        self.query_one(TopBar).set_connected(
            str(health.get("version", "?")), self.config.base_url, self.config.user
        )
        self.set_status("conectado", theme.STYLE_OK)
        self.refresh_context()
        self._welcome = WelcomeSplash(self.config.base_url, self.config.user)
        self.add_widget(self._welcome)

    # ---------------- chat ----------------
    @property
    def chat(self) -> VerticalScroll:
        return self.query_one("#chat", VerticalScroll)

    @property
    def panes(self) -> ContentSwitcher:
        return self.query_one("#panes", ContentSwitcher)

    @property
    def tabs(self) -> TabStrip:
        return self.query_one("#tab-strip", TabStrip)

    def add_widget(self, widget: Any) -> None:
        try:
            self.chat.mount(widget)
        except NoMatches:  # pragma: no cover - la app ya se está cerrando
            return
        except Exception as exc:  # noqa: BLE001 - nunca debe romper el chat
            self.log.warning("No se pudo montar el widget: %s", exc)
            return
        self.call_after_refresh(self._scroll_to_end)

    def _scroll_to_end(self) -> None:
        try:
            self.chat.scroll_end(animate=False)
        except Exception as exc:  # noqa: BLE001 - el scroll nunca debe romper el chat
            self.log.warning("No se pudo hacer scroll al final: %s", exc)

    def _scroll_pane(self, pane: VerticalScroll) -> None:
        try:
            pane.scroll_end(animate=False)
        except Exception as exc:  # noqa: BLE001 - idem con las ventanas de subagente
            self.log.warning("No se pudo hacer scroll al final: %s", exc)

    def add_system(self, text: str, error: bool = False) -> None:
        self.add_widget(SystemNote(text, error=error))

    def add_error(self, title: str, detail: str = "", hints: Sequence[str] = ()) -> None:
        """Error con salida: qué pasó, el detalle y qué hacer al respecto."""
        self.add_widget(ErrorNote(title, detail, hints))

    def add_api_error(self, exc: ApiError, action: str) -> None:
        """Error de la API con pistas según el código de respuesta."""
        self.add_error(
            f"No se pudo {action}",
            f"El servidor respondió **{exc.status}**: {exc.detail}",
            _api_hints(exc),
        )

    def _drop_welcome(self) -> None:
        """El splash es solo de inicio: al hablar, deja de ocupar pantalla."""
        if self._welcome is not None:
            self._welcome.remove()
            self._welcome = None

    @on(Input.Submitted, "#prompt")
    def _on_submit(self, event: Input.Submitted) -> None:
        text = event.value.strip()
        event.input.value = ""
        if not text:
            return
        if text.startswith("/"):
            self.run_worker(self._command(text))
            return
        if self._busy:
            self.add_system("Hay una respuesta en curso: pulsa `esc` para detenerla.", error=True)
            return
        self.add_widget(UserMessage(text))
        self._turn_worker = self._run_turn(text)

    @work(exclusive=True)
    async def _run_turn(self, text: str) -> None:
        self._busy = True
        self.set_busy(True)
        self.set_status("pensando…", theme.ACCENT)
        self._drop_welcome()
        # la respuesta se monta cuando llega el primer texto: así queda detrás
        # de las tools, en el orden real de la conversación
        self._reply = None
        self._reasoning = None
        self._text = ""
        self._dirty = False
        self._last_flush = 0.0  # el primer token se pinta al instante
        self._cards = {}
        try:
            async for ev in self.client.stream_chat(self._body(text)):
                await self._handle(ev)
            await self._flush_text(force=True)
        except ApiError as exc:
            self.add_api_error(exc, "enviar el mensaje")
            self.set_status("error", theme.STYLE_ERR)
        except asyncio.CancelledError:
            await self._flush_text(force=True)
            self.add_system("Generación detenida.")
            self.set_status("detenido", theme.STYLE_WARN)
            raise
        finally:
            self._busy = False
            self._settle_turn()

    @work(exclusive=False)
    async def _run_resume(self, decision: dict[str, Any]) -> None:
        if not self.thread_id:
            return
        self._busy = True
        self.set_busy(True)
        self.set_status("reanudando…", theme.ACCENT)
        try:
            async for ev in self.client.stream_resume(self._body(""), decision):
                await self._handle(ev)
        except ApiError as exc:
            self.add_api_error(exc, "reanudar la ejecución")
        except asyncio.CancelledError:
            self.add_system("Reanudación detenida.")
            raise
        finally:
            self._busy = False
            self._settle_turn()

    def _settle_turn(self) -> None:
        """Deja la interfaz como debe quedar al acabar un turno.

        Si la app se está cerrando, los widgets ya no existen: no es un error.
        """
        try:
            self.set_busy(False)
            self.set_status("listo")
            if self._reasoning is not None:
                self._reasoning.flush()
            self._finish_all_subagents()
            self.refresh_context()
            self._focus_prompt()
        except NoMatches:  # pragma: no cover - la app ya se está cerrando
            pass

    def _body(self, message: str) -> dict[str, Any]:
        body: dict[str, Any] = {
            "message": message,
            "mode": self.mode,
            "skills": sorted(self.skills),
        }
        if self.thread_id:
            body["thread_id"] = self.thread_id
        if self.provider:
            body["provider"] = self.provider
        if self.model:
            body["model"] = self.model
        if self.project:
            body["project"] = self.project
        return body

    async def _handle(self, ev: ServerEvent) -> None:
        kind = ev.type
        agent = ev.agent
        if kind == "tool_start" and (ev.name or "") == "task":
            # el agente principal lanza un subagente: se prepara su ventana
            await self._note_task_start(ev)
        if agent:
            await self._handle_subagent(agent, ev)
            return
        if kind == "meta":
            thread = ev.data.get("thread_id")
            if thread:
                self.thread_id = str(thread)
                self.set_right(f"hilo {self.thread_id}")
        elif kind == "token":
            self._text += ev.text
            self._dirty = True
            await self._flush_text()
        elif kind == "reasoning":
            await self._add_reasoning(ev.text)
        elif kind == "tool_start":
            card = ToolCard(ev.name or "tool", ev.agent)
            card.set_args(ev.data.get("payload"))
            key = str(ev.data.get("run_id") or ev.name or len(self._cards))
            self._cards[key] = card
            # hay que esperar al montaje: la tool puede terminar antes de que
            # la tarjeta esté en el DOM y su salida se perdería
            await self.chat.mount(card)
        elif kind in {"tool_end", "tool_error"}:
            run_id = str(ev.data.get("run_id") or "")
            finished = self._cards.get(run_id)
            if finished is not None:
                self._cards.pop(run_id, None)
                if kind == "tool_end":
                    finished.set_done(ev.text)
                else:
                    finished.set_error(ev.text)
            self._note_task_end(ev)
        elif kind == "usage":
            payload = ev.data.get("payload")
            if isinstance(payload, dict):
                self.usage = {k: int(v) for k, v in payload.items() if isinstance(v, (int, float))}
            self.refresh_context()
        elif kind == "interrupt":
            self._show_approvals(ev.data.get("payload"))
        elif kind == "error":
            text = ev.text or "error desconocido en el servidor"
            self.add_error("El agente se ha detenido", text, _error_hints(text))

    # ---------------- subagentes ----------------
    async def _note_task_start(self, ev: ServerEvent) -> None:
        """El agente principal invoca a un subagente (`task`)."""
        payload = ev.data.get("payload")
        sub = payload.get("subagent_type") if isinstance(payload, dict) else None
        if not sub:
            return
        name = str(sub)
        run_id = str(ev.data.get("run_id") or "")
        if run_id:
            self._task_runs[run_id] = name
        await self._ensure_subagent(name)

    def _note_task_end(self, ev: ServerEvent) -> None:
        """El subagente ha terminado (se acaba la llamada `task`)."""
        if (ev.name or "") != "task":
            return
        run_id = str(ev.data.get("run_id") or "")
        name = self._task_runs.pop(run_id, None)
        if name:
            self._finish_subagent(name, error=ev.type == "tool_error")

    async def _ensure_subagent(self, name: str) -> _Conversation:
        """Crea la ventana del subagente y su aviso en el chat principal.

        Es idempotente. La ventana nace *cerrada*: el chat principal sigue a
        la vista y es el aviso (con el spinner) el que lleva a ella al pulsarlo.
        """
        existing = self._subagents.get(name)
        if existing is not None:
            return existing

        pane_id = self._unique_pane_id(name)
        self._pane_ids[name] = pane_id
        state = _Conversation(running=True, pane_id=pane_id, label=f"@{name}")
        self._subagents[name] = state

        self.tabs.add_tab(name, name)
        self.tabs.set_state(name, "run")
        loader = SubagentLoader(name)
        self._loaders[name] = loader
        self.add_widget(loader)

        pane = VerticalScroll(id=pane_id, classes="subagent-pane")
        state.container = pane
        await self.panes.add_content(pane)
        head = Text()
        head.append("◆ ", style=f"bold {theme.ACCENT}")
        head.append(f"subagente {name}", style=f"bold {theme.TEXT_HI}")
        head.append("  ·  ventana propia", style=theme.FAINT)
        await pane.mount(Static(head, classes="subagent-head"))
        return state

    def _unique_pane_id(self, name: str) -> str:
        base = f"pane-{_slug(name)}"
        pane_id = base
        index = 2
        while pane_id in self._pane_ids.values():
            pane_id = f"{base}-{index}"
            index += 1
        return pane_id

    async def _handle_subagent(self, name: str, ev: ServerEvent) -> None:
        """Enruta un evento al subagente que lo originó."""
        state = await self._ensure_subagent(name)
        container = state.container
        if container is None:
            return
        kind = ev.type
        if kind == "token":
            state.text += ev.text
            state.dirty = True
            await self._flush_conversation(state)
        elif kind == "reasoning":
            if state.reasoning is None:
                state.reasoning = ReasoningPanel()
                await container.mount(state.reasoning)
            state.reasoning.append(ev.text)
        elif kind == "tool_start":
            card = ToolCard(ev.name or "tool", name)
            card.set_args(ev.data.get("payload"))
            key = str(ev.data.get("run_id") or ev.name or len(state.cards))
            state.cards[key] = card
            await container.mount(card)
        elif kind in {"tool_end", "tool_error"}:
            run_id = str(ev.data.get("run_id") or "")
            finished = state.cards.get(run_id)
            if finished is not None:
                del state.cards[run_id]
                if kind == "tool_end":
                    finished.set_done(ev.text)
                else:
                    finished.set_error(ev.text)
        elif kind == "error":
            await container.mount(
                SystemNote(f"subagente {name}: {ev.text or 'error'}", error=True)
            )

    def _finish_subagent(self, name: str, error: bool = False) -> None:
        """Marca el subagente como terminado y para su spinner."""
        state = self._subagents.get(name)
        if state is None or not state.running:
            return
        state.running = False
        if state.reasoning is not None:
            state.reasoning.flush()
        try:
            self.tabs.set_state(name, "err" if error else "ok")
        except NoMatches:  # pragma: no cover - la app ya se está cerrando
            pass
        loader = self._loaders.get(name)
        if loader is not None:
            if error:
                loader.set_error()
            else:
                loader.set_done()

    def _finish_all_subagents(self, error: bool = False) -> None:
        for name, state in list(self._subagents.items()):
            if state.running:
                self._finish_subagent(name, error=error)

    def _open_tab(self, key: str) -> None:
        """Muestra la conversación principal o la ventana de un subagente.

        `key` es la clave de la pestaña: `chat` o el nombre del subagente.
        """
        pane_id = "chat" if key == "chat" else self._pane_ids.get(key, key)
        try:
            self.panes.current = pane_id
        except Exception:  # noqa: BLE001 - un id raro no debe romper la app
            return
        self._tab = pane_id
        self.tabs.set_selected(key)
        in_chat = pane_id == "chat"
        self.query_one("#prompt", Input).display = in_chat
        self.query_one("#prompt-mark").display = in_chat
        note = self.query_one("#prompt-note", Static)
        note.display = not in_chat
        if in_chat:
            self._focus_prompt()
        else:
            name = key if key != "chat" else "?"
            note.update(
                Text(
                    f"subagente {name} · «chat» para escribir",
                    style=theme.FAINT,
                )
            )

    def _open_subagent(self, name: str) -> None:
        if name not in self._subagents:
            return
        self._open_tab(name)

    @on(SubagentLoader.Open)
    def _on_loader_open(self, event: SubagentLoader.Open) -> None:
        """El aviso del chat principal lleva a la ventana del subagente."""
        event.stop()
        self._open_subagent(event.name)

    @on(TabChip.Pressed)
    def _on_tab_pressed(self, event: TabChip.Pressed) -> None:
        event.stop()
        if event.key == "chat":
            self._open_tab("chat")
        else:
            self._open_subagent(event.key)

    async def _flush_text(self, force: bool = False) -> None:
        await self._flush_conversation(self._main, force=force)

    async def _flush_conversation(self, state: _Conversation, force: bool = False) -> None:
        if not state.dirty:
            return
        if not force and time.monotonic() - state.last_flush <= 0.08:
            return
        state.dirty = False
        state.last_flush = time.monotonic()
        if state.reply is None:
            # la respuesta se monta con el primer texto: así el chat sigue el
            # orden real (razonamiento → tools → respuesta)
            state.reply = AgentMessage(label=state.label)
            container = state.container
            if container is None:
                return
            await container.mount(state.reply)
        await state.reply.set_text(state.text)
        # el layout cambia al montar el markdown: el scroll va después del refresco
        container = state.container
        if container is None:
            return
        self.call_after_refresh(lambda: self._scroll_pane(container))


    async def _add_reasoning(self, text: str) -> None:
        """Añade razonamiento al panel (markdown en vivo)."""
        if self._reasoning is None:
            self._reasoning = ReasoningPanel()
            # hay que esperar al montaje: si no, el markdown se pierde
            await self.chat.mount(self._reasoning)
        self._reasoning.append(text)

    def _show_approvals(self, payload: Any) -> None:
        requests = payload if isinstance(payload, list) else [payload]
        for request in requests:
            if not isinstance(request, dict):
                continue
            for action in request.get("action_requests", []) or []:
                if not isinstance(action, dict):
                    continue
                panel = ApprovalPanel(
                    str(action.get("name", "tool")),
                    action.get("args", {}),
                    str(action.get("description", "")),
                )
                self.add_widget(panel)
                # el foco pasa a la aprobación: `enter` acepta, `tab` va al otro botón
                self.call_after_refresh(panel.focus_first)

    @on(ApprovalPanel.Approved)
    def _on_approved(self, event: ApprovalPanel.Approved) -> None:
        event.stop()
        self.add_system("Aprobado ✓")
        self._run_resume({"decisions": [{"type": "approve"}]})

    @on(ApprovalPanel.Rejected)
    def _on_rejected(self, event: ApprovalPanel.Rejected) -> None:
        event.stop()
        self.add_system("Rechazado ✗")
        self._run_resume({"decisions": [{"type": "reject", "message": "Rechazado por el usuario"}]})

    # ---------------- contexto ----------------
    def refresh_context(self) -> None:
        try:
            panel = self.query_one(ContextPanel)
        except NoMatches:  # pragma: no cover - la app ya se está cerrando
            return
        modes = {m.get("name"): m.get("description", "") for m in self.registry.get("modes", [])}
        skills = [s.get("name", "") for s in self.registry.get("skills", [])]
        counts: dict[str, int] = {}
        for tool in self.registry.get("tools", []):
            category = str(tool.get("category", "other"))
            counts[category] = counts.get(category, 0) + 1
        panel.update_context(
            {
                "mode": self.mode,
                "modes": modes,
                "skills": self.skills,
                "skill_list": skills,
                "project": self.project,
                "provider": self.provider,
                "model": self.model,
                "default_provider": self.server.get("default_provider"),
                "default_model": self.server.get("default_model"),
                "tool_counts": counts,
                "usage": self.usage,
            }
        )

    def set_status(self, text: str, style: str = theme.DIM) -> None:
        bar = self._status_bar()
        if bar is not None:
            bar.set_status(text, style)

    def set_right(self, text: str, style: str = theme.FAINT) -> None:
        bar = self._status_bar()
        if bar is not None:
            bar.set_right(text, style)

    def set_busy(self, busy: bool) -> None:
        bar = self._status_bar()
        if bar is not None:
            bar.set_busy(busy)

    def _status_bar(self) -> StatusBar | None:
        """La barra de estado, o `None` si la app ya se está cerrando."""
        try:
            return self.query_one(StatusBar)
        except NoMatches:
            return None

    def _focus_prompt(self) -> None:
        """Devuelve el foco al prompt (si la app sigue en pie)."""
        try:
            self.query_one("#prompt", Input).focus()
        except NoMatches:  # pragma: no cover - la app ya se está cerrando
            pass

    # ---------------- comandos ----------------
    async def _command(self, raw: str) -> None:
        """Ejecuta un comando slash. Cada acción dice su endpoint de la API."""
        try:
            parts = shlex.split(raw[1:])
        except ValueError:
            parts = raw[1:].split()
        if not parts:
            return
        cmd, args = parts[0].lower(), parts[1:]

        if cmd in {"help", "?"}:
            self.add_system(HELP)
        elif cmd == "mode":
            await self._cmd_mode(args)
        elif cmd == "user":
            self._cmd_user(args)
        elif cmd == "skill":
            await self._cmd_skill(args)
        elif cmd == "skills":
            self._cmd_skills()
        elif cmd == "provider":
            await self._cmd_provider(args)
        elif cmd == "providers":
            self._cmd_providers()
        elif cmd == "model":
            self._cmd_model(args)
        elif cmd == "models":
            await self._cmd_models(args)
        elif cmd == "project":
            await self._cmd_project(args)
        elif cmd == "projects":
            self._cmd_projects()
        elif cmd == "mcp":
            await self._cmd_mcp(args)
        elif cmd == "http":
            await self._cmd_http(args)
        elif cmd == "memories":
            await self._cmd_memories(args)
        elif cmd == "memory":
            await self._cmd_memory(args)
        elif cmd == "threads":
            await self._cmd_threads(args)
        elif cmd == "thread":
            await self._cmd_thread(args)
        elif cmd == "tools":
            self._cmd_tools()
        elif cmd == "new":
            self._new_thread()
        elif cmd == "clear":
            self._clear_chat()
        elif cmd in {"quit", "exit"}:
            self.exit()
        else:
            self.add_system(f"Comando desconocido: `/{cmd}`. Escribe `/help`.")

    # ---------------- modo ----------------
    async def _cmd_mode(self, args: list[str]) -> None:
        modes = [str(m.get("name")) for m in self.registry.get("modes", [])]
        if not args:
            current = self.mode
            self.add_system(
                "Modos: "
                + ", ".join(f"`{m}`{' ←' if m == current else ''}" for m in modes)
                + "\n\nSe envía en cada mensaje a `POST /api/v1/chat/stream` (`mode`)."
            )
            return
        mode = args[0]
        if mode not in modes:
            self.add_system(f"Modo desconocido: `{mode}`. Disponibles: {', '.join(modes)}", error=True)
            return
        self.mode = mode
        self.refresh_context()
        self.add_system(f"Modo → **{mode}**")

    # ---------------- usuario ----------------
    def _cmd_user(self, args: list[str]) -> None:
        """`/user [nombre]` — muestra o cambia el usuario del cliente."""
        if not args:
            self.add_system(
                f"Usuario: **{self.config.user}**\n\n"
                "Es el valor de la cabecera `X-User-Id` con el que te identifica el "
                "servidor (hilos, memoria, skills y proyectos son por usuario).\n\n"
                "Cambiarlo: `/user <nombre>` · al arrancar: `KLI_USER=<nombre> kliccode` "
                "· `kliccode --user <nombre>`.\n\n"
                "Si el servidor tiene `API_KEYS` configuradas, manda la clave Bearer y "
                "el usuario lo decide el servidor (la cabecera se ignora)."
            )
            return
        user = args[0].strip()
        if not user:
            self.add_system("El usuario no puede estar vacío.", error=True)
            return
        self.config = replace(self.config, user=user)
        self.client.set_user(user)
        self.query_one(TopBar).set_user(user)
        self.add_system(f"Usuario → **{user}**")

    # ---------------- skills ----------------
    async def _cmd_skill(self, args: list[str]) -> None:
        skills = [str(s.get("name")) for s in self.registry.get("skills", [])]
        if not args:
            self._cmd_skills()
            return
        action = args[0].lower()

        if action == "create":
            await self._create_skill(args[1:])
            return
        if action == "delete":
            if len(args) < 2:
                self.add_error(
                    "Falta el nombre de la skill",
                    "Uso: `/skill delete <nombre>`",
                    ["Endpoint: `DELETE /api/v1/skills/{nombre}`"],
                )
                return
            name = args[1]
            try:
                await self.client.delete_skill(name)
            except ApiError as exc:
                self.add_api_error(exc, "borrar la skill")
                return
            self.skills.discard(name)
            await self._reload_registry()
            self.add_system(f"Skill **{name}** borrada → `DELETE /api/v1/skills/{name}`")
            return

        name = action
        if name not in skills:
            self.add_system(f"Skill desconocida: `{name}`.", error=True)
            return
        if name in self.skills:
            self.skills.discard(name)
            self.add_system(f"Skill **{name}** desactivada (se envía en `skills` del chat)")
        else:
            self.skills.add(name)
            self.add_system(f"Skill **{name}** activada (se envía en `skills` del chat)")
        self.refresh_context()

    async def _create_skill(self, args: list[str]) -> None:
        """`/skill create <nombre> "<descripción>" "<instrucciones>" [--tools a,b]`"""
        tool_names: list[str] = []
        if args and args[-1].startswith("--tools="):
            tool_names = [t.strip() for t in args.pop().split("=", 1)[1].split(",") if t.strip()]
        elif "--tools" in args:
            index = args.index("--tools")
            if index + 1 < len(args):
                tool_names = [t.strip() for t in args[index + 1].split(",") if t.strip()]
                del args[index : index + 2]
            else:
                del args[index]
        if len(args) < 3:
            self.add_error(
                "Faltan datos para crear la skill",
                'Uso: `/skill create <nombre> "<descripción>" "<instrucciones>" [--tools a,b]`',
                ["Endpoint: `POST /api/v1/skills`"],
            )
            return
        name = args[0]
        description = args[1]
        instructions = " ".join(args[2:])
        body = {
            "name": name,
            "description": description,
            "instructions": instructions,
            "tool_names": tool_names,
        }
        try:
            await self.client.create_skill(body)
        except ApiError as exc:
            self.add_api_error(exc, "crear la skill")
            return
        await self._reload_registry()
        self.add_system(f"Skill **{name}** creada → `POST /api/v1/skills`")

    def _cmd_skills(self) -> None:
        skills = self.registry.get("skills", [])
        if not skills:
            self.add_system(
                "No hay skills registradas.\n\n"
                'Crea una con `/skill create <nombre> "<descripción>" "<instrucciones>"`'
                " → `POST /api/v1/skills`"
            )
            return
        lines = []
        for skill in skills:
            mark = "✓" if skill.get("name") in self.skills else "·"
            owner = f" _(de {skill.get('owner')})_" if skill.get("owner") else ""
            tools = ", ".join(skill.get("tool_names") or [])
            lines.append(
                f"{mark} **{skill.get('name')}**{owner} — {skill.get('description', '')}"
                + (f"\n  tools: {tools}" if tools else "")
            )
        self.add_system(
            "### Skills\n\n" + "\n".join(lines) + "\n\n`GET /api/v1/registry` · activa con `/skill <nombre>`"
        )

    # ---------------- proveedores ----------------
    async def _cmd_provider(self, args: list[str]) -> None:
        providers = [str(p.get("name")) for p in self.registry.get("providers", [])]
        if not args:
            self._cmd_providers()
            return
        action = args[0].lower()

        if action == "create":
            await self._create_provider(args[1:])
            return
        if action == "delete":
            if len(args) < 2:
                self.add_error(
                    "Falta el nombre del proveedor",
                    "Uso: `/provider delete <nombre>`",
                    ["Endpoint: `DELETE /api/v1/providers/{nombre}`"],
                )
                return
            name = args[1]
            try:
                await self.client.delete_provider(name)
            except ApiError as exc:
                self.add_api_error(exc, "borrar el proveedor")
                return
            if self.provider == name:
                self.provider = None
            await self._reload_registry()
            self.add_system(f"Proveedor **{name}** borrado → `DELETE /api/v1/providers/{name}`")
            return

        name = action
        if name not in providers:
            self.add_system(
                f"Proveedor desconocido: `{name}`. Crea uno con "
                "`/provider create <nombre> <openai|anthropic> [base_url] [modelo] [api_key]`"
                " → `POST /api/v1/providers`",
                error=True,
            )
            return
        self.provider = None if name == "default" else name
        self.refresh_context()
        self.add_system(f"Proveedor → **{self.provider or 'automático'}**")

    async def _create_provider(self, args: list[str]) -> None:
        """`/provider create <nombre> <openai|anthropic> [base_url] [modelo] [api_key]`"""
        if len(args) < 2:
            self.add_error(
                "Faltan datos para crear el proveedor",
                "Uso: `/provider create <nombre> <openai|anthropic> [base_url] [modelo] [api_key]`",
                ["Endpoint: `POST /api/v1/providers`"],
            )
            return
        name, kind = args[0], args[1]
        if kind not in {"openai", "anthropic"}:
            self.add_system("El tipo debe ser `openai` o `anthropic`", error=True)
            return
        body: dict[str, Any] = {"name": name, "kind": kind}
        if len(args) > 2:
            body["base_url"] = args[2]
        if len(args) > 3:
            body["default_model"] = args[3]
        if len(args) > 4:
            body["api_key"] = args[4]
        try:
            await self.client.create_provider(body)
        except ApiError as exc:
            self.add_api_error(exc, "crear el proveedor")
            return
        await self._reload_registry()
        self.add_system(f"Proveedor **{name}** creado → `POST /api/v1/providers`")

    def _cmd_providers(self) -> None:
        providers = self.registry.get("providers", [])
        if not providers:
            self.add_system(
                "No hay proveedores.\n\n"
                "Crea uno con `/provider create <nombre> <openai|anthropic> [base_url] [modelo] [api_key]`"
                " → `POST /api/v1/providers`"
            )
            return
        lines = []
        for provider in providers:
            mark = "◆" if provider.get("name") == self.provider else "·"
            url = provider.get("base_url") or ""
            model = provider.get("default_model") or "—"
            key = "con clave" if provider.get("has_key") else "sin clave"
            lines.append(f"{mark} **{provider.get('name')}** ({provider.get('kind')}) — {model} · {key} {url}".rstrip())
        self.add_system(
            "### Proveedores\n\n" + "\n".join(lines)
            + "\n\n`GET /api/v1/registry` · usa uno con `/provider <nombre>`"
        )

    # ---------------- modelo ----------------
    def _cmd_model(self, args: list[str]) -> None:
        if not args:
            self.add_system(
                f"Modelo actual: **{self.model or self.server.get('default_model')}**\n\n"
                "Se envía en `POST /api/v1/chat/stream` (`model`)."
            )
            return
        model = args[0]
        self.model = None if model in {"auto", "default"} else model
        self.refresh_context()
        self.add_system(f"Modelo → **{self.model or 'automático'}**")

    async def _cmd_models(self, args: list[str]) -> None:
        provider = args[0] if args else self.provider
        try:
            models = await self.client.models(provider)
        except ApiError as exc:
            self.add_api_error(exc, "listar los modelos")
            return
        if not models:
            self.add_system(
                "El proveedor no devolvió modelos.\n\n"
                "Endpoint: `GET /api/v1/models?provider=<nombre>`"
            )
            return
        lines = [f"- `{m}`" for m in models[:60]]
        more = f"\n\n… y {len(models) - 60} más" if len(models) > 60 else ""
        self.add_system(
            f"### Modelos de `{provider or 'default'}`\n\n" + "\n".join(lines) + more
            + "\n\n`GET /api/v1/models?provider=` · fija uno con `/model <modelo>`"
        )

    # ---------------- proyectos ----------------
    async def _cmd_project(self, args: list[str]) -> None:
        projects = [str(p.get("name")) for p in self.registry.get("projects", [])]
        if not args:
            self._cmd_projects()
            return
        action = args[0].lower()

        if action == "create":
            await self._create_project(args[1:])
            return
        if action == "import":
            await self._create_project(args[1:], importing=True)
            return
        if action == "browse":
            await self._browse_projects(args[1:])
            return
        if action == "delete":
            if len(args) < 2:
                self.add_error(
                    "Falta el nombre del proyecto",
                    "Uso: `/project delete <nombre>`",
                    ["Endpoint: `DELETE /api/v1/projects/{nombre}`"],
                )
                return
            name = args[1]
            try:
                await self.client.delete_project(name)
            except ApiError as exc:
                self.add_api_error(exc, "borrar el proyecto")
                return
            if self.project == name:
                self.project = None
            await self._reload_registry()
            self.add_system(f"Proyecto **{name}** borrado → `DELETE /api/v1/projects/{name}`")
            return

        name = action
        if name in {"none", "null", "-"}:
            self.project = None
            self.refresh_context()
            self.add_system("Proyecto → **workspace por defecto**")
            return
        if name not in projects:
            self.add_system(
                f"Proyecto desconocido: `{name}`.\n\n"
                "Crea una carpeta con `/project create <nombre> [ruta]` → `POST /api/v1/projects`",
                error=True,
            )
            return
        self.project = name
        self.refresh_context()
        self.add_system(
                f"Proyecto → **{name}**\n\n"
                "El agente lee y escribe dentro de esa carpeta (las `fs_*` quedan encerradas ahí)."
            )

    async def _create_project(self, args: list[str], importing: bool = False) -> None:
        """`/project create <nombre> [ruta]` · `/project import <nombre> <ruta>`"""
        if importing and len(args) < 2:
            self.add_error(
                "Falta la ruta de la carpeta",
                "Uso: `/project import <nombre> <ruta>`",
                [
                    (
                        "La carpeta se usa tal cual (con todos sus archivos) como workspace "
                        "del proyecto. Tiene que estar dentro de las raíces permitidas."
                    ),
                    "Endpoint: `POST /api/v1/projects`",
                ],
            )
            return
        if not args:
            self.add_error(
                "Falta el nombre del proyecto",
                "Uso: `/project create <nombre> [ruta]`",
                [
                    (
                        "Sin ruta crea una carpeta nueva en el workspace del servidor; "
                        "con ruta usa esa carpeta existente tal cual."
                    ),
                    "Endpoint: `POST /api/v1/projects`",
                ],
            )
            return
        name = args[0]
        path = args[1] if len(args) > 1 else None
        try:
            project = await self.client.create_project(name, path)
        except ApiError as exc:
            hints = _api_hints(exc)
            if exc.status == 403:
                hints.insert(0, f"Raíces permitidas: {self._import_roots_text()}")
            self.add_error(
                "No se pudo crear el proyecto",
                f"El servidor respondió **{exc.status}**: {exc.detail}",
                hints,
            )
            return
        await self._reload_registry()
        root = project.get("root", "")
        self.add_system(
            f"Proyecto **{name}** creado → `POST /api/v1/projects`\n\n"
            f"Workspace: `{root}`\n"
            + (
                "Se usa **tal cual**: el agente lee y escribe dentro de esa carpeta.\n"
                if path
                else "Carpeta nueva en el workspace del servidor.\n"
            )
            + f"Actívalo con `/project {name}`"
        )

    def _import_roots_text(self) -> str:
        roots = self.server.get("projects_import_roots") or []
        if not roots:
            return "(ninguna; amplía PROJECTS_IMPORT_ROOTS en el servidor)"
        return ", ".join(f"`{r}`" for r in roots)

    async def _browse_projects(self, args: list[str]) -> None:
        """`/project browse [ruta]` — lista carpetas para elegir una."""
        path = args[0] if args else None
        try:
            data = await self.client.browse_projects(path)
        except ApiError as exc:
            hints = _api_hints(exc)
            if exc.status == 403:
                hints.insert(0, f"Raíces permitidas: {self._import_roots_text()}")
            self.add_error(
                "No se pudo listar la carpeta",
                f"El servidor respondió **{exc.status}**: {exc.detail}",
                hints,
            )
            return
        current = str(data.get("path", ""))
        dirs = list(data.get("dirs") or [])
        files = list(data.get("files") or [])
        roots = list(data.get("roots") or [])
        lines = [f"**{current}**", ""]
        if dirs:
            lines.append("carpetas:")
            lines += [f"  ▸ `{d}/`" for d in dirs]
        if files:
            lines.append("")
            lines.append(f"ficheros ({len(files)}): " + ", ".join(f"`{f}`" for f in files[:12]))
        if not dirs and not files:
            lines.append("(vacía)")
        lines.append("")
        lines.append("raíces permitidas: " + ", ".join(f"`{r}`" for r in roots))
        lines.append("")
        lines.append(
            f"Impórtala con `/project import <nombre> {current}`"
            if current
            else "Impórtala con `/project import <nombre> <ruta>`"
        )
        self.add_system("### Carpetas\n\n" + "\n".join(lines))

    def _cmd_projects(self) -> None:
        projects = self.registry.get("projects", [])
        projects_dir = self.server.get("projects_dir", "")
        roots = self.server.get("projects_import_roots") or []
        header = "### Proyectos\n\n"
        if not projects:
            header += (
                "No hay proyectos todavía.\n\n"
                f"Workspace del servidor: `{projects_dir}`\n\n"
                "- `/project create <nombre>` → crea una carpeta nueva ahí "
                "(`POST /api/v1/projects`)\n"
                "- `/project import <nombre> <ruta>` → usa una carpeta que ya existe, "
                "con todos sus archivos (`POST /api/v1/projects`)\n"
                "- `/project browse [ruta]` → lista carpetas para elegir "
                "(`GET /api/v1/projects/browse`)\n\n"
                "Raíces permitidas: " + (", ".join(f"`{r}`" for r in roots) or "(ninguna)")
            )
            self.add_system(header)
            return
        lines = []
        for project in projects:
            mark = "◆" if project.get("name") == self.project else "·"
            lines.append(f"{mark} **{project.get('name')}** — `{project.get('root')}`")
        header += "\n".join(lines)
        header += (
            "\n\n`GET /api/v1/registry` · usa uno con `/project <nombre>`"
            + "\nRaíces permitidas: " + (", ".join(f"`{r}`" for r in roots) or "(ninguna)")
        )
        self.add_system(header)

    # ---------------- MCP ----------------
    async def _cmd_mcp(self, args: list[str]) -> None:
        if not args:
            await self._list_mcp()
            return
        action = args[0].lower()
        if action == "add":
            if len(args) < 3:
                self.add_error(
                    "Faltan el nombre y la URL del servidor MCP",
                    "Uso: `/mcp add <nombre> <url>`",
                    ["Endpoint: `POST /api/v1/mcp`"],
                )
                return
            try:
                await self.client.create_mcp({"name": args[1], "url": args[2]})
            except ApiError as exc:
                self.add_api_error(exc, "añadir el servidor MCP")
                return
            await self._reload_registry()
            self.add_system(f"Servidor MCP **{args[1]}** añadido → `POST /api/v1/mcp`")
            return
        if action == "delete":
            if len(args) < 2:
                self.add_error(
                    "Falta el nombre del servidor MCP",
                    "Uso: `/mcp delete <nombre>`",
                    ["Endpoint: `DELETE /api/v1/mcp/{nombre}`"],
                )
                return
            try:
                await self.client.delete_mcp(args[1])
            except ApiError as exc:
                self.add_api_error(exc, "borrar el servidor MCP")
                return
            await self._reload_registry()
            self.add_system(f"Servidor MCP **{args[1]}** borrado → `DELETE /api/v1/mcp/{args[1]}`")
            return
        await self._list_mcp()

    async def _list_mcp(self) -> None:
        try:
            servers = await self.client.list_mcp()
        except ApiError as exc:
            self.add_api_error(exc, "listar los servidores MCP")
            return
        if not servers:
            self.add_system(
                "No hay servidores MCP.\n\n"
                "Añade uno con `/mcp add <nombre> <url>` → `POST /api/v1/mcp`"
            )
            return
        lines = []
        for server in servers:
            tools = ", ".join(server.get("tools") or [])
            lines.append(
                f"· **{server.get('name')}** ({server.get('transport')}) — {server.get('status')}"
                + (f"\n  tools: {tools}" if tools else "")
            )
        self.add_system("### Servidores MCP\n\n" + "\n".join(lines) + "\n\n`GET /api/v1/mcp`")

    # ---------------- tools HTTP ----------------
    async def _cmd_http(self, args: list[str]) -> None:
        if not args:
            await self._list_http_tools()
            return
        action = args[0].lower()
        if action == "add":
            if len(args) < 4:
                self.add_error(
                    "Faltan datos para crear la tool HTTP",
                    'Uso: `/http add <nombre> "<descripción>" <url> [host[,host]]`',
                    ["Endpoint: `POST /api/v1/tools/http`"],
                )
                return
            name, description, url = args[1], args[2], args[3]
            hosts = [h.strip() for h in args[4].split(",")] if len(args) > 4 else []
            body: dict[str, Any] = {"name": name, "description": description, "url": url}
            if hosts:
                body["allowed_hosts"] = hosts
            try:
                await self.client.create_http_tool(body)
            except ApiError as exc:
                self.add_api_error(exc, "crear la tool HTTP")
                return
            await self._reload_registry()
            self.add_system(f"Tool HTTP **{name}** creada → `POST /api/v1/tools/http`")
            return
        if action == "delete":
            if len(args) < 2:
                self.add_error(
                    "Falta el nombre de la tool HTTP",
                    "Uso: `/http delete <nombre>`",
                    ["Endpoint: `DELETE /api/v1/tools/http/{nombre}`"],
                )
                return
            try:
                await self.client.delete_http_tool(args[1])
            except ApiError as exc:
                self.add_api_error(exc, "borrar la tool HTTP")
                return
            await self._reload_registry()
            self.add_system(f"Tool HTTP **{args[1]}** borrada → `DELETE /api/v1/tools/http/{args[1]}`")
            return
        await self._list_http_tools()

    async def _list_http_tools(self) -> None:
        try:
            tools = await self.client.list_http_tools()
        except ApiError as exc:
            self.add_api_error(exc, "listar las tools HTTP")
            return
        if not tools:
            self.add_system(
                "No hay tools HTTP.\n\n"
                'Crea una con `/http add <nombre> "<descripción>" <url> [host]`'
                " → `POST /api/v1/tools/http`"
            )
            return
        lines = [f"· **{t.get('name')}** — `{t.get('url')}`" for t in tools]
        self.add_system("### Tools HTTP\n\n" + "\n".join(lines) + "\n\n`GET /api/v1/tools/http`")

    # ---------------- memoria ----------------
    async def _cmd_memories(self, args: list[str]) -> None:
        try:
            memories = await self.client.list_memories()
        except ApiError as exc:
            self.add_api_error(exc, "listar los recuerdos")
            return
        if not memories:
            self.add_system(
                "No hay recuerdos de largo plazo.\n\n"
                "El agente los guarda solo con la tool `remember`."
            )
            return
        lines = []
        for item in memories:
            key = item.get("key", "?")
            value = str(item.get("value", ""))
            lines.append(f"· **{key}** — {value[:120]}")
        self.add_system(
            "### Recuerdos\n\n" + "\n".join(lines)
            + "\n\n`GET /api/v1/memories` · borra uno con `/memory delete <clave>`"
        )

    async def _cmd_memory(self, args: list[str]) -> None:
        if not args:
            await self._cmd_memories([])
            return
        action = args[0].lower()
        if action == "delete":
            if len(args) < 2:
                self.add_error(
                    "Falta la clave del recuerdo",
                    "Uso: `/memory delete <clave>`",
                    ["Endpoint: `DELETE /api/v1/memories/{clave}`"],
                )
                return
            try:
                await self.client.delete_memory(args[1])
            except ApiError as exc:
                self.add_api_error(exc, "borrar el recuerdo")
                return
            self.add_system(f"Recuerdo **{args[1]}** borrado → `DELETE /api/v1/memories/{args[1]}`")
            return
        await self._cmd_memories([])

    # ---------------- hilos ----------------
    async def _cmd_threads(self, args: list[str]) -> None:
        try:
            threads = await self.client.threads()
        except ApiError as exc:
            self.add_api_error(exc, "listar los hilos")
            return
        if not threads:
            self.add_system("No hay hilos guardados. Empieza uno con `/new`.")
            return
        lines = []
        for thread in threads:
            mark = "◆" if thread.get("thread_id") == self.thread_id else "·"
            lines.append(
                f"{mark} `{thread.get('thread_id')}` — {str(thread.get('title', ''))[:60]}"
                f" ({thread.get('mode', '?')}, {thread.get('updated_at', '')})"
            )
        self.add_system(
            "### Hilos\n\n" + "\n".join(lines)
            + "\n\n`GET /api/v1/threads` · abre uno con `/thread open <id>`"
        )

    async def _cmd_thread(self, args: list[str]) -> None:
        if not args:
            await self._cmd_threads([])
            return
        action = args[0].lower()
        if action == "open":
            if len(args) < 2:
                self.add_error(
                    "Falta el id del hilo",
                    "Uso: `/thread open <id>`",
                    ["Endpoint: `GET /api/v1/threads/{id}/messages`"],
                )
                return
            await self._open_thread(args[1])
            return
        if action == "delete":
            if len(args) < 2:
                self.add_error(
                    "Falta el id del hilo",
                    "Uso: `/thread delete <id>`",
                    ["Endpoint: `DELETE /api/v1/threads/{id}`"],
                )
                return
            try:
                await self.client.delete_thread(args[1])
            except ApiError as exc:
                self.add_api_error(exc, "borrar el hilo")
                return
            if self.thread_id == args[1]:
                self.thread_id = None
            self.add_system(f"Hilo **{args[1]}** borrado → `DELETE /api/v1/threads/{args[1]}`")
            return
        await self._cmd_threads([])

    async def _open_thread(self, thread_id: str) -> None:
        """Carga un hilo guardado en el chat (`GET /api/v1/threads/{id}/messages`)."""
        try:
            messages = await self.client.thread_messages(thread_id)
        except ApiError as exc:
            self.add_api_error(exc, "abrir el hilo")
            return
        self._clear_chat()
        self.thread_id = thread_id
        for message in messages:
            role = str(message.get("role", ""))
            content = str(message.get("content", ""))
            if not content:
                continue
            if role == "human":
                self.add_widget(UserMessage(content))
            elif role == "ai":
                reply = AgentMessage()
                await self.chat.mount(reply)
                await reply.set_text(content)
            else:
                self.add_system(f"**{role}**: {content}")
        self._scroll_to_end()
        self.set_right(f"hilo {thread_id}")
        self.add_system(
            f"Hilo **{thread_id}** abierto ({len(messages)} mensajes) → "
            f"`GET /api/v1/threads/{thread_id}/messages`"
        )

    # ---------------- herramientas ----------------
    def _cmd_tools(self) -> None:
        tools = self.registry.get("tools", [])
        if not tools:
            self.add_system("No hay herramientas disponibles.")
            return
        by_cat: dict[str, list[str]] = {}
        for tool in tools:
            by_cat.setdefault(str(tool.get("category", "other")), []).append(str(tool.get("name")))
        blocks = []
        for category, names in sorted(by_cat.items()):
            blocks.append(f"**{category}** — " + ", ".join(f"`{n}`" for n in sorted(names)))
        self.add_system("### Herramientas\n\n" + "\n\n".join(blocks) + "\n\n`GET /api/v1/registry`")

    # ---------------- estado ----------------
    def _new_thread(self) -> None:
        """Empieza un hilo nuevo (el siguiente mensaje crea otro en el servidor)."""
        self.thread_id = None
        self._text = ""
        self._reply = None
        self._reasoning = None
        self._cards = {}
        self._reset_subagents()
        self._clear_chat()
        self.set_right("")
        self.add_system("Hilo nuevo")

    def _clear_chat(self) -> None:
        """Vacía la conversación visible (no toca lo guardado en el servidor)."""
        chat = self.chat
        for child in list(chat.children):
            child.remove()
        self._reply = None
        self._reasoning = None
        self._cards = {}

    def _reset_subagents(self) -> None:
        """Cierra todas las ventanas de subagente (hilo nuevo)."""
        for state in self._subagents.values():
            if state.container is not None:
                state.container.remove()
        for name in list(self._subagents):
            self.tabs.remove_tab(name)
        self._subagents.clear()
        self._loaders.clear()
        self._task_runs.clear()
        self._pane_ids.clear()
        self.tabs.set_selected("chat")
        self._open_tab("chat")

    async def _reload_registry(self) -> None:
        """Vuelve a pedir el registro tras un cambio (para que la UI esté al día)."""
        try:
            self.registry = await self.client.registry()
        except ApiError:
            pass
        self.refresh_context()

    # ---------------- acciones ----------------
    def action_new_thread(self) -> None:
        self._new_thread()

    def action_clear_chat(self) -> None:
        self._clear_chat()

    def action_help(self) -> None:
        self.add_system(HELP)

    async def action_stop(self) -> None:
        """Esc: detiene la generación en curso."""
        if not self._busy:
            return
        self.workers.cancel_all()
        if self.thread_id:
            try:
                await self.client.cancel(self.thread_id)
            except ApiError:
                pass
        self.set_status("detenido", theme.STYLE_WARN)

    def action_palette(self) -> None:
        self.push_screen(PaletteScreen(self._palette_items()), self._on_palette)

    def _palette_items(self) -> list[tuple[str, str, str]]:
        items: list[tuple[str, str, str]] = []
        for mode in self.registry.get("modes", []):
            name = str(mode.get("name"))
            mark = "◆" if name == self.mode else "◇"
            items.append((f"mode:{name}", f"{mark} modo {name}", str(mode.get("description", ""))[:60]))
        for skill in self.registry.get("skills", []):
            name = str(skill.get("name"))
            mark = "✓" if name in self.skills else "·"
            items.append((f"skill:{name}", f"{mark} skill {name}", str(skill.get("description", ""))[:60]))
        for project in self.registry.get("projects", []):
            name = str(project.get("name"))
            mark = "◆" if name == self.project else "◇"
            items.append((f"project:{name}", f"{mark} proyecto {name}", str(project.get("root", ""))[:60]))
        for provider in self.registry.get("providers", []):
            name = str(provider.get("name"))
            mark = "◆" if name == self.provider else "◇"
            items.append((f"provider:{name}", f"{mark} proveedor {name}", str(provider.get("kind", ""))))
        items.extend(
            [
                ("action:new", "+ hilo nuevo", "empieza una conversación limpia"),
                ("action:clear", "- limpiar pantalla", "borra la conversación visible"),
                ("action:projects", "▦ proyectos", "crear/listar/borrar proyectos (POST /api/v1/projects)"),
                ("action:skills", "◈ skills", "crear/listar/borrar skills (POST /api/v1/skills)"),
                ("action:providers", "▤ proveedores", "crear/listar proveedores (POST /api/v1/providers)"),
                ("action:models", "≡ modelos", "listar modelos (GET /api/v1/models)"),
                ("action:tools", "▥ herramientas", "listar tools disponibles"),
                ("action:http", "» tools HTTP", "gestionar tools HTTP (POST /api/v1/tools/http)"),
                ("action:mcp", "⧉ servidores MCP", "gestionar MCP (POST /api/v1/mcp)"),
                ("action:memories", "◆ recuerdos", "memoria a largo plazo (GET /api/v1/memories)"),
                ("action:threads", "☰ hilos", "ver/abrir/borrar hilos (GET /api/v1/threads)"),
                ("action:user", "◍ usuario", "ver o cambiar el usuario (X-User-Id)"),
                ("action:help", "? ayuda", "lista los comandos"),
                ("action:quit", "× salir", "cierra kliccode"),
            ]
        )
        return items

    def _on_palette(self, choice: str | None) -> None:
        if not choice:
            return
        kind, _, value = choice.partition(":")
        if kind == "mode":
            self.mode = value
            self.refresh_context()
            self.add_system(f"Modo → **{value}**")
        elif kind == "skill":
            if value in self.skills:
                self.skills.discard(value)
                self.add_system(f"Skill **{value}** desactivada")
            else:
                self.skills.add(value)
                self.add_system(f"Skill **{value}** activada")
            self.refresh_context()
        elif kind == "project":
            self.project = None if value == "none" else value
            self.refresh_context()
            self.add_system(f"Proyecto → **{self.project or 'workspace por defecto'}**")
        elif kind == "provider":
            self.provider = value
            self.refresh_context()
            self.add_system(f"Proveedor → **{value}**")
        elif choice == "action:new":
            self._new_thread()
        elif choice == "action:clear":
            self._clear_chat()
        elif choice == "action:projects":
            self._cmd_projects()
        elif choice == "action:skills":
            self._cmd_skills()
        elif choice == "action:providers":
            self._cmd_providers()
        elif choice == "action:models":
            self.run_worker(self._cmd_models([]))
        elif choice == "action:tools":
            self._cmd_tools()
        elif choice == "action:http":
            self.run_worker(self._list_http_tools())
        elif choice == "action:mcp":
            self.run_worker(self._list_mcp())
        elif choice == "action:memories":
            self.run_worker(self._cmd_memories([]))
        elif choice == "action:threads":
            self.run_worker(self._cmd_threads([]))
        elif choice == "action:user":
            self._cmd_user([])
        elif choice == "action:help":
            self.add_system(HELP)
        elif choice == "action:quit":
            self.exit()
        self._focus_prompt()

    async def on_unmount(self) -> None:
        await self.client.aclose()


def _parse_args(argv: list[str]) -> CliConfig:
    """Lee las opciones de la línea de comandos."""
    parser = argparse.ArgumentParser(
        prog="kliccode",
        description="KLI: cliente de terminal para el harness agéntico (habla con la API).",
    )
    parser.add_argument("--url", help="URL del servidor (equivale a KLI_API_URL)")
    parser.add_argument("--user", help="usuario (cabecera X-User-Id)")
    parser.add_argument("--api-key", help="clave Bearer si el servidor exige API_KEYS")
    parser.add_argument("-V", "--version", action="version", version=f"kliccode {__version__}")
    args = parser.parse_args(argv)
    base = load_config()
    return CliConfig(
        base_url=args.url or base.base_url,
        user=args.user or base.user,
        api_key=args.api_key or base.api_key,
    )


def main() -> None:
    """Punto de entrada del ejecutable `kliccode`."""
    config = _parse_args(sys.argv[1:])
    KliApp(config=config).run()


if __name__ == "__main__":  # pragma: no cover
    main()
