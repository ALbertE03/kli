"""Utilidades pequeñas compartidas."""

import json
from typing import Any

from langchain_core.messages import BaseMessage


def content_to_text(content: Any) -> str:
    """Normaliza el contenido de un mensaje (str o bloques estilo Anthropic) a texto."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for block in content:
            if isinstance(block, str):
                parts.append(block)
            elif isinstance(block, dict) and block.get("type") == "text":
                parts.append(str(block.get("text", "")))
        return "".join(parts)
    return "" if content is None else str(content)


def _block_text(block: Any) -> str:
    """Texto de un bloque de razonamiento, sea str, dict o lista de bloques.

    Cada proveedor lo da de otra manera: el API de Responses lo manda en
    `summary` (lista de bloques `summary_text`), el formato viejo (v0.3) lo
    deja como dict en `additional_kwargs["reasoning"]` y los proxies lo
    mandan como texto plano.
    """
    if isinstance(block, str):
        return block
    if isinstance(block, list):
        return "".join(_block_text(item) for item in block)
    if isinstance(block, dict):
        for key in ("summary", "text", "reasoning", "thinking", "content"):
            raw = block.get(key)
            if isinstance(raw, str) and raw:
                return raw
            if isinstance(raw, list | dict):
                found = _block_text(raw)
                if found:
                    return found
    return ""


def split_chunk(chunk: Any) -> tuple[str, str]:
    """Separa (texto, razonamiento) de un chunk de streaming.

    El razonamiento llega de varias maneras según el proveedor:
      · bloques `{"type": "reasoning"|"thinking"}` dentro del contenido
      · `additional_kwargs["reasoning_content"]` (proxies OpenAI-compatible)
      · `additional_kwargs["reasoning"]` (formato v0.3: un dict, no un texto)
    """
    content = getattr(chunk, "content", chunk)
    text: list[str] = []
    reasoning: list[str] = []
    if isinstance(content, str):
        text.append(content)
    elif isinstance(content, list):
        for block in content:
            if isinstance(block, str):
                text.append(block)
            elif isinstance(block, dict):
                kind = block.get("type")
                if kind == "text":
                    text.append(str(block.get("text", "")))
                elif kind in ("reasoning", "thinking"):
                    # API de Responses: el texto va en "summary"
                    reasoning.append(_block_text(block))
    extra = getattr(chunk, "additional_kwargs", None)
    if isinstance(extra, dict):
        for key in ("reasoning_content", "reasoning", "reasoning_details", "thinking"):
            found = _block_text(extra.get(key))
            if found:
                reasoning.append(found)
    return "".join(text), "".join(reasoning)


def clip(text: str, limit: int = 4000) -> str:
    return text if len(text) <= limit else text[:limit] + "…[truncado]"


def json_safe(value: Any, limit: int = 4000) -> Any:
    """Convierte cualquier valor a algo serializable y acotado."""
    dumped = json.dumps(value, default=str, ensure_ascii=False)
    if len(dumped) > limit:
        return {"truncated": dumped[:limit]}
    return json.loads(dumped)


def serialize_message(message: BaseMessage) -> dict[str, Any]:
    return {
        "id": message.id,
        "role": message.type,  # human | ai | tool | system
        "content": content_to_text(message.content),
        "name": getattr(message, "name", None),
        "tool_calls": getattr(message, "tool_calls", None) or [],
    }
