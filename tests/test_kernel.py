"""Tests del kernel: qué tools se cargan en cada pedido.

La búsqueda web (web_search/deep_search) es opt-in: hasta que el usuario la
pide, no se carga en el prompt (ahorra tokens de entrada).
"""

from langchain_core.tools import tool

from harness.kernel import AgentRequest, select_tool_names
from harness.registry import Registry
from harness.types import Mode, Skill, ToolCategory


@tool("web_search")
def web_search(query: str) -> str:
    """Busca en la web y devuelve resultados."""
    return ""


@tool("deep_search")
def deep_search(question: str) -> str:
    """Investigación en profundidad con citas."""
    return ""


@tool("fs_read_file")
def fs_read_file(path: str) -> str:
    """Lee un fichero del proyecto."""
    return ""


def make() -> Registry:
    r = Registry()
    r.add_tool(web_search, ToolCategory.NETWORK)
    r.add_tool(deep_search, ToolCategory.NETWORK)
    r.add_tool(fs_read_file, ToolCategory.READ)
    return r


def plan_mode() -> Mode:
    return Mode(
        name="plan",
        description="d",
        instructions="i",
        categories=frozenset({ToolCategory.READ, ToolCategory.NETWORK}),
        base_tool_names=("fs_read_file",),
    )


def test_web_tools_are_not_loaded_by_default():
    registry = make()
    names, enabled = select_tool_names(AgentRequest("u1"), plan_mode(), [], registry)
    assert names == ["fs_read_file"]
    assert enabled == set()


def test_web_tools_load_when_they_are_requested():
    registry = make()
    names, enabled = select_tool_names(
        AgentRequest("u1", opt_in=("web_search", "deep_search")), plan_mode(), [], registry
    )
    assert "web_search" in names
    assert "deep_search" in names
    assert enabled == {"web_search", "deep_search"}


def test_skill_web_tools_follow_the_toggle():
    """Una skill con tools web tampoco las carga si no se han pedido."""
    registry = make()
    skill = Skill(
        name="investigacion",
        description="busca en la web",
        instructions="delega la búsqueda",
        tool_names=["web_search", "deep_search"],
    )
    names, _ = select_tool_names(AgentRequest("u1"), plan_mode(), [skill], registry)
    assert names == ["fs_read_file"]

    names, _ = select_tool_names(
        AgentRequest("u1", opt_in=("web_search",)), plan_mode(), [skill], registry
    )
    assert "web_search" in names
    assert "deep_search" not in names


def test_only_opt_in_tools_can_be_asked_for():
    """Pedir una tool normal por la puerta de atrás no la cuela."""
    registry = make()
    names, enabled = select_tool_names(
        AgentRequest("u1", opt_in=("fs_read_file",)), plan_mode(), [], registry
    )
    assert enabled == set()
    assert names == ["fs_read_file"]


def test_the_request_key_separates_opt_in_agents():
    """El caché de agentes distingue un pedido con web de otro sin ella."""
    sin_web = AgentRequest("u1")
    con_web = AgentRequest("u1", opt_in=("web_search",))
    assert sin_web.key() != con_web.key()
