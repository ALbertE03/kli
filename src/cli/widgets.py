"""Widgets propios del CLI: cabecera, panel de contexto, burbujas, tools y aprobaciones."""

from __future__ import annotations

import json
import re
import time
from collections.abc import Sequence
from typing import Any, ClassVar

from rich.text import Text
from textual import work
from textual.app import ComposeResult
from textual.await_complete import AwaitComplete
from textual.binding import Binding
from textual.containers import Horizontal, Vertical
from textual.message import Message
from textual.suggester import Suggester
from textual.timer import Timer
from textual.widgets import (
    Button,
    Collapsible,
    Input,
    LoadingIndicator,
    Markdown,
    Static,
)

from cli import theme

# ---------------------------------------------------------------------------
# Markdown: cuándo un texto se dibuja como markdown y cuándo tal cual
# ---------------------------------------------------------------------------
_MD_BLOCK = re.compile(r"^\s*(#{1,6}\s|[-*+]\s|\d+[.)]\s|>\s|```|\|)", re.MULTILINE)
_MD_INLINE = re.compile(r"(\*\*|__|`[^`]+`|\[[^\]]+\]\([^)]+\))")


def looks_like_markdown(text: str) -> bool:
    """¿El texto es markdown de verdad o es la salida cruda de una tool?"""
    return bool(_MD_BLOCK.search(text) or _MD_INLINE.search(text))


def clip_markdown(text: str, max_lines: int) -> str:
    """Recorta un markdown a N líneas cerrando el bloque de código si quedó abierto."""
    lines = text.rstrip().splitlines()
    if len(lines) <= max_lines:
        return text
    clipped = "\n".join(lines[:max_lines])
    if clipped.count("```") % 2 == 1:  # el bloque de código quedó abierto
        clipped += "\n```"
    return clipped + f"\n\n_… {len(lines) - max_lines} líneas más_"

