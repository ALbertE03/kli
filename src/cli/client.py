"""Cliente HTTP del harness.

El CLI nunca habla con el runtime: siempre con la API. Este módulo encapsula
las llamadas (JSON) y el stream SSE de `POST /chat/stream` y `POST /chat/resume`.
"""

from __future__ import annotations

import json
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from typing import Any

import httpx

from cli.config import CliConfig

__all__ = ["ApiError", "HarnessClient", "SSEParser", "ServerEvent"]


class ApiError(RuntimeError):
    """Error devuelto por la API (status + detalle)."""

    def __init__(self, status: int, detail: str) -> None:
        super().__init__(f"HTTP {status}: {detail}")
        self.status = status
        self.detail = detail


@dataclass(slots=True)
class ServerEvent:
    """Un evento del stream SSE."""

    type: str
    data: dict[str, Any] = field(default_factory=dict)

    @property
    def text(self) -> str:
        value = self.data.get("text")
        return value if isinstance(value, str) else ""

    @property
    def name(self) -> str:
        value = self.data.get("name")
        return value if isinstance(value, str) else ""

    @property
    def agent(self) -> str | None:
        value = self.data.get("agent")
        return value if isinstance(value, str) else None


class SSEParser:
    """Parser de Server-Sent Events (`event:`/`data:`).

    Acumula líneas y emite un `ServerEvent` cada vez que llega un frame vacío
    (separador de eventos). Es independiente de httpx para poder testearlo.
    """

    def __init__(self) -> None:
        self._event: str | None = None
        self._data: list[str] = []

    def feed(self, line: str) -> ServerEvent | None:
        """Procesa una línea; devuelve el evento si la línea cerraba un frame."""
        line = line.rstrip("\r")
        if not line:
            return self._flush()
        if line.startswith(":"):  # comentario/heartbeat
            return None
        name, _, value = line.partition(":")
        value = value.removeprefix(" ")
        if name == "event":
            self._event = value
        elif name == "data":
            self._data.append(value)
        return None

    def close(self) -> ServerEvent | None:
        """Cierra el stream: emite el último frame pendiente si quedó alguno."""
        return self._flush()

    def _flush(self) -> ServerEvent | None:
        if self._event is None and not self._data:
            return None
        event = self._event or "message"
        raw = "\n".join(self._data)
        self._event = None
        self._data = []
        try:
            payload = json.loads(raw) if raw.strip() else {}
        except json.JSONDecodeError:
            payload = {"raw": raw}
        if not isinstance(payload, dict):
            payload = {"value": payload}
        return ServerEvent(type=event, data=payload)


