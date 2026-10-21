"""Tests del CLI: parser de SSE y flujo del TUI con un cliente falso."""

from __future__ import annotations

import asyncio
from typing import Any

import pytest

from cli.app import KliApp
from cli.client import ServerEvent, SSEParser
from cli.config import CliConfig
from cli.widgets import ApprovalPanel, ToolCard, UserMessage

# ---------------------------------------------------------------- SSE


def test_sse_parser_reads_event_and_data():
    parser = SSEParser()
    assert parser.feed("event: token") is None
    assert parser.feed('data: {"text": "hola"}') is None
    event = parser.feed("")
    assert event is not None
    assert event.type == "token"
    assert event.text == "hola"


def test_sse_parser_defaults_to_message_and_survives_bad_json():
    parser = SSEParser()
    parser.feed("data: no-es-json")
    event = parser.feed("")
    assert event is not None
    assert event.type == "message"
    assert event.data["raw"] == "no-es-json"


def test_sse_parser_ignores_comments_and_empty_frames():
    parser = SSEParser()
    assert parser.feed(": keep-alive") is None
    assert parser.feed("") is None


def test_sse_parser_close_emits_pending_event():
    parser = SSEParser()
    parser.feed("event: done")
    parser.feed("data: {}")
    event = parser.close()
    assert event is not None and event.type == "done"


# ---------------------------------------------------------------- TUI


class FakeClient:
    """Cliente falso: devuelve un stream de eventos predefinido."""

    def __init__(self, events: list[ServerEvent], resume_events: list[ServerEvent] | None = None):
        self.events = events
        self.resume_events = resume_events or []
        self.sent: list[dict[str, Any]] = []
        self.resumed: Any = None
        self.cancelled = False
        self.calls: list[tuple[str, Any]] = []  # (método, argumentos)

    async def health(self) -> dict[str, Any]:
        return {"status": "ok", "version": "0.1.0"}

    async def server_config(self) -> dict[str, Any]:
        return {
            "version": "0.1.0",
            "default_provider": "openai",
            "default_model": "gpt-4o",
            "enable_exec": False,
            "recursion_limit": 100,
            "max_custom_per_user": 50,
            "projects_dir": "/data/projects",
            "projects_import_roots": ["/data/projects", "/host"],
        }

    async def registry(self) -> dict[str, Any]:
        return {
            "modes": [{"name": "plan", "description": "solo lectura"}],
            "skills": [{"name": "investigacion", "description": "busca en la web"}],
            "tools": [{"name": "code_search", "category": "read"}],
            "providers": [{"name": "openai"}],
            "projects": [{"name": "demo", "root": "/tmp/demo"}],
        }

    async def threads(self) -> list[dict[str, Any]]:
        return [{"thread_id": "abc123", "title": "hola", "mode": "plan", "updated_at": "hoy"}]

    async def thread_messages(self, thread_id: str) -> list[dict[str, Any]]:
        self.calls.append(("thread_messages", thread_id))
        return [
            {"id": "1", "role": "human", "content": "hola"},
            {"id": "2", "role": "ai", "content": "**hola** a ti"},
        ]

    # ---- recursos: se registran las llamadas para poder comprobar el CRUD ----
    async def create_project(self, name: str, path: str | None = None) -> dict[str, Any]:
        self.calls.append(("create_project", (name, path)))
        return {"name": name, "root": f"/data/projects/{name}"}

    async def delete_project(self, name: str) -> None:
        self.calls.append(("delete_project", name))

    async def create_skill(self, body: dict[str, Any]) -> dict[str, Any]:
        self.calls.append(("create_skill", body))
        return body

    async def delete_skill(self, name: str) -> None:
        self.calls.append(("delete_skill", name))

    async def create_provider(self, body: dict[str, Any]) -> dict[str, Any]:
        self.calls.append(("create_provider", body))
        return body

    async def delete_provider(self, name: str) -> None:
        self.calls.append(("delete_provider", name))

    async def models(self, provider: str | None = None) -> list[str]:
        self.calls.append(("models", provider))
        return ["gpt-4o", "gpt-6-luna"]

    async def provider_models(self, name: str) -> list[str]:
        return ["gpt-4o"]

    async def browse_projects(self, path: str | None = None) -> dict[str, Any]:
        self.calls.append(("browse_projects", path))
        return {
            "path": path or "/data/projects",
            "parent": "/data",
            "dirs": ["mi-repo", "otro"],
            "files": ["notas.txt"],
            "roots": ["/data/projects", "/host"],
        }

    async def list_mcp(self) -> list[dict[str, Any]]:
        return []

    async def create_mcp(self, body: dict[str, Any]) -> dict[str, Any]:
        self.calls.append(("create_mcp", body))
        return body

    async def delete_mcp(self, name: str) -> None:
        self.calls.append(("delete_mcp", name))

    async def list_http_tools(self) -> list[dict[str, Any]]:
        return []

    async def create_http_tool(self, body: dict[str, Any]) -> dict[str, Any]:
        self.calls.append(("create_http_tool", body))
        return body

    async def delete_http_tool(self, name: str) -> None:
        self.calls.append(("delete_http_tool", name))

    async def list_memories(self) -> list[dict[str, Any]]:
        return [{"key": "nota", "value": "recuerdame esto"}]

    async def delete_memory(self, key: str) -> None:
        self.calls.append(("delete_memory", key))

    async def delete_thread(self, thread_id: str) -> None:
        self.calls.append(("delete_thread", thread_id))

    async def stream_chat(self, body: dict[str, Any]):
        self.sent.append(body)
        for event in self.events:
            yield event

    async def stream_resume(self, body: dict[str, Any], resume: Any):
        self.resumed = resume
        for event in self.resume_events:
            yield event

    async def cancel(self, thread_id: str) -> bool:
        self.cancelled = True
        return True

    async def aclose(self) -> None:
        return None


