"""Tests del CLI: parser de SSE y flujo del TUI con un cliente falso."""

from __future__ import annotations

import asyncio
from typing import Any

import pytest
from textual.widgets import Button, Markdown

from cli.app import KliApp
from cli.client import ServerEvent, SSEParser
from cli.config import CliConfig
from cli.widgets import (
    AgentMessage,
    ApprovalPanel,
    ReasoningPanel,
    SubagentLoader,
    TabChip,
    ToggleChip,
    ToolCard,
    UserMessage,
)

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


# ---------------------------------------------------------------- payload


def test_the_chat_payload_forwards_the_opt_in_tools():
    """Las tools opt-in tienen que llegar al servidor: si no, no se cargan."""
    from cli.client import HarnessClient

    client = HarnessClient(CliConfig(base_url="http://servidor-fake"))
    body = {"message": "hola", "mode": "plan", "skills": [], "opt_in": ["web_search"]}
    payload = client._chat_payload(body)
    assert payload["opt_in"] == ["web_search"]

    # apagada: no se manda el campo (el servidor no carga nada extra)
    assert "opt_in" not in client._chat_payload({"message": "hola"})

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
        self.headers: dict[str, str] = {}  # cabeceras de la petición

    def set_user(self, user: str) -> None:
        self.headers["X-User-Id"] = user

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
            "skills": [
                {"name": "investigacion", "description": "busca en la web", "tool_names": ["web_search"]}
            ],
            "tools": [
                {"name": "code_search", "category": "read"},
                {"name": "web_search", "category": "network", "opt_in": True},
            ],
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


# ---------------------------------------------------------------- búsqueda web


def test_the_usage_event_keeps_the_cached_tokens():
    """Los tokens de caché tienen que llegar al panel: sin ellos no se ve el ahorro."""

    async def scenario(app: KliApp) -> None:
        client = FakeClient(
            [
                ServerEvent(
                    "usage",
                    {"payload": {"input_tokens": 1200, "output_tokens": 30, "cached_tokens": 900}},
                ),
                ServerEvent("done", {}),
            ]
        )
        app.client = client
        async with app.run_test(size=(120, 40)) as pilot:
            await pilot.pause()
            app.query_one("#prompt").value = "hola"
            await pilot.press("enter")
            for _ in range(20):
                await pilot.pause()
                if app.usage:
                    break
            assert app.usage["input_tokens"] == 1200
            assert app.usage["cached_tokens"] == 900

    _run(scenario)


def test_web_is_off_by_default_and_the_request_omits_it():
    """Sin tocarla, la búsqueda web no se pide: el prompt va más corto."""

    async def scenario(app: KliApp) -> None:
        client = FakeClient([ServerEvent("token", {"text": "hola"}), ServerEvent("done", {})])
        app.client = client
        async with app.run_test(size=(120, 40)) as pilot:
            await pilot.pause()
            assert app.web is False
            app.query_one("#prompt").value = "hola"
            await pilot.press("enter")
            for _ in range(20):
                await pilot.pause()
                if client.sent:
                    break
            assert client.sent
            assert "opt_in" not in client.sent[0]

    _run(scenario)


def test_web_command_asks_for_the_opt_in_tools():
    async def scenario(app: KliApp) -> None:
        client = FakeClient([ServerEvent("token", {"text": "hola"}), ServerEvent("done", {})])
        app.client = client
        async with app.run_test(size=(120, 40)) as pilot:
            await pilot.pause()
            await app._command("/web on")
            assert app.web is True
            app.query_one("#prompt").value = "busca algo"
            await pilot.press("enter")
            for _ in range(20):
                await pilot.pause()
                if client.sent:
                    break
            assert client.sent[0]["opt_in"] == ["web_search"]
            await app._command("/web off")
            assert app.web is False

    _run(scenario)


def test_the_web_chip_in_the_status_bar_toggles_it():
    """La pastilla de la barra inferior es el botón de la búsqueda web."""

    async def scenario(app: KliApp) -> None:
        app.client = FakeClient([])
        async with app.run_test(size=(120, 40)) as pilot:
            await pilot.pause()
            chip = app.query_one(ToggleChip)
            assert app.web is False
            chip.post_message(ToggleChip.Pressed("web"))
            for _ in range(10):
                await pilot.pause()
                if app.web:
                    break
            assert app.web is True

    _run(scenario)


def test_a_skill_that_needs_the_web_turns_it_on():
    """La skill `investigacion` usa la web: al activarla, se enciende."""

    async def scenario(app: KliApp) -> None:
        app.client = FakeClient([])
        async with app.run_test(size=(120, 40)) as pilot:
            await pilot.pause()
            await app._command("/skill investigacion")
            assert "investigacion" in app.skills
            assert app.web is True

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


# ---------------------------------------------------------------- subagentes


