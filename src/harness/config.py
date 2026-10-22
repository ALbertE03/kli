"""Configuración tipada del harness (variables de entorno o .env)."""

from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic import SecretStr, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

Provider = Literal["openai", "anthropic"]
Backend = Literal["memory", "sqlite", "postgres"]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    harness_env: Literal["dev", "prod"] = "dev"
    log_level: str = "INFO"

    # --- Modelo (built-in "openai"; otros proveedores compatibles se registran vía API) ---
    default_provider: Provider = "openai"
    openai_base_url: str = "https://api.openai.com/v1"
    openai_model: str = "auto"
    openai_api_key: SecretStr = SecretStr("not-needed")
    openai_stream_usage: bool = False
    anthropic_model: str = "claude-sonnet-5-5"
    anthropic_api_key: SecretStr | None = None
    temperature: float | None = 0.2  # None = no mandarlo (modelos que no lo admiten)
    # esfuerzo de razonamiento: vacío = no mandarlo (solo lo aceptan algunos modelos)
    reasoning_effort: str | None = None
    request_timeout: float = 120.0
    max_retries: int = 2
    max_output_tokens: int = 8192

    # --- Memoria / persistencia ---
    checkpoint_backend: Backend = "sqlite"
    store_backend: Backend = "sqlite"
    postgres_url: str | None = None
    data_dir: Path = Path("./data")
    workspace_dir: Path = Path("./workspace")

    # --- Proyectos (sandbox por carpeta) ---
    projects_dir: Path = Path("./projects")
    # Raíces desde las que se puede importar una carpeta existente (además del cwd)
    projects_import_roots: str = ""

    # --- Seguridad ---
    api_keys: str = ""
    secret_key: SecretStr | None = None
    cors_origins: str = "http://localhost:3000"
    enable_exec: bool = False

    # --- Herramientas ---
    tavily_api_key: SecretStr | None = None
    mcp_config_file: Path | None = None
    mcp_stdio_allowlist: str = "npx,uvx,node,python"

    # --- Límites ---
    recursion_limit: int = 100
    agent_cache_size: int = 32
    max_custom_per_user: int = 50

    @field_validator("temperature", mode="before")
    @classmethod
    def _blank_temperature(cls, value: object) -> object:
        """TEMPERATURE vacío = no mandar el parámetro (modelos que no lo admiten)."""
        if isinstance(value, str) and not value.strip():
            return None
        return value

    @field_validator("mcp_config_file", mode="before")
    @classmethod
    def _blank_mcp_config(cls, value: object) -> object:
        """MCP_CONFIG_FILE vacío = sin fichero de configuración."""
        if isinstance(value, str) and not value.strip():
            return None
        return value

    @property
    def api_key_map(self) -> dict[str, str]:
        """'clave:usuario,clave2:usuario2' -> {clave: usuario}."""
        result: dict[str, str] = {}
        for item in (p.strip() for p in self.api_keys.split(",")):
            if item:
                key, _, user = item.partition(":")
                result[key] = user or "user"
        return result

    @property
    def cors_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]

    @property
    def stdio_allowlist(self) -> frozenset[str]:
        return frozenset(c.strip() for c in self.mcp_stdio_allowlist.split(",") if c.strip())

    @property
    def db_path(self) -> Path:
        return self.data_dir / "harness.db"

    def validate_for_runtime(self) -> None:
        if self.harness_env == "prod" and not self.api_key_map:
            raise RuntimeError("HARNESS_ENV=prod exige API_KEYS configuradas")
        if "postgres" in (self.checkpoint_backend, self.store_backend) and not self.postgres_url:
            raise RuntimeError("Falta POSTGRES_URL para el backend postgres")


@lru_cache
def get_settings() -> Settings:
    return Settings()
