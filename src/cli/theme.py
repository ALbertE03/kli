"""Tema visual del CLI: paleta, CSS de Textual y helpers de render."""

from __future__ import annotations

from string import Template

from rich.text import Text

# Paleta (estilo "midnight": fondo azul casi negro, acentos violeta/cian)
BG = "#0b0e14"
PANEL = "#11151f"
PANEL_ALT = "#0f131c"
BORDER = "#232a3b"
BORDER_HI = "#3b4a6b"
TEXT = "#c8d3f5"
DIM = "#6b7a99"
FAINT = "#454f6b"
ACCENT = "#bb9af7"  # violeta
ACCENT2 = "#7dcfff"  # cian
OK = "#9ece6a"
WARN = "#e0af68"
ERR = "#f7768e"

_CSS_TEMPLATE = Template(
    """
Screen {
    background: $bg;
    color: $text;
}

#topbar {
    dock: top;
    height: 3;
    background: $panel;
    border-bottom: solid $border;
    padding: 0 1;
}
#brand {
    width: auto;
    height: 3;
    content-align: left middle;
}
#conn {
    width: 1fr;
    height: 3;
    content-align: right middle;
}

#body { height: 1fr; }

#context {
    width: 34;
    background: $panel_alt;
    border-right: solid $border;
    padding: 1 1 0 1;
    overflow-y: auto;
    scrollbar-size-vertical: 1;
}
.section {
    color: $dim;
    text-style: bold;
    margin-top: 1;
}
.kv-key { color: $accent2; }
.kv-val { color: $text; }
.chip { color: $accent; }
.chip-on { color: $ok; text-style: bold; }
.chip-off { color: $faint; }

#chat-col { width: 1fr; }
#chat {
    height: 1fr;
    background: $bg;
    padding: 1 2 0 2;
    scrollbar-size-vertical: 1;
    scrollbar-size-horizontal: 0;
}
#prompt-row {
    height: 3;
    margin: 0 2 1 2;
    background: $panel;
    border: round $border;
}
#prompt-row:focus-within { border: round $accent; }
#prompt-mark {
    width: 2;
    height: 1;
    content-align: left middle;
    color: $accent;
    text-style: bold;
}
#prompt {
    width: 1fr;
    height: 1;
    margin: 0;
    border: none;
    background: $panel;
    color: $text;
}
#prompt:focus { border: none; }

.user-bubble {
    width: 100%;
    margin: 1 0 0 0;
    padding: 0 1;
    background: $panel_alt;
    border-left: thick $accent2;
    color: #dbe4ff;
}
.agent-bubble {
    width: 100%;
    height: auto;
    margin: 1 0 0 0;
    padding: 0 1;
    border-left: thick $accent;
}
.agent-label { color: $accent; text-style: bold; }
.agent-body { color: $text; }
.system-note {
    width: 100%;
    margin: 1 0 0 0;
    padding: 0 1;
    border-left: thick $faint;
}
.system-error {
    width: 100%;
    margin: 1 0 0 0;
    padding: 0 1;
    border-left: thick $err;
}
.reasoning-box {
    width: 100%;
    height: auto;
    margin: 0 0 0 0;
    padding: 0 0 0 1;
    background: $bg;
    border: round $border;
    border-top: none;
}
.reasoning-box Contents { padding: 0 0 0 1; }
.reasoning {
    color: $dim;
    text-style: italic;
}
.tool-card {
    width: 100%;
    height: auto;
    margin: 0 0 0 0;
    padding: 0 0 0 1;
    background: $panel_alt;
    border: round $border;
    border-top: none;
}
.tool-card.state-run { border: round $accent2; }
.tool-card.state-ok { border: round $border; }
.tool-card.state-err { border: round $err; }
.tool-card Contents { padding: 0 0 0 1; }
.tool-name { color: $warn; text-style: bold; }
.tool-run { color: $accent2; }
.tool-ok { color: $ok; }
.tool-err { color: $err; }
.tool-out { color: $dim; }

.approval-card {
    width: 100%;
    height: auto;
    margin: 0 0 1 0;
    padding: 0 1;
    background: $panel_alt;
    border: round $warn;
}
.approval-title { color: $warn; text-style: bold; }
.approval-args { color: $dim; }
.approve { background: $ok; color: $bg; }
.reject { background: $err; color: $bg; }

#status {
    dock: bottom;
    height: 1;
    background: $panel;
    color: $dim;
}
#status-text { width: 1fr; height: 1; }
#status-right { width: auto; height: 1; color: $faint; }

#palette-bg {
    align: center middle;
    background: $bg 70%;
}
#palette-box {
    width: 64;
    height: 24;
    background: $panel;
    border: round $border_hi;
    padding: 0 1;
}
#palette-title { color: $accent; text-style: bold; }
#palette-input { height: 3; border: round $border; background: $panel_alt; }
#palette-list { height: 1fr; background: $panel_alt; border: none; }
#palette-hint { color: $faint; height: 1; }
"""
)

CSS = _CSS_TEMPLATE.substitute(
    bg=BG,
    panel=PANEL,
    panel_alt=PANEL_ALT,
    border=BORDER,
    border_hi=BORDER_HI,
    text=TEXT,
    dim=DIM,
    faint=FAINT,
    accent=ACCENT,
    accent2=ACCENT2,
    ok=OK,
    warn=WARN,
    err=ERR,
)


def gradient(text: str, colors: tuple[str, ...] = (ACCENT, ACCENT2)) -> Text:
    """Pinta un texto con un degradado (para el logo de la cabecera)."""
    out = Text()
    if not text:
        return out
    for i, char in enumerate(text):
        out.append(char, style=f"bold {colors[i % len(colors)]}")
    return out
