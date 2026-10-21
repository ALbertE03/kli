from fastapi import APIRouter

from api.deps import Rt, User
from api.schemas import MessageOut, ThreadOut
from harness.errors import NotFound
from harness.utils import serialize_message

router = APIRouter(tags=["threads"])


@router.get("/threads", response_model=list[ThreadOut])
async def list_threads(user: User, rt: Rt) -> list[ThreadOut]:
    return [ThreadOut(**t) for t in rt.storage.list_threads(user)]


@router.get("/threads/{thread_id}/messages", response_model=list[MessageOut])
async def thread_messages(thread_id: str, user: User, rt: Rt) -> list[MessageOut]:
    if not rt.storage.thread_exists(user, thread_id):
        raise NotFound("Hilo no encontrado")
    messages = await rt.memory.get_messages(f"{user}:{thread_id}")
    return [MessageOut(**serialize_message(m)) for m in messages]


@router.delete("/threads/{thread_id}", status_code=204)
async def delete_thread(thread_id: str, user: User, rt: Rt) -> None:
    if not rt.storage.delete_thread(user, thread_id):
        raise NotFound("Hilo no encontrado")
    await rt.memory.delete_thread(f"{user}:{thread_id}")
