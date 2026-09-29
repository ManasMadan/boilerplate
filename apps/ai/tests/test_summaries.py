"""The summary workflow (LangGraph), with the local summarizer: no provider needed."""

from app.summaries import build_summary_graph, local_summarizer, summarize


async def test_summarizes_each_passage_then_combines_them() -> None:
    graph = build_summary_graph(local_summarizer(), tokens_per_run=20_000)
    summary, usage = await summarize(
        graph,
        [
            "Refunds take five days. They go to the original card.",
            "Shipping is free over 50 euros. Otherwise it costs 5.",
            "Support answers within a day. Weekends are slower.",
            "Returns are accepted for 30 days. Items must be unused.",
        ],
    )
    # One sentence per passage, then the combined summary keeps the first three.
    assert summary == (
        "Refunds take five days. Shipping is free over 50 euros. Support answers within a day."
    )
    assert usage.requests == 5  # four passages, one combine
    assert usage.input_tokens > 0


async def test_one_passage_needs_no_combining() -> None:
    graph = build_summary_graph(local_summarizer(), tokens_per_run=20_000)
    summary, usage = await summarize(graph, ["Only one thing here. And a detail."])
    assert summary == "Only one thing here."
    assert usage.requests == 1


async def test_nothing_to_summarize() -> None:
    graph = build_summary_graph(local_summarizer(), tokens_per_run=20_000)
    assert (await summarize(graph, []))[0] == ""
