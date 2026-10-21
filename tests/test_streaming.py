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


def test_usage_accumulates():
    m = EventMapper()
    out = SimpleNamespace(usage_metadata={"input_tokens": 3, "output_tokens": 2, "total_tokens": 5})
    m.map(ev("on_chat_model_end", output=out))
    last = m.map(ev("on_chat_model_end", output=out))
    assert last[0].payload["total_tokens"] == 10