class HarnessClient:
    """Cliente asíncrono de la API del harness."""

    def __init__(self, config: CliConfig, timeout: float = 30.0) -> None:
        self.config = config
        self._client = httpx.AsyncClient(
            base_url=config.base_url.rstrip("/"),
            timeout=httpx.Timeout(timeout, read=None, connect=10.0),
            headers=config.headers,
        )

    async def aclose(self) -> None:
        await self._client.aclose()

    # ------------- JSON -------------
    async def _get(self, route: str, **params: Any) -> Any:
        try:
            resp = await self._client.get(route, params=params or None)
        except httpx.HTTPError as exc:
            raise ApiError(0, f"No se pudo contactar con {self.config.base_url}: {exc}") from exc
        return self._json(resp)

    async def _post(self, path: str, payload: dict[str, Any]) -> Any:
        try:
            resp = await self._client.post(path, json=payload)
        except httpx.HTTPError as exc:
            raise ApiError(0, f"No se pudo contactar con {self.config.base_url}: {exc}") from exc
        return self._json(resp)

    async def _delete(self, path: str) -> None:
        try:
            resp = await self._client.delete(path)
        except httpx.HTTPError as exc:
            raise ApiError(0, f"No se pudo contactar con {self.config.base_url}: {exc}") from exc
        self._json(resp)

    @staticmethod
    def _json(resp: httpx.Response) -> Any:
        if resp.status_code >= 400:
            detail = resp.text
            try:
                body = resp.json()
                detail = body.get("detail", body) if isinstance(body, dict) else body
            except ValueError:
                pass
            raise ApiError(resp.status_code, str(detail))
        if resp.status_code == 204 or not resp.content:
            return None
        return resp.json()

    async def health(self) -> dict[str, Any]:
        return await self._get("/health")

    async def server_config(self) -> dict[str, Any]:
        return await self._get(f"{self.config.api_root}/config")

    async def registry(self) -> dict[str, Any]:
        return await self._get(f"{self.config.api_root}/registry")

    async def models(self, provider: str | None = None) -> list[str]:
        data = await self._get(f"{self.config.api_root}/models", provider=provider)
        return list(data.get("models", [])) if isinstance(data, dict) else []

    async def threads(self) -> list[dict[str, Any]]:
        data = await self._get(f"{self.config.api_root}/threads")
        return list(data) if isinstance(data, list) else []

    async def thread_messages(self, thread_id: str) -> list[dict[str, Any]]:
        data = await self._get(f"{self.config.api_root}/threads/{thread_id}/messages")
        return list(data) if isinstance(data, list) else []

    async def delete_thread(self, thread_id: str) -> None:
        await self._delete(f"{self.config.api_root}/threads/{thread_id}")

    async def cancel(self, thread_id: str) -> bool:
        data = await self._post(f"{self.config.api_root}/chat/cancel", {"thread_id": thread_id})
        return bool(data.get("cancelled")) if isinstance(data, dict) else False

    # ------------- proyectos -------------
    async def create_project(self, name: str, path: str | None = None) -> dict[str, Any]:
        body: dict[str, Any] = {"name": name}
        if path:
            body["path"] = path
        data = await self._post(f"{self.config.api_root}/projects", body)
        return data if isinstance(data, dict) else {}

    async def browse_projects(self, path: str | None = None) -> dict[str, Any]:
        """Lista carpetas de una raíz permitida (`GET /api/v1/projects/browse`)."""
        data = await self._get(f"{self.config.api_root}/projects/browse", path=path)
        return data if isinstance(data, dict) else {}

    async def delete_project(self, name: str) -> None:
        await self._delete(f"{self.config.api_root}/projects/{name}")

    # ------------- skills -------------
    async def create_skill(self, body: dict[str, Any]) -> dict[str, Any]:
        data = await self._post(f"{self.config.api_root}/skills", body)
        return data if isinstance(data, dict) else {}

    async def delete_skill(self, name: str) -> None:
        await self._delete(f"{self.config.api_root}/skills/{name}")

    # ------------- proveedores -------------
    async def create_provider(self, body: dict[str, Any]) -> dict[str, Any]:
        data = await self._post(f"{self.config.api_root}/providers", body)
        return data if isinstance(data, dict) else {}

    async def delete_provider(self, name: str) -> None:
        await self._delete(f"{self.config.api_root}/providers/{name}")

    async def provider_models(self, name: str) -> list[str]:
        data = await self._get(f"{self.config.api_root}/providers/{name}/models")
        return list(data.get("models", [])) if isinstance(data, dict) else []

    # ------------- MCP -------------
    async def list_mcp(self) -> list[dict[str, Any]]:
        data = await self._get(f"{self.config.api_root}/mcp")
        return list(data) if isinstance(data, list) else []

    async def create_mcp(self, body: dict[str, Any]) -> dict[str, Any]:
        data = await self._post(f"{self.config.api_root}/mcp", body)
        return data if isinstance(data, dict) else {}

    async def delete_mcp(self, name: str) -> None:
        await self._delete(f"{self.config.api_root}/mcp/{name}")

    # ------------- tools HTTP -------------
    async def list_http_tools(self) -> list[dict[str, Any]]:
        data = await self._get(f"{self.config.api_root}/tools/http")
        return list(data) if isinstance(data, list) else []

    async def create_http_tool(self, body: dict[str, Any]) -> dict[str, Any]:
        data = await self._post(f"{self.config.api_root}/tools/http", body)
        return data if isinstance(data, dict) else {}

    async def delete_http_tool(self, name: str) -> None:
        await self._delete(f"{self.config.api_root}/tools/http/{name}")

    # ------------- memoria -------------
    async def list_memories(self) -> list[dict[str, Any]]:
        data = await self._get(f"{self.config.api_root}/memories")
        return list(data) if isinstance(data, list) else []

    async def delete_memory(self, key: str) -> None:
        await self._delete(f"{self.config.api_root}/memories/{key}")

    # ------------- SSE -------------
    def _chat_payload(self, body: dict[str, Any]) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "message": body.get("message", ""),
            "mode": body.get("mode", "plan"),
            "skills": list(body.get("skills", [])),
        }
        for key in ("thread_id", "provider", "model", "project"):
            value = body.get(key)
            if value:
                payload[key] = value
        return payload

    async def stream_chat(self, body: dict[str, Any]) -> AsyncIterator[ServerEvent]:
        """Envía un mensaje y devuelve el stream de eventos del agente."""
        payload = self._chat_payload(body)
        async for ev in self._stream("/chat/stream", payload):
            yield ev

    async def stream_resume(self, body: dict[str, Any], resume: Any) -> AsyncIterator[ServerEvent]:
        """Reanuda un hilo pausado (aprobación) con la decisión del usuario."""
        payload = self._chat_payload(body)
        payload["resume"] = resume
        async for ev in self._stream("/chat/resume", payload):
            yield ev

    async def _stream(self, path: str, payload: dict[str, Any]) -> AsyncIterator[ServerEvent]:
        url = f"{self.config.api_root}{path}"
        try:
            async with self._client.stream(
                "POST", url, json=payload, headers={"Accept": "text/event-stream"}
            ) as resp:
                if resp.status_code >= 400:
                    body = await resp.aread()
                    detail = body.decode("utf-8", "replace")
                    try:
                        parsed = json.loads(detail)
                        detail = parsed.get("detail", parsed) if isinstance(parsed, dict) else parsed
                    except ValueError:
                        pass
                    raise ApiError(resp.status_code, str(detail))
                parser = SSEParser()
                async for line in resp.aiter_lines():
                    event = parser.feed(line)
                    if event is not None:
                        yield event
                last = parser.close()
                if last is not None:
                    yield last
        except httpx.HTTPError as exc:
            raise ApiError(0, f"Se perdió la conexión con el servidor: {exc}") from exc
