# The SQLAlchemy and Redis instrumentations ship no type stubs and take untyped options.
# pyright: reportMissingTypeStubs=false, reportUnknownMemberType=false
"""OpenTelemetry for the Python service, like the Node services': traces and metrics,
off unless OTEL_EXPORTER_OTLP_ENDPOINT is set (any OTLP/HTTP collector; the standard
OTEL_* variables apply). Instrumented: FastAPI (health probes left out), SQLAlchemy,
Redis and outgoing httpx calls (model providers, the api). Log lines carry `trace_id`
and `span_id` whenever a span is active (see `add_trace_ids`).

Seam: this is where traces and metrics leave the process; another exporter is a change
here only.
"""

import os

from fastapi import FastAPI
from opentelemetry import metrics, trace
from opentelemetry.exporter.otlp.proto.http.metric_exporter import OTLPMetricExporter
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor
from opentelemetry.instrumentation.httpx import HTTPXClientInstrumentor
from opentelemetry.instrumentation.redis import RedisInstrumentor
from opentelemetry.instrumentation.sqlalchemy import SQLAlchemyInstrumentor
from opentelemetry.sdk.metrics import MeterProvider
from opentelemetry.sdk.metrics.export import PeriodicExportingMetricReader
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import SpanProcessor, TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from structlog.typing import EventDict, WrappedLogger


def start_telemetry(
    service: str,
    app: FastAPI | None = None,
    *,
    processor: SpanProcessor | None = None,
) -> bool:
    """Starts exporting when an endpoint is configured (or a processor is given, in
    tests); returns whether it started. Call once per process, before serving."""
    if not os.environ.get("OTEL_EXPORTER_OTLP_ENDPOINT") and processor is None:
        return False
    resource = Resource.create({"service.name": os.environ.get("OTEL_SERVICE_NAME", service)})
    tracer_provider = TracerProvider(resource=resource)
    tracer_provider.add_span_processor(processor or BatchSpanProcessor(OTLPSpanExporter()))
    trace.set_tracer_provider(tracer_provider)
    if processor is None:
        reader = PeriodicExportingMetricReader(OTLPMetricExporter())
        metrics.set_meter_provider(MeterProvider(resource=resource, metric_readers=[reader]))

    SQLAlchemyInstrumentor().instrument(tracer_provider=tracer_provider)
    RedisInstrumentor().instrument(tracer_provider=tracer_provider)
    HTTPXClientInstrumentor().instrument(tracer_provider=tracer_provider)
    if app is not None:
        FastAPIInstrumentor.instrument_app(
            app, tracer_provider=tracer_provider, excluded_urls="health/live,health/ready"
        )
    return True


def add_trace_ids(_logger: WrappedLogger, _method: str, event: EventDict) -> EventDict:
    """structlog processor: the active span's ids, so logs and traces join up."""
    context = trace.get_current_span().get_span_context()
    if context.is_valid:
        event["trace_id"] = format(context.trace_id, "032x")
        event["span_id"] = format(context.span_id, "016x")
    return event
