from types import SimpleNamespace
from typing import Any

from langchain_core.language_models import BaseChatModel
from langchain_core.messages import AIMessage, AIMessageChunk
from langchain_core.outputs import ChatGeneration, ChatGenerationChunk, ChatResult

from harness.streaming import EventMapper


def chunk(text):
    return SimpleNamespace(content=text)


def ev(kind, run_id="r", parents=(), name=None, **data):
    return {"event": kind, "run_id": run_id, "parent_ids": list(parents), "name": name, "data": data}


def test_tokens_are_mapped():
    m = EventMapper()
    out = m.map(ev("on_chat_model_stream", chunk=chunk("hola")))
    assert out[0].type == "token" and out[0].text == "hola" and out[0].agent is None


def test_subagent_attribution_via_task_run():
    m = EventMapper()
    start = m.map(ev("on_tool_start", run_id="t1", name="task", input={"subagent_type": "revisor"}))
    assert start[0].agent is None
    inner = m.map(ev("on_chat_model_stream", run_id="x", parents=["root", "t1"], chunk=chunk("hallazgo")))
    assert inner[0].agent == "revisor"
    m.map(ev("on_tool_end", run_id="t1", name="task", output="fin"))
    after = m.map(ev("on_chat_model_stream", run_id="y", parents=["root"], chunk=chunk("ok")))
    assert after[0].agent is None


def test_tokens_inside_regular_tools_are_suppressed():
    m = EventMapper()
    m.map(ev("on_tool_start", run_id="deep", name="deep_search", input={"question": "q"}))
    inner = m.map(ev("on_chat_model_stream", run_id="z", parents=["deep"], chunk=chunk("plan")))
    assert inner == []


def test_reasoning_from_additional_kwargs_is_mapped():
    """Los proxies mandan el razonamiento aparte: no se debe perder."""
    piece = SimpleNamespace(content="", additional_kwargs={"reasoning_content": "voy a mirarlo"})
    m = EventMapper()
    out = m.map(ev("on_chat_model_stream", chunk=piece))
    assert out[0].type == "reasoning" and out[0].text == "voy a mirarlo"


def test_reasoning_block_in_content_is_mapped():
    piece = SimpleNamespace(content=[{"type": "reasoning", "reasoning": "pienso"}])
    m = EventMapper()
    out = m.map(ev("on_chat_model_stream", chunk=piece))
    assert out[0].type == "reasoning" and out[0].text == "pienso"


def test_reasoning_summary_block_is_mapped():
    """El API de Responses manda el razonamiento como bloques con `summary`."""
    piece = SimpleNamespace(
        content=[
            {
                "type": "reasoning",
                "index": 0,
                "summary": [{"index": 0, "type": "summary_text", "text": "pienso **en voz alta**"}],
            }
        ]
    )
    m = EventMapper()
    out = m.map(ev("on_chat_model_stream", chunk=piece))
    assert out[0].type == "reasoning"
    assert out[0].text == "pienso **en voz alta**"


def test_reasoning_in_the_v03_format_is_mapped():
    """El formato viejo deja el razonamiento como dict en `additional_kwargs`."""
    piece = SimpleNamespace(
        content="",
        additional_kwargs={
            "reasoning": {
                "summary": [{"index": 0, "type": "summary_text", "text": "pienso"}],
                "type": "reasoning",
            }
        },
    )
    m = EventMapper()
    out = m.map(ev("on_chat_model_stream", chunk=piece))
    assert out[0].type == "reasoning" and out[0].text == "pienso"


def test_reasoning_only_in_the_final_message_is_recovered():
    """Hay proveedores que no vaguan el razonamiento: llega en el mensaje final."""
    m = EventMapper()
    m.map(ev("on_chat_model_stream", run_id="m1", chunk=chunk("hola")))
    final = SimpleNamespace(
        content=[
            {
                "type": "reasoning",
                "index": 0,
                "summary": [{"index": 0, "type": "summary_text", "text": "pienso"}],
            }
        ],
        usage_metadata=None,
    )
    out = m.map(ev("on_chat_model_end", run_id="m1", output=final))
    assert out and out[0].type == "reasoning" and out[0].text == "pienso"
    assert m.saw_reasoning is True


def test_reasoning_is_not_repeated_when_it_was_streamed():
    """Si ya salió en el stream, el mensaje final no lo duplica."""
    m = EventMapper()
    piece = SimpleNamespace(content="", additional_kwargs={"reasoning_content": "pienso"})
    m.map(ev("on_chat_model_stream", run_id="m1", chunk=piece))
    final = SimpleNamespace(content="hola", usage_metadata=None)
    out = m.map(ev("on_chat_model_end", run_id="m1", output=final))
    assert out == []


