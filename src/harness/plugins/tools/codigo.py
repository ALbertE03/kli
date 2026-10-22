"""Tools clásicas de código y archivos de LangChain.

- Los archivos quedan confinados a un root (WORKSPACE por defecto, o la raíz del
  proyecto activo) y se renombran con prefijo `fs_` porque deepagents ya expone
  read_file/write_file/... virtuales y los nombres chocarían.
- `terminal` y `python_repl` ejecutan código REAL: solo se registran si
  ENABLE_EXEC=true, y en producción exigen además ALLOW_UNSANDBOXED_EXEC=true.
  Ojo: **no hay aislamiento** — el comando ve el host entero. Lo único que se
  confina es el directorio de trabajo (la raíz del proyecto).
"""

import logging
import subprocess
import sys
from functools import lru_cache
from typing import Any

from langchain_community.agent_toolkits import FileManagementToolkit
from langchain_core.tools import BaseTool
from pydantic import BaseModel, Field

from harness.config import get_settings
from harness.registry import registry
from harness.types import ToolCategory

log = logging.getLogger(__name__)
_settings = get_settings()

WORKSPACE = _settings.workspace_dir.resolve()
WORKSPACE.mkdir(parents=True, exist_ok=True)

_READ_ONLY = {"read_file", "list_directory", "file_search"}

# Tope de ejecución: una tool que se cuelga no debe tumbar el servidor.
_EXEC_TIMEOUT = 300


def fs_category(name: str) -> ToolCategory:
    return ToolCategory.READ if name.removeprefix("fs_") in _READ_ONLY else ToolCategory.WRITE


def exec_enabled() -> bool:
    """¿Se registran `terminal` y `python_repl` en este entorno?

    En producción hacen falta las dos banderas: el exec no está aislado y
    cualquiera que llegue al servidor ejecuta código en la máquina.
    """
    if not _settings.enable_exec:
        return False
    if _settings.harness_env == "prod":
        return _settings.allow_unsandboxed_exec
    return True


@lru_cache(maxsize=16)
def make_fs_tools(root: str) -> dict[str, BaseTool]:
    """Crea las tools fs_* confinadas a `root`; se usa también por proyecto."""
    tools: dict[str, BaseTool] = {}
    for t in FileManagementToolkit(root_dir=root).get_tools():
        t.name = f"fs_{t.name}"  # evita colisión con las tools virtuales de deepagents
        t.handle_tool_error = True  # los errores vuelven al modelo como texto
        tools[t.name] = t
    return tools


class RootedShell:
    """Bash con el directorio de trabajo en la raíz del proyecto.

    El `ShellTool` de LangChain arranca su bash en el cwd del proceso del
    servidor: con un proyecto activo, los archivos que suelta el agente acaban
    fuera del proyecto. Este los mete dentro.
    """

    def __init__(self, root: str) -> None:
        self.root = root

    def run(self, commands: str | list[str], **kwargs: Any) -> str:
        if isinstance(commands, list):
            commands = " && ".join(commands)
        try:
            proc = subprocess.run(
                commands,
                shell=True,
                cwd=self.root,
                capture_output=True,
                text=True,
                timeout=_EXEC_TIMEOUT,
                check=False,
            )
        except subprocess.TimeoutExpired:
            return f"Comando abortado: timeout de {_EXEC_TIMEOUT} s."
        return ((proc.stdout or "") + (proc.stderr or "")).strip()


class PythonInput(BaseModel):
    """Entrada de `python_repl`."""

    code: str = Field(description="Código Python a ejecutar.")


class PythonRunner(BaseTool):
    """Ejecuta Python en un subproceso con el cwd en la raíz del proyecto.

    El `PythonREPLTool` de LangChain ejecuta el código **en el proceso del
    servidor** (un `sys.exit()` lo tumba) y en su cwd. Aquí va en un subproceso
    aparte: a cambio, no hay estado entre llamadas.
    """

    name: str = "python_repl"
    description: str = (
        "Ejecuta código Python y devuelve stdout y stderr. Cada llamada corre en "
        "un subproceso nuevo, en el directorio del proyecto: no hay estado entre "
        "llamadas."
    )
    args_schema: type[BaseModel] = PythonInput
    root: str = ""

    def _run(self, code: str, run_manager: Any = None) -> str:
        """Ejecuta el código y devuelve stdout y stderr."""
        try:
            proc = subprocess.run(
                [sys.executable, "-c", code],
                cwd=self.root,
                capture_output=True,
                text=True,
                timeout=_EXEC_TIMEOUT,
                check=False,
            )
        except subprocess.TimeoutExpired:
            return f"Código abortado: timeout de {_EXEC_TIMEOUT} s."
        out = ((proc.stdout or "") + (proc.stderr or "")).strip()
        if proc.returncode:
            # el código de salida suele ser la pista que necesita el modelo
            out = f"{out}\n(exit {proc.returncode})".strip()
        return out or "(sin salida)"


@lru_cache(maxsize=16)
def make_exec_tools(root: str) -> dict[str, BaseTool]:
    """Tools de ejecución con el directorio de trabajo en `root`."""
    if not exec_enabled():
        return {}
    from langchain_community.tools import ShellTool

    shell = ShellTool(process=RootedShell(root))
    shell.name = "terminal"
    shell.handle_tool_error = True  # los errores vuelven al modelo como texto
    return {"terminal": shell, "python_repl": PythonRunner(root=root)}


for _name, _tool in make_fs_tools(str(WORKSPACE)).items():
    registry.add_tool(_tool, fs_category(_name))

for _name, _tool in make_exec_tools(str(WORKSPACE)).items():
    registry.add_tool(_tool, ToolCategory.EXEC)

if not exec_enabled():
    log.info(
        "Exec desactivado (ENABLE_EXEC=%s, HARNESS_ENV=%s, ALLOW_UNSANDBOXED_EXEC=%s): "
        "terminal y python_repl no se registran",
        _settings.enable_exec,
        _settings.harness_env,
        _settings.allow_unsandboxed_exec,
    )
