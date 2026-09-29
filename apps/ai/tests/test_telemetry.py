"""Telemetry: off without an endpoint; with one, requests are traced (health probes
aren't) and log lines carry the trace."""

from fastapi import FastAPI
from fastapi.testclient import TestClient
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter
from pytest import MonkeyPatch

from app.telemetry import add_trace_ids, start_telemetry


def test_nothing_starts_without_an_endpoint(monkeypatch: MonkeyPatch) -> None:
    monkeypatch.delenv("OTEL_EXPORTER_OTLP_ENDPOINT", raising=False)
    assert start_telemetry("ai", FastAPI()) is False


def test_requests_are_traced_and_logs_carry_the_trace() -> None:
    exporter = InMemorySpanExporter()
    app = FastAPI()
    logged: dict[str, object] = {}

    @app.get("/hello")
    def hello() -> dict[str, str]:  # pyright: ignore[reportUnusedFunction]
        logged.update(add_trace_ids(None, "info", {"event": "hello"}))
        return {"ok": "yes"}

    @app.get("/health/live")
    def live() -> dict[str, str]:  # pyright: ignore[reportUnusedFunction]
        return {"status": "ok"}

    assert start_telemetry("ai-test", app, processor=SimpleSpanProcessor(exporter)) is True
    client = TestClient(app)
    assert client.get("/hello").status_code == 200
    assert client.get("/health/live").status_code == 200

    spans = exporter.get_finished_spans()
    server = [span for span in spans if span.name == "GET /hello"]
    assert server, [span.name for span in spans]
    assert not [span for span in spans if "/health" in span.name]
    assert server[0].resource.attributes["service.name"] == "ai-test"
    context = server[0].get_span_context()
    assert context is not None
    assert logged["trace_id"] == format(context.trace_id, "032x")