__all__ = [
    "AgentMessage",
    "ApprovalPanel",
    "CommandSuggester",
    "ContextPanel",
    "ErrorNote",
    "Prompt",
    "ReasoningPanel",
    "StatusBar",
    "SubagentLoader",
    "SystemNote",
    "TabChip",
    "TabStrip",
    "ToolCard",
    "TopBar",
    "UserMessage",
    "WelcomeBanner",
    "WelcomeNote",
    "WelcomeSplash",
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


class Prompt(Input):
    """Input del prompt: `tab` acepta la sugerencia del autocompletado.

    Textual solo liga la flecha derecha a la sugerencia y usa `tab` para
    mover el foco; aquí `tab` completa (y repetido recorre las opciones) y
    `shift+tab` sigue moviendo el foco.
    """

    BINDINGS: ClassVar[list[Binding | tuple[str, str] | tuple[str, str, str]]] = [
        Binding("tab", "accept_suggestion", "Completar", show=False),
    ]

    def __init__(self, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self._base: str | None = None  # valor sobre el que se completa
        self._index = 0
        self._applied: str | None = None  # último valor puesto por nosotros

    def action_accept_suggestion(self) -> None:
        """Completa el comando o su argumento; repetirlo recorre las opciones."""
        suggester = self.suggester
        if not isinstance(suggester, CommandSuggester):
            suggestion = self._suggestion
            if suggestion and suggestion.startswith(self.value):
                self.value = suggestion
                self.cursor_position = len(self.value)
                self._suggestion = ""
            return
        if self.value == self._applied:
            # segunda pulsación: recorremos las opciones del mismo valor
            base = self._base or self.value
            matches = suggester.matches(base)
            if not matches:
                self._reset_completion()
                return
            self._index = (self._index + 1) % len(matches)
        else:
            # el usuario ha escrito: serie nueva de completados
            base = self.value
            matches = suggester.matches(base)
            if not matches:
                self._reset_completion()
                return
            # si lo escrito ya es un match exacto, vamos al siguiente
            self._index = 1 % len(matches) if matches[0] == base else 0
        self._base = base
        self.value = matches[self._index]
        self._applied = self.value
        self.cursor_position = len(self.value)
        self._suggestion = ""

    def _reset_completion(self) -> None:
        self._base = None
        self._index = 0
        self._applied = None


class MarkdownBody(Markdown):
    """Markdown que se repinta sin dejar promesas sin recoger.

    Textual devuelve un `AwaitComplete`; si nadie lo espera y falla, Python
    avisa por consola. Aquí la actualización va en un worker.
    """

    @work(exclusive=True)
    async def set_markdown(self, text: str) -> None:
        await self.update(text)


class CommandSuggester(Suggester):
    """Autocompletado del prompt: comandos slash y el valor que les sigue.

    `/mo` → `/mode` · `/mode ` → `plan` · `/skill ` → `investigacion`
    """

    def __init__(self, app: Any) -> None:
        super().__init__()
        self._app = app

    async def get_suggestion(self, value: str) -> str | None:
        matches = self.matches(value)
        return matches[0] if matches else None

    def matches(self, value: str) -> list[str]:
        """Todas las completaciones posibles para el valor, en orden."""
        if not value:
            return []
        if " " in value:
            head, _, tail = value.rpartition(" ")
            return [f"{head} {opt}" for opt in self._options(head) if opt.startswith(tail)]
        return [cmd for cmd in self._commands() if cmd.startswith(value)]

    def _commands(self) -> list[str]:
        return list(getattr(self._app, "SLASH_COMMANDS", ()))

    def _options(self, head: str) -> list[str]:
        """Valores posibles para el argumento de un comando."""
        registry = getattr(self._app, "registry", None) or {}
        if head == "/mode":
            return [str(item.get("name", "")) for item in registry.get("modes", [])]
        if head == "/provider":
            return [str(item.get("name", "")) for item in registry.get("providers", [])]
        if head == "/skill":
            return [str(item.get("name", "")) for item in registry.get("skills", [])]
        if head == "/project":
            return [str(item.get("name", "")) for item in registry.get("projects", [])]
        return []


class TopBar(Horizontal):
    """Cabecera: marca a la izquierda y estado de la conexión a la derecha."""

    def __init__(self, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self._version = ""
        self._base_url = ""
        self._user = ""
        self._brand = Static(Text(""), id="brand")
        self._status = Static(Text("conectando…", style=theme.STYLE_WARN), id="conn")
        self._paint()

    def compose(self) -> ComposeResult:
        yield self._brand
        yield self._status

    def set_connected(self, version: str, base_url: str, user: str) -> None:
        self._version = version
        self._base_url = base_url
        self._user = user
        right = Text()
        right.append(f"{theme.dot(True)} ", style=theme.OK)
        right.append(f"{base_url}", style=theme.TEXT)
        right.append(" · ", style=theme.FAINT)
        right.append(f"user {user}", style=theme.DIM)
        right.append(" · ", style=theme.FAINT)
        right.append(f"v{version}", style=theme.FAINT)
        self._status.update(right)

    def set_user(self, user: str) -> None:
        """Cambia el usuario que se muestra en la cabecera."""
        self._user = user
        if self._base_url:
            self.set_connected(self._version, self._base_url, user)

    def set_disconnected(self, reason: str) -> None:
        status = Text()
        status.append(f"{theme.dot(False)} ", style=theme.ERR)
        status.append(reason, style=theme.STYLE_ERR)
        self._status.update(status)

    def _paint(self) -> None:
        brand = Text()
        brand.append("◆ ", style=f"bold {theme.ACCENT}")
        brand.append_text(theme.brand())
        brand.append("  ")
        brand.append("agentic harness", style=theme.FAINT)
        self._brand.update(brand)


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
            # hairline discontinuo: menos ruido que una línea completa
            text.append("┈" * 26 + " ", style=theme.BORDER)
            text.append("\n")
            text.append(title.upper(), style=f"bold {theme.DIM}")
            text.append("\n")

        def item(label: str, value: str, value_style: str = theme.TEXT) -> None:
            text.append(f"  {label} ", style=theme.ACCENT2)
            text.append(value, style=value_style)
            text.append("\n")

        mode = str(d.get("mode") or "plan")
        section("modo")
        item("◆", mode, f"bold {theme.ACCENT}")
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
                text.append(name, style=f"bold {theme.TEXT_HI}")
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


class UserMessage(Horizontal):
    """Mensaje del usuario: marca a la izquierda y texto plano (sin markup).

    El texto va en su propia columna para que las líneas largas se alineen
    con el resto del chat.
    """

    def __init__(self, text: str) -> None:
        super().__init__()
        self.add_class("user-bubble")
        self._rail = Static(Text("▌", style=f"bold {theme.ACCENT}"))
        self._rail.add_class("bubble-rail")
        self._body = Static(Text(text, style=theme.TEXT_HI))
        self._body.add_class("bubble-body")

    def compose(self) -> ComposeResult:
        yield self._rail
        yield self._body


# ---------------------------------------------------------------------------
# Banner de bienvenida: la palabra "kliccode" en grande (píxeles de bloques)
# con una letra viva. Fuente de 5 filas, cada letra con ancho fijo.
# ---------------------------------------------------------------------------
BANNER_FONT: dict[str, tuple[str, ...]] = {
    "k": ("█  █", "█  █", "███ ", "█ █ ", "█  █"),
    "l": ("█ ", "█ ", "█ ", "█ ", "██"),
    "i": ("█", " ", "█", "█", "█"),
    "c": (" ██ ", "█   ", "█   ", "█   ", " ██ "),
    "o": (" ██ ", "█  █", "█  █", "█  █", " ██ "),
    "d": ("   █", " ██ ", "█ █ ", "█ █ ", " ██ "),
    "e": (" ██ ", "█  █", "███ ", "█   ", " ██ "),
}

# Fotogramas de la letra animada: el punto parpadea y el trazo late.
BANNER_FRAMES: tuple[tuple[str, ...], ...] = (
    ("█", " ", "█", "█", "█"),
    ("▓", " ", "▒", "▒", "▒"),
    ("█", " ", "█", "█", "█"),
    ("▒", " ", "░", "░", "░"),
)


class WelcomeBanner(Static):
    """'kliccode' en grande con una letra que se mueve (todo en grises)."""

    WORD = "kliccode"
    ANIMATED = 2  # índice de la letra animada: la 'i'
    ROWS = 5
    FRAME_TIME = 0.28

    def __init__(self, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self._frame = 0
        self.add_class("welcome-banner")

    # ---------------- ciclo ----------------
    def on_mount(self) -> None:
        self._paint()
        self.set_interval(self.FRAME_TIME, self._tick)

    def on_resize(self) -> None:
        self._paint()

    def _tick(self) -> None:
        self._frame = (self._frame + 1) % len(BANNER_FRAMES)
        self._paint()

    # ---------------- pintado ----------------
    @property
    def width_needed(self) -> int:
        """Ancho que ocupa el banner grande (letras + separadores)."""
        widths = sum(len(BANNER_FONT[letter][0]) for letter in self.WORD)
        return widths + len(self.WORD) - 1

    def _paint(self) -> None:
        width = self.size.width
        if width and width < self.width_needed:
            self.update(self._compact())
            return
        text = Text()
        for row in range(self.ROWS):
            for index, letter in enumerate(self.WORD):
                animated = index == self.ANIMATED
                art = BANNER_FRAMES[self._frame] if animated else BANNER_FONT[letter]
                style = f"bold {theme.ACCENT}" if animated else f"bold {theme.TEXT_HI}"
                text.append(art[row], style=style)
                if index < len(self.WORD) - 1:
                    text.append(" ")
            text.append("\n")
        # regla bajo la palabra: el bloque queda centrado como un conjunto
        text.append("─" * self.width_needed, style=theme.FAINT)
        self.update(text)

    def _compact(self) -> Text:
        """Versión de una línea para terminales estrechas."""
        text = Text()
        for index, letter in enumerate(self.WORD):
            if index == self.ANIMATED:
                # sin bloques: la letra late cambiando de brillo
                style = theme.TEXT_HI if self._frame % 2 == 0 else theme.FAINT
                text.append(letter, style=f"bold {style}")
            else:
                text.append(letter, style=f"bold {theme.TEXT_HI}")
        return text


class WelcomeNote(Static):
    """Línea de ayuda bajo el banner: servidor, usuario y atajos."""

    def __init__(self, base_url: str, user: str) -> None:
        super().__init__()
        self.add_class("welcome-note")
        text = Text()
        text.append("listo", style=f"bold {theme.ACCENT}")
        text.append("  ·  ", style=theme.FAINT)
        text.append(base_url, style=theme.DIM)
        text.append("  ·  ", style=theme.FAINT)
        text.append("user ", style=theme.FAINT)
        text.append(user, style=theme.DIM)
        text.append("\n")
        text.append("/help", style=theme.ACCENT2)
        text.append(" · ", style=theme.FAINT)
        text.append("ctrl+p", style=theme.ACCENT2)
        text.append(" paleta · ", style=theme.FAINT)
        text.append("tab", style=theme.ACCENT2)
        text.append(" completa · ", style=theme.FAINT)
        text.append("esc", style=theme.ACCENT2)
        text.append(" detener", style=theme.FAINT)
        self.update(text)


class WelcomeSplash(Vertical):
    """Pantalla de inicio: el logo centrado y los atajos debajo.

    Ocupa la primera pantalla del chat; al escribir, se queda en el
    historial y la conversación sigue debajo.
    """

    def __init__(self, base_url: str, user: str) -> None:
        super().__init__()
        self.add_class("welcome-splash")
        self._base_url = base_url
        self._user = user

    def compose(self) -> ComposeResult:
        yield WelcomeBanner()
        yield WelcomeNote(self._base_url, self._user)


class AgentMessage(Vertical):
    """Respuesta del agente: etiqueta + cuerpo en Markdown."""

    def __init__(self, label: str = "assistant") -> None:
        super().__init__()
        self.add_class("agent-bubble")
        self._label = Static(Text(f"◆ {label}", style=theme.FAINT))
        self._label.add_class("agent-label")
        self.body = Markdown("")
        self.body.add_class("agent-body")

    def compose(self) -> ComposeResult:
        yield self._label
        yield self.body

    def set_text(self, text: str) -> AwaitComplete:
        return self.body.update(text)


class ReasoningPanel(Collapsible):
    """Razonamiento del modelo: markdown en vivo, plegable."""

    # el markdown se reparsea en cada trozo: no hace falta más de 8 veces/s
    MIN_INTERVAL = 0.12

    def __init__(self) -> None:
        self._body = MarkdownBody("")
        self._body.add_class("reasoning")
        self._text = ""
        self._last = 0.0
        super().__init__(
            self._body,
            title="razonamiento",
            # el pensamiento se ve siempre: se puede plegar con enter/click
            collapsed=False,
            classes="reasoning-box",
        )
        _set_title(self, Text("razonamiento", style=theme.FAINT))

    def append(self, text: str) -> None:
        """Añade texto al razonamiento (se dibuja como markdown)."""
        self._text += text
        now = time.monotonic()
        if now - self._last < self.MIN_INTERVAL:
            return
        self._last = now
        self._body.set_markdown(self._text)

    def flush(self) -> None:
        """Fuerza el dibujado de lo que falte (fin del turno)."""
        self._last = 0.0
        self._body.set_markdown(self._text)


class SystemNote(Markdown):
    """Aviso del sistema (conexión, cambios de contexto, errores)."""

    def __init__(self, text: str, error: bool = False) -> None:
        super().__init__(f"✗ {text}" if error else f"· {text}")
        self.add_class("system-error" if error else "system-note")


class ErrorNote(Markdown):
    """Error con contexto: qué pasó, el detalle y qué hacer al respecto.

    Un error sin salida es un callejón sin salida: aquí siempre se dice
    también el siguiente paso.
    """

    def __init__(self, title: str, detail: str = "", hints: Sequence[str] = ()) -> None:
        blocks = [f"✗ **{title}**"]
        if detail:
            blocks.append(detail)
        if hints:
            blocks.append("**Qué hacer**\n\n" + "\n".join(f"· {hint}" for hint in hints))
        super().__init__("\n\n".join(blocks))
        self.add_class("system-error")


class ToolCard(Collapsible):
    """Llamada a una tool: una línea resumen y el detalle plegable.

    La línea muestra el estado, el nombre y el argumento clave (para tener
    una lista de llamadas escaneable); dentro van los argumentos —legibles,
    no volcados de dict— y la salida, que se dibuja como markdown cuando el
    texto lo es.
    """

    ICONS: ClassVar[dict[str, str]] = {"run": "◐", "ok": "✓", "err": "✗"}
    LABELS: ClassVar[dict[str, str]] = {"run": "ejecutando", "ok": "listo", "err": "error"}
    # argumentos que resumen mejor la llamada
    KEY_ARGS: ClassVar[tuple[str, ...]] = (
        "command",
        "path",
        "file_path",
        "notebook_path",
        "pattern",
        "query",
        "question",
        "url",
    )
    MAX_OUTPUT_LINES = 12
    MAX_MD_LINES = 40

    def __init__(self, name: str, agent: str | None = None) -> None:
        self._tool_name = name
        self._agent = agent
        self._state = "run"
        self._args: list[tuple[str, str]] = []
        self._shell: str | None = None
        self._output = ""
        self._args_view = Static()
        self._output_view = Static()
        self._output_md = MarkdownBody()
        self._output_md.add_class("tool-md")
        super().__init__(
            self._args_view,
            self._output_view,
            self._output_md,
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

        icon_style = {
            "run": theme.ACCENT,
            "ok": theme.DIM,
            "err": theme.ERR,
        }[self._state]
        label_style = {
            "run": theme.STYLE_WARN,
            "ok": theme.DIM,
            "err": theme.STYLE_ERR,
        }[self._state]

        title = Text()
        title.append(f"{self.ICONS[self._state]} ", style=icon_style)
        title.append(self._tool_name, style=f"bold {theme.TEXT_HI}")
        key = self._key_arg()
        if key:
            title.append("  ", style=theme.FAINT)
            title.append(key, style=theme.TEXT)
        if self._agent:
            title.append(f"  @{self._agent}", style=theme.FAINT)
        title.append(" · ")
        title.append(self.LABELS[self._state], style=label_style)
        _set_title(self, title)

        self._paint_args()
        self._paint_output()

    def _key_arg(self) -> str:
        """El argumento que mejor resume la llamada (para la línea de título)."""
        if self._shell is not None:
            return _one_line(self._shell, 70)
        for key, value in self._args:
            if key in self.KEY_ARGS:
                return _one_line(value, 70)
        for _, value in self._args:
            if 0 < len(value) <= 70:
                return value
        return ""

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
        if self._shell:
            # el servidor suele devolver el comando repetido: no lo repetimos
            for prefix in (f"$ {self._shell}", self._shell):
                if output.startswith(prefix):
                    output = output[len(prefix) :].lstrip("\n$ ")
                    break
        if not output.strip():
            self._output_view.display = False
            self._output_md.display = False
            return
        if looks_like_markdown(output):
            # el texto de la tool es markdown (resúmenes, listas, tablas…)
            self._output_view.display = False
            self._output_md.display = True
            self._output_md.set_markdown(clip_markdown(output, self.MAX_MD_LINES))
            return
        # si no, es la salida cruda (código, logs): se muestra tal cual
        self._output_md.display = False
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

    def focus_first(self) -> None:
        """Pone el foco en el primer botón: la aprobación se decide con el teclado."""
        for button in self.query(Button):
            button.focus()
            return

    def __init__(self, tool: str, args: Any, description: str = "") -> None:
        super().__init__()
        self.add_class("approval-card")
        self._tool = tool
        self._args = args

        title = Text()
        title.append("! ", style=theme.ACCENT)
        title.append("Aprobación requerida", style=f"bold {theme.TEXT_HI}")
        title.append(f"  ·  {tool}", style=theme.DIM)
        self._title = Static(title)

        # la descripción la escribe el modelo: puede venir en markdown
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
        self._description = _truncate(description, 400) if description else ""

        approve = Button("Aprobar", variant="primary")
        reject = Button("Rechazar", variant="error")
        approve.add_class("approve")
        reject.add_class("reject")
        self._buttons = Horizontal(approve, reject)

    def compose(self) -> ComposeResult:
        yield self._title
        if self._description and looks_like_markdown(self._description):
            # la descripción del modelo puede venir en markdown
            yield Markdown(self._description)
            yield Static(self._detail)
        else:
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


# ---------------------------------------------------------------------------
# Subagentes: aviso en el chat, tira de pestañas y ventana del subagente
# ---------------------------------------------------------------------------

# Spinner en braille: monocromo y sin dependencias.
SPINNER = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"
SPINNER_TIME = 0.12


class SubagentLoader(Static):
    """Aviso del chat principal: hay un subagente trabajando.

    Es clicable: al pulsarlo se abre la ventana del subagente.
    """

    class Open(Message):
        """El usuario ha pulsado el aviso: abrir la ventana del subagente."""

        def __init__(self, name: str) -> None:
            super().__init__()
            self.name = name

    def __init__(self, name: str) -> None:
        super().__init__()
        self.add_class("subagent-loader")
        self._agent_name = name
        self._state = "run"
        self._frame = 0
        self._timer: Timer | None = None

    def on_mount(self) -> None:
        self._timer = self.set_interval(SPINNER_TIME, self._tick)
        self._paint()

    def on_click(self) -> None:
        self.post_message(self.Open(self._agent_name))

    def set_done(self) -> None:
        """El subagente ha terminado (deja de girar)."""
        self._state = "ok"
        self._stop()
        self._paint()

    def set_error(self) -> None:
        """El subagente ha fallado."""
        self._state = "err"
        self._stop()
        self._paint()

    def _stop(self) -> None:
        if self._timer is not None:
            self._timer.stop()
            self._timer = None

    def _tick(self) -> None:
        self._frame = (self._frame + 1) % len(SPINNER)
        self._paint()

    def _paint(self) -> None:
        text = Text()
        if self._state == "run":
            text.append(f"{SPINNER[self._frame]} ", style=theme.ACCENT)
            text.append(f"subagente {self._agent_name}", style=f"bold {theme.TEXT_HI}")
            text.append("  trabajando…", style=theme.DIM)
        elif self._state == "ok":
            text.append("✓ ", style=theme.OK)
            text.append(f"subagente {self._agent_name}", style=f"bold {theme.TEXT_HI}")
            text.append("  terminado", style=theme.DIM)
        else:
            text.append("✗ ", style=theme.STYLE_ERR)
            text.append(f"subagente {self._agent_name}", style=f"bold {theme.TEXT_HI}")
            text.append("  falló", style=theme.STYLE_ERR)
        text.append("   clic para abrir", style=theme.FAINT)
        self.update(text)


class TabChip(Static):
    """Pestaña de la tira: la conversación principal o un subagente."""

    class Pressed(Message):
        """El usuario ha pulsado la pestaña."""

        def __init__(self, key: str) -> None:
            super().__init__()
            self.key = key

    def __init__(self, key: str, label: str) -> None:
        super().__init__()
        self.add_class("tab-chip")
        self._key = key
        self._label = label
        self._state = "idle"
        self._selected = False
        self._frame = 0
        self._paint()

    def on_click(self) -> None:
        self.post_message(self.Pressed(self._key))

    def tick(self) -> None:
        """Avanza la animación del spinner (lo llama la tira)."""
        self._frame = (self._frame + 1) % len(SPINNER)
        if self._state == "run":
            self._paint()

    def set_state(self, state: str) -> None:
        """`idle` (conversación), `run` (trabajando), `ok` o `err`."""
        self._state = state
        self._paint()

    def set_selected(self, selected: bool) -> None:
        if self._selected != selected:
            self._selected = selected
            self._paint()

    def _paint(self) -> None:
        if self._selected:
            # invertida: así se distingue sin usar color
            style = f"bold {theme.BG} on {theme.TEXT_HI}"
            glyph_style = style
        else:
            style = theme.DIM
            glyph_style = theme.ACCENT2 if self._state == "run" else theme.FAINT
        text = Text()
        if self._state == "run":
            text.append(SPINNER[self._frame], style=glyph_style)
            text.append(" ", style=style)
        elif self._state == "ok":
            text.append("✓ ", style=glyph_style)
        elif self._state == "err":
            text.append("✗ ", style=glyph_style)
        text.append(self._label, style=style)
        self.update(text)


class TabStrip(Horizontal):
    """Tira de pestañas: la conversación y una ventana por subagente."""

    def __init__(self, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self.add_class("tab-strip")
        self._chips: dict[str, TabChip] = {}

    def compose(self) -> ComposeResult:
        chip = TabChip("chat", "chat")
        self._chips["chat"] = chip
        yield chip

    def on_mount(self) -> None:
        self.set_interval(SPINNER_TIME, self._tick)
        self.set_selected("chat")

    def _tick(self) -> None:
        for chip in self._chips.values():
            chip.tick()

    def add_tab(self, key: str, label: str) -> TabChip:
        """Añade (o reutiliza) la pestaña de una clave."""
        chip = self._chips.get(key)
        if chip is None:
            chip = TabChip(key, label)
            self._chips[key] = chip
            self.mount(chip)
        return chip

    def set_state(self, key: str, state: str) -> None:
        chip = self._chips.get(key)
        if chip is not None:
            chip.set_state(state)

    def set_selected(self, key: str) -> None:
        for chip_key, chip in self._chips.items():
            chip.set_selected(chip_key == key)

    def remove_tab(self, key: str) -> None:
        """Quita la pestaña de una clave (al cerrar la ventana del subagente)."""
        chip = self._chips.pop(key, None)
        if chip is not None:
            chip.remove()

    def keys(self) -> list[str]:
        """Claves de las pestañas abiertas."""
        return list(self._chips)
