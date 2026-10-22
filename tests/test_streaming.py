from types import SimpleNamespace

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


def test_usage_accumulates():
    m = EventMapper()
    out = SimpleNamespace(usage_metadata={"input_tokens": 3, "output_tokens": 2, "total_tokens": 5})
    m.map(ev("on_chat_model_end", output=out))
    last = m.map(ev("on_chat_model_end", output=out))
    assert last[0].payload["total_tokens"] == 10
