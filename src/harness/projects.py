"""Proyectos: carpetas de trabajo aisladas por usuario (crear o importar).

El proyecto fija la raíz del sandbox: las tools `fs_*` solo operan dentro de ella.
Borrar el registro nunca borra archivos del disco.
"""

from __future__ import annotations

import re
from pathlib import Path

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
        roots += [
            Path(r).expanduser().resolve()
            for r in self._s.projects_import_roots.split(",")
            if r.strip()
        ]
        return roots

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
