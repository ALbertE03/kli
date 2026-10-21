"""Tools clásicas de código y archivos de LangChain.

- Los archivos quedan confinados a un root (WORKSPACE por defecto, o la raíz del
  proyecto activo) y se renombran con prefijo `fs_` porque deepagents ya expone
  read_file/write_file/... virtuales y los nombres chocarían.
- python_repl y terminal ejecutan código REAL en el proceso: solo se registran si
  ENABLE_EXEC=true. Úsalo únicamente dentro de un contenedor o sandbox.
"""

import logging
from functools import lru_cache

from langchain_community.agent_toolkits import FileManagementToolkit
from langchain_core.tools import BaseTool

from harness.config import get_settings
from harness.registry import registry
from harness.types import ToolCategory

log = logging.getLogger(__name__)
_settings = get_settings()

WORKSPACE = _settings.workspace_dir.resolve()
WORKSPACE.mkdir(parents=True, exist_ok=True)

_READ_ONLY = {"read_file", "list_directory", "file_search"}


def fs_category(name: str) -> ToolCategory:
    return ToolCategory.READ if name.removeprefix("fs_") in _READ_ONLY else ToolCategory.WRITE


@lru_cache(maxsize=16)
def make_fs_tools(root: str) -> dict[str, BaseTool]:
    """Crea las tools fs_* confinadas a `root`; se usa también por proyecto."""
    tools: dict[str, BaseTool] = {}
    for t in FileManagementToolkit(root_dir=root).get_tools():
        t.name = f"fs_{t.name}"  # evita colisión con las tools virtuales de deepagents
        t.handle_tool_error = True  # los errores vuelven al modelo como texto
        tools[t.name] = t
    return tools


for _name, _tool in make_fs_tools(str(WORKSPACE)).items():
    registry.add_tool(_tool, fs_category(_name))

if _settings.enable_exec:
    from langchain_community.tools import ShellTool
    from langchain_experimental.tools import PythonREPLTool

    _repl = PythonREPLTool()
    _repl.name = "python_repl"
    registry.add_tool(_repl, ToolCategory.EXEC)

    _shell = ShellTool()
    _shell.name = "terminal"
    registry.add_tool(_shell, ToolCategory.EXEC)
else:
    log.info("ENABLE_EXEC=false: python_repl y terminal no se registran")