SUBAGENT_EVENTS = [
    ServerEvent("meta", {"thread_id": "t1"}),
    ServerEvent(
        "tool_start",
        {"name": "task", "run_id": "r1", "payload": {"subagent_type": "revisor", "description": "mira el código"}},
    ),
    ServerEvent("token", {"agent": "revisor", "text": "revisando **todo**"}),
    ServerEvent(
        "tool_start",
        {"agent": "revisor", "name": "code_search", "run_id": "r2", "payload": {"pattern": "def "}},
    ),
    ServerEvent("tool_end", {"agent": "revisor", "name": "code_search", "run_id": "r2", "text": "3 hits"}),
    ServerEvent("token", {"text": "listo"}),
    ServerEvent("tool_end", {"name": "task", "run_id": "r1", "text": "revisión ok"}),
]


def test_subagent_opens_its_own_window_closed():
    """Al crearse el subagente hay una ventana propia, pero nace cerrada."""
    async def scenario(app: KliApp) -> None:
        app.client = FakeClient(SUBAGENT_EVENTS)
        async with app.run_test(size=(120, 40)) as pilot:
            await pilot.pause()
            app.query_one("#prompt").value = "revisa el repo"
            await pilot.press("enter")
            for _ in range(30):
                await pilot.pause()
                if app.query(SubagentLoader):
                    break
            assert app.query(SubagentLoader), "no apareció el aviso del subagente"
            assert app.query("#pane-revisor"), "no se creó la ventana del subagente"
            # la ventana nace cerrada: sigue el chat principal
            assert app.panes.current == "chat"
            # y hay una pestaña para ella
            assert "revisor" in [chip._key for chip in app.query(TabChip)]

    _run(scenario)


def test_subagent_events_go_to_its_window():
    """Lo que dice el subagente aparece en su ventana, no en el chat principal."""
    async def scenario(app: KliApp) -> None:
        app.client = FakeClient(SUBAGENT_EVENTS)
        async with app.run_test(size=(120, 40)) as pilot:
            await pilot.pause()
            app.query_one("#prompt").value = "revisa el repo"
            await pilot.press("enter")
            for _ in range(30):
                await pilot.pause()
                if app.query("#pane-revisor"):
                    break
            await pilot.pause()
            pane = app.query_one("#pane-revisor")
            labels = [w._label.content.plain for w in pane.children if isinstance(w, AgentMessage)]
            assert any("revisor" in label for label in labels)
            # en el chat principal solo está el aviso (y la respuesta del agente principal)
            main_labels = [w._label.content.plain for w in app.chat.children if isinstance(w, AgentMessage)]
            assert not any("revisor" in label for label in main_labels)

    _run(scenario)


def test_clicking_the_loader_opens_the_subagent_window():
    """El aviso con spinner lleva a la ventana del subagente."""
    async def scenario(app: KliApp) -> None:
        app.client = FakeClient(SUBAGENT_EVENTS)
        async with app.run_test(size=(120, 40)) as pilot:
            await pilot.pause()
            app.query_one("#prompt").value = "revisa el repo"
            await pilot.press("enter")
            for _ in range(30):
                await pilot.pause()
                if app.query(SubagentLoader):
                    break
            await pilot.click(SubagentLoader)
            await pilot.pause()
            await pilot.pause()
            assert app.panes.current == "pane-revisor"
            # en la ventana del subagente no se escribe: el prompt da paso
            assert not app.query_one("#prompt").display
            assert app.query_one("#prompt-note").display
            # y al volver al chat, el prompt vuelve
            app._open_tab("chat")
            await pilot.pause()
            assert app.panes.current == "chat"
            assert app.query_one("#prompt").display

    _run(scenario)


def test_clicking_the_tab_switches_windows():
    """La tira de pestañas salta entre la conversación y el subagente."""
    async def scenario(app: KliApp) -> None:
        app.client = FakeClient(SUBAGENT_EVENTS)
        async with app.run_test(size=(120, 40)) as pilot:
            await pilot.pause()
            app.query_one("#prompt").value = "revisa el repo"
            await pilot.press("enter")
            for _ in range(30):
                await pilot.pause()
                if app.query("#pane-revisor"):
                    break
            chip = next(c for c in app.query(TabChip) if c._key == "revisor")
            await pilot.click(chip)
            await pilot.pause()
            await pilot.pause()
            assert app.panes.current == "pane-revisor"
            chat_chip = next(c for c in app.query(TabChip) if c._key == "chat")
            await pilot.click(chat_chip)
            await pilot.pause()
            assert app.panes.current == "chat"

    _run(scenario)


