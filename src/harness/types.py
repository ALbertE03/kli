"""Modelos tipados del dominio: modos, skills, subagentes y categorías de tools."""

from enum import StrEnum

from pydantic import BaseModel, ConfigDict, Field

NAME_PATTERN = r"^[a-z][a-z0-9_]{1,47}$"


class ToolCategory(StrEnum):
    READ = "read"
    WRITE = "write"
    NETWORK = "network"
    EXEC = "exec"
    MEMORY = "memory"


class ToolInfo(BaseModel):
    name: str
    description: str
    category: ToolCategory
    owner: str | None = None


class SubAgentSpec(BaseModel):
    name: str = Field(pattern=NAME_PATTERN)
    description: str = Field(min_length=5, max_length=300)
    prompt: str = Field(min_length=5, max_length=8000)
    tool_names: list[str] = Field(default_factory=list, max_length=30)


class SkillBase(BaseModel):
    """Lo que el usuario puede enviar al crear una skill (sin owner)."""

    name: str = Field(pattern=NAME_PATTERN)
    description: str = Field(min_length=5, max_length=300)
    instructions: str = Field(min_length=5, max_length=8000)
    tool_names: list[str] = Field(default_factory=list, max_length=50)
    subagents: list[SubAgentSpec] = Field(default_factory=list, max_length=10)


class Skill(SkillBase):
    owner: str | None = None  # None = skill del sistema


class Mode(BaseModel):
    """Un modo fija el comportamiento y las categorías de tools permitidas."""

    model_config = ConfigDict(frozen=True)

    name: str = Field(pattern=NAME_PATTERN)
    description: str
    instructions: str
    categories: frozenset[ToolCategory]
    base_tool_names: tuple[str, ...] = ()
    # Tools que requieren aprobación humana antes de ejecutarse (human-in-the-loop)
    approval_required: frozenset[str] = frozenset()


class Project(BaseModel):
    """Una carpeta de trabajo aislada por usuario: las fs_* solo operan dentro de su root."""

    model_config = ConfigDict(frozen=True)

    name: str = Field(pattern=NAME_PATTERN)
    root: str
