"""Proyectos: carpetas de trabajo aisladas por usuario (crear o importar).

El proyecto fija la raíz del sandbox: las tools `fs_*` solo operan dentro de ella.
Borrar el registro nunca borra archivos del disco.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from harness.config import Settings
from harness.errors import Conflict, Forbidden, InvalidConfig, NotFound
from harness.storage import Storage
from harness.types import NAME_PATTERN, Project


class ProjectRegistry:
    def __init__(self, settings: Settings, storage: Storage) -> None:
        self._s = settings
        self._storage = storage

    def _allowed_roots(self) -> list[Path]:
        roots = [Path.cwd().resolve()]
        roots.append(self._s.projects_dir.resolve())
        roots += [
            Path(r).expanduser().resolve()
            for r in self._s.projects_import_roots.split(",")
            if r.strip()
        ]
        # sin duplicados y en orden estable
        unique: list[Path] = []
        for root in roots:
            if root not in unique:
                unique.append(root)
        return unique

    def import_roots(self) -> list[str]:
        """Raíces desde las que se puede importar una carpeta existente."""
        return [str(root) for root in self._allowed_roots()]

    def _validated_root(self, raw: str) -> Path:
        try:
            root = Path(raw).expanduser().resolve()
        except (OSError, RuntimeError) as exc:
            raise InvalidConfig(f"Ruta inválida: {raw}") from exc
        if not root.is_dir():
            raise InvalidConfig(f"La carpeta no existe o no es un directorio: {root}")
        if not any(root == allowed or allowed in root.parents for allowed in self._allowed_roots()):
            raise Forbidden(
                "La carpeta queda fuera de las raíces permitidas; "
                f"amplíalas con PROJECTS_IMPORT_ROOTS: {root}"
            )
        return root

    def add(self, owner: str, name: str, path: str | None = None) -> Project:
        if not re.match(NAME_PATTERN, name):
            raise InvalidConfig(f"Nombre de proyecto inválido: {name!r}")
        if self._storage.get_config("project", owner, name) is not None:
            raise Conflict(f"Proyecto duplicado: {name}")
        if path:
            root = self._validated_root(path)
        else:
            root = (self._s.projects_dir / name).resolve()
            root.mkdir(parents=True, exist_ok=True)
        self._storage.put_config("project", owner, name, {"root": str(root)})
        return Project(name=name, root=str(root))

    def remove(self, owner: str, name: str) -> None:
        if not self._storage.delete_config("project", owner, name):
            raise NotFound(f"Proyecto no encontrado: {name}")

    def list(self, owner: str) -> list[Project]:
        return [
            Project(name=name, root=data.get("root", ""))
            for _, name, data in self._storage.list_configs("project", owner)
        ]

    def get(self, owner: str, name: str) -> Project:
        data = self._storage.get_config("project", owner, name)
        if data is None:
            raise NotFound(f"Proyecto no encontrado: {name}")
        return Project(name=name, root=data.get("root", ""))

    def browse(self, path: str | None = None) -> dict[str, Any]:
        """Lista el contenido de una carpeta permitida (para elegir un proyecto).

        No lee archivos: solo devuelve subcarpetas y nombres de fichero.
        """
        raw = path or str(self._s.projects_dir)
        root = self._validated_root(raw)
        try:
            entries = list(root.iterdir())
        except OSError as exc:
            raise InvalidConfig(f"No se pudo leer la carpeta: {root} ({exc})") from exc
        dirs = sorted(p.name for p in entries if p.is_dir() and not p.name.startswith("."))
        files = sorted(p.name for p in entries if p.is_file() and not p.name.startswith("."))
        parent = str(root.parent) if root.parent != root else None
        return {
            "path": str(root),
            "parent": parent,
            "dirs": dirs,
            "files": files,
            "roots": self.import_roots(),
        }
