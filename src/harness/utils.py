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


def split_chunk(content: Any) -> tuple[str, str]:
    """Separa (texto, razonamiento) de un chunk de streaming."""
    if isinstance(content, str):
        return content, ""
    text: list[str] = []
    reasoning: list[str] = []
    if isinstance(content, list):
        for block in content:
            if isinstance(block, str):
                text.append(block)
            elif isinstance(block, dict):
                kind = block.get("type")
                if kind == "text":
                    text.append(str(block.get("text", "")))
                elif kind == "thinking":
                    reasoning.append(str(block.get("thinking", "")))
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
