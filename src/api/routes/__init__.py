from fastapi import APIRouter

from api.routes import catalog, chat, custom, projects, providers, threads

api_router = APIRouter()
for module in (chat, threads, catalog, custom, providers, projects):
    api_router.include_router(module.router)
