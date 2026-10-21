"""Autodescubrimiento: todo módulo dentro de `plugins/` se importa y se autoregistra."""

import importlib
import pkgutil


def load_plugins() -> list[str]:
    import harness.plugins as pkg

    loaded: list[str] = []
    for module in pkgutil.walk_packages(pkg.__path__, prefix=f"{pkg.__name__}."):
        importlib.import_module(module.name)
        loaded.append(module.name)
    return loaded
