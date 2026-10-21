import pytest
from langchain_core.tools import tool

from harness.errors import Conflict, InvalidConfig, NotFound
from harness.registry import Registry
from harness.types import ToolCategory


@tool("lector")
def lector() -> str:
    """Lee algo."""
    return "x"


@tool("escritor")
def escritor() -> str:
    """Escribe algo."""
    return "y"


def make() -> Registry:
    r = Registry()
    r.add_tool(lector, ToolCategory.READ)
    r.add_tool(escritor, ToolCategory.WRITE)
    return r


def test_category_filter_blocks_write_in_read_only_mode():
    r = make()
    tools = r.resolve_tools(["lector", "escritor"], frozenset({ToolCategory.READ}), "u1")
    assert [t.name for t in tools] == ["lector"]


def test_reserved_and_duplicate_names_rejected():
    r = make()
    with pytest.raises(Conflict):
        r.add_tool(lector, ToolCategory.READ)

    @tool("read_file")
    def clash() -> str:
        """x"""
        return ""

    with pytest.raises(Conflict):
        r.add_tool(clash, ToolCategory.READ)


def test_user_tools_are_private():
    r = make()

    @tool("privada")
    def privada() -> str:
        """x"""
        return ""

    r.add_tool(privada, ToolCategory.NETWORK, owner="alice")
    allowed = frozenset(ToolCategory)
    assert [t.name for t in r.resolve_tools(["privada"], allowed, "alice")] == ["privada"]
    assert r.resolve_tools(["privada"], allowed, "bob") == []
    with pytest.raises(InvalidConfig):
        r.require_tools(["privada"], "bob")


def test_strict_resolution_raises():
    with pytest.raises(NotFound):
        make().resolve_tools(["nope"], frozenset(ToolCategory), "u", strict=True)


def test_version_bumps_on_change():
    r = Registry()
    v = r.version
    r.add_tool(lector, ToolCategory.READ)
    assert r.version > v
