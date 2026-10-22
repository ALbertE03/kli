"""Traduce los eventos de LangGraph a eventos tipados para el front (SSE)."""

import logging
from collections.abc import AsyncIterator
from typing import Any, Literal

from pydantic import BaseModel

from harness.utils import clip, content_to_text, json_safe, split_chunk

log = logging.getLogger(__name__)

EventType = Literal[
    "token", "reasoning", "tool_start", "tool_end", "tool_error", "usage", "interrupt", "error"
]


class StreamEvent(BaseModel):
    type: EventType
    agent: str | None = None  # nombre del subagente que lo originó (None = agente principal)
    name: str | None = None
    run_id: str | None = None
    text: str | None = None
    payload: Any = None


class EventMapper:
    """Convierte eventos `astream_events(v2)` en StreamEvent.

    - Atribuye cada evento al subagente correcto usando `parent_ids` y la tool `task`.
    - Suprime los tokens de llamadas internas a modelos hechas dentro de una tool
      (p. ej. deep_search), para no mezclarlos con la respuesta al usuario.
    """

    def __init__(self) -> None:
        self._tasks: dict[str, str] = {}  # run_id de `task` -> nombre del subagente
        self._tools: set[str] = set()  # run_id de tools normales en ejecución
        self.usage = {"input_tokens": 0, "output_tokens": 0, "total_tokens": 0}

    def _agent_for(self, parents: list[str]) -> str | None:
        for pid in reversed(parents):
            if pid in self._tasks:
                return self._tasks[pid]
        return None

    def _inside_tool(self, parents: list[str]) -> bool:
        return any(p in self._tools for p in parents)

    def map(self, ev: dict[str, Any]) -> list[StreamEvent]:
        kind = ev.get("event")
        run_id = ev.get("run_id")
        parents: list[str] = ev.get("parent_ids") or []
        data: dict[str, Any] = ev.get("data") or {}
        agent = self._agent_for(parents)

        if kind == "on_chat_model_stream":
            if self._inside_tool(parents):
                return []
            chunk = data.get("chunk")
            if chunk is None:
                return []
            text, reasoning = split_chunk(chunk)
            out: list[StreamEvent] = []
            if reasoning:
                out.append(StreamEvent(type="reasoning", agent=agent, text=reasoning))
            if text:
                out.append(StreamEvent(type="token", agent=agent, text=text))
            return out

        if kind == "on_chat_model_end":
            usage = getattr(data.get("output"), "usage_metadata", None)
            if not usage or self._inside_tool(parents):
                return []
            for field in self.usage:
                self.usage[field] += int(usage.get(field, 0) or 0)
            return [StreamEvent(type="usage", agent=agent, payload=dict(self.usage))]

        if kind == "on_tool_start":
            name = ev.get("name") or "tool"
            tool_input = data.get("input")
            if run_id:
                if name == "task":
                    sub = tool_input.get("subagent_type") if isinstance(tool_input, dict) else None
                    self._tasks[run_id] = str(sub or "subagent")
                else:
                    self._tools.add(run_id)
            return [
                StreamEvent(
                    type="tool_start", agent=agent, name=name, run_id=run_id,
                    payload=json_safe(tool_input),
                )
            ]

        if kind == "on_tool_end":
            if run_id:
                self._tasks.pop(run_id, None)
                self._tools.discard(run_id)
            output = data.get("output")
            text = content_to_text(getattr(output, "content", output))
            return [
                StreamEvent(
                    type="tool_end", agent=agent, name=ev.get("name"), run_id=run_id,
                    text=clip(text),
                )
            ]

        if kind == "on_tool_error":
            if run_id:
                self._tasks.pop(run_id, None)
                self._tools.discard(run_id)
            return [
                StreamEvent(
                    type="tool_error", agent=agent, name=ev.get("name"), run_id=run_id,
                    text=clip(str(data.get("error", ""))),
                )
            ]
        return []


async def _pending_interrupts(agent: Any, config: dict[str, Any]) -> list[Any]:
    try:
        snapshot = await agent.aget_state(config)
        return [i.value for task in snapshot.tasks for i in getattr(task, "interrupts", ())]
    except Exception:  # consultar interrupciones nunca debe romper el stream
        log.debug("No se pudo leer el estado para interrupciones", exc_info=True)
        return []


async def stream_run(
    agent: Any,
    inputs: Any,
    *,
    thread_id: str,
    user_id: str,
    recursion_limit: int = 100,
) -> AsyncIterator[StreamEvent]:
    config: dict[str, Any] = {
        "configurable": {"thread_id": thread_id, "user_id": user_id},
        "recursion_limit": recursion_limit,
    }
    mapper = EventMapper()
    try:
        async for ev in agent.astream_events(inputs, config=config, version="v2"):
            for out in mapper.map(ev):
                yield out
        interrupts = await _pending_interrupts(agent, config)
        if interrupts:
            yield StreamEvent(type="interrupt", payload=json_safe(interrupts))
    except Exception as exc:  # el stream siempre termina con un evento claro
        log.exception("Error durante la ejecución del agente")
        yield StreamEvent(type="error", text=f"{type(exc).__name__}: {clip(str(exc), 500)}")
