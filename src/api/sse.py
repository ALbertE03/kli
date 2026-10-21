import asyncio
import json
from collections.abc import AsyncIterator
from typing import Any

from fastapi.responses import StreamingResponse

from harness.streaming import StreamEvent


def _frame(event: str, data: str) -> str:
    return f"event: {event}\ndata: {data}\n\n"


async def _generate(
    events: AsyncIterator[StreamEvent], meta: dict[str, Any], lock: asyncio.Lock
) -> AsyncIterator[str]:
    yield _frame("meta", json.dumps(meta))
    async with lock:
        async for ev in events:
            yield _frame(ev.type, ev.model_dump_json(exclude_none=True))
    yield _frame("done", "{}")


def sse_response(
    events: AsyncIterator[StreamEvent], meta: dict[str, Any], lock: asyncio.Lock
) -> StreamingResponse:
    return StreamingResponse(
        _generate(events, meta, lock),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
