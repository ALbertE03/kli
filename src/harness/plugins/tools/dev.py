"""Tools de desarrollo: búsqueda en código, árbol, outline AST y git de solo lectura.

Todas se construyen con `make_dev_tools(root)` y quedan confinadas a esa raíz
(WORKSPACE por defecto, o la raíz del proyecto activo). `run_tests` ejecuta la
suite del proyecto: solo se registra si ENABLE_EXEC=true y requiere aprobación.
"""

from __future__ import annotations

import ast
import fnmatch
import logging
import re
import shlex
import shutil
import subprocess
import sys
from functools import lru_cache
from pathlib import Path

from langchain_core.tools import BaseTool, tool

from harness.config import get_settings
from harness.plugins.tools.codigo import WORKSPACE
from harness.registry import registry
from harness.types import ToolCategory
from harness.utils import clip

log = logging.getLogger(__name__)
_settings = get_settings()

IGNORE_DIRS = frozenset(
    {
        ".git", ".hg", ".svn", "node_modules", "__pycache__", ".venv", "venv",
        "dist", "build", "target", ".next", ".mypy_cache", ".pytest_cache",
        ".ruff_cache", ".tox", ".eggs", "coverage", ".idea", ".vscode",
    }
)
_MAX_FILE_BYTES = 512 * 1024


def _inside(root: Path, relative: str) -> Path | None:
    """Resuelve `relative` dentro de `root`; None si escapa de la raíz."""
    target = (root / relative).resolve()
    if target != root and root not in target.parents:
        return None
    return target


def _iter_files(base: Path, root: Path, pattern: str = "*"):
    for path in sorted(base.rglob("*")):
        if not path.is_file():
            continue
        if any(part in IGNORE_DIRS for part in path.relative_to(root).parts):
            continue
        if not fnmatch.fnmatch(path.name, pattern):
            continue
        try:
            if path.stat().st_size <= _MAX_FILE_BYTES:
                yield path
        except OSError:
            continue


