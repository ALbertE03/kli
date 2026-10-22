"""Kernel: arma un deep agent filtrando tools, skills y subagentes según modo, usuario y proyecto."""

import logging
from collections import OrderedDict
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

from langchain_core.language_models import BaseChatModel
from langchain_core.tools import BaseTool

from harness.compat import create_agent_compat
from harness.memory import MemoryRuntime
from harness.models import build_chat_model
from harness.plugins.tools.codigo import make_exec_tools, make_fs_tools
from harness.plugins.tools.dev import make_dev_tools
from harness.projects import ProjectRegistry
from harness.prompts import build_system_prompt
from harness.providers import ProviderRegistry
from harness.registry import Registry
from harness.types import Mode, Skill, SubAgentSpec

log = logging.getLogger(__name__)


@dataclass(frozen=True)
class AgentRequest:
    user_id: str
    mode: str = "plan"
    skills: tuple[str, ...] = ()
    provider: str | None = None
    model: str | None = None
    project: str | None = None
    # Tools opt-in que se cargan (p. ej. web_search). Vacío = solo las de siempre.
    opt_in: tuple[str, ...] = ()

    def key(self) -> tuple[Any, ...]:
        return (
            self.user_id,
            self.mode,
            self.skills,
            self.provider,
            self.model,
            self.project,
            self.opt_in,
        )


def _scope_project(tools: list[BaseTool], root: str) -> list[BaseTool]:
    """Sustituye las tools de archivos/código por versiones confinadas a la raíz del proyecto."""
    scoped = {**make_fs_tools(root), **make_dev_tools(root), **make_exec_tools(root)}
    return [scoped.get(t.name, t) for t in tools]


def select_tool_names(
    req: AgentRequest, mode: Mode, skills: Sequence[Skill], registry: Registry
) -> tuple[list[str], set[str]]:
    """Tools que se cargan para este pedido y el conjunto de opt-in activadas.

    Las tools opt-in (búsqueda web, deep research) no entran hasta que se piden:
    hasta entonces, cargar sus esquemas en el prompt es tokens de entrada
    tirados. Se devuelven también las activadas para filtrar los subagentes.
    """
    enabled = {name for name in req.opt_in if registry.is_gated(name)}
    names = [
        n
        for n in [*mode.base_tool_names, *(t for s in skills for t in s.tool_names)]
        if not registry.is_gated(n) or n in enabled
    ]
    names.extend(n for n in enabled if n not in names)
    return names, enabled


def build_agent(
    req: AgentRequest,
    *,
    registry: Registry,
    memory: MemoryRuntime,
    providers: ProviderRegistry,
    projects: ProjectRegistry,
    model: BaseChatModel | None = None,
) -> Any:
    mode = registry.get_mode(req.mode)
    skills = [registry.get_skill(name, req.user_id) for name in req.skills]
    allowed = mode.categories

    tool_names, enabled = select_tool_names(req, mode, skills, registry)
    tools = registry.resolve_tools(tool_names, allowed, req.user_id)

    subagents: list[tuple[SubAgentSpec, list[BaseTool]]] = []
    seen: set[str] = set()
    for skill in skills:
        for spec in skill.subagents:
            if spec.name in seen:
                continue
            seen.add(spec.name)
            names = [n for n in spec.tool_names if not registry.is_gated(n) or n in enabled]
            # Un subagente nunca recibe más permisos que el modo activo
            subagents.append((spec, registry.resolve_tools(names, allowed, req.user_id)))

    if req.project:
        # Sandbox por proyecto: las fs_* solo operan dentro de su raíz
        root = str(projects.get(req.user_id, req.project).root)
        tools = _scope_project(tools, root)
        subagents = [(spec, _scope_project(ts, root)) for spec, ts in subagents]

    active = {t.name for t in tools}
    prompt = build_system_prompt(mode, skills, tool_names=sorted(active))
    interrupt_on = {name: True for name in mode.approval_required if name in active}

    resolved = providers.resolve(req.provider, req.user_id)
    return create_agent_compat(
        model=model or build_chat_model(resolved),
        tools=tools,
        system_prompt=prompt,
        subagents=subagents,
        checkpointer=memory.checkpointer,
        store=memory.store,
        interrupt_on=interrupt_on,
        middleware=_caching_middleware(resolved.kind),
    )


def _caching_middleware(kind: str) -> list[Any]:
    """Caching del lado del proveedor: Anthropic necesita breakpoints explícitos."""
    if kind != "anthropic":
        return []  # OpenAI cachea prefijos automáticamente en el servidor
    from langchain_anthropic.middleware.prompt_caching import (
        AnthropicPromptCachingMiddleware,
    )

    return [AnthropicPromptCachingMiddleware(unsupported_model_behavior="ignore")]


class AgentFactory:
    """Construye agentes y los cachea (LRU) hasta que el registro cambie."""

    def __init__(
        self,
        registry: Registry,
        memory: MemoryRuntime,
        providers: ProviderRegistry,
        projects: ProjectRegistry,
        max_size: int = 32,
    ) -> None:
        self._registry = registry
        self._memory = memory
        self._providers = providers
        self._projects = projects
        self._max = max_size
        self._cache: OrderedDict[tuple[Any, ...], Any] = OrderedDict()

    def get(self, req: AgentRequest) -> Any:
        key = (*req.key(), self._registry.version)
        agent = self._cache.get(key)
        if agent is not None:
            self._cache.move_to_end(key)
            return agent
        agent = build_agent(
            req,
            registry=self._registry,
            memory=self._memory,
            providers=self._providers,
            projects=self._projects,
        )
        self._cache[key] = agent
        while len(self._cache) > self._max:
            self._cache.popitem(last=False)
        return agent

    def clear(self) -> None:
        self._cache.clear()