def _run(scenario) -> None:
    """Ejecuta un escenario del TUI en su propio loop."""

    async def main() -> None:
        app = KliApp(config=CliConfig(base_url="http://servidor-fake"))
        await scenario(app)

    asyncio.run(main())


def test_app_shows_welcome_and_context():
    async def scenario(app: KliApp) -> None:
        app.client = FakeClient([])
        async with app.run_test(size=(120, 40)) as pilot:
            await pilot.pause()
            assert app.registry["modes"]
            assert app.mode == "plan"
            # el panel lateral se actualizó con los datos del registro
            assert app.query_one("ContextPanel")._data["mode"] == "plan"

    _run(scenario)


def test_app_streams_tokens_and_tools():
    events = [
        ServerEvent("meta", {"thread_id": "abc123"}),
        ServerEvent("token", {"text": "Hola "}),
        ServerEvent("token", {"text": "mundo"}),
        ServerEvent("tool_start", {"name": "code_search", "run_id": "r1", "payload": {"pattern": "x"}}),
        ServerEvent("tool_end", {"name": "code_search", "run_id": "r1", "text": "3 coincidencias"}),
        ServerEvent("usage", {"payload": {"input_tokens": 10, "output_tokens": 4, "total_tokens": 14}}),
        ServerEvent("done", {}),
    ]

    async def scenario(app: KliApp) -> None:
        client = FakeClient(events)
        app.client = client
        async with app.run_test(size=(120, 40)) as pilot:
            await pilot.pause()
            app.query_one("#prompt").value = "hola agente"
            await pilot.press("enter")
            for _ in range(20):
                await pilot.pause()
                if client.sent:
                    break
            assert client.sent, "no se envió el mensaje"
            assert client.sent[0]["message"] == "hola agente"
            assert client.sent[0]["mode"] == "plan"
            assert app.thread_id == "abc123"
            assert app.usage["output_tokens"] == 4
            cards = list(app.query(ToolCard))
            assert cards and "code_search" in cards[0].title.plain
            assert app.query(UserMessage)

    _run(scenario)


