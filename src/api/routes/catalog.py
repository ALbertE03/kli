from fastapi import APIRouter

from api.deps import Rt, User
from api.schemas import ModeOut, RegistryOut, ServerConfigOut, SkillOut
from harness import __version__
from harness.errors import NotFound
from harness.memory import MemoryItem

router = APIRouter(tags=["catalog"])


@router.get("/config", response_model=ServerConfigOut)
async def server_config(user: User, rt: Rt) -> ServerConfigOut:
    """Capacidades del servidor: versión, proveedor/modelo por defecto y límites."""
    settings = rt.settings
    provider = settings.default_provider
    model = settings.anthropic_model if provider == "anthropic" else settings.openai_model
    return ServerConfigOut(
        version=__version__,
        default_provider=provider,
        default_model=model,
        enable_exec=settings.enable_exec,
        recursion_limit=settings.recursion_limit,
        max_custom_per_user=settings.max_custom_per_user,
        projects_dir=str(settings.projects_dir),
        projects_import_roots=rt.projects.import_roots(),
    )


@router.get("/registry", response_model=RegistryOut)
async def get_registry(user: User, rt: Rt) -> RegistryOut:
    reg = rt.registry
    return RegistryOut(
        modes=[
            ModeOut(
                name=m.name,
                description=m.description,
                categories=sorted(m.categories),
                approval_required=sorted(m.approval_required),
            )
            for m in reg.list_modes()
        ],
        skills=[
            SkillOut(
                name=s.name,
                description=s.description,
                owner=s.owner,
                tool_names=s.tool_names,
                subagents=[sa.name for sa in s.subagents],
            )
            for s in reg.list_skills(user)
        ],
        tools=reg.list_tools(user),
        mcp=rt.mcp.list(user),
        providers=rt.list_providers(user),
        projects=rt.list_projects(user),
    )


@router.get("/memories", response_model=list[MemoryItem])
async def list_memories(user: User, rt: Rt) -> list[MemoryItem]:
    return await rt.memory.long_term.list(user)


@router.delete("/memories/{key}", status_code=204)
async def delete_memory(key: str, user: User, rt: Rt) -> None:
    if not await rt.memory.long_term.forget(user, key):
        raise NotFound("Recuerdo no encontrado")
