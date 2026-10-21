"""Runtime: une configuración, registro, memoria, MCP, persistencia y fábrica de agentes."""

import asyncio
import json
import logging
from pathlib import Path
from typing import Any

from harness.config import Settings
from harness.errors import Conflict, Forbidden, HarnessError, NotFound
from harness.kernel import AgentFactory
from harness.log import configure_logging
from harness.mcp.manager import MCPManager, parse_server_config
from harness.mcp.types import HttpServerConfig, MCPServerInfo
from harness.memory import MemoryRuntime
from harness.plugins import load_plugins
from harness.plugins.tools.http_template import HttpToolConfig, build_http_tool
from harness.projects import ProjectRegistry
from harness.providers import ProviderOut, ProviderRegistry, ProviderSpec
from harness.registry import Registry, registry
from harness.storage import Storage
from harness.types import Project, Skill, SkillBase, ToolCategory

log = logging.getLogger(__name__)
# "project" no cuenta: es solo un registro de carpetas, no un tool
CUSTOM_KINDS = ("skill", "http_tool", "mcp", "provider")


class Runtime:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.registry: Registry = registry
        self.memory = MemoryRuntime(settings)
        self.storage = Storage(settings.db_path, settings.secret_key)
        self.mcp = MCPManager(self.registry, settings.stdio_allowlist)
        self.providers = ProviderRegistry(settings)
        self.projects = ProjectRegistry(settings, self.storage)
        self.factory: AgentFactory
        self._locks: dict[str, asyncio.Lock] = {}
        # task que emite el stream de cada hilo en curso (para poder cancelarla)
        self._runs: dict[str, asyncio.Task[Any]] = {}

    async def start(self) -> None:
        configure_logging(self.settings.log_level)
        self.settings.validate_for_runtime()
        # el workspace de proyectos siempre existe (ahí se crean los proyectos)
        self.settings.projects_dir.mkdir(parents=True, exist_ok=True)
        load_plugins()
        await self.memory.start()
        self.factory = AgentFactory(
            self.registry, self.memory, self.providers, self.projects, self.settings.agent_cache_size
        )
        await self._load_global_mcp()
        await self._restore_user_configs()
        log.info("Runtime listo (%d tools)", len(self.registry.list_tools(None)))

    async def stop(self) -> None:
        self.factory.clear()
        await self.memory.stop()
        self.storage.close()

    def lock_for(self, key: str) -> asyncio.Lock:
        """Un lock por hilo evita dos ejecuciones simultáneas sobre el mismo estado."""
        return self._locks.setdefault(key, asyncio.Lock())

    # ------------- control de ejecuciones -------------
    def register_run(self, key: str, task: asyncio.Task[Any]) -> None:
        """Guarda la task que emite el stream de un hilo (para poder cancelarla)."""
        self._runs[key] = task

    def unregister_run(self, key: str) -> None:
        self._runs.pop(key, None)

    def cancel_run(self, key: str) -> bool:
        """Corta el stream en curso de un hilo. True si había algo que cortar."""
        task = self._runs.get(key)
        if task is None or task.done():
            return False
        task.cancel()
        return True

    # ------------- arranque -------------
    async def _load_global_mcp(self) -> None:
        path = self.settings.mcp_config_file
        if not path or not path.exists():
            return
        try:
            raw: list[dict[str, Any]] = json.loads(path.read_text())
            configs = [parse_server_config(item) for item in raw]
        except Exception as exc:  # noqa: BLE001
            log.error("mcp_config_file inválido: %s", exc)
            return
        await self.mcp.connect_all(configs)

    async def _restore_user_configs(self) -> None:
        for owner, _, data in self.storage.list_configs("skill"):
            try:
                self.registry.add_skill(Skill(**data, owner=owner))
            except Conflict:
                pass
            except Exception as exc:  # noqa: BLE001
                log.error("Skill de %s no restaurada: %s", owner, exc)
        for owner, name, data in self.storage.list_configs("http_tool"):
            try:
                tool = await build_http_tool(HttpToolConfig(**data))
                self.registry.add_tool(tool, ToolCategory.NETWORK, owner)
            except Conflict:
                pass
            except Exception as exc:  # noqa: BLE001
                log.error("Tool HTTP '%s' de %s no restaurada: %s", name, owner, exc)
        for owner, name, data in self.storage.list_configs("mcp"):
            try:
                cfg = parse_server_config(data)
                await self.mcp.connect(cfg, owner=owner)
            except Conflict:
                pass
            except Exception as exc:  # noqa: BLE001
                log.error("MCP '%s' de %s no restaurado: %s", name, owner, exc)
        for owner, name, data in self.storage.list_configs("provider"):
            try:
                self.providers.add(owner, ProviderSpec(name=name, **data))
            except Conflict:
                pass
            except Exception as exc:  # noqa: BLE001
                log.error("Proveedor '%s' de %s no restaurado: %s", name, owner, exc)
        for owner, name, data in self.storage.list_configs("project"):
            if not Path(data.get("root", "")).is_dir():
                log.warning(
                    "El proyecto '%s' de %s apunta a una carpeta inexistente: %s",
                    name, owner, data.get("root"),
                )

    # ------------- recursos del usuario -------------
    def _check_quota(self, owner: str) -> None:
        total = sum(self.storage.count_configs(k, owner) for k in CUSTOM_KINDS)
        if total >= self.settings.max_custom_per_user:
            raise Forbidden("Límite de elementos personalizados alcanzado")

    def add_skill(self, owner: str, data: SkillBase) -> Skill:
        self._check_quota(owner)
        skill = Skill(**data.model_dump(), owner=owner)
        names = [*skill.tool_names, *(t for sa in skill.subagents for t in sa.tool_names)]
        self.registry.require_tools(names, owner)
        self.registry.add_skill(skill)
        self.storage.put_config("skill", owner, skill.name, skill.model_dump(mode="json", exclude={"owner"}))
        return skill

    def delete_skill(self, owner: str, name: str) -> None:
        self.registry.remove_skill(name, owner)
        self.storage.delete_config("skill", owner, name)

    async def add_http_tool(self, owner: str, cfg: HttpToolConfig) -> str:
        self._check_quota(owner)
        tool = await build_http_tool(cfg)
        self.registry.add_tool(tool, ToolCategory.NETWORK, owner)  # categoría fija: nunca EXEC
        self.storage.put_config("http_tool", owner, cfg.name, cfg.model_dump(mode="json"))
        return tool.name

    def delete_http_tool(self, owner: str, name: str) -> None:
        if not self.storage.delete_config("http_tool", owner, name):
            raise NotFound(f"Tool HTTP no encontrada: {name}")
        self.registry.remove_tool(name, owner)

    async def add_mcp(self, owner: str, cfg: HttpServerConfig) -> MCPServerInfo:
        self._check_quota(owner)
        cfg = cfg.model_copy(update={"category": ToolCategory.NETWORK})  # el usuario no elige categoría
        info = await self.mcp.connect(cfg, owner=owner)
        self.storage.put_config("mcp", owner, cfg.name, cfg.model_dump(mode="json"))
        return info

    def delete_mcp(self, owner: str, name: str) -> None:
        self.mcp.disconnect(name, owner)
        self.storage.delete_config("mcp", owner, name)

    def list_http_tools(self, owner: str) -> list[dict[str, Any]]:
        result = []
        for _, name, data in self.storage.list_configs("http_tool", owner):
            data.pop("headers", None)  # nunca devolver credenciales
            result.append(data)
        return result

    # ------------- proveedores -------------
    def add_provider(self, owner: str, spec: ProviderSpec) -> ProviderOut:
        self._check_quota(owner)
        self.providers.add(owner, spec)
        self.storage.put_config(
            "provider",
            owner,
            spec.name,
            {
                "kind": spec.kind,
                "base_url": spec.base_url,
                # clave real en disco (cifrada si SECRET_KEY); nunca se devuelve por API
                "api_key": spec.api_key.get_secret_value() if spec.api_key else None,
                "default_model": spec.default_model,
            },
        )
        return self._provider_out(owner, spec.name)

    def delete_provider(self, owner: str, name: str) -> None:
        self.providers.remove(owner, name)
        self.storage.delete_config("provider", owner, name)

    def list_providers(self, owner: str) -> list[ProviderOut]:
        return self.providers.list(owner)

    def _provider_out(self, owner: str, name: str) -> ProviderOut:
        for out in self.providers.list(owner):
            if out.name == name:
                return out
        raise NotFound(f"Proveedor no encontrado: {name}")

    # ------------- proyectos -------------
    def add_project(self, owner: str, name: str, path: str | None = None) -> Project:
        return self.projects.add(owner, name, path)

    def delete_project(self, owner: str, name: str) -> None:
        self.projects.remove(owner, name)

    def list_projects(self, owner: str) -> list[Project]:
        return self.projects.list(owner)

    def get_project(self, owner: str, name: str) -> Project:
        return self.projects.get(owner, name)


__all__ = ["HarnessError", "Runtime"]