def test_subagent_stops_its_spinner_when_it_finishes():
    async def scenario(app: KliApp) -> None:
        app.client = FakeClient(SUBAGENT_EVENTS)
        async with app.run_test(size=(120, 40)) as pilot:
            await pilot.pause()
            app.query_one("#prompt").value = "revisa el repo"
            await pilot.press("enter")
            for _ in range(40):
                await pilot.pause()
                if app._subagents and not app._subagents["revisor"].running:
                    break
            loader = app.query_one(SubagentLoader)
            assert "terminado" in loader.content.plain
            chip = next(c for c in app.query(TabChip) if c._key == "revisor")
            assert "✓" in chip.content.plain

    _run(scenario)


def test_user_command_shows_and_changes_the_user():
    async def scenario(app: KliApp) -> None:
        app.client = FakeClient([])
        async with app.run_test(size=(120, 40)) as pilot:
            await pilot.pause()
            await app._command("/user")
            await pilot.pause()
            assert "anonymous" in _texts(app)
            await app._command("/user rocio")
            await pilot.pause()
            assert app.config.user == "rocio"
            assert app.client.headers["X-User-Id"] == "rocio"
            assert "rocio" in _texts(app)

    _run(scenario)


# ------------------------------------------------------------ autocompletado


def test_tab_completes_slash_commands():
    """`tab` completa el comando que se está escribiendo."""

    async def scenario(app: KliApp) -> None:
        app.client = FakeClient([])
        async with app.run_test(size=(120, 40)) as pilot:
            await pilot.pause()
            prompt = app.query_one("#prompt")
            prompt.value = "/mo"
            await pilot.pause()
            await pilot.press("tab")
            await pilot.pause()
            assert prompt.value == "/mode"

    _run(scenario)


def test_tab_completes_command_arguments_and_cycles():
    """`tab` completa el argumento y, repetido, recorre las opciones."""

    async def scenario(app: KliApp) -> None:
        app.client = FakeClient([])
        async with app.run_test(size=(120, 40)) as pilot:
            await pilot.pause()
            app.registry = {
                "modes": [{"name": "plan"}, {"name": "build"}],
                "skills": [{"name": "investigacion"}, {"name": "depuracion"}],
                "tools": [],
            }
            prompt = app.query_one("#prompt")
            prompt.value = "/mode "
            await pilot.pause()
            await pilot.press("tab")
            await pilot.pause()
            assert prompt.value == "/mode plan"
            await pilot.press("tab")
            await pilot.pause()
            assert prompt.value == "/mode build"

    _run(scenario)


def test_tab_does_nothing_on_plain_text():
    async def scenario(app: KliApp) -> None:
        app.client = FakeClient([])
        async with app.run_test(size=(120, 40)) as pilot:
            await pilot.pause()
            prompt = app.query_one("#prompt")
            prompt.value = "hola"
            await pilot.pause()
            await pilot.press("tab")
            await pilot.pause()
            assert prompt.value == "hola"

    _run(scenario)


def test_approval_takes_the_focus():
    """Al pedir permiso, el foco va a la tarjeta: se decide con el teclado."""
    interrupt = ServerEvent(
        "interrupt",
        {"payload": [{"action_requests": [{"name": "terminal", "args": {"command": "ls"}}]}]},
    )

    async def scenario(app: KliApp) -> None:
        app.client = FakeClient([interrupt])
        async with app.run_test(size=(120, 40)) as pilot:
            await pilot.pause()
            app.query_one("#prompt").value = "borra todo"
            await pilot.press("enter")
            for _ in range(30):
                await pilot.pause()
                if app.query(ApprovalPanel):
                    break
            await pilot.pause()
            focused = app.screen.focused
            assert isinstance(focused, Button)
            assert "approve" in focused.classes

    _run(scenario)


def test_reasoning_is_rendered_as_markdown():
    """El razonamiento se dibuja como markdown (no en crudo)."""

    async def scenario(app: KliApp) -> None:
        app.client = FakeClient(
            [
                ServerEvent("reasoning", {"text": "**Paso 1**: miro `test()`"}),
                ServerEvent("token", {"text": "hecho"}),
            ]
        )
        async with app.run_test(size=(120, 40)) as pilot:
            await pilot.pause()
            app.query_one("#prompt").value = "explica"
            await pilot.press("enter")
            for _ in range(30):
                await pilot.pause()
                if app._reasoning is not None:
                    break
            await pilot.pause()
            assert app._reasoning is not None
            # el cuerpo es un Markdown: se renderiza, no se muestra en crudo
            body = app._reasoning._body
            assert isinstance(body, Markdown)
            assert body._markdown == "**Paso 1**: miro `test()`"

    _run(scenario)


def test_reasoning_keeps_everything_it_receives():
    """El throttle del razonamiento no puede perder texto."""

    async def scenario(app: KliApp) -> None:
        app.client = FakeClient([])
        async with app.run_test(size=(120, 40)) as pilot:
            await pilot.pause()
            panel = ReasoningPanel()
            await app.chat.mount(panel)
            for i in range(50):
                panel.append(f"trozo {i} ")
            panel.flush()
            await pilot.pause()
            assert "trozo 49" in panel._body._markdown
            assert panel._text.count("trozo") == 50

    _run(scenario)


