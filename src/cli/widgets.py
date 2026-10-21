"""Widgets propios del CLI: cabecera, panel de contexto, burbujas, tools y aprobaciones."""

from __future__ import annotations

import json
from typing import Any, ClassVar

from rich.table import Table
from rich.text import Text
from textual.app import ComposeResult
from textual.await_complete import AwaitComplete
from textual.containers import Horizontal, Vertical
from textual.message import Message
from textual.widgets import Button, Collapsible, LoadingIndicator, Markdown, Static

from cli import theme

__all__ = [
    "AgentMessage",
    "ApprovalPanel",
    "ContextPanel",
    "ReasoningPanel",
    "StatusBar",
    "SystemNote",
    "ToolCard",
    "TopBar",
    "UserMessage",
]


def _truncate(text: str, limit: int = 160) -> str:
    text = " ".join(text.split())
    return text if len(text) <= limit else text[: limit - 1] + "…"


def _one_line(text: str, limit: int = 120) -> str:
    """Colapsa saltos de línea y recorta (para valores de argumentos)."""
    flat = text.replace("\n", " ⏎ ").replace("\r", "")
    return flat if len(flat) <= limit else flat[: limit - 1] + "…"


def _format_value(value: Any, limit: int = 120) -> str:
    """Convierte un valor de argumento en algo legible (nada de dicts en crudo)."""
    if value is None:
        return "—"
    if isinstance(value, bool):
        return "sí" if value else "no"
    if isinstance(value, (int, float)):
        return str(value)
    if isinstance(value, str):
        return _one_line(value, limit)
    if isinstance(value, (list, tuple, set)):
        items = [_format_value(v, 40) for v in list(value)[:6]]
        extra = "" if len(value) <= 6 else f" +{len(value) - 6}"
        return "[" + ", ".join(items) + f"]{extra}"
    if isinstance(value, dict):
        if not value:
            return "{}"
        keys = ", ".join(str(k) for k in list(value)[:6])
        return "{" + keys + ("}" if len(value) <= 6 else ", …}")
    return _one_line(str(value), limit)


def _format_args(payload: Any) -> list[tuple[str, str]]:
    """Normaliza los argumentos de una tool en pares (clave, valor legible)."""
    if payload is None:
        return []
    if isinstance(payload, dict):
        return [(str(k), _format_value(v)) for k, v in payload.items()]
    if isinstance(payload, (list, tuple)):
        return [("args", _format_value(payload))]
    return [("args", _format_value(payload))]


SHELL_KEYS = ("command", "cmd", "script", "shell", "code")
SHELL_TOOLS = ("terminal", "run_tests", "python_repl", "bash", "sh")


def _set_title(collapsible: Collapsible, text: Text) -> None:
    """El título de un Collapsible admite texto enriquecido (Textual lo soporta)."""
    collapsible.title = text  # type: ignore[assignment]


