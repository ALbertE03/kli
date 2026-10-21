import logging
import uuid

from fastapi import APIRouter
from fastapi.responses import StreamingResponse
from langchain_core.messages import HumanMessage
from langgraph.types import Command

from api.deps import Rt, User
from api.schemas import AgentConfigIn, ChatRequest, ResumeRequest
from api.sse import sse_response
from harness.errors import Conflict, NotFound
from harness.kernel import AgentRequest
from harness.streaming import stream_run

router = APIRouter(tags=["chat"])
log = logging.getLogger(__name__)


def _resolve_project(rt: Rt, user: str, requested: str | None, thread: str) -> str | None:
    """Proyecto activo del hilo: el pedido explícito manda (404 si no existe).

    Si el hilo apuntaba a un proyecto ya eliminado, se degrada al workspace por
    defecto en lugar de romper el hilo.
    """
    if requested:
        rt.get_project(user, requested)  # valida propiedad -> 404 si no existe
        return requested
    stored = rt.storage.thread_project(user, thread)
    if stored:
        try:
            rt.get_project(user, stored)
        except NotFound:
            log.warning("Hilo %s: proyecto '%s' eliminado; se usa el workspace", thread, stored)
            return None
        return stored
    return None


def _agent_request(user: str, cfg: AgentConfigIn, project: str | None) -> AgentRequest:
    return AgentRequest(user, cfg.mode, tuple(cfg.skills), cfg.provider, cfg.model, project)


@router.post("/chat/stream")
async def chat_stream(req: ChatRequest, user: User, rt: Rt) -> StreamingResponse:
    thread = req.thread_id or uuid.uuid4().hex[:16]
    key = f"{user}:{thread}"
    lock = rt.lock_for(key)
    if lock.locked():
        raise Conflict("El hilo ya tiene una ejecución en curso")

    project = _resolve_project(rt, user, req.project, thread)
    agent = rt.factory.get(_agent_request(user, req, project))  # errores -> HTTP antes del stream
    rt.storage.touch_thread(user, thread, req.message, req.mode, project)

    events = stream_run(
        agent,
        {"messages": [HumanMessage(content=req.message)]},
        thread_id=key,
        user_id=user,
        recursion_limit=rt.settings.recursion_limit,
    )
    return sse_response(events, {"thread_id": thread}, lock)


@router.post("/chat/resume")
async def chat_resume(req: ResumeRequest, user: User, rt: Rt) -> StreamingResponse:
    """Reanuda un hilo pausado por una aprobación (human-in-the-loop)."""
    if not rt.storage.thread_exists(user, req.thread_id):
        raise NotFound("Hilo no encontrado")
    key = f"{user}:{req.thread_id}"
    lock = rt.lock_for(key)
    if lock.locked():
        raise Conflict("El hilo ya tiene una ejecución en curso")

    project = _resolve_project(rt, user, req.project, req.thread_id)
    agent = rt.factory.get(_agent_request(user, req, project))
    events = stream_run(
        agent,
        Command(resume=req.resume),
        thread_id=key,
        user_id=user,
        recursion_limit=rt.settings.recursion_limit,
    )
    return sse_response(events, {"thread_id": req.thread_id}, lock)
