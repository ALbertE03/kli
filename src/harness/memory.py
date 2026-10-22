"""Memoria del agente.

- Corto plazo: checkpointer de LangGraph (estado y mensajes por hilo, persistente).
- Largo plazo: Store de LangGraph (hechos del usuario entre hilos), por usuario.

ConversationBufferMemory y similares están obsoletos; esto es el patrón vigente.
"""

from __future__ import annotations

import logging
import re
import uuid
from contextlib import AsyncExitStack
from typing import Any

from langchain_core.messages import BaseMessage
from langgraph.checkpoint.memory import MemorySaver
from langgraph.store.memory import InMemoryStore
from pydantic import BaseModel

from harness.config import Settings
from harness.errors import InvalidConfig

log = logging.getLogger(__name__)


class MemoryItem(BaseModel):
    key: str
    text: str
    tags: list[str] = []
    updated_at: str | None = None


# `LongTermMemory.list` tapa el `list` builtin dentro de la clase: las
# anotaciones que lo usan se resuelven con este alias de módulo.
MemoryItems = list[MemoryItem]


def _tokens(text: str) -> set[str]:
    return set(re.findall(r"\w{3,}", text.lower()))


class LongTermMemory:
    """Hechos duraderos por usuario sobre un BaseStore de LangGraph."""

    MAX_PER_USER = 500
    MAX_TEXT = 1000

    def __init__(self, store: Any) -> None:
        self._store = store

    @staticmethod
    def _ns(user_id: str) -> tuple[str, str]:
        return ("memories", user_id)

    @staticmethod
    def _to_item(item: Any) -> MemoryItem:
        value = item.value or {}
        updated = getattr(item, "updated_at", None)
        return MemoryItem(
            key=item.key,
            text=str(value.get("text", "")),
            tags=list(value.get("tags", [])),
            updated_at=updated.isoformat() if updated else None,
        )

    async def remember(self, user_id: str, text: str, tags: list[str] | None = None) -> str:
        text = text.strip()
        if not text:
            raise InvalidConfig("Texto vacío")
        if len(text) > self.MAX_TEXT:
            raise InvalidConfig(f"Máximo {self.MAX_TEXT} caracteres por recuerdo")
        existing = await self._store.asearch(self._ns(user_id), limit=self.MAX_PER_USER + 1)
        if len(existing) > self.MAX_PER_USER:
            raise InvalidConfig("Límite de recuerdos alcanzado; olvida alguno primero")
        key = uuid.uuid4().hex[:12]
        await self._store.aput(self._ns(user_id), key, {"text": text, "tags": tags or []})
        return key

    async def list(self, user_id: str, limit: int = 100) -> MemoryItems:
        items = await self._store.asearch(self._ns(user_id), limit=limit)
        return [self._to_item(i) for i in items]

    async def recall(self, user_id: str, query: str, limit: int = 5) -> MemoryItems:
        """Búsqueda por solapamiento de términos: funciona con cualquier backend, sin embeddings."""
        items = [self._to_item(i) for i in await self._store.asearch(self._ns(user_id), limit=200)]
        wanted = _tokens(query)
        if not wanted:
            return sorted(items, key=lambda i: i.updated_at or "", reverse=True)[:limit]
        scored = [
            (len(wanted & (_tokens(i.text) | {t.lower() for t in i.tags})), i) for i in items
        ]
        scored.sort(key=lambda p: p[0], reverse=True)
        return [i for score, i in scored if score > 0][:limit]

    async def forget(self, user_id: str, key: str) -> bool:
        if await self._store.aget(self._ns(user_id), key) is None:
            return False
        await self._store.adelete(self._ns(user_id), key)
        return True


class MemoryRuntime:
    """Abre y cierra checkpointer + store según la configuración."""

    def __init__(self, settings: Settings) -> None:
        self._s = settings
        self._stack = AsyncExitStack()
        self.checkpointer: Any = None
        self.store: Any = None
        self.long_term: LongTermMemory

    async def start(self) -> None:
        s = self._s
        s.data_dir.mkdir(parents=True, exist_ok=True)
        await self._start_checkpointer()
        await self._start_store()
        self.long_term = LongTermMemory(self.store)
        set_memory(self)

    async def _start_checkpointer(self) -> None:
        s = self._s
        if s.checkpoint_backend == "sqlite":
            from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver

            self.checkpointer = await self._stack.enter_async_context(
                AsyncSqliteSaver.from_conn_string(str(s.data_dir / "checkpoints.db"))
            )
        elif s.checkpoint_backend == "postgres":
            from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver

            self.checkpointer = await self._stack.enter_async_context(
                AsyncPostgresSaver.from_conn_string(str(s.postgres_url))
            )
            await self.checkpointer.setup()
        else:
            self.checkpointer = MemorySaver()

    async def _start_store(self) -> None:
        s = self._s
        if s.store_backend == "sqlite":
            try:
                from langgraph.store.sqlite.aio import AsyncSqliteStore

                self.store = await self._stack.enter_async_context(
                    AsyncSqliteStore.from_conn_string(str(s.data_dir / "store.db"))
                )
                await self.store.setup()
                return
            except ImportError:
                log.warning("AsyncSqliteStore no disponible; la memoria a largo plazo será volátil")
        elif s.store_backend == "postgres":
            from langgraph.store.postgres.aio import AsyncPostgresStore

            self.store = await self._stack.enter_async_context(
                AsyncPostgresStore.from_conn_string(str(s.postgres_url))
            )
            await self.store.setup()
            return
        self.store = InMemoryStore()

    async def stop(self) -> None:
        await self._stack.aclose()

    # ---- lectura de hilos (sin necesitar construir un agente) ----
    async def get_messages(self, thread_key: str) -> list[BaseMessage]:
        tup = await self.checkpointer.aget_tuple({"configurable": {"thread_id": thread_key}})
        if tup is None:
            return []
        values = tup.checkpoint.get("channel_values", {})
        messages: list[BaseMessage] = values.get("messages", [])
        return messages

    async def delete_thread(self, thread_key: str) -> None:
        if hasattr(self.checkpointer, "adelete_thread"):
            await self.checkpointer.adelete_thread(thread_key)


_current: MemoryRuntime | None = None


def set_memory(memory: MemoryRuntime) -> None:
    global _current
    _current = memory


def get_memory() -> MemoryRuntime:
    if _current is None:
        raise RuntimeError("MemoryRuntime no iniciado")
    return _current
