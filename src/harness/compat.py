"""Capa de compatibilidad con deepagents.

La API de `create_deep_agent` ha cambiado entre versiones (instructions -> system_prompt,
prompt -> system_prompt en subagentes, checkpointer/store/interrupt_on/middleware como
parámetros). Todo ese ajuste vive aquí: si tu versión difiere, este es el único archivo
que tocas.
"""

import inspect
import logging
from typing import Any

from langchain_core.language_models import BaseChatModel
from langchain_core.tools import BaseTool

from harness.types import SubAgentSpec

log = logging.getLogger(__name__)


def _subagent_dict(spec: SubAgentSpec, tools: list[BaseTool]) -> dict[str, Any]:
    return {
        "name": spec.name,
        "description": spec.description,
        "prompt": spec.prompt,  # deepagents antiguos
        "system_prompt": spec.prompt,  # deepagents recientes
        "tools": tools,
    }


def create_agent_compat(
    *,
    model: BaseChatModel,
    tools: list[BaseTool],
    system_prompt: str,
    subagents: list[tuple[SubAgentSpec, list[BaseTool]]],
    checkpointer: Any,
    store: Any,
    interrupt_on: dict[str, bool],
    middleware: list[Any] | None = None,
) -> Any:
    from deepagents import create_deep_agent

    params = inspect.signature(create_deep_agent).parameters
    kwargs: dict[str, Any] = {"tools": tools, "model": model}

    if "system_prompt" in params:
        kwargs["system_prompt"] = system_prompt
    elif "instructions" in params:
        kwargs["instructions"] = system_prompt
    else:
        raise RuntimeError("create_deep_agent no acepta system_prompt ni instructions")

    if subagents and "subagents" in params:
        kwargs["subagents"] = [_subagent_dict(spec, t) for spec, t in subagents]
    if middleware and "middleware" in params:
        kwargs["middleware"] = middleware
    if "checkpointer" in params:
        kwargs["checkpointer"] = checkpointer
    if "store" in params:
        kwargs["store"] = store
    if interrupt_on:
        if "interrupt_on" in params:
            kwargs["interrupt_on"] = interrupt_on
        else:
            log.warning("Esta versión de deepagents no soporta interrupt_on; sin aprobaciones")

    agent = create_deep_agent(**kwargs)

    # Versiones sin esos parámetros: se asignan al grafo compilado
    if "checkpointer" not in params and checkpointer is not None:
        agent.checkpointer = checkpointer
    if "store" not in params and store is not None:
        agent.store = store
    return agent
