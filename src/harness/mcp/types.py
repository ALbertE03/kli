"""Configuración tipada de servidores MCP."""

from typing import Annotated, Literal

from pydantic import BaseModel, Field

from harness.types import ToolCategory

SERVER_NAME = r"^[a-z][a-z0-9_]{1,31}$"


class StdioServerConfig(BaseModel):
    transport: Literal["stdio"] = "stdio"
    name: str = Field(pattern=SERVER_NAME)
    command: str
    args: list[str] = Field(default_factory=list)
    env: dict[str, str] = Field(default_factory=dict)
    category: ToolCategory = ToolCategory.NETWORK  # la fija el operador, no el servidor
    allowed_tools: list[str] = Field(default_factory=list)  # vacío = todas


class HttpServerConfig(BaseModel):
    transport: Literal["streamable_http"] = "streamable_http"
    name: str = Field(pattern=SERVER_NAME)
    url: str
    headers: dict[str, str] = Field(default_factory=dict)
    category: ToolCategory = ToolCategory.NETWORK
    allowed_tools: list[str] = Field(default_factory=list)


MCPServerConfig = Annotated[StdioServerConfig | HttpServerConfig, Field(discriminator="transport")]


class MCPServerInfo(BaseModel):
    name: str
    owner: str | None
    transport: str
    category: ToolCategory
    status: Literal["connected", "error"]
    tools: list[str] = Field(default_factory=list)
    error: str | None = None