def test_chat_follows_the_real_order():
    """El orden del chat es: usuario → razonamiento → tools → respuesta."""
    events = [
        ServerEvent("reasoning", {"text": "primero miro"}),
        ServerEvent("tool_start", {"name": "code_search", "run_id": "r1", "payload": {"pattern": "x"}}),
        ServerEvent("tool_end", {"name": "code_search", "run_id": "r1", "text": "3 hits"}),
        ServerEvent("token", {"text": "hecho"}),
    ]

    async def scenario(app: KliApp) -> None:
        app.client = FakeClient(events)
        async with app.run_test(size=(120, 40)) as pilot:
            await pilot.pause()
            app.query_one("#prompt").value = "busca"
            await pilot.press("enter")
            for _ in range(30):
                await pilot.pause()
                if app._reply is not None and app._reply.body.children:
                    break
            await pilot.pause()
            tipos = [type(w).__name__ for w in app.chat.children]
            # el usuario, el razonamiento, la tool y la respuesta (en ese orden)
            assert tipos.index("UserMessage") < tipos.index("ReasoningPanel")
            assert tipos.index("ReasoningPanel") < tipos.index("ToolCard")
            assert tipos.index("ToolCard") < tipos.index("AgentMessage")

    _run(scenario)


def test_tool_output_is_markdown_when_it_is():
    """La salida de una tool en markdown se dibuja como markdown."""
    events = [
        ServerEvent(
            "tool_start",
            {"name": "web_search", "run_id": "r1", "payload": {"query": "klicode"}},
        ),
        ServerEvent(
            "tool_end",
            {"name": "web_search", "run_id": "r1", "text": "## Resultados\n\n1. **uno**"},
        ),
    ]

    async def scenario(app: KliApp) -> None:
        app.client = FakeClient(events)
        async with app.run_test(size=(120, 40)) as pilot:
            await pilot.pause()
            app.query_one("#prompt").value = "busca"
            await pilot.press("enter")
            for _ in range(30):
                await pilot.pause()
                if app.query(ToolCard) and app.query_one(ToolCard)._output:
                    break
            await pilot.pause()
            card = app.query_one(ToolCard)
            for _ in range(20):  # el markdown se pinta en un worker
                await pilot.pause()
                if card._output_md._markdown:
                    break
            # el markdown se ve en la vista de markdown, la cruda se oculta
            assert card._output_md.display
            assert not card._output_view.display
            assert "Resultados" in card._output_md._markdown

    _run(scenario)


def test_tool_output_stays_raw_when_it_is_code():
    """La salida de código se muestra tal cual, sin interpreting markdown."""
    events = [
        ServerEvent("tool_start", {"name": "terminal", "run_id": "r1", "payload": {"command": "ls"}}),
        ServerEvent("tool_end", {"name": "terminal", "run_id": "r1", "text": "  -> Compilando 3 archivos\n  ok"}),
    ]

    async def scenario(app: KliApp) -> None:
        app.client = FakeClient(events)
        async with app.run_test(size=(120, 40)) as pilot:
            await pilot.pause()
            app.query_one("#prompt").value = "lista"
            await pilot.press("enter")
            for _ in range(30):
                await pilot.pause()
                if app.query(ToolCard) and app.query_one(ToolCard)._output:
                    break
            await pilot.pause()
            card = app.query_one(ToolCard)
            assert card._output_view.display
            assert not card._output_md.display

    _run(scenario)


# ----------------------------------------------------------------- errores


def test_errors_explain_what_to_do():
    """Un error dice qué pasó y qué hacer, no solo el detalle del servidor."""

    async def scenario(app: KliApp) -> None:
        client = FakeClient([])
        app.client = client
        async with app.run_test(size=(120, 40)) as pilot:
            await pilot.pause()
            await app._command("/skill delete")
            await pilot.pause()
            text = _texts(app)
            assert "Falta el nombre de la skill" in text
            assert "DELETE /api/v1/skills" in text

    _run(scenario)


def test_api_error_shows_the_status_and_a_hint():
    from cli.client import ApiError

    async def scenario(app: KliApp) -> None:
        client = FakeClient([])
        app.client = client
        async with app.run_test(size=(120, 40)) as pilot:
            await pilot.pause()

            async def forbidden(*args: Any, **kwargs: Any) -> None:
                raise ApiError(403, "proyecto de otro usuario")

            client.delete_project = forbidden  # type: ignore[method-assign]
            await app._command("/project delete demo")
            await pilot.pause()
            text = _texts(app)
            assert "403" in text
            assert "No se pudo borrar el proyecto" in text

    _run(scenario)
