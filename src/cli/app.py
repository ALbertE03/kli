"""KLI: TUI de chat para el harness.

El CLI es un cliente puro de la API: pide el registro, manda mensajes y consume
el stream SSE. No importa nada de `harness` (salvo los tipos del cliente), así
que puede hablar con un servidor remoto sin tocar el código.
"""

from __future__ import annotations

import asyncio
import time
from typing import Any, ClassVar

from textual import on, work
from textual.app import App, ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal, Vertical, VerticalScroll
from textual.screen import ModalScreen
from textual.widgets import Input, OptionList, Static
from textual.widgets.option_list import Option

from cli import theme
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

| comando | qué hace |
|---|---|
| `/help` | esta ayuda |
| `/mode <plan\\|build>` | cambia el modo de trabajo |
| `/skill <nombre>` | activa o desactiva una skill |
| `/skills` | lista las skills disponibles |
| `/model <modelo>` | fija el modelo (o `auto`) |
| `/provider <nombre>` | cambia de proveedor |
| `/project <nombre\\|none>` | fija el proyecto activo |
| `/projects` | lista los proyectos |
| `/tools` | lista las herramientas disponibles |
| `/threads` | lista los hilos guardados |
| `/new` | empieza un hilo nuevo |
| `/clear` | limpia la pantalla |
| `/quit` | sale |

Atajos: `ctrl+p` paleta de comandos · `ctrl+n` hilo nuevo · `esc` detener · `ctrl+q` salir.
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
        elif cmd == "model":
            self._cmd_model(args)
        elif cmd == "provider":
            self._cmd_provider(args)
        elif cmd == "project":
            await self._cmd_project(args)
        elif cmd == "projects":
            self._cmd_projects()
        elif cmd == "tools":
            self._cmd_tools()
        elif cmd == "threads":
            await self._cmd_threads()
        elif cmd == "new":
            self._new_thread()
        elif cmd == "clear":
            self._clear_chat()
        elif cmd in {"quit", "exit"}:
            self.exit()
        else:
            self.add_system(f"Comando desconocido: `/{cmd}`. Escribe `/help`.")

    async def _cmd_mode(self, args: list[str]) -> None:
        modes = [m.get("name", "") for m in self.registry.get("modes", [])]
        if not args:
            self.add_system("Modos: " + ", ".join(f"`{m}`" for m in modes))
            return
        mode = args[0]
        if mode not in modes:
            self.add_system(f"Modo desconocido: `{mode}`. Disponibles: {', '.join(modes)}", error=True)
            return
        self.mode = mode
        self.refresh_context()
        self.add_system(f"Modo → **{mode}**")

    async def _cmd_skill(self, args: list[str]) -> None:
        skills = [s.get("name", "") for s in self.registry.get("skills", [])]
        if not args:
            self._cmd_skills()
            return
        name = args[0]
        if name not in skills:
            self.add_system(f"Skill desconocida: `{name}`.", error=True)
            return
        if name in self.skills:
            self.skills.discard(name)
            self.add_system(f"Skill **{name}** desactivada")
        else:
            self.skills.add(name)
            self.add_system(f"Skill **{name}** activada")
        self.refresh_context()

    def _cmd_skills(self) -> None:
        skills = self.registry.get("skills", [])
        if not skills:
            self.add_system("No hay skills registradas.")
            return
        lines = []
        for skill in skills:
            mark = "✓" if skill.get("name") in self.skills else "·"
            lines.append(f"{mark} **{skill.get('name')}** — {skill.get('description', '')}")
        self.add_system("### Skills\n\n" + "\n".join(lines))

    def _cmd_model(self, args: list[str]) -> None:
        if not args:
            self.add_system(f"Modelo actual: **{self.model or self.server.get('default_model')}**")
            return
        model = args[0]
        self.model = None if model in {"auto", "default"} else model
        self.refresh_context()
        self.add_system(f"Modelo → **{self.model or 'automático'}**")

    def _cmd_provider(self, args: list[str]) -> None:
        providers = [p.get("name", "") for p in self.registry.get("providers", [])]
        if not args:
            self.add_system("Proveedores: " + ", ".join(f"`{p}`" for p in providers))
            return
        provider = args[0]
        if provider not in providers:
            self.add_system(f"Proveedor desconocido: `{provider}`.", error=True)
            return
        self.provider = None if provider == "default" else provider
        self.refresh_context()
        self.add_system(f"Proveedor → **{self.provider or 'automático'}**")

    async def _cmd_project(self, args: list[str]) -> None:
        projects = [p.get("name", "") for p in self.registry.get("projects", [])]
        if not args:
            self._cmd_projects()
            return
        name = args[0]
        if name in {"none", "null", "-"}:
            self.project = None
            self.add_system("Proyecto → **workspace por defecto**")
        elif name in projects:
            self.project = name
            self.add_system(f"Proyecto → **{name}**")
        else:
            self.add_system(f"Proyecto desconocido: `{name}`.", error=True)
            return
        self.refresh_context()

    def _cmd_projects(self) -> None:
        projects = self.registry.get("projects", [])
        if not projects:
            self.add_system("No hay proyectos. Créalos con `POST /api/v1/projects`.")
            return
        lines = [f"{'✓' if p.get('name') == self.project else '·'} **{p.get('name')}** — `{p.get('root')}`" for p in projects]
        self.add_system("### Proyectos\n\n" + "\n".join(lines))

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
        self.add_system("### Herramientas\n\n" + "\n\n".join(blocks))

    async def _cmd_threads(self) -> None:
        try:
            threads = await self.client.threads()
        except ApiError as exc:
            self.add_system(f"No se pudieron listar los hilos: {exc.detail}", error=True)
            return
        if not threads:
            self.add_system("No hay hilos guardados.")
            return
        lines = [
            f"`{t.get('thread_id')}` — {t.get('title', '')[:60]} "
            f"({t.get('mode', '?')}, {t.get('updated_at', '')})"
            for t in threads
        ]
        self.add_system("### Hilos\n\n" + "\n".join(lines))

    def _new_thread(self) -> None:
        self.thread_id = None
        self._text = ""
        self._reply = None
        self._reasoning = None
        self._cards = {}
        self._clear_chat()
        self.add_system("Hilo nuevo ✨")

    def _clear_chat(self) -> None:
        chat = self.chat
        for child in list(chat.children):
            child.remove()
        self._reply = None
        self._reasoning = None
        self._cards = {}

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
        items.extend(
            [
                ("action:new", "✦ hilo nuevo", "empieza una conversación limpia"),
                ("action:clear", "✧ limpiar pantalla", "borra la conversación visible"),
                ("action:help", "? ayuda", "lista los comandos"),
                ("action:quit", "⏻ salir", "cierra KLI"),
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
        elif choice == "action:new":
            self._new_thread()
        elif choice == "action:clear":
            self._clear_chat()
        elif choice == "action:help":
            self.add_system(HELP)
        elif choice == "action:quit":
            self.exit()
        self.query_one("#prompt", Input).focus()

    async def on_unmount(self) -> None:
        await self.client.aclose()


def main() -> None:
    """Punto de entrada del ejecutable `klicode`."""
    KliApp().run()


if __name__ == "__main__":  # pragma: no cover
    main()
