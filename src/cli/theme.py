"""Tema visual del CLI: paleta monocroma, CSS de Textual y helpers de render.

Regla del proyecto: la interfaz es **acromática**. Solo blanco, negro y los
grises que hay entre medias. Cuando un estado necesita distinguirse (error,
aviso, foco, ejecución) se marca con *forma* —grosor de línea, peso de la
tipografía, glifos, inversión— y nunca con color, para que la app siga
leyéndose bien en terminales monocromos o con daltonismo.
"""

from __future__ import annotations

from string import Template

from rich.text import Text
from textual.theme import Theme

# ---------------------------------------------------------------------------
# Paleta: únicamente grises (#000 → #fff)
# ---------------------------------------------------------------------------
BG = "#090909"  # fondo de la app
PANEL = "#101010"  # barras (cabecera, pie) y prompt
PANEL_ALT = "#151515"  # tarjetas y burbujas
PANEL_HI = "#1c1c1c"  # superficies activas / hover
BORDER = "#242424"  # separadores y bordes en reposo
BORDER_HI = "#3d3d3d"  # bordes marcados
BORDER_FOCUS = "#8f8f8f"  # borde de foco
TEXT_HI = "#f2f2f2"  # texto destacado (blanco roto)
TEXT = "#c9c9c9"  # texto normal
DIM = "#8e8e8e"  # texto secundario
FAINT = "#5a5a5a"  # texto terciario, separadores

# "Acentos" neutros: sustituyen a los colores de la paleta original.
ACCENT = "#e4e4e4"  # acento principal (elementos activos)
ACCENT2 = "#a6a6a6"  # acento secundario (etiquetas, claves)

# Estados. El color solo es un refuerzo: el peso y el glifo hacen el trabajo.
OK = "#dcdcdc"
WARN = "#b0b0b0"
ERR = "#ffffff"

STYLE_OK = f"bold {OK}"
STYLE_WARN = f"bold {WARN}"
STYLE_ERR = f"bold {ERR}"

# ---------------------------------------------------------------------------
# Tema de Textual: neutraliza los widgets que trae de serie (Input, Button,
# OptionList, scrollbars, Markdown…) para que no metan un color suelto.
# ---------------------------------------------------------------------------
TEXTUAL_THEME = Theme(
    name="kli-mono",
    primary="#dcdcdc",
    secondary="#a6a6a6",
    accent=ACCENT,
    warning=WARN,
    error=ERR,
    success=OK,
    foreground=TEXT,
    background=BG,
    surface=PANEL,
    panel=PANEL_ALT,
    boost=PANEL_HI,
    dark=True,
    luminosity_spread=0.0,
    text_alpha=1.0,
    variables={
        # texto
        "text": TEXT,
        "text-muted": DIM,
        "text-disabled": FAINT,
        "foreground-muted": DIM,
        "foreground-disabled": FAINT,
        "text-primary": TEXT_HI,
        "text-secondary": ACCENT2,
        "text-warning": WARN,
        "text-error": ERR,
        "text-success": OK,
        "text-accent": ACCENT,
        # bordes y superficies
        "border": BORDER_FOCUS,
        "border-blurred": BORDER,
        "surface-active": PANEL_HI,
        # cursor de bloque (OptionList, tablas…)
        "block-cursor-foreground": BG,
        "block-cursor-background": ACCENT,
        "block-cursor-text-style": "bold",
        "block-cursor-blurred-foreground": TEXT,
        "block-cursor-blurred-background": PANEL_HI,
        "block-cursor-blurred-text-style": "none",
        "block-hover-background": PANEL_HI,
        # scrollbars
        "scrollbar": "#2e2e2e",
        "scrollbar-hover": "#454545",
        "scrollbar-active": "#666666",
        "scrollbar-background": BG,
        "scrollbar-corner-color": BG,
        "scrollbar-background-hover": PANEL,
        "scrollbar-background-active": PANEL_ALT,
        # enlaces
        "link-color": TEXT_HI,
        "link-color-hover": "#ffffff",
        "link-background": "transparent",
        "link-background-hover": PANEL_HI,
        "link-style": "underline",
        "link-style-hover": "bold underline",
        # input
        "input-cursor-background": ACCENT,
        "input-cursor-foreground": BG,
        "input-cursor-text-style": "none",
        "input-selection-background": "#3d3d3d",
        "input-selection-foreground": "#ffffff",
        # markdown
        "markdown-h1-color": TEXT_HI,
        "markdown-h1-background": "transparent",
        "markdown-h1-text-style": "bold",
        "markdown-h2-color": ACCENT,
        "markdown-h2-background": "transparent",
        "markdown-h2-text-style": "bold underline",
        "markdown-h3-color": TEXT,
        "markdown-h3-background": "transparent",
        "markdown-h3-text-style": "bold",
        "markdown-h4-color": ACCENT2,
        "markdown-h4-background": "transparent",
        "markdown-h4-text-style": "bold",
        "markdown-h5-color": DIM,
        "markdown-h5-background": "transparent",
        "markdown-h5-text-style": "none",
        "markdown-h6-color": FAINT,
        "markdown-h6-background": "transparent",
        "markdown-h6-text-style": "none",
        # botones y footer
        "button-foreground": TEXT,
        "button-color-foreground": BG,
        "button-focus-text-style": "reverse",
        "footer-key-foreground": ACCENT,
        # selección de texto
        "screen-selection-background": "#3d3d3d",
        "screen-selection-foreground": "#ffffff",
    },
)

