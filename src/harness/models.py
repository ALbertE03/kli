"""Fábrica de modelos de chat a partir de proveedores registrados.

`ResolvedProvider` llega del registro (harness.providers); aquí solo se construye
el cliente (OpenAI-compatible o Anthropic) y se cachea por parámetros efectivos.
"""

from __future__ import annotations

from functools import lru_cache
from typing import Any

from langchain_anthropic import ChatAnthropic
from langchain_core.language_models import BaseChatModel
from langchain_core.messages import AIMessageChunk
from langchain_openai import ChatOpenAI

from harness.config import get_settings
from harness.errors import InvalidConfig
from harness.providers import ResolvedProvider

# Claves con las que los proxies OpenAI-compatible mandan el razonamiento.
REASONING_KEYS = ("reasoning_content", "reasoning")


def _reasoning_from_chunk(chunk: dict[str, Any]) -> str:
    """Saca el razonamiento de un delta del stream.

    Cada proxy lo llama distinto: `reasoning_content` (DeepSeek, Ollama,
    Groq), `reasoning` (OpenRouter) o bloques con texto dentro.
    """
    choices = chunk.get("choices") or chunk.get("chunk", {}).get("choices") or []
    if not choices:
        return ""
    delta = choices[0].get("delta") or {}
    for key in REASONING_KEYS:
        value = delta.get(key)
        if isinstance(value, str) and value:
            return value
        if isinstance(value, list):
            parts: list[str] = []
            for block in value:
                if isinstance(block, str):
                    parts.append(block)
                elif isinstance(block, dict):
                    parts.append(str(block.get("text") or block.get("reasoning") or ""))
            if parts:
                return "".join(parts)
    return ""


class KliChatOpenAI(ChatOpenAI):
    """ChatOpenAI que conserva el razonamiento que manda el proxy.

    El `ChatOpenAI` de LangChain convierte el delta y **tira** los campos
    que no conoce (`reasoning_content`, `reasoning`), así que el pensamiento
    del modelo se perdía antes de llegar al cliente. Aquí se rescata y se
    guarda en `additional_kwargs` para poder mostrarlo.
    """

    def _convert_chunk_to_generation_chunk(
        self,
        chunk: dict,
        default_chunk_class: type,
        base_generation_info: dict | None,
    ) -> Any:
        generation = super()._convert_chunk_to_generation_chunk(
            chunk, default_chunk_class, base_generation_info
        )
        if generation is None:
            return None
        reasoning = _reasoning_from_chunk(chunk)
        message = generation.message
        if reasoning and isinstance(message, AIMessageChunk):
            extra = dict(message.additional_kwargs or {})
            extra["reasoning_content"] = f"{extra.get('reasoning_content', '')}{reasoning}"
            message.additional_kwargs = extra
        return generation


@lru_cache(maxsize=32)
def _build(
    kind: str,
    base_url: str | None,
    api_key: str | None,
    model: str,
    temperature: float | None,
    timeout: float,
    retries: int,
    max_tokens: int,
    stream_usage: bool,
    reasoning_effort: str | None = None,
    reasoning_api: str = "responses",
) -> BaseChatModel:
    key = api_key or "not-needed"  # proxies locales sin autenticación
    # algunos modelos (gpt-6-luna, o1…) no aceptan `temperature`: si es None no se manda
    common: dict[str, object] = {
        "model": model,
        "base_url": base_url,
        "api_key": key,
        "timeout": timeout,
        "max_retries": retries,
        "streaming": True,
    }
    if temperature is not None:
        common["temperature"] = temperature
    if reasoning_effort:
        if reasoning_api == "chat":
            # Chat completions: el modelo razona (`reasoning_effort`) y los proxies
            # que lo soportan mandan el pensamiento en `delta.reasoning_content`
            # (lo rescata KliChatOpenAI). Es la vía para los proveedores que no
            # implementan el API de Responses.
            common["reasoning_effort"] = reasoning_effort
            common["use_responses_api"] = False
        else:
            # El API de Responses es el único que transmite el razonamiento (en el
            # de chat completions solo algunos proxies mandan `reasoning_content`).
            # Con `summary` el modelo envía su resumen de pensamiento, que es lo
            # que se muestra en el cliente.
            common["reasoning"] = {"effort": reasoning_effort, "summary": "auto"}
            common["use_responses_api"] = True
    if kind == "openai":
        return KliChatOpenAI(stream_usage=stream_usage, **common)  # type: ignore[arg-type]
    return ChatAnthropic(max_tokens=max_tokens, **common)  # type: ignore[arg-type]


def build_chat_model(rp: ResolvedProvider) -> BaseChatModel:
    s = get_settings()
    model = rp.model or (s.openai_model if rp.kind == "openai" else s.anthropic_model)
    if rp.kind == "anthropic" and rp.api_key is None:
        raise InvalidConfig("El proveedor anthropic necesita api_key (o ANTHROPIC_API_KEY)")
    return _build(
        rp.kind,
        rp.base_url,
        rp.api_key.get_secret_value() if rp.api_key else None,
        model,
        s.temperature,
        s.request_timeout,
        s.max_retries,
        s.max_output_tokens,
        s.openai_stream_usage,
        s.reasoning_effort,
        s.reasoning_api,
    )


def default_chat_model() -> BaseChatModel:
    """Modelo del proveedor por defecto (lo usan tools del sistema como deep_search)."""
    from harness.providers import ProviderRegistry

    return build_chat_model(ProviderRegistry(get_settings()).resolve(None, "_system"))
