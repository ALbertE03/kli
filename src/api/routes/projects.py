"""Proyectos: carpetas de trabajo aisladas por usuario (crear o importar).

`path` opcional importa una carpeta existente (validada contra PROJECTS_IMPORT_ROOTS);
sin `path` se crea `projects/<name>`. El registro no borra nunca archivos del disco.
"""

from fastapi import APIRouter

from api.deps import Rt, User
from api.schemas import ProjectIn
from harness.types import Project

router = APIRouter(tags=["projects"])


@router.get("/projects", response_model=list[Project])
async def list_projects(user: User, rt: Rt) -> list[Project]:
    return rt.list_projects(user)


@router.post("/projects", status_code=201, response_model=Project)
async def create_project(body: ProjectIn, user: User, rt: Rt) -> Project:
    return rt.add_project(user, body.name, body.path)


@router.delete("/projects/{name}", status_code=204)
async def delete_project(name: str, user: User, rt: Rt) -> None:
    rt.delete_project(user, name)
