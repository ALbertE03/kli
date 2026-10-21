"""Tools de memoria a largo plazo (por usuario) sobre el Store de LangGraph."""

from langchain_core.runnables import RunnableConfig
from langchain_core.tools import tool

from harness.memory import get_memory
from harness.registry import register_tool
from harness.types import ToolCategory


def _user(config: RunnableConfig) -> str:
    return str((config.get("configurable") or {}).get("user_id", "anonymous"))


@register_tool(ToolCategory.MEMORY)
@tool("remember")
async def remember(text: str, config: RunnableConfig, tags: list[str] | None = None) -> str:
    """Guarda un hecho duradero sobre el usuario o sus preferencias en la memoria a largo plazo.
    No guardes secretos, claves ni datos efímeros."""
    key = await get_memory().long_term.remember(_user(config), text, tags)
    return f"Recordado (id: {key})"


@register_tool(ToolCategory.MEMORY)
@tool("recall")
async def recall(query: str, config: RunnableConfig, limit: int = 5) -> str:
    """Busca en la memoria a largo plazo recuerdos relevantes para la consulta."""
    items = await get_memory().long_term.recall(_user(config), query, min(max(limit, 1), 20))
    if not items:
        return "No hay recuerdos relevantes."
    return "\n".join(f"[{i.key}] {i.text}" for i in items)


@register_tool(ToolCategory.MEMORY)
@tool("forget")
async def forget(key: str, config: RunnableConfig) -> str:
    """Elimina un recuerdo por su id (el que devuelve `recall`)."""
    ok = await get_memory().long_term.forget(_user(config), key)
    return "Olvidado." if ok else "No existe ese recuerdo."
