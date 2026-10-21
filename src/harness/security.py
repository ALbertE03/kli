"""Protecciones SSRF y validaciones de entrada para recursos de red."""

import asyncio
import ipaddress
import socket
from typing import Any
from urllib.parse import urlparse

import httpx

from harness.errors import Forbidden, InvalidConfig


def assert_public_url(url: str) -> None:
    """Rechaza URLs que no sean http(s) o que resuelvan a IPs no públicas.

    Limitación conocida: no evita DNS rebinding entre la validación y la conexión.
    Para mitigarlo del todo, aísla el proceso a nivel de red (egress firewall).
    """
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https"):
        raise InvalidConfig("Solo se permiten URLs http(s)")
    host = parsed.hostname
    if not host:
        raise InvalidConfig("URL sin host")
    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    try:
        infos = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except socket.gaierror as exc:
        raise InvalidConfig(f"No se pudo resolver {host}") from exc
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if not ip.is_global:
            raise Forbidden(f"Destino no permitido: {host} resuelve a una IP no pública")


async def aassert_public_url(url: str) -> None:
    await asyncio.to_thread(assert_public_url, url)


def validate_headers(headers: dict[str, str]) -> dict[str, str]:
    for key, value in headers.items():
        if any(c in key + value for c in "\r\n"):
            raise InvalidConfig("Cabecera inválida")
    return headers


def validate_stdio_command(command: str, allowlist: frozenset[str]) -> None:
    if command not in allowlist:
        raise Forbidden(f"Comando '{command}' fuera de la lista permitida")


async def safe_fetch(
    url: str,
    *,
    method: str = "GET",
    params: dict[str, Any] | None = None,
    json_body: Any = None,
    headers: dict[str, str] | None = None,
    max_bytes: int = 1_000_000,
    timeout: float = 10.0,
    max_redirects: int = 3,
) -> tuple[int, str]:
    """GET/POST con validación SSRF en cada salto y tope de bytes."""
    current = url
    req_headers = {"User-Agent": "agentic-harness/0.1", **(headers or {})}
    async with httpx.AsyncClient(timeout=timeout, follow_redirects=False) as client:
        for _ in range(max_redirects + 1):
            await aassert_public_url(current)
            async with client.stream(
                method, current, params=params, json=json_body, headers=req_headers
            ) as resp:
                location = resp.headers.get("location")
                if resp.is_redirect and location:
                    next_url = str(resp.url.join(location))
                    if urlparse(next_url).hostname != urlparse(current).hostname:
                        req_headers = {"User-Agent": "agentic-harness/0.1"}  # no filtrar credenciales
                    current, method, params, json_body = next_url, "GET", None, None
                    continue
                chunks: list[bytes] = []
                size = 0
                async for chunk in resp.aiter_bytes():
                    chunks.append(chunk)
                    size += len(chunk)
                    if size >= max_bytes:
                        break
                body = b"".join(chunks)[:max_bytes]
                return resp.status_code, body.decode(resp.encoding or "utf-8", errors="replace")
    raise Forbidden("Demasiadas redirecciones")
