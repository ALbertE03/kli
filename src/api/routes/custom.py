"""CRUD de skills, tools HTTP y servidores MCP creados desde el front."""

from typing import Any

from fastapi import APIRouter

from api.deps import Rt, User
from harness.mcp.types import HttpServerConfig, MCPServerInfo
from harness.plugins.tools.http_template import HttpToolConfig
from harness.types import Skill, SkillBase

router = APIRouter(tags=["custom"])


# ---- skills (incluyen subagentes) ----
@router.post("/skills", status_code=201, response_model=Skill)
async def create_skill(body: SkillBase, user: User, rt: Rt) -> Skill:
    return rt.add_skill(user, body)


@router.delete("/skills/{name}", status_code=204)
async def delete_skill(name: str, user: User, rt: Rt) -> None:
    rt.delete_skill(user, name)


# ---- tools HTTP (plantilla cerrada: nunca código libre) ----
@router.get("/tools/http")
async def list_http_tools(user: User, rt: Rt) -> list[dict[str, Any]]:
    return rt.list_http_tools(user)


@router.post("/tools/http", status_code=201)
async def create_http_tool(body: HttpToolConfig, user: User, rt: Rt) -> dict[str, str]:
    return {"name": await rt.add_http_tool(user, body)}


@router.delete("/tools/http/{name}", status_code=204)
async def delete_http_tool(name: str, user: User, rt: Rt) -> None:
    rt.delete_http_tool(user, name)


# ---- MCP (el usuario solo puede añadir servidores HTTP públicos) ----
@router.get("/mcp", response_model=list[MCPServerInfo])
async def list_mcp(user: User, rt: Rt) -> list[MCPServerInfo]:
    return rt.mcp.list(user)


@router.post("/mcp", status_code=201, response_model=MCPServerInfo)
async def create_mcp(body: HttpServerConfig, user: User, rt: Rt) -> MCPServerInfo:
    return await rt.add_mcp(user, body)


@router.delete("/mcp/{name}", status_code=204)
async def delete_mcp(name: str, user: User, rt: Rt) -> None:
    rt.delete_mcp(user, name)
