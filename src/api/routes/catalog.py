from fastapi import APIRouter

from api.deps import Rt, User
from api.schemas import ModeOut, RegistryOut, SkillOut
from harness.errors import NotFound
from harness.memory import MemoryItem

router = APIRouter(tags=["catalog"])


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
