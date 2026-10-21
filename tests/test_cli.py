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


@pytest.mark.parametrize("command", ["/help", "/tools", "/skills", "/projects", "/threads"])
def test_slash_commands_do_not_crash(command: str):
    async def scenario(app: KliApp) -> None:
        app.client = FakeClient([])
        async with app.run_test(size=(120, 40)) as pilot:
            await pilot.pause()
            await app._command(command)
            assert app.chat.children

    _run(scenario)
