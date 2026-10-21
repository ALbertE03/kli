from typing import Any, Literal

from pydantic import BaseModel, Field

from harness.mcp.types import MCPServerInfo
from harness.providers import ProviderOut
from harness.types import NAME_PATTERN, Project, SkillBase, ToolCategory, ToolInfo

THREAD_PATTERN = r"^[A-Za-z0-9_-]{1,64}$"


class AgentConfigIn(BaseModel):
    mode: str = "plan"
    skills: list[str] = Field(default_factory=list, max_length=10)
    # nombre de proveedor registrado o built-in ("openai" | "anthropic")
    provider: str | None = Field(default=None, pattern=NAME_PATTERN)
    model: str | None = Field(default=None, max_length=120)
    # proyecto activo: las fs_* quedan confinadas a su raíz
    project: str | None = Field(default=None, pattern=NAME_PATTERN)


class ProviderIn(BaseModel):
    name: str = Field(pattern=NAME_PATTERN)
    kind: Literal["openai", "anthropic"]  # API compatible con OpenAI o con Anthropic
    base_url: str | None = Field(default=None, max_length=512)
    api_key: str | None = Field(default=None, max_length=512)
    default_model: str | None = Field(default=None, max_length=120)


class ModelListOut(BaseModel):
    provider: str
    kind: str
    models: list[str]


class ProjectIn(BaseModel):
    name: str = Field(pattern=NAME_PATTERN)
    # si se indica, importa esa carpeta existente en lugar de crear projects/<name>
    path: str | None = Field(default=None, max_length=1024)


class ChatRequest(AgentConfigIn):
    message: str = Field(min_length=1, max_length=32000)
    thread_id: str | None = Field(default=None, pattern=THREAD_PATTERN)


class ResumeRequest(AgentConfigIn):
    thread_id: str = Field(pattern=THREAD_PATTERN)
    # Se pasa tal cual a Command(resume=...). Ej.: {"decisions": [{"type": "approve"}]}
    resume: Any


class ThreadOut(BaseModel):
    thread_id: str
    title: str
    mode: str
    project: str | None = None
    created_at: str
    updated_at: str


class MessageOut(BaseModel):
    id: str | None
    role: str
    content: str
    name: str | None = None
    tool_calls: list[Any] = []


class ModeOut(BaseModel):
    name: str
    description: str
    categories: list[ToolCategory]
    approval_required: list[str]


class SkillOut(BaseModel):
    name: str
    description: str
    owner: str | None
    tool_names: list[str]
    subagents: list[str]


class RegistryOut(BaseModel):
    modes: list[ModeOut]
    skills: list[SkillOut]
    tools: list[ToolInfo]
    mcp: list[MCPServerInfo]
    providers: list[ProviderOut]
    projects: list[Project]


__all__ = [
    "AgentConfigIn", "ChatRequest", "ResumeRequest", "ThreadOut", "MessageOut",
    "ModeOut", "SkillOut", "RegistryOut", "SkillBase", "ProviderIn", "ProviderOut",
    "ProjectIn", "Project", "ModelListOut",
]