def test_app_renders_assistant_text_in_the_chat():
    """El Markdown de la respuesta debe acabar montado y visible en el chat."""

    async def scenario(app: KliApp) -> None:
        client = FakeClient([ServerEvent("token", {"text": "hola **mundo**"}), ServerEvent("done", {})])
        app.client = client
        async with app.run_test(size=(120, 40)) as pilot:
            await pilot.pause()
            app.query_one("#prompt").value = "hola"
            await pilot.press("enter")
            for _ in range(20):
                await pilot.pause()
                if app._reply is not None and app._reply.body.children:
                    break
            reply = app._reply
            assert reply is not None
            assert reply.body.children, "la respuesta no se montó en el chat"
            assert reply.body.size.height >= 1
            assert reply.size.height >= 2, "el contenedor debe crecer con el texto"

    _run(scenario)


def test_app_approval_resumes_the_thread():
    interrupt = ServerEvent(
        "interrupt",
        {
            "payload": [
                {
                    "action_requests": [
                        {"name": "terminal", "args": {"command": "ls"}, "description": "listar"}
                    ]
                }
            ]
        },
    )
    events = [ServerEvent("meta", {"thread_id": "t1"}), interrupt, ServerEvent("done", {})]
    resumed_events = [ServerEvent("token", {"text": "listo"}), ServerEvent("done", {})]

    async def scenario(app: KliApp) -> None:
        client = FakeClient(events, resumed_events)
        app.client = client
        async with app.run_test(size=(120, 40)) as pilot:
            await pilot.pause()
            app.query_one("#prompt").value = "ejecuta"
            await pilot.press("enter")
            for _ in range(20):
                await pilot.pause()
                if app.query(ApprovalPanel):
                    break
            panels = list(app.query(ApprovalPanel))
            assert panels, "no se mostró el panel de aprobación"
            panels[0].post_message(ApprovalPanel.Approved())
            for _ in range(20):
                await pilot.pause()
                if client.resumed is not None:
                    break
            assert client.resumed == {"decisions": [{"type": "approve"}]}

    _run(scenario)


def test_slash_command_switches_mode():
    async def scenario(app: KliApp) -> None:
        app.client = FakeClient([])
        async with app.run_test(size=(120, 40)) as pilot:
            await pilot.pause()
            app.registry = await app.client.registry()
            app.registry["modes"].append({"name": "build", "description": "programa"})
            await app._command("/mode build")
            assert app.mode == "build"
            await app._command("/mode plan")
            assert app.mode == "plan"
            await app._command("/mode inexistente")
            assert app.mode == "plan"  # no cambia si el modo no existe

    _run(scenario)


# ---------------------------------------------------------------- tarjetas de tools


def _with_app(scenario) -> None:
    """Ejecuta un escenario con la app viva (los widgets necesitan su contexto)."""

    async def main() -> None:
        app = KliApp(config=CliConfig(base_url="http://servidor-fake"))
        app.client = FakeClient([])
        async with app.run_test(size=(120, 40)) as pilot:
            await pilot.pause()
            await scenario(app)

    asyncio.run(main())


def test_tool_card_shows_readable_args_not_raw_dicts():
    async def scenario(app: KliApp) -> None:
        card = ToolCard("code_search")
        card.set_args({"pattern": "def create_app", "glob": "*.py", "max_results": 50})
        text = card.args_text
        assert "pattern" in text and "def create_app" in text
        assert "max_results" in text and "50" in text
        assert "{" not in text and "'" not in text  # nada de volcados de dict

    _with_app(scenario)


def test_tool_card_renders_shell_command_as_console_line():
    async def scenario(app: KliApp) -> None:
        card = ToolCard("terminal")
        card.set_args({"command": "uv run pytest -q", "cwd": "/app"})
        assert "$ uv run pytest -q" in card.args_text
        assert "cwd" in card.args_text  # el resto de argumentos no se pierden

    _with_app(scenario)


def test_tool_card_strips_echoed_command_from_output():
    async def scenario(app: KliApp) -> None:
        card = ToolCard("terminal")
        card.set_args({"command": "ls -la"})
        card.set_done("ls -la\ntotal 0\ndrwxr-xr-x  2 app app")
        assert card.output_text.strip().startswith("total 0")
        assert "ls -la" not in card.output_text

    _with_app(scenario)


