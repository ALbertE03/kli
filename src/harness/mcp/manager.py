"""Conexión a servidores MCP y registro de sus tools en el registro común.

Con langchain-mcp-adapters >= 0.1 el cliente ya no es un context manager:
`get_tools()` abre una sesión por llamada, así que no hay ciclo de vida que gestionar.
"""

import asyncio
import logging
import re
from typing import Any

from langchain_mcp_adapters.client import MultiServerMCPClient
from langchain_mcp_adapters.sessions import StdioConnection, StreamableHttpConnection
from pydantic import TypeAdapter

from harness.errors import Conflict, Forbidden, InvalidConfig, NotFound
from harness.mcp.types import (
    HttpServerConfig,
    MCPServerConfig,
    MCPServerInfo,
    StdioServerConfig,
)
from harness.registry import Registry
from harness.security import (
    aassert_public_url,
    validate_headers,
    validate_stdio_command,
)

log = logging.getLogger(__name__)
_config_adapter: TypeAdapter[Any] = TypeAdapter(MCPServerConfig)


def parse_server_config(data: dict[str, Any]) -> StdioServerConfig | HttpServerConfig:
    result: StdioServerConfig | HttpServerConfig = _config_adapter.validate_python(data)
    return result


def _connection(
    cfg: StdioServerConfig | HttpServerConfig,
) -> StdioConnection | StreamableHttpConnection:
    if isinstance(cfg, StdioServerConfig):
        return {
            "transport": "stdio",
            "command": cfg.command,
            "args": cfg.args,
            "env": cfg.env or None,
        }
    return {"transport": "streamable_http", "url": cfg.url, "headers": cfg.headers or None}


def _safe_name(name: str) -> str:
    return re.sub(r"[^A-Za-z0-9_-]", "_", name)[:64]


class MCPManager:
    def __init__(self, registry: Registry, stdio_allowlist: frozenset[str]) -> None:
        self._registry = registry
        self._allow = stdio_allowlist
        self._servers: dict[tuple[str | None, str], MCPServerInfo] = {}

    async def connect(
        self, cfg: StdioServerConfig | HttpServerConfig, owner: str | None = None
    ) -> MCPServerInfo:
        key = (owner, cfg.name)
        if key in self._servers:
            raise Conflict(f"Ya existe un servidor MCP '{cfg.name}'")

        if isinstance(cfg, StdioServerConfig):
            if owner is not None:
                raise Forbidden("Los servidores stdio solo se configuran en el servidor")
            validate_stdio_command(cfg.command, self._allow)
        else:
            validate_headers(cfg.headers)
            if owner is not None:  # la config del operador es de confianza; la del usuario no
                await aassert_public_url(cfg.url)

        client = MultiServerMCPClient({cfg.name: _connection(cfg)})
        try:
            tools = await asyncio.wait_for(client.get_tools(), timeout=30)
        except Exception as exc:  # se re-lanza como InvalidConfig
            raise InvalidConfig(f"No se pudo conectar a '{cfg.name}': {exc}") from exc

        registered: list[str] = []
        for tool in tools:
            if cfg.allowed_tools and tool.name not in cfg.allowed_tools:
                continue
            tool.name = _safe_name(f"{cfg.name}__{tool.name}")
            try:
                self._registry.add_tool(tool, cfg.category, owner)
            except Conflict:
                log.warning("Tool MCP duplicada omitida: %s", tool.name)
                continue
            registered.append(tool.name)

        info = MCPServerInfo(
            name=cfg.name, owner=owner, transport=cfg.transport,
            category=cfg.category, status="connected", tools=registered,
        )
        self._servers[key] = info
        log.info("MCP '%s' conectado con %d tools", cfg.name, len(registered))
        return info

    async def connect_all(self, configs: list[StdioServerConfig | HttpServerConfig]) -> None:
        """Arranque: un servidor caído no debe impedir que la API levante."""
        for cfg in configs:
            try:
                await self.connect(cfg, owner=None)
            except Exception as exc:  # noqa: BLE001
                log.error("MCP '%s' falló al conectar: %s", cfg.name, exc)
                self._servers[(None, cfg.name)] = MCPServerInfo(
                    name=cfg.name, owner=None, transport=cfg.transport,
                    category=cfg.category, status="error", error=str(exc),
                )

    def disconnect(self, name: str, owner: str | None) -> None:
        info = self._servers.pop((owner, name), None)
        if info is None:
            raise NotFound(f"Servidor MCP no encontrado: {name}")
        for tool_name in info.tools:
            try:
                self._registry.remove_tool(tool_name, owner)
            except NotFound:
                pass

    def list(self, user_id: str | None) -> list[MCPServerInfo]:
        return [i for (o, _), i in self._servers.items() if o is None or o == user_id]
