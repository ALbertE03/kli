"""KLI: interfaz de terminal para el harness. Todo pasa por la API HTTP."""

from __future__ import annotations

from importlib.metadata import PackageNotFoundError, version

__all__ = ["__version__"]

try:
    __version__ = version("klicode")
except PackageNotFoundError:  # pragma: no cover - sin instalar (python -m cli)
    __version__ = "0.1.0"