def test_tool_card_state_changes_are_visible():
    async def scenario(app: KliApp) -> None:
        card = ToolCard("terminal")
        assert "ejecutando" in card.title.plain
        card.set_done("ok")
        assert "listo" in card.title.plain
        card.set_error("boom")
        assert "error" in card.title.plain

    _with_app(scenario)


# ---------------------------------------------------------------- recursos (CRUD)


def _texts(app: KliApp) -> str:
    """Todo el texto que se ve en el chat (para comprobar los mensajes)."""
    parts: list[str] = []
    for widget in app.chat.children:
        source = getattr(widget, "_markdown", None)  # widgets Markdown
        if isinstance(source, str):
            parts.append(source)
        content = getattr(widget, "content", None)  # widgets Static
        if content is not None and hasattr(content, "plain"):
            parts.append(content.plain)
    return "\n".join(parts)


def test_project_create_calls_the_api_and_shows_the_folder():
    async def scenario(app: KliApp) -> None:
        client = FakeClient([])
        app.client = client
        async with app.run_test(size=(120, 40)) as pilot:
            await pilot.pause()
            await app._command("/project create mi_proyecto")
            assert ("create_project", ("mi_proyecto", None)) in client.calls
            assert app.registry  # el registro se recarga

    _run(scenario)


def test_project_delete_calls_the_api():
    async def scenario(app: KliApp) -> None:
        client = FakeClient([])
        app.client = client
        async with app.run_test(size=(120, 40)) as pilot:
            await pilot.pause()
            await app._command("/project delete demo")
            assert ("delete_project", "demo") in client.calls

    _run(scenario)


def test_skill_create_sends_name_description_and_tools():
    async def scenario(app: KliApp) -> None:
        client = FakeClient([])
        app.client = client
        async with app.run_test(size=(120, 40)) as pilot:
            await pilot.pause()
            await app._command('/skill create nueva "descripción larga" "instrucciones aquí" --tools web_search,fs_read_file')
            calls = [c for c in client.calls if c[0] == "create_skill"]
            assert calls, "no se creó la skill"
            body = calls[0][1]
            assert body["name"] == "nueva"
            assert body["description"] == "descripción larga"
            assert body["instructions"] == "instrucciones aquí"
            assert body["tool_names"] == ["web_search", "fs_read_file"]

    _run(scenario)


def test_provider_create_sends_kind_and_base_url():
    async def scenario(app: KliApp) -> None:
        client = FakeClient([])
        app.client = client
        async with app.run_test(size=(120, 40)) as pilot:
            await pilot.pause()
            await app._command("/provider create local openai http://127.0.0.1:11434/v1 qwen3 clave")
            calls = [c for c in client.calls if c[0] == "create_provider"]
            assert calls
            body = calls[0][1]
            assert body == {
                "name": "local",
                "kind": "openai",
                "base_url": "http://127.0.0.1:11434/v1",
                "default_model": "qwen3",
                "api_key": "clave",
            }

    _run(scenario)


def test_http_and_mcp_commands_call_the_api():
    async def scenario(app: KliApp) -> None:
        client = FakeClient([])
        app.client = client
        async with app.run_test(size=(120, 40)) as pilot:
            await pilot.pause()
            await app._command('/http add api_test "tool de prueba" https://example.com/api example.com')
            await app._command("/http delete api_test")
            await app._command("/mcp add srv https://mcp.example.com/mcp")
            await app._command("/mcp delete srv")
            names = [c[0] for c in client.calls]
            assert "create_http_tool" in names and "delete_http_tool" in names
            assert "create_mcp" in names and "delete_mcp" in names

    _run(scenario)


def test_memory_and_thread_commands_call_the_api():
    async def scenario(app: KliApp) -> None:
        client = FakeClient([])
        app.client = client
        async with app.run_test(size=(120, 40)) as pilot:
            await pilot.pause()
            await app._command("/memory delete nota")
            await app._command("/thread delete abc123")
            names = [c[0] for c in client.calls]
            assert "delete_memory" in names and "delete_thread" in names

    _run(scenario)