# ---------------------------------------------------------------------------
# CSS de la app
# ---------------------------------------------------------------------------
_CSS_TEMPLATE = Template(
    """
Screen {
    background: $bg;
    color: $text;
}

/* ------------------------------ cabecera ------------------------------ */
#topbar {
    dock: top;
    /* 1 fila de texto + 1 del borde */
    height: 2;
    background: $panel;
    border-bottom: solid $border;
    padding: 0 2;
}
#brand {
    width: auto;
    height: 2;
    content-align: left middle;
}
#conn {
    width: 1fr;
    height: 2;
    padding-left: 1;
    content-align: right middle;
    text-overflow: ellipsis;
}

/* -------------------------------- cuerpo ------------------------------ */
#body { height: 1fr; }

#context {
    width: 32;
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

#chat-col { width: 1fr; }

/* --------------------------- pestañas de subagente ----------------------- */
#tab-strip {
    /* 1 fila de chips + 1 del borde inferior */
    height: 2;
    background: $panel;
    border-bottom: solid $border;
    padding: 0 2;
    overflow-x: auto;
    scrollbar-size-horizontal: 0;
    scrollbar-size-vertical: 0;
}
/* pastillas: superficie propia y la activa invertida */
.tab-chip {
    width: auto;
    height: 1;
    margin: 0 1 0 0;
    padding: 0 1;
    background: $panel_alt;
    content-align: left middle;
    color: $dim;
}
#panes { height: 1fr; }
#chat {
    height: 1fr;
    background: $bg;
    padding: 1 2 0 2;
    scrollbar-size-vertical: 1;
    scrollbar-size-horizontal: 0;
}
.subagent-pane {
    height: 1fr;
    background: $bg;
    padding: 1 2 0 2;
    scrollbar-size-vertical: 1;
    scrollbar-size-horizontal: 0;
}
.subagent-head {
    width: 100%;
    height: auto;
    margin: 0 0 1 0;
    color: $dim;
}
/* aviso del chat: superficie plana y clicable (al pulsarlo abre la ventana) */
.subagent-loader {
    width: 100%;
    height: auto;
    margin: 1 0 0 0;
    padding: 0 1;
    background: $panel_alt;
    color: $dim;
}
.subagent-loader:hover {
    background: $panel_hi;
}

/* ------------------------------- prompt ------------------------------- */
#prompt-row {
    height: 3;
    margin: 0 2 1 2;
    align: left middle;
    background: $panel;
    border: round $border;
}
#prompt-row:focus-within { border: round $border_focus; }
#prompt-mark {
    width: 2;
    height: 1;
    content-align: left middle;
    color: $faint;
    text-style: bold;
}
#prompt-row:focus-within #prompt-mark { color: $text_hi; }
#prompt {
    width: 1fr;
    height: 1;
    margin: 0;
    padding: 0 1;
    border: none;
    background: $panel;
    color: $text;
}
#prompt:focus { border: none; }
#prompt-note {
    width: 1fr;
    height: 1;
    padding: 0 1;
    color: $faint;
    content-align: left middle;
    /* oculta por defecto: solo aparece en la ventana de un subagente */
    display: none;
}

/* ------------------------------ burbujas ------------------------------ */
/* Todo el chat usa el mismo rail: 2 columnas de marca a la izquierda y el
   contenido a la derecha. Sin cajas ni bordes gruesos: la FORMA dice qué es
   cada cosa (bloque = tu, rombo = agente, punto = sistema, aspa = error). */
.user-bubble {
    width: 100%;
    height: auto;
    margin: 1 0 0 0;
}
.user-bubble .bubble-rail {
    width: 2;
    height: auto;
    content-align: left top;
}
.user-bubble .bubble-body {
    width: 1fr;
    height: auto;
    color: $text_hi;
}
.agent-bubble {
    width: 100%;
    height: auto;
    margin: 1 0 0 0;
}
.agent-label { color: $faint; }
.agent-body { color: $text; padding-left: 2; }
.system-note {
    width: 100%;
    height: auto;
    margin: 1 0 0 0;
    color: $dim;
}
.system-error {
    width: 100%;
    height: auto;
    margin: 1 0 0 0;
    color: $text_hi;
    text-style: bold;
}

/* ------------------------------ bienvenida ----------------------------- */
.welcome-splash {
    /* ocupa la primera pantalla del chat: el logo queda en el centro */
    height: 100%;
    width: 100%;
    align: center middle;
}
.welcome-banner {
    width: 100%;
    height: auto;
    margin: 0;
    content-align: center middle;
}
.welcome-note {
    width: 100%;
    height: auto;
    margin: 1 0 0 0;
    content-align: center middle;
    color: $dim;
}

/* ------------------------------ razonamiento --------------------------- */
/* bloque plano: se distingue por la superficie, no por un marco */
.reasoning-box {
    width: 100%;
    height: auto;
    margin: 0 0 0 0;
    padding: 0 0 0 2;
    background: $panel_alt;
    /* sin el borde "hkey" que Textual pone por defecto */
    border: none;
}
.reasoning-box Contents { padding: 0 0 0 0; }
.reasoning {
    /* el razonamiento es markdown: cursiva suave, pero el código sin cursiva */
    color: $dim;
    text-style: italic;
    /* sin el padding propio del markdown: así queda alineado con el chat */
    padding: 0;
}
.reasoning MarkdownFence { text-style: none; }
.reasoning MarkdownTable { text-style: none; }

/* -------------------------------- tools ------------------------------- */
/* la tool es una línea en la lista de llamadas: sin caja, como el detalle
   de una acción; el rail de la izquierda lo marca */
.tool-card {
    width: 100%;
    height: auto;
    margin: 0 0 0 0;
    padding: 0 0 0 2;
    background: $panel_alt;
    border: none;
}
.tool-card.state-run { background: $panel_hi; }
.tool-card.state-err { border-left: thick $text_hi; }
.tool-card Contents { padding: 0 0 0 0; }
.tool-name { color: $text_hi; text-style: bold; }
.tool-run { color: $accent; }
.tool-ok { color: $dim; }
.tool-err { color: $err; text-style: bold; }
.tool-out { color: $dim; }
/* la salida de la tool en markdown: sin marcos propios, inherits del chat */
.tool-md {
    width: 100%;
    height: auto;
    color: $text;
    padding: 0;
}

/* ------------------------------ aprobación ----------------------------- */
.approval-card {
    width: 100%;
    height: auto;
    margin: 0 0 1 0;
    padding: 0 1;
    background: $panel_hi;
    border: round $border_focus;
}
.approval-title { color: $text_hi; text-style: bold; }
.approval-args { color: $dim; }
.approve {
    height: 1;
    min-width: 12;
    background: $text_hi;
    color: $bg;
    text-style: bold;
    border: none;
}
.reject {
    height: 1;
    min-width: 12;
    background: $panel;
    color: $text;
    border: none;
}
/* el foco se marca invirtiendo: sin color ni bordes pesados */
.approve:focus { text-style: bold reverse; }
.reject:focus { text-style: reverse; }

/* ------------------------------ barra pie ----------------------------- */
#status {
    dock: bottom;
    height: 1;
    background: $panel;
    color: $dim;
}
/* el spinner de Textual ocupa el 100% por defecto: aquí solo 2 columnas */
#status LoadingIndicator { width: 2; }
#status-text { width: 1fr; height: 1; }
#status-right { width: auto; height: 1; color: $faint; }

/* --------------------------- paleta de comandos ------------------------ */
#palette-bg {
    align: center middle;
    background: $bg 70%;
}
#palette-box {
    width: 64;
    max-width: 92%;
    height: 24;
    max-height: 92%;
    background: $panel;
    border: round $border_focus;
    padding: 0 1;
}
#palette-title { color: $text_hi; text-style: bold; }
#palette-input { height: 3; border: tall $border; background: $panel_alt; }
#palette-input:focus { border: tall $border_focus; }
#palette-list { height: 1fr; background: $panel_alt; border: none; }
#palette-list > .option-list--option-highlighted {
    background: $accent;
    color: $bg;
    text-style: bold;
}
#palette-hint { color: $faint; height: 1; }
"""
)

CSS = _CSS_TEMPLATE.substitute(
    bg=BG,
    panel=PANEL,
    panel_alt=PANEL_ALT,
    panel_hi=PANEL_HI,
    border=BORDER,
    border_hi=BORDER_HI,
    border_focus=BORDER_FOCUS,
    text_hi=TEXT_HI,
    text=TEXT,
    dim=DIM,
    faint=FAINT,
    accent=ACCENT,
    accent2=ACCENT2,
    ok=OK,
    warn=WARN,
    err=ERR,
)


def brand(text: str = "kliccode") -> Text:
    """Marca de la cabecera: neutra y en negrita (sin degradado: no hay color)."""
    return Text(text, style=f"bold {TEXT_HI}")


def dot(connected: bool) -> str:
    """Glifo de estado de la conexión: relleno si va bien, hueco si no."""
    return "●" if connected else "○"