def test_reasoning_inside_a_tool_is_not_recovered():
    """El razonamiento de una tool interna no se cuela en la respuesta."""
    m = EventMapper()
    m.map(ev("on_tool_start", run_id="deep", name="deep_search", input={"question": "q"}))
    final = SimpleNamespace(
        content=[{"type": "reasoning", "summary": [{"text": "pienso"}]}], usage_metadata=None
    )
    out = m.map(ev("on_chat_model_end", run_id="m1", parents=["deep"], output=final))
    assert out == []


def test_openai_model_keeps_the_reasoning_of_the_proxy():
    """El ChatOpenAI de LangChain tira el razonamiento: aquí se rescata."""
    from langchain_core.messages import AIMessageChunk

    from harness.models import KliChatOpenAI

    model = KliChatOpenAI(model="gpt-6-luna", api_key="x")
    chunk = {
        "id": "1",
        "choices": [{"index": 0, "delta": {"content": "hola", "reasoning_content": "pienso"}}],
    }
    generation = model._convert_chunk_to_generation_chunk(
        chunk, AIMessageChunk, None
    )
    assert generation is not None
    assert generation.message.additional_kwargs["reasoning_content"] == "pienso"


def test_the_reasoning_api_switches_the_endpoint():
    """`REASONING_API` decide por dónde se pide el razonamiento."""
    from harness.models import _build

    args = ("openai", None, "x", "gpt-6-luna", None, 10.0, 1, 100, False)
    responses = _build(*args, "low", "responses")
    assert responses.use_responses_api is True
    assert responses.reasoning == {"effort": "low", "summary": "auto"}

    chat = _build(*args, "low", "chat")
    assert chat.use_responses_api is False
    assert chat.reasoning_effort == "low"


def test_usage_accumulates():
    m = EventMapper()
    out = SimpleNamespace(usage_metadata={"input_tokens": 3, "output_tokens": 2, "total_tokens": 5})
    m.map(ev("on_chat_model_end", output=out))
    last = m.map(ev("on_chat_model_end", output=out))
    assert last[0].payload["total_tokens"] == 10


def test_usage_reports_the_cached_tokens():
    """Los tokens de caché se ven: sin ellos no se sabe si el prompt se cachea."""
    m = EventMapper()
    out = SimpleNamespace(
        usage_metadata={
            "input_tokens": 1200,
            "output_tokens": 30,
            "total_tokens": 1230,
            "input_token_details": {"cache_read": 900},
        }
    )
    last = m.map(ev("on_chat_model_end", output=out))
    assert last[0].payload["cached_tokens"] == 900
    assert last[0].payload["input_tokens"] == 1200


# ---------------------------------------------------------------- e2e


class _FakeModel(BaseChatModel):
    """Modelo falso que emite un bloque de razonamiento y luego texto."""

    @property
    def _llm_type(self) -> str:
        return "fake"

    def bind_tools(self, tools: Any, **kwargs: Any) -> Any:
        return self

    def _stream(self, messages: Any, stop: Any = None, run_manager: Any = None, **kwargs: Any):
        yield ChatGenerationChunk(
            message=AIMessageChunk(
                content=[
                    {
                        "type": "reasoning",
                        "index": 0,
                        "summary": [
                            {"index": 0, "type": "summary_text", "text": "pienso **en voz alta**"}
                        ],
                    }
                ]
            )
        )
        yield ChatGenerationChunk(message=AIMessageChunk(content="hola"))

    def _generate(self, messages: Any, stop: Any = None, run_manager: Any = None, **kwargs: Any):
        return ChatResult(generations=[ChatGeneration(message=AIMessage(content="hola"))])


def test_the_real_stream_maps_reasoning_and_tokens():
    """El camino completo: `astream_events` real → mapper → eventos.

    Los tests unitarios del mapper usan objetos falsos: este es el que de
    verdad pasa por LangGraph, que es donde se pierden cosas.
    """
    import asyncio

    from harness.compat import create_agent_compat
    from harness.streaming import stream_run

    async def run() -> list[Any]:
        agent = create_agent_compat(
            model=_FakeModel(),
            tools=[],
            system_prompt="eres un agente",
            subagents=[],
            checkpointer=None,
            store=None,
            interrupt_on={},
        )
        return [
            ev
            async for ev in stream_run(
                agent,
                {"messages": [{"role": "user", "content": "hola"}]},
                thread_id="t1",
                user_id="u1",
            )
        ]

    events = asyncio.run(run())
    kinds = [e.type for e in events]
    assert "reasoning" in kinds, kinds
    assert "token" in kinds, kinds
    reasoning = next(e for e in events if e.type == "reasoning")
    assert reasoning.text == "pienso **en voz alta**"
    token = next(e for e in events if e.type == "token")
    assert token.text == "hola"
