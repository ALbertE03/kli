import pytest
from fastapi.testclient import TestClient

from api.main import create_app


@pytest.fixture(scope="module")
def client():
    with TestClient(create_app()) as c:
        yield c


H = {"X-User-Id": "alice"}
SKILL = {
    "name": "mi_skill",
    "description": "Skill de prueba",
    "instructions": "Responde breve.",
    "tool_names": ["web_search"],
    "subagents": [],
}


def test_health(client):
    assert client.get("/health").json()["status"] == "ok"


def test_registry_lists_modes_and_tools(client):
    data = client.get("/api/v1/registry", headers=H).json()
    assert {m["name"] for m in data["modes"]} == {"plan", "build"}
    names = {t["name"] for t in data["tools"]}
    assert "remember" in names
    # tools de desarrollo
    assert {"code_search", "file_tree", "python_outline", "git_status", "git_diff", "git_log"} <= names
    # hora_actual se eliminó: el prompt ya incluye la fecha
    assert "hora_actual" not in names


def test_registry_marks_the_web_tools_as_opt_in(client):
    """La búsqueda web viene apagada: el cliente tiene que pedirla."""
    data = client.get("/api/v1/registry", headers=H).json()
    tools = {t["name"]: t for t in data["tools"]}
    assert tools["web_search"]["opt_in"] is True
    assert tools["deep_search"]["opt_in"] is True
    assert tools["code_search"]["opt_in"] is False


def test_skill_lifecycle_and_isolation(client):
    assert client.post("/api/v1/skills", json=SKILL, headers=H).status_code == 201
    assert client.post("/api/v1/skills", json=SKILL, headers=H).status_code == 409
    bob = client.get("/api/v1/registry", headers={"X-User-Id": "bob"}).json()
    assert "mi_skill" not in {s["name"] for s in bob["skills"]}
    assert client.delete("/api/v1/skills/mi_skill", headers=H).status_code == 204


def test_skill_with_unknown_tool_is_rejected(client):
    bad = {**SKILL, "name": "otra", "tool_names": ["no_existe"]}
    assert client.post("/api/v1/skills", json=bad, headers=H).status_code == 422


def test_http_tool_to_private_host_is_blocked(client):
    body = {
        "name": "interna",
        "description": "Intenta llegar a localhost",
        "url": "http://127.0.0.1:8080/x",
        "allowed_hosts": ["127.0.0.1"],
    }
    assert client.post("/api/v1/tools/http", json=body, headers=H).status_code == 403


def test_server_config_exposes_capabilities(client):
    data = client.get("/api/v1/config", headers=H).json()
    assert data["version"]
    assert data["default_provider"] in {"openai", "anthropic"}
    assert data["default_model"]
    assert isinstance(data["enable_exec"], bool)


def test_cancel_without_running_stream_is_false(client):
    resp = client.post("/api/v1/chat/cancel", json={"thread_id": "no_existe"}, headers=H)
    assert resp.status_code == 200
    assert resp.json() == {"cancelled": False}


def test_cancel_rejects_invalid_thread_id(client):
    assert client.post("/api/v1/chat/cancel", json={"thread_id": "mal id!"}, headers=H).status_code == 422


def test_projects_browse_lists_folders_and_roots(client):
    data = client.get("/api/v1/projects/browse", headers=H).json()
    assert "dirs" in data and "files" in data and "roots" in data
    assert any(root for root in data["roots"])


def test_projects_browse_outside_allowed_roots_is_forbidden(client):
    resp = client.get("/api/v1/projects/browse?path=/etc", headers=H)
    assert resp.status_code == 403
    assert "raíces permitidas" in resp.json()["detail"]


def test_server_config_exposes_project_roots(client):
    data = client.get("/api/v1/config", headers=H).json()
    assert data["projects_dir"]
    assert isinstance(data["projects_import_roots"], list)
