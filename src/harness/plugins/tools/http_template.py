"""Plantilla de tool HTTP configurable desde el front (el usuario parametriza; el código es nuestro)."""

from typing import Literal

from langchain_core.tools import StructuredTool
from pydantic import BaseModel, Field, HttpUrl, field_validator

from harness.errors import Forbidden
from harness.security import aassert_public_url, safe_fetch, validate_headers
from harness.types import NAME_PATTERN


class HttpToolConfig(BaseModel):
    name: str = Field(pattern=NAME_PATTERN)
    description: str = Field(min_length=10, max_length=300)
    url: HttpUrl
    method: Literal["GET", "POST"] = "GET"
    allowed_hosts: list[str] = Field(min_length=1, max_length=10)
    headers: dict[str, str] = Field(default_factory=dict)

    @field_validator("headers")
    @classmethod
    def _headers_ok(cls, value: dict[str, str]) -> dict[str, str]:
        return validate_headers(value)


class _QueryArgs(BaseModel):
    query: str = Field(default="", description="Texto de la consulta", max_length=2000)


async def build_http_tool(cfg: HttpToolConfig) -> StructuredTool:
    url = str(cfg.url)
    if cfg.url.host not in cfg.allowed_hosts:
        raise Forbidden(f"El host {cfg.url.host} no está en allowed_hosts")
    await aassert_public_url(url)  # se vuelve a validar en cada llamada dentro de safe_fetch

    async def _call(query: str = "") -> str:
        status, body = await safe_fetch(
            url,
            method=cfg.method,
            params={"q": query} if cfg.method == "GET" else None,
            json_body={"q": query} if cfg.method == "POST" else None,
            headers=cfg.headers,
            max_bytes=200_000,
        )
        return f"HTTP {status}\n{body[:4000]}"

    return StructuredTool.from_function(
        coroutine=_call, name=cfg.name, description=cfg.description, args_schema=_QueryArgs
    )
