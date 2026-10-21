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
from typing import Any, ClassVar

from textual import on, work
from textual.app import App, ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal, Vertical, VerticalScroll
from textual.screen import ModalScreen
from textual.widgets import Input, OptionList, Static
from textual.widgets.option_list import Option

from cli import __version__, theme
from cli.client import ApiError, HarnessClient, ServerEvent
from cli.config import CliConfig, load_config
from cli.widgets import (
    AgentMessage,
    ApprovalPanel,
    ContextPanel,
    ReasoningPanel,
    StatusBar,
    SystemNote,
    ToolCard,
    TopBar,
    UserMessage,
)

__all__ = ["KliApp", "main"]

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
| `/new` · `/clear` · `/quit` | — |

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
`esc` detener · `ctrl+q` salir.
"""


class PaletteScreen(ModalScreen[str | None]):
    """Paleta de comandos: modos, skills, proyectos y acciones."""

    def __init__(self, items: list[tuple[str, str, str]]) -> None:
        """`items` = [(id, etiqueta, detalle)]."""
        super().__init__()
        self._items = items

    def compose(self) -> ComposeResult:
        with Vertical(id="palette-box"):
            yield Static("⌘  comandos", id="palette-title")
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
            options.add_option(Option(f"{label}  [dim]{detail}[/]", id=ident))

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
        self._reply: AgentMessage | None = None
        self._reasoning: ReasoningPanel | None = None
        self._text = ""
        self._dirty = False
        self._last_flush = 0.0
        self._cards: dict[str, ToolCard] = {}

    # ---------------- layout ----------------
    def compose(self) -> ComposeResult:
        yield TopBar(id="topbar")
        with Horizontal(id="body"):
            yield ContextPanel(id="context")
            with Vertical(id="chat-col"):
                yield VerticalScroll(id="chat")
                with Horizontal(id="prompt-row"):
                    yield Static("❯", id="prompt-mark")
                    yield Input(id="prompt", placeholder="Escribe tu mensaje…   (/help)")
        yield StatusBar(id="status")

    async def on_mount(self) -> None:
        self.query_one("#prompt", Input).focus()
        self.set_status("conectando con el servidor…", theme.WARN)
        await self.connect()

    # ---------------- conexiones ----------------
    async def connect(self) -> None:
        try:
            health = await self.client.health()
            self.server = await self.client.server_config()
            self.registry = await self.client.registry()
        except ApiError as exc:
            self.set_status("sin conexión", theme.ERR)
            self.query_one(TopBar).set_disconnected("sin conexión")
            self.add_system(
                f"No se pudo conectar con **{self.config.base_url}**\n\n"
                f"`{exc.detail}`\n\n"
                "Arranca el servidor con `make dev` (o `docker compose up`) "
                "y vuelve a pulsar `ctrl+p` → * reconectar *.",
                error=True,
            )
            return
        self.query_one(TopBar).set_connected(
            str(health.get("version", "?")), self.config.base_url, self.config.user
        )
        self.set_status("conectado", theme.OK)
        self.refresh_context()
        self.add_system(
            "### Bienvenido a kliccode\n\n"
            "El agente está listo. Escribe tu mensaje y pulsa `enter`.\n\n"
            "- `/help` — todos los comandos\n"
            "- `ctrl+p` — paleta de comandos\n"
            "- `esc` — detener la respuesta en curso\n\n"
            f"Servidor `{self.config.base_url}` · usuario `{self.config.user}`"
        )

    # ---------------- chat ----------------
    @property
    def chat(self) -> VerticalScroll:
        return self.query_one("#chat", VerticalScroll)

    def add_widget(self, widget: Any) -> None:
        self.chat.mount(widget)
        self.call_after_refresh(self._scroll_to_end)

    def _scroll_to_end(self) -> None:
        try:
            self.chat.scroll_end(animate=False)
        except Exception as exc:  # noqa: BLE001 - el scroll nunca debe romper el chat
            self.log.warning("No se pudo hacer scroll al final: %s", exc)

    def add_system(self, text: str, error: bool = False) -> None:
        self.add_widget(SystemNote(text, error=error))

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
        self.set_status("pensando…", theme.ACCENT2)
        self._reply = AgentMessage()
        # hay que esperar al montaje: si no, el Markdown se actualiza sin estar
        # en el DOM y la respuesta nunca se ve
        await self.chat.mount(self._reply)
        self._scroll_to_end()
        self._reasoning = None
        self._text = ""
        self._dirty = False
        self._last_flush = time.monotonic()
        self._cards = {}
        try:
            async for ev in self.client.stream_chat(self._body(text)):
                await self._handle(ev)
            await self._flush_text(force=True)
        except ApiError as exc:
            self.add_system(f"Error de la API: {exc.detail}", error=True)
            self.set_status("error", theme.ERR)
        except asyncio.CancelledError:
            await self._flush_text(force=True)
            self.add_system("Generación detenida.")
            self.set_status("detenido", theme.WARN)
            raise
        finally:
            self._busy = False
            self.set_busy(False)
            self.set_status("listo")
            self.refresh_context()
            self.query_one("#prompt", Input).focus()

    @work(exclusive=False)
    async def _run_resume(self, decision: dict[str, Any]) -> None:
        if not self.thread_id:
            return
        self._busy = True
        self.set_busy(True)
        self.set_status("reanudando…", theme.ACCENT2)
        try:
            async for ev in self.client.stream_resume(self._body(""), decision):
                await self._handle(ev)
        except ApiError as exc:
            self.add_system(f"Error de la API: {exc.detail}", error=True)
        except asyncio.CancelledError:
            self.add_system("Reanudación detenida.")
            raise
        finally:
            self._busy = False
            self.set_busy(False)
            self.refresh_context()
            self.query_one("#prompt", Input).focus()

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
            self._add_reasoning(ev.text)
        elif kind == "tool_start":
            card = ToolCard(ev.name or "tool", ev.agent)
            card.set_args(ev.data.get("payload"))
            key = str(ev.data.get("run_id") or ev.name or len(self._cards))
            self._cards[key] = card
            self.add_widget(card)
        elif kind in {"tool_end", "tool_error"}:
            run_id = str(ev.data.get("run_id") or "")
            finished = self._cards.get(run_id)
            if finished is not None:
                self._cards.pop(run_id, None)
                if kind == "tool_end":
                    finished.set_done(ev.text)
                else:
                    finished.set_error(ev.text)
        elif kind == "usage":
            payload = ev.data.get("payload")
            if isinstance(payload, dict):
                self.usage = {k: int(v) for k, v in payload.items() if isinstance(v, (int, float))}
            self.refresh_context()
        elif kind == "interrupt":
            self._show_approvals(ev.data.get("payload"))
        elif kind == "error":
            self.add_system(ev.text or "error desconocido en el servidor", error=True)

    async def _flush_text(self, force: bool = False) -> None:
        if not self._dirty or self._reply is None:
            return
        if not force and time.monotonic() - self._last_flush <= 0.08:
            return
        self._dirty = False
        self._last_flush = time.monotonic()
        await self._reply.set_text(self._text)
        # el layout cambia al montar el markdown: el scroll va después del refresco
        self.call_after_refresh(self._scroll_to_end)

    def _add_reasoning(self, text: str) -> None:
        if self._reasoning is None:
            self._reasoning = ReasoningPanel()
            self.add_widget(self._reasoning)
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
        modes = {m.get("name"): m.get("description", "") for m in self.registry.get("modes", [])}
        skills = [s.get("name", "") for s in self.registry.get("skills", [])]
        counts: dict[str, int] = {}
        for tool in self.registry.get("tools", []):
            category = str(tool.get("category", "other"))
            counts[category] = counts.get(category, 0) + 1
        self.query_one(ContextPanel).update_context(
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
        self.query_one(StatusBar).set_status(text, style)

    def set_right(self, text: str, style: str = theme.FAINT) -> None:
        self.query_one(StatusBar).set_right(text, style)

    def set_busy(self, busy: bool) -> None:
        self.query_one(StatusBar).set_busy(busy)

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
                self.add_system("Uso: `/skill delete <nombre>`", error=True)
                return
            name = args[1]
            try:
                await self.client.delete_skill(name)
            except ApiError as exc:
                self.add_system(f"No se pudo borrar la skill: {exc.detail}", error=True)
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
            self.add_system(
                'Uso: `/skill create <nombre> "<descripción>" "<instrucciones>" [--tools a,b]`\n\n'
                "Endpoint: `POST /api/v1/skills`",
                error=True,
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
            self.add_system(f"No se pudo crear la skill: {exc.detail}", error=True)
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
                self.add_system("Uso: `/provider delete <nombre>`", error=True)
                return
            name = args[1]
            try:
                await self.client.delete_provider(name)
            except ApiError as exc:
                self.add_system(f"No se pudo borrar el proveedor: {exc.detail}", error=True)
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
            self.add_system(
                "Uso: `/provider create <nombre> <openai|anthropic> [base_url] [modelo] [api_key]`\n\n"
                "Endpoint: `POST /api/v1/providers`",
                error=True,
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
            self.add_system(f"No se pudo crear el proveedor: {exc.detail}", error=True)
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
            self.add_system(f"No se pudieron listar los modelos: {exc.detail}", error=True)
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
                self.add_system("Uso: `/project delete <nombre>`", error=True)
                return
            name = args[1]
            try:
                await self.client.delete_project(name)
            except ApiError as exc:
                self.add_system(f"No se pudo borrar el proyecto: {exc.detail}", error=True)
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
            self.add_system(
                "Uso: `/project import <nombre> <ruta>`\n\n"
                "La carpeta se usa tal cual (con todos sus archivos) como workspace del "
                "proyecto. Tiene que estar dentro de las raíces permitidas.\n\n"
                "Endpoint: `POST /api/v1/projects`",
                error=True,
            )
            return
        if not args:
            self.add_system(
                "Uso: `/project create <nombre> [ruta]`\n\n"
                "Sin ruta crea una carpeta nueva en el workspace del servidor; "
                "con ruta usa esa carpeta existente tal cual.\n\n"
                "Endpoint: `POST /api/v1/projects`",
                error=True,
            )
            return
        name = args[0]
        path = args[1] if len(args) > 1 else None
        try:
            project = await self.client.create_project(name, path)
        except ApiError as exc:
            detail = exc.detail
            if exc.status == 403:
                detail = f"{detail}\n\nRaíces permitidas: {self._import_roots_text()}"
            self.add_system(f"No se pudo crear el proyecto: {detail}", error=True)
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
            detail = exc.detail
            if exc.status == 403:
                detail = f"{detail}\n\nRaíces permitidas: {self._import_roots_text()}"
            self.add_system(f"No se pudo listar la carpeta: {detail}", error=True)
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
                self.add_system(
                    "Uso: `/mcp add <nombre> <url>`\n\nEndpoint: `POST /api/v1/mcp`", error=True
                )
                return
            try:
                await self.client.create_mcp({"name": args[1], "url": args[2]})
            except ApiError as exc:
                self.add_system(f"No se pudo añadir el servidor MCP: {exc.detail}", error=True)
                return
            await self._reload_registry()
            self.add_system(f"Servidor MCP **{args[1]}** añadido → `POST /api/v1/mcp`")
            return
        if action == "delete":
            if len(args) < 2:
                self.add_system("Uso: `/mcp delete <nombre>`", error=True)
                return
            try:
                await self.client.delete_mcp(args[1])
            except ApiError as exc:
                self.add_system(f"No se pudo borrar el servidor MCP: {exc.detail}", error=True)
                return
            await self._reload_registry()
            self.add_system(f"Servidor MCP **{args[1]}** borrado → `DELETE /api/v1/mcp/{args[1]}`")
            return
        await self._list_mcp()

    async def _list_mcp(self) -> None:
        try:
            servers = await self.client.list_mcp()
        except ApiError as exc:
            self.add_system(f"No se pudieron listar los servidores MCP: {exc.detail}", error=True)
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
                self.add_system(
                    'Uso: `/http add <nombre> "<descripción>" <url> [host[,host]]`\n\n'
                    "Endpoint: `POST /api/v1/tools/http`",
                    error=True,
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
                self.add_system(f"No se pudo crear la tool HTTP: {exc.detail}", error=True)
                return
            await self._reload_registry()
            self.add_system(f"Tool HTTP **{name}** creada → `POST /api/v1/tools/http`")
            return
        if action == "delete":
            if len(args) < 2:
                self.add_system("Uso: `/http delete <nombre>`", error=True)
                return
            try:
                await self.client.delete_http_tool(args[1])
            except ApiError as exc:
                self.add_system(f"No se pudo borrar la tool HTTP: {exc.detail}", error=True)
                return
            await self._reload_registry()
            self.add_system(f"Tool HTTP **{args[1]}** borrada → `DELETE /api/v1/tools/http/{args[1]}`")
            return
        await self._list_http_tools()

    async def _list_http_tools(self) -> None:
        try:
            tools = await self.client.list_http_tools()
        except ApiError as exc:
            self.add_system(f"No se pudieron listar las tools HTTP: {exc.detail}", error=True)
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
            self.add_system(f"No se pudieron listar los recuerdos: {exc.detail}", error=True)
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
                self.add_system("Uso: `/memory delete <clave>`", error=True)
                return
            try:
                await self.client.delete_memory(args[1])
            except ApiError as exc:
                self.add_system(f"No se pudo borrar el recuerdo: {exc.detail}", error=True)
                return
            self.add_system(f"Recuerdo **{args[1]}** borrado → `DELETE /api/v1/memories/{args[1]}`")
            return
        await self._cmd_memories([])

    # ---------------- hilos ----------------
    async def _cmd_threads(self, args: list[str]) -> None:
        try:
            threads = await self.client.threads()
        except ApiError as exc:
            self.add_system(f"No se pudieron listar los hilos: {exc.detail}", error=True)
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
                self.add_system("Uso: `/thread open <id>`", error=True)
                return
            await self._open_thread(args[1])
            return
        if action == "delete":
            if len(args) < 2:
                self.add_system("Uso: `/thread delete <id>`", error=True)
                return
            try:
                await self.client.delete_thread(args[1])
            except ApiError as exc:
                self.add_system(f"No se pudo borrar el hilo: {exc.detail}", error=True)
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
            self.add_system(f"No se pudo abrir el hilo: {exc.detail}", error=True)
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
        self._clear_chat()
        self.set_right("")
        self.add_system("Hilo nuevo ✨")

    def _clear_chat(self) -> None:
        """Vacía la conversación visible (no toca lo guardado en el servidor)."""
        chat = self.chat
        for child in list(chat.children):
            child.remove()
        self._reply = None
        self._reasoning = None
        self._cards = {}

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
        self.set_status("detenido", theme.WARN)

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
                ("action:new", "✦ hilo nuevo", "empieza una conversación limpia"),
                ("action:clear", "✧ limpiar pantalla", "borra la conversación visible"),
                ("action:projects", "▤ proyectos", "crear/listar/borrar proyectos (POST /api/v1/projects)"),
                ("action:skills", "◈ skills", "crear/listar/borrar skills (POST /api/v1/skills)"),
                ("action:providers", "⚙ proveedores", "crear/listar proveedores (POST /api/v1/providers)"),
                ("action:models", "≡ modelos", "listar modelos (GET /api/v1/models)"),
                ("action:tools", "⚒ herramientas", "listar tools disponibles"),
                ("action:http", "⇄ tools HTTP", "gestionar tools HTTP (POST /api/v1/tools/http)"),
                ("action:mcp", "⧉ servidores MCP", "gestionar MCP (POST /api/v1/mcp)"),
                ("action:memories", "★ recuerdos", "memoria a largo plazo (GET /api/v1/memories)"),
                ("action:threads", "☰ hilos", "ver/abrir/borrar hilos (GET /api/v1/threads)"),
                ("action:help", "? ayuda", "lista los comandos"),
                ("action:quit", "⏻ salir", "cierra kliccode"),
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
        elif choice == "action:help":
            self.add_system(HELP)
        elif choice == "action:quit":
            self.exit()
        self.query_one("#prompt", Input).focus()

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
