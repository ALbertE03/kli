"""CRUD de proveedores de modelos: built-ins (openai, anthropic) + compatibles por usuario.

Solo se admiten proveedores compatibles con la API de OpenAI o con la de Anthropic
(freellmapi, LM Studio, vLLM, proxies corporativos…). Las claves nunca se devuelven.
"""

from fastapi import APIRouter, Query
from pydantic import SecretStr

from api.deps import Rt, User
from api.schemas import ModelListOut, ProviderIn
from harness.providers import ProviderOut, ProviderSpec, fetch_models
from harness.types import NAME_PATTERN

router = APIRouter(tags=["providers"])


@router.get("/providers", response_model=list[ProviderOut])
async def list_providers(user: User, rt: Rt) -> list[ProviderOut]:
    return rt.list_providers(user)


@router.post("/providers", status_code=201, response_model=ProviderOut)
async def create_provider(body: ProviderIn, user: User, rt: Rt) -> ProviderOut:
    spec = ProviderSpec(
        name=body.name,
        kind=body.kind,
        base_url=body.base_url,
        api_key=SecretStr(body.api_key) if body.api_key else None,
        default_model=body.default_model,
    )
    return rt.add_provider(user, spec)


@router.delete("/providers/{name}", status_code=204)
async def delete_provider(name: str, user: User, rt: Rt) -> None:
    rt.delete_provider(user, name)


@router.get("/providers/{name}/models", response_model=ModelListOut)
async def provider_models(name: str, user: User, rt: Rt) -> ModelListOut:
    """Modelos que ofrece un proveedor concreto (para poblar el selector del front)."""
    rp = rt.providers.resolve(name, user)
    return ModelListOut(provider=rp.name, kind=rp.kind, models=await fetch_models(rp))


@router.get("/models", response_model=ModelListOut)
async def default_models(
    user: User,
    rt: Rt,
    provider: str | None = Query(default=None, pattern=NAME_PATTERN),
) -> ModelListOut:
    """Modelos del proveedor por defecto (o de ?provider=nombre)."""
    rp = rt.providers.resolve(provider, user)
    return ModelListOut(provider=rp.name, kind=rp.kind, models=await fetch_models(rp))
