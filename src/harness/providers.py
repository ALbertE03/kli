"""Registro de proveedores de modelos: built-ins (openai, anthropic) + compatibles por usuario.

Cualquier proveedor compatible con la API de OpenAI (freellmapi, LM Studio, vLLM…)
o con la de Anthropic se registra por usuario y se elige por nombre en cada chat.
"""

from __future__ import annotations

from typing import Literal
from urllib.parse import urlparse

import httpx
from pydantic import BaseModel, ConfigDict, Field, SecretStr

from harness.config import Settings
from harness.errors import Conflict, Forbidden, InvalidConfig, NotFound, UpstreamError
from harness.types import NAME_PATTERN

BUILT_IN = frozenset({"openai", "anthropic"})


class ProviderSpec(BaseModel):
    """Proveedor registrado por el usuario (sin owner: lo añade el runtime)."""

    model_config = ConfigDict(frozen=True)

    name: str = Field(pattern=NAME_PATTERN)
    kind: Literal["openai", "anthropic"]
    base_url: str | None = None
    api_key: SecretStr | None = None
    default_model: str | None = Field(default=None, max_length=120)


class ProviderOut(BaseModel):
    name: str
    kind: str
    base_url: str | None
    default_model: str | None
    built_in: bool
    has_key: bool


class ResolvedProvider(BaseModel):
    """Configuración efectiva con la que se construye el modelo de chat."""

    name: str
    kind: Literal["openai", "anthropic"]
    base_url: str | None = None
    api_key: SecretStr | None = None
    model: str | None = None


def _validate_base_url(url: str) -> None:
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        raise InvalidConfig("base_url debe ser una URL http(s) con host")


class ProviderRegistry:
    """Proveedores por usuario en memoria, respaldados por Storage."""

    def __init__(self, settings: Settings) -> None:
        self._s = settings
        self._custom: dict[tuple[str, str], ProviderSpec] = {}

    # ------------- escritura -------------
    def add(self, owner: str, spec: ProviderSpec) -> ProviderSpec:
        if spec.name in BUILT_IN:
            raise Conflict(f"'{spec.name}' es un proveedor built-in; elige otro nombre")
        if self._custom.get((None, spec.name)) or (owner, spec.name) in self._custom:
            raise Conflict(f"Proveedor duplicado: {spec.name}")
        if spec.base_url:
            _validate_base_url(spec.base_url)
        self._custom[(owner, spec.name)] = spec
        return spec

    def remove(self, owner: str, name: str) -> None:
        if name in BUILT_IN:
            raise Forbidden("No se puede eliminar un proveedor built-in")
        if self._custom.pop((owner, name), None) is None:
            raise NotFound(f"Proveedor no encontrado: {name}")

    def list(self, owner: str) -> list[ProviderOut]:
        s = self._s
        result = [
            ProviderOut(
                name="openai",
                kind="openai",
                base_url=s.openai_base_url,
                default_model=s.openai_model,
                built_in=True,
                has_key=bool(s.openai_api_key),
            ),
            ProviderOut(
                name="anthropic",
                kind="anthropic",
                base_url=None,
                default_model=s.anthropic_model,
                built_in=True,
                has_key=bool(s.anthropic_api_key),
            ),
        ]
        for (spec_owner, _), spec in sorted(self._custom.items()):
            if spec_owner in (None, owner):
                result.append(
                    ProviderOut(
                        name=spec.name,
                        kind=spec.kind,
                        base_url=spec.base_url,
                        default_model=spec.default_model,
                        built_in=False,
                        has_key=spec.api_key is not None,
                    )
                )
        return result

    # ------------- resolución -------------
    def resolve(self, name: str | None, user_id: str) -> ResolvedProvider:
        """Built-in o personalizado; `None` usa DEFAULT_PROVIDER."""
        s = self._s
        if name is not None:
            spec = self._custom.get((user_id, name)) or self._custom.get((None, name))
            if spec is not None:
                return ResolvedProvider(
                    name=spec.name, kind=spec.kind, base_url=spec.base_url,
                    api_key=spec.api_key, model=spec.default_model,
                )
            if name not in BUILT_IN:
                raise NotFound(f"Proveedor no encontrado: {name}")
        chosen = name or s.default_provider
        if chosen == "anthropic":
            if s.anthropic_api_key is None:
                raise InvalidConfig("Falta ANTHROPIC_API_KEY para usar el proveedor anthropic")
            return ResolvedProvider(
                name="anthropic", kind="anthropic", api_key=s.anthropic_api_key,
                model=s.anthropic_model,
            )
        return ResolvedProvider(
            name="openai", kind="openai", base_url=s.openai_base_url,
            api_key=s.openai_api_key, model=s.openai_model,
        )


# ------------- modelos (para la interfaz externa) -------------
async def fetch_models(rp: ResolvedProvider, timeout: float = 15.0) -> list[str]:
    """Lista los modelos que ofrece un proveedor (GET .../models de OpenAI o Anthropic)."""
    key = rp.api_key.get_secret_value() if rp.api_key else ""
    if rp.kind == "anthropic":
        base = (rp.base_url or "https://api.anthropic.com").rstrip("/")
        url = f"{base}/models" if base.endswith("/v1") else f"{base}/v1/models"
        headers = {"x-api-key": key, "anthropic-version": "2023-06-01"}
    else:
        if not rp.base_url:
            raise InvalidConfig("El proveedor openai necesita base_url")
        url = f"{rp.base_url.rstrip('/')}/models"
        headers = {"Authorization": f"Bearer {key}"} if key else {}

    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            resp = await client.get(url, headers=headers)
    except httpx.HTTPError as exc:
        raise UpstreamError(f"No se pudo contactar con el proveedor: {exc}") from exc
    if resp.status_code >= 400:
        raise UpstreamError(f"El proveedor devolvió {resp.status_code} en {url}")

    payload = resp.json()
    items = payload.get("data", payload) if isinstance(payload, dict) else payload
    models: list[str] = []
    for item in items if isinstance(items, list) else []:
        if isinstance(item, str):
            models.append(item)
        elif isinstance(item, dict) and item.get("id"):
            models.append(str(item["id"]))
    return models