def test_thread_open_loads_the_conversation():
    async def scenario(app: KliApp) -> None:
        client = FakeClient([])
        app.client = client
        async with app.run_test(size=(120, 40)) as pilot:
            await pilot.pause()
            await app._command("/thread open abc123")
            assert app.thread_id == "abc123"
            assert any(isinstance(w, UserMessage) for w in app.chat.children)
            assert ("thread_messages", "abc123") in client.calls

    _run(scenario)


def test_project_browse_lists_folders_and_roots():
    async def scenario(app: KliApp) -> None:
        client = FakeClient([])
        app.client = client
        async with app.run_test(size=(120, 40)) as pilot:
            await pilot.pause()
            await app._command("/project browse /host")
            await pilot.pause()
            assert ("browse_projects", "/host") in client.calls
            text = _texts(app)
            assert "mi-repo" in text and "notas.txt" in text
            assert "/host" in text  # las raíces permitidas

    _run(scenario)


def test_project_import_uses_the_existing_folder():
    async def scenario(app: KliApp) -> None:
        client = FakeClient([])
        app.client = client
        async with app.run_test(size=(120, 40)) as pilot:
            await pilot.pause()
            await app._command("/project import mi_repo /host/mi-repo")
            assert ("create_project", ("mi_repo", "/host/mi-repo")) in client.calls
            await pilot.pause()
            text = _texts(app)
            assert "POST /api/v1/projects" in text
            assert "tal cual" in text  # deja claro que usa esa carpeta

    _run(scenario)


def test_project_import_without_path_explains_the_usage():
    async def scenario(app: KliApp) -> None:
        client = FakeClient([])
        app.client = client
        async with app.run_test(size=(120, 40)) as pilot:
            await pilot.pause()
            await app._command("/project import mi_repo")
            await pilot.pause()
            assert not [c for c in client.calls if c[0] == "create_project"]
            assert "POST /api/v1/projects" in _texts(app)

    _run(scenario)


def test_project_create_shows_the_allowed_roots_when_forbidden():
    async def scenario(app: KliApp) -> None:
        client = FakeClient([])
        app.client = client
        app.server = {"projects_import_roots": ["/host", "/app/projects"]}
        async with app.run_test(size=(120, 40)) as pilot:
            await pilot.pause()
            original = client.create_project

            async def forbidden(name: str, path: str | None = None) -> dict[str, Any]:
                from cli.client import ApiError

                raise ApiError(403, "La carpeta queda fuera de las raíces permitidas")

            client.create_project = forbidden  # type: ignore[method-assign]
            await app._command("/project import mi_repo /tmp/no-permitido")
            await pilot.pause()
            text = _texts(app)
            assert "/host" in text  # muestra las raíces permitidas
            assert original is not None

    _run(scenario)


def test_empty_lists_suggest_the_command_and_the_endpoint():
    """Si no hay recursos, el mensaje dice el comando y el endpoint (no solo 'créalos')."""
    async def scenario(app: KliApp) -> None:
        client = FakeClient([])
        app.client = client
        async with app.run_test(size=(120, 40)) as pilot:
            await pilot.pause()
            app.registry = {"modes": [], "skills": [], "tools": [], "providers": [], "projects": []}
            await app._command("/projects")
            await pilot.pause()
            await app._command("/skills")
            await pilot.pause()
            await app._command("/mcp")
            await pilot.pause()
            text = _texts(app)
            assert "POST /api/v1/projects" in text
            assert "POST /api/v1/skills" in text
            assert "POST /api/v1/mcp" in text

    _run(scenario)


@pytest.mark.parametrize("command", ["/help", "/tools", "/skills", "/projects", "/providers", "/memories", "/threads"])
def test_slash_commands_do_not_crash(command: str):
    async def scenario(app: KliApp) -> None:
        app.client = FakeClient([])
        async with app.run_test(size=(120, 40)) as pilot:
            await pilot.pause()
            await app._command(command)
            assert app.chat.children

    _run(scenario)
