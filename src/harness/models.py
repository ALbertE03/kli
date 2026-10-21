"""Fábrica de modelos de chat a partir de proveedores registrados.

`ResolvedProvider` llega del registro (harness.providers); aquí solo se construye
el cliente (OpenAI-compatible o Anthropic) y se cachea por parámetros efectivos.
"""

from functools import lru_cache

from langchain_anthropic import ChatAnthropic
from langchain_core.language_models import BaseChatModel
from langchain_openai import ChatOpenAI

from harness.config import get_settings
from harness.errors import InvalidConfig
from harness.providers import ResolvedProvider


@lru_cache(maxsize=32)
def _build(
    kind: str,
    base_url: str | None,
    api_key: str | None,
    model: str,
    temperature: float,
    timeout: float,
    retries: int,
    max_tokens: int,
    stream_usage: bool,
) -> BaseChatModel:
    key = api_key or "not-needed"  # proxies locales sin autenticación
    if kind == "openai":
        return ChatOpenAI(
            model=model,
            base_url=base_url,
            api_key=key,
            temperature=temperature,
            timeout=timeout,
            max_retries=retries,
            streaming=True,
            stream_usage=stream_usage,
        )
    return ChatAnthropic(
        model=model,
        base_url=base_url,
        api_key=key,
        temperature=temperature,
        timeout=timeout,
        max_retries=retries,
        max_tokens=max_tokens,
        streaming=True,
    )


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
    )


def default_chat_model() -> BaseChatModel:
    """Modelo del proveedor por defecto (lo usan tools del sistema como deep_search)."""
    from harness.providers import ProviderRegistry

    return build_chat_model(ProviderRegistry(get_settings()).resolve(None, "_system"))
