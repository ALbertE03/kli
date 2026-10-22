"""Ajustes del cliente: contra qué servidor, como qué usuario y con qué credencial.

Se leen del entorno para que el CLI no dependa de ficheros:

    KLI_API_URL   URL del servidor (por defecto http://127.0.0.1:8000)
    KLI_USER      usuario para las cabeceras X-User-Id (por defecto "anonymous")
    KLI_API_KEY   clave Bearer si el servidor exige API_KEYS

Si existe un `.env` en el directorio de trabajo, también se lee (sin pisar
las variables que ya vengan de verdad en el entorno).
"""

from __future__ import annotations

import os
from dataclasses import dataclass

from dotenv import load_dotenv

DEFAULT_URL = "http://127.0.0.1:8000"


@dataclass(frozen=True, slots=True)
class CliConfig:
    base_url: str = DEFAULT_URL
    user: str = "anonymous"
    api_key: str = ""

    @property
    def api_root(self) -> str:
        return f"{self.base_url.rstrip('/')}/api/v1"

    @property
    def headers(self) -> dict[str, str]:
        headers = {"X-User-Id": self.user}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        return headers


def load_config() -> CliConfig:
    """Construye la configuración desde el entorno y del `.env` si existe."""
    # el .env es la configuración local del proyecto: lo que venga de verdad
    # en el entorno manda siempre (override=False)
    try:
        load_dotenv(override=False)
    except OSError:  # pragma: no cover - sin .env seguimos con el entorno
        pass
    url = (os.environ.get("KLI_API_URL") or os.environ.get("KLI_BASE_URL") or DEFAULT_URL).strip()
    user = (os.environ.get("KLI_USER") or os.environ.get("KLI_USER_ID") or "anonymous").strip()
    key = (os.environ.get("KLI_API_KEY") or "").strip()
    return CliConfig(base_url=url or DEFAULT_URL, user=user or "anonymous", api_key=key)