def _git(root: Path, *args: str, timeout: int = 30) -> str:
    """Ejecuta un subcomando git de solo lectura en `root` (sin shell)."""
    if shutil.which("git") is None:
        return "git no está instalado en el servidor."
    try:
        proc = subprocess.run(
            ["git", *args], cwd=root, capture_output=True, text=True, timeout=timeout
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        return f"git falló: {exc}"
    out = (proc.stdout or "").strip()
    if proc.returncode != 0:
        err = (proc.stderr or "").strip()
        return clip(err or f"git {args[0]} terminó con código {proc.returncode}", 2000)
    return clip(out, 8000)


@lru_cache(maxsize=16)
def make_dev_tools(root: str) -> dict[str, BaseTool]:
    """Tools de desarrollo confinadas a `root` (workspace o proyecto activo)."""
    base = Path(root).resolve()

    @tool("code_search")
    def code_search(
        pattern: str,
        path: str = ".",
        glob: str = "*",
        ignore_case: bool = False,
        max_results: int = 50,
    ) -> str:
        """Busca un patrón regex en los archivos del proyecto (tipo ripgrep).
        Devuelve 'archivo:linea: texto'. `path` es una subcarpeta y `glob` filtra
        por nombre de archivo (p. ej. '*.py'). Ignora .git, node_modules, venv, etc."""
        target = _inside(base, path)
        if target is None:
            return f"Ruta fuera del proyecto: {path}"
        if not target.is_dir():
            return f"No existe la carpeta: {path}"
        try:
            regex = re.compile(pattern, re.IGNORECASE if ignore_case else 0)
        except re.error as exc:
            return f"Regex inválida: {exc}"
        hits: list[str] = []
        n = min(max(max_results, 1), 200)
        for file in _iter_files(target, base, glob):
            try:
                lines = file.read_text(encoding="utf-8", errors="replace").splitlines()
            except OSError:
                continue
            for i, line in enumerate(lines, 1):
                if regex.search(line):
                    hits.append(f"{file.relative_to(base)}:{i}: {line.strip()[:200]}")
                    if len(hits) >= n:
                        break
            if len(hits) >= n:
                break
        if not hits:
            return "Sin coincidencias."
        return clip("\n".join(hits), 8000)

    @tool("file_tree")
    def file_tree(path: str = ".", max_depth: int = 4) -> str:
        """Muestra el árbol de archivos del proyecto (nombres y carpetas, sin contenido).
        `path` es una subcarpeta y `max_depth` la profundidad máxima (1-10)."""
        target = _inside(base, path)
        if target is None:
            return f"Ruta fuera del proyecto: {path}"
        if not target.is_dir():
            return f"No existe la carpeta: {path}"
        depth = min(max(max_depth, 1), 10)
        rows: list[str] = []
        count = 0

        def walk(current: Path, level: int) -> None:
            nonlocal count
            if level > depth or count >= 200:
                return
            for entry in sorted(current.iterdir(), key=lambda p: (not p.is_dir(), p.name)):
                if entry.is_dir() and entry.name in IGNORE_DIRS:
                    continue
                count += 1
                rows.append(f"{'  ' * (level - 1)}{entry.name}/" if entry.is_dir()
                            else f"{'  ' * (level - 1)}{entry.name}")
                if entry.is_dir():
                    walk(entry, level + 1)

        walk(target, 1)
        return clip("\n".join(rows) or "(carpeta vacía)", 6000)

    @tool("python_outline")
    def python_outline(path: str) -> str:
        """Índice de un archivo .py: clases y funciones con firma y número de línea.
        Para leer un archivo completo usa fs_read_file."""
        target = _inside(base, path)
        if target is None:
            return f"Ruta fuera del proyecto: {path}"
        if not target.is_file():
            return f"No existe el archivo: {path}"
        try:
            tree = ast.parse(target.read_text(encoding="utf-8", errors="replace"))
        except SyntaxError as exc:
            return f"SyntaxError en {path}:{exc.lineno}: {exc.msg}"
        rows: list[str] = []

        def walk(node: ast.AST, depth: int) -> None:
            for child in ast.iter_child_nodes(node):
                pad = "  " * depth
                if isinstance(child, ast.ClassDef):
                    bases = f"({ast.unparse(child.bases)})" if child.bases else ""
                    rows.append(f"{pad}class {child.name}{bases}  # L{child.lineno}")
                    walk(child, depth + 1)
                elif isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    kind = "async def" if isinstance(child, ast.AsyncFunctionDef) else "def"
                    rows.append(
                        f"{pad}{kind} {child.name}({ast.unparse(child.args)})  # L{child.lineno}"
                    )
                    walk(child, depth + 1)

        walk(tree, 0)
        return clip("\n".join(rows) or "(sin clases ni funciones)", 6000)

    @tool("git_status")
    def git_status() -> str:
        """Estado del repositorio git del proyecto (rama, cambios staged/unstaged, untracked)."""
        return _git(base, "status", "-sb")

    @tool("git_diff")
    def git_diff(path: str = "", unified: int = 3) -> str:
        """Diff sin commitear del proyecto (staged + unstaged).
        `path` acota a un archivo o carpeta; `unified` es el número de líneas de contexto."""
        args = ["diff", f"-U{min(max(unified, 0), 20)}", "--no-color"]
        if path:
            target = _inside(base, path)
            if target is None:
                return f"Ruta fuera del proyecto: {path}"
            args.append(str(target))
        return _git(base, *args)

    @tool("git_log")
    def git_log(n: int = 10) -> str:
        """Últimos `n` commits (1-50): hash, fecha, autor y mensaje."""
        return _git(base, "log", f"-n{min(max(n, 1), 50)}", "--pretty=format:%h %ad %an %s", "--date=short")

    @tool("run_tests")
    def run_tests(args: str = "-q") -> str:
        """Ejecuta la suite de tests (pytest) en la raíz del proyecto y devuelve el
        resumen. Requiere ENABLE_EXEC=true y aprobación humana: los tests ejecutan
        código real del proyecto."""
        cmd = [sys.executable, "-m", "pytest", *shlex.split(args)]
        try:
            proc = subprocess.run(cmd, cwd=base, capture_output=True, text=True, timeout=300)
        except subprocess.TimeoutExpired:
            return "Tests abortados: timeout de 300 s."
        except OSError as exc:
            return f"No se pudo ejecutar pytest: {exc}"
        out = ((proc.stdout or "") + (proc.stderr or "")).strip()
        return clip(f"$ {' '.join(cmd)} → exit {proc.returncode}\n{out}", 8000)

    tools = {
        t.name: t
        for t in (code_search, file_tree, python_outline, git_status, git_diff, git_log, run_tests)
    }
    for t in tools.values():
        t.handle_tool_error = True  # los errores vuelven al modelo como texto
    return tools


for _name, _tool in make_dev_tools(str(WORKSPACE)).items():
    if _name == "run_tests":
        if _settings.enable_exec:
            registry.add_tool(_tool, ToolCategory.EXEC)
        else:
            log.info("ENABLE_EXEC=false: run_tests no se registra")
    else:
        registry.add_tool(_tool, ToolCategory.READ)