class TopBar(Static):
    """Cabecera: marca a la izquierda y estado de la conexión a la derecha."""

    def __init__(self, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self._version = ""
        self._status = Text("conectando…", style=theme.WARN)

    def set_connected(self, version: str, base_url: str, user: str) -> None:
        self._version = version
        right = Text()
        right.append("● ", style=theme.OK)
        right.append(f"{base_url}", style=theme.TEXT)
        right.append("  ·  ", style=theme.FAINT)
        right.append(f"user {user}", style=theme.DIM)
        right.append("  ·  ", style=theme.FAINT)
        right.append(f"v{version}", style=theme.DIM)
        self._status = right
        self._paint()

    def set_disconnected(self, reason: str) -> None:
        self._status = Text()
        self._status.append("● ", style=theme.ERR)
        self._status.append(reason, style=theme.ERR)
        self._paint()

    def _paint(self) -> None:
        brand = Text()
        brand.append("◆ ", style=theme.ACCENT)
        brand.append_text(theme.gradient("kliccode"))
        brand.append("  ", style=theme.TEXT)
        brand.append("agentic harness", style=theme.DIM)

        grid = Table.grid(expand=True)
        grid.add_column(justify="left")
        grid.add_column(justify="right")
        grid.add_row(brand, self._status)
        self.update(grid)


class ContextPanel(Static):
    """Panel lateral: modo, skills, proyecto, modelo, tools y tokens."""

    def __init__(self, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self._data: dict[str, Any] = {}

    def update_context(self, data: dict[str, Any]) -> None:
        self._data = data
        self._paint()

    def _paint(self) -> None:
        d = self._data
        text = Text()

        def section(title: str) -> None:
            text.append("\n")
            text.append("─" * 30 + " ", style=theme.BORDER)
            text.append("\n")
            text.append(title.upper(), style=f"bold {theme.DIM}")
            text.append("\n")

        def item(label: str, value: str, value_style: str = theme.TEXT) -> None:
            text.append(f"  {label} ", style=theme.ACCENT2)
            text.append(value, style=value_style)
            text.append("\n")

        mode = str(d.get("mode") or "plan")
        section("modo")
        item("◆", mode, theme.ACCENT)
        desc = (d.get("modes") or {}).get(mode, "")
        if desc:
            text.append(f"    {desc}\n", style=theme.FAINT)

        section("skills")
        active = set(d.get("skills") or ())
        skills = d.get("skill_list") or []
        if not skills:
            text.append("  (ninguna)\n", style=theme.FAINT)
        for name in skills:
            name = str(name)
            if name in active:
                text.append("  ✓ ", style=theme.OK)
                text.append(name, style=f"bold {theme.OK}")
            else:
                text.append("  · ", style=theme.FAINT)
                text.append(name, style=theme.FAINT)
            text.append("\n")

        section("proyecto")
        project = d.get("project")
        item("◆", str(project) if project else "workspace por defecto",
             theme.TEXT if project else theme.FAINT)

        section("modelo")
        provider = str(d.get("provider") or d.get("default_provider") or "openai")
        model = str(d.get("model") or d.get("default_model") or "—")
        text.append(f"  {provider}", style=theme.TEXT)
        text.append(" / ", style=theme.FAINT)
        text.append(model, style=theme.ACCENT2)
        text.append("\n")

        section("herramientas")
        counts = d.get("tool_counts") or {}
        total = sum(counts.values())
        if total:
            text.append(f"  {total}", style=theme.TEXT)
            text.append("  " + " · ".join(f"{k}:{v}" for k, v in sorted(counts.items())) + "\n",
                        style=theme.FAINT)
        else:
            text.append("  (ninguna)\n", style=theme.FAINT)

        section("tokens")
        usage = d.get("usage") or {}
        text.append("  in ", style=theme.ACCENT2)
        text.append(str(usage.get("input_tokens", 0)), style=theme.TEXT)
        text.append("   out ", style=theme.ACCENT2)
        text.append(str(usage.get("output_tokens", 0)), style=theme.TEXT)
        text.append("\n")

        self.update(text)


class UserMessage(Static):
    """Burbuja del usuario (texto plano, sin interpretar markup)."""

    def __init__(self, text: str) -> None:
        super().__init__(Text(text, style=theme.TEXT))
        self.add_class("user-bubble")


class AgentMessage(Vertical):
    """Respuesta del agente: etiqueta + cuerpo en Markdown."""

    def __init__(self, label: str = "assistant") -> None:
        super().__init__()
        self.add_class("agent-bubble")
        self._label = Static(Text(f"◆ {label}", style=theme.ACCENT))
        self._label.add_class("agent-label")
        self.body = Markdown("")
        self.body.add_class("agent-body")

    def compose(self) -> ComposeResult:
        yield self._label
        yield self.body

    def set_text(self, text: str) -> AwaitComplete:
        return self.body.update(text)


class ReasoningPanel(Collapsible):
    """Razonamiento del modelo: aparece en el chat, plegado y desplegable."""

    def __init__(self) -> None:
        self._body = Static(Text("", style=theme.DIM))
        self._text = ""
        super().__init__(
            self._body,
            title="razonamiento",
            collapsed=True,
            classes="reasoning-box",
        )
        _set_title(self, Text("🧠 razonamiento", style=theme.FAINT))

    def append(self, text: str) -> None:
        self._text += text
        self._body.update(Text(self._text, style=theme.DIM))


class SystemNote(Markdown):
    """Aviso del sistema (conexión, cambios de contexto, errores)."""

    def __init__(self, text: str, error: bool = False) -> None:
        super().__init__(f"⚠ {text}" if error else text)
        self.add_class("system-error" if error else "system-note")


class ToolCard(Collapsible):
    """Tarjeta de una llamada a tool.

    La cabecera (icono, nombre, estado) es el título plegable; dentro van los
    argumentos —legibles, no volcados de dict— y la salida de la tool.
    """

    ICONS: ClassVar[dict[str, str]] = {"run": "⏳", "ok": "✓", "err": "✗"}
    LABELS: ClassVar[dict[str, str]] = {"run": "ejecutando", "ok": "listo", "err": "error"}
    MAX_OUTPUT_LINES = 12

    def __init__(self, name: str, agent: str | None = None) -> None:
        self._tool_name = name
        self._agent = agent
        self._state = "run"
        self._args: list[tuple[str, str]] = []
        self._shell: str | None = None
        self._output = ""
        self._args_view = Static()
        self._output_view = Static()
        super().__init__(
            self._args_view,
            self._output_view,
            title="tool",
            collapsed=False,
            classes="tool-card",
        )
        self.add_class("state-run")
        self._paint()

    def set_args(self, payload: Any) -> None:
        self._args = _format_args(payload)
        for key, value in self._args:
            if key in SHELL_KEYS and (self._tool_name in SHELL_TOOLS or key == "command"):
                self._shell = value
                break
        self._paint()

    def set_done(self, output: str) -> None:
        self._state = "ok"
        self._output = output or ""
        self._paint()

    def set_error(self, error: str) -> None:
        self._state = "err"
        self._output = error or ""
        self._paint()

    # ---------------- pintado ----------------
    @property
    def args_text(self) -> str:
        """Argumentos tal como se muestran (para tests y depuración)."""
        content = self._args_view.content
        return content.plain if hasattr(content, "plain") else str(content)

    @property
    def output_text(self) -> str:
        """Salida tal como se muestra (para tests y depuración)."""
        content = self._output_view.content
        return content.plain if hasattr(content, "plain") else str(content)

    def _paint(self) -> None:
        for state in ("run", "ok", "err"):
            self.remove_class(f"state-{state}")
        self.add_class(f"state-{self._state}")

        title = Text()
        title.append(f"{self.ICONS[self._state]} ", style=theme.ACCENT2)
        title.append(self._tool_name, style=f"bold {theme.WARN}")
        if self._agent:
            title.append(f"  @{self._agent}", style=theme.FAINT)
        title.append("   ")
        title.append(self.LABELS[self._state], style={
            "run": theme.ACCENT2, "ok": theme.OK, "err": theme.ERR,
        }[self._state])
        _set_title(self, title)

        self._paint_args()
        self._paint_output()

    def _paint_args(self) -> None:
        if not self._args:
            self._args_view.display = False
            return
        self._args_view.display = True
        text = Text()
        rest = self._args
        if self._shell is not None:
            # comandos de shell: se muestran como una línea de consola
            text.append("  $ ", style=f"bold {theme.OK}")
            text.append(self._shell, style=theme.TEXT)
            text.append("\n")
            rest = [(k, v) for k, v in self._args if k not in SHELL_KEYS]
        if rest:
            width = max(len(key) for key, _ in rest)
            for key, value in rest:
                text.append(f"  {key.ljust(width)}  ", style=theme.ACCENT2)
                text.append(value, style=theme.TEXT)
                text.append("\n")
        self._args_view.update(text)

    def _paint_output(self) -> None:
        output = self._output
        if self._shell and output.startswith(self._shell):
            # el servidor suele devolver el comando repetido: no lo repetimos
            output = output[len(self._shell) :].lstrip("\n$ ")
        if not output.strip():
            self._output_view.display = False
            return
        self._output_view.display = True
        lines = output.rstrip().splitlines()
        hidden = max(0, len(lines) - self.MAX_OUTPUT_LINES)
        text = Text()
        for line in lines[: self.MAX_OUTPUT_LINES]:
            text.append(line, style=theme.DIM)
            text.append("\n")
        if hidden:
            text.append(f"  ▾ {hidden} líneas más", style=theme.FAINT)
        self._output_view.update(text)


class ApprovalPanel(Vertical):
    """Petición de aprobación: el usuario acepta o rechaza la acción."""

    class Approved(Message):
        """El usuario ha aprobado la acción."""

    class Rejected(Message):
        """El usuario ha rechazado la acción."""

    def __init__(self, tool: str, args: Any, description: str = "") -> None:
        super().__init__()
        self.add_class("approval-card")
        self._tool = tool
        self._args = args

        title = Text()
        title.append("⚠ ", style=theme.WARN)
        title.append("Aprobación requerida", style=f"bold {theme.WARN}")
        title.append(f"  ·  {tool}", style=theme.TEXT)
        self._title = Static(title)

        detail = Text()
        if description:
            detail.append(_truncate(description, 200), style=theme.DIM)
            detail.append("\n")
        try:
            raw = json.dumps(args, ensure_ascii=False, indent=2)
        except (TypeError, ValueError):
            raw = str(args)
        detail.append(_truncate(raw, 600), style=theme.DIM)
        self._detail = detail

        approve = Button("Aprobar", variant="primary")
        reject = Button("Rechazar", variant="error")
        approve.add_class("approve")
        reject.add_class("reject")
        self._buttons = Horizontal(approve, reject)

    def compose(self) -> ComposeResult:
        yield self._title
        yield Static(self._detail)
        yield self._buttons

    def on_button_pressed(self, event: Button.Pressed) -> None:
        event.stop()
        if event.button.has_class("approve"):
            self.post_message(self.Approved())
        else:
            self.post_message(self.Rejected())


class StatusBar(Horizontal):
    """Barra inferior: estado a la izquierda, avisos a la derecha."""

    def __init__(self, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self._spinner = LoadingIndicator()
        self._spinner.display = False
        self._text = Static(Text("listo", style=theme.DIM))
        self._text.id = "status-text"
        self._right = Static(Text("", style=theme.FAINT))
        self._right.id = "status-right"

    def compose(self) -> ComposeResult:
        yield self._spinner
        yield self._text
        yield self._right

    def set_status(self, text: str, style: str = theme.DIM) -> None:
        self._text.update(Text(text, style=style))

    def set_right(self, text: str, style: str = theme.FAINT) -> None:
        self._right.update(Text(text, style=style))

    def set_busy(self, busy: bool) -> None:
        self._spinner.display = busy
