"""Registro central de tools, skills y modos, con visibilidad por usuario."""

import logging
import re
from collections.abc import Callable, Iterable
from dataclasses import dataclass

from langchain_core.tools import BaseTool

from harness.errors import Conflict, InvalidConfig, NotFound
from harness.types import Mode, Skill, ToolCategory, ToolInfo

log = logging.getLogger(__name__)

# Nombres que deepagents ya expone: registrarlos provocaría colisión de tools.
RESERVED_TOOL_NAMES = frozenset(
    {"task", "write_todos", "ls", "read_file", "write_file", "edit_file", "glob", "grep", "execute"}
)

# Tools "opt-in": no entran en el prompt hasta que se piden explícitamente.
# La búsqueda web y el deep research son caras de describir (y de usar): si no
# hacen falta, cargar sus esquemas es tokens de entrada tirados.
GATED_TOOL_NAMES = frozenset({"web_search", "deep_search"})

_TOOL_NAME_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


@dataclass(frozen=True)
class ToolEntry:
    tool: BaseTool
    category: ToolCategory
    owner: str | None = None  # None = tool del sistema
    opt_in: bool = False  # solo se carga si se pide


class Registry:
    def __init__(self) -> None:
        self._tools: dict[tuple[str | None, str], ToolEntry] = {}
        self._skills: dict[tuple[str | None, str], Skill] = {}
        self._modes: dict[str, Mode] = {}
        self.version = 0  # invalida la caché de agentes cuando cambia algo

    # ---------------- tools ----------------
    def add_tool(
        self, tool: BaseTool, category: ToolCategory, owner: str | None = None
    ) -> BaseTool:
        name = tool.name
        if not _TOOL_NAME_RE.match(name):
            raise InvalidConfig(f"Nombre de tool inválido: {name!r}")
        if name in RESERVED_TOOL_NAMES:
            raise Conflict(f"'{name}' es un nombre reservado por deepagents")
        if (None, name) in self._tools or (owner, name) in self._tools:
            raise Conflict(f"Tool duplicada: {name}")
        if not tool.handle_tool_error:
            tool.handle_tool_error = True  # los errores vuelven al modelo como texto
        self._tools[(owner, name)] = ToolEntry(
            tool, category, owner, opt_in=name in GATED_TOOL_NAMES
        )
        self.version += 1
        return tool

    def remove_tool(self, name: str, owner: str | None) -> None:
        if self._tools.pop((owner, name), None) is None:
            raise NotFound(f"Tool no encontrada: {name}")
        self.version += 1

    def _lookup(self, name: str, user_id: str | None) -> ToolEntry | None:
        return self._tools.get((None, name)) or (
            self._tools.get((user_id, name)) if user_id else None
        )

    def list_tools(self, user_id: str | None) -> list[ToolInfo]:
        return sorted(
            (
                ToolInfo(
                    name=e.tool.name,
                    description=(e.tool.description or "")[:200],
                    category=e.category,
                    owner=e.owner,
                    opt_in=e.opt_in,
                )
                for (owner, _), e in self._tools.items()
                if owner is None or owner == user_id
            ),
            key=lambda t: t.name,
        )

    def is_gated(self, name: str) -> bool:
        """¿La tool es opt-in (solo se carga si se pide)?"""
        entry = self._tools.get((None, name))
        return bool(entry and entry.opt_in)

    def gated_tools(self) -> list[str]:
        """Nombres de las tools del sistema que son opt-in."""
        return sorted(
            name for (owner, name), e in self._tools.items() if owner is None and e.opt_in
        )

    def require_tools(self, names: Iterable[str], user_id: str | None) -> None:
        missing = [n for n in dict.fromkeys(names) if self._lookup(n, user_id) is None]
        if missing:
            raise InvalidConfig(f"Tools desconocidas: {', '.join(missing)}")

    def resolve_tools(
        self,
        names: Iterable[str],
        allowed: frozenset[ToolCategory],
        user_id: str | None,
        *,
        strict: bool = False,
    ) -> list[BaseTool]:
        """Devuelve solo las tools visibles para el usuario y permitidas por categoría."""
        result: list[BaseTool] = []
        for name in dict.fromkeys(names):
            entry = self._lookup(name, user_id)
            if entry is None:
                if strict:
                    raise NotFound(f"Tool desconocida: {name}")
                log.warning("Tool '%s' no disponible; se omite", name)
                continue
            if entry.category in allowed:
                result.append(entry.tool)
            else:
                log.debug("Tool '%s' (%s) bloqueada por el modo", name, entry.category)
        return result

    # ---------------- skills ----------------
    def add_skill(self, skill: Skill) -> Skill:
        key = (skill.owner, skill.name)
        if (None, skill.name) in self._skills or key in self._skills:
            raise Conflict(f"Skill duplicada: {skill.name}")
        self._skills[key] = skill
        self.version += 1
        return skill

    def remove_skill(self, name: str, owner: str | None) -> None:
        if self._skills.pop((owner, name), None) is None:
            raise NotFound(f"Skill no encontrada: {name}")
        self.version += 1

    def get_skill(self, name: str, user_id: str | None) -> Skill:
        skill = self._skills.get((None, name)) or self._skills.get((user_id, name))
        if skill is None:
            raise NotFound(f"Skill desconocida: {name}")
        return skill

    def list_skills(self, user_id: str | None) -> list[Skill]:
        return sorted(
            (s for (owner, _), s in self._skills.items() if owner is None or owner == user_id),
            key=lambda s: s.name,
        )

    # ---------------- modos ----------------
    def add_mode(self, mode: Mode) -> Mode:
        self._modes[mode.name] = mode
        self.version += 1
        return mode

    def get_mode(self, name: str) -> Mode:
        try:
            return self._modes[name]
        except KeyError:
            raise NotFound(f"Modo desconocido: {name}") from None

    def list_modes(self) -> list[Mode]:
        return sorted(self._modes.values(), key=lambda m: m.name)


registry = Registry()


def register_tool(category: ToolCategory) -> Callable[[BaseTool], BaseTool]:
    """Decorador para plugins: @register_tool(ToolCategory.READ) sobre un @tool."""

    def decorator(tool: BaseTool) -> BaseTool:
        return registry.add_tool(tool, category)

    return decorator
