/**
 * OpenTelemetry for every Node service: traces and metrics, off unless
 * OTEL_EXPORTER_OTLP_ENDPOINT is set. No SaaS is assumed: point it at any OTLP/HTTP
 * collector (the OpenTelemetry Collector, Grafana Alloy, Jaeger, ...). The standard
 * OTEL_* variables apply as OpenTelemetry documents them (OTEL_SERVICE_NAME,
 * OTEL_RESOURCE_ATTRIBUTES, OTEL_TRACES_SAMPLER, ...).
 *
 * It must run before the application loads, so the modules it instruments are wrapped
 * when they're imported: each service has a `src/telemetry.ts` that calls this, built to
 * `dist/telemetry.mjs` and started with `node --import ./dist/telemetry.mjs dist/main.mjs`.
 *
 * Instrumented: HTTP in and out, Postgres (pg, under Prisma's driver adapter), Redis
 * (ioredis, so BullMQ's commands too), and pino, whose log lines then carry `trace_id`
 * and `span_id` next to the request id. Trace context isn't carried through queued jobs;
 * the request id already is (JobMeta).
 *
 * Seam: this is where metrics and traces leave the process. Another exporter or protocol
 * is a change here only.
 */
import { register } from "node:module";

/** Starts the SDK when an OTLP endpoint is configured; returns whether it started. */
export async function startTelemetry(service: string): Promise<boolean> {
  if (!process.env.OTEL_EXPORTER_OTLP_ENDPOINT) return false;
  // ES modules are instrumented through a loader hook, registered before they load.
  register("@opentelemetry/instrumentation/hook.mjs", import.meta.url);

  const [
    { NodeSDK },
    { OTLPTraceExporter },
    { OTLPMetricExporter },
    { PeriodicExportingMetricReader },
    { HttpInstrumentation },
    { PgInstrumentation },
    { IORedisInstrumentation },
    { PinoInstrumentation },
  ] = await Promise.all([
    import("@opentelemetry/sdk-node"),
    import("@opentelemetry/exporter-trace-otlp-http"),
    import("@opentelemetry/exporter-metrics-otlp-http"),
    import("@opentelemetry/sdk-metrics"),
    import("@opentelemetry/instrumentation-http"),
    import("@opentelemetry/instrumentation-pg"),
    import("@opentelemetry/instrumentation-ioredis"),
    import("@opentelemetry/instrumentation-pino"),
  ]);

  process.env.OTEL_SERVICE_NAME ??= service;
  const sdk = new NodeSDK({
    traceExporter: new OTLPTraceExporter(),
    metricReaders: [new PeriodicExportingMetricReader({ exporter: new OTLPMetricExporter() })],
    instrumentations: [
      // Health probes would be most of the traces and say nothing.
      new HttpInstrumentation({
        ignoreIncomingRequestHook: (request) => request.url?.startsWith("/health") ?? false,
      }),
      new PgInstrumentation(),
      new IORedisInstrumentation(),
      new PinoInstrumentation(),
    ],
  });
  sdk.start();
  // Flush what's buffered when the service stops (Nest closes the app on the same signals).
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => void sdk.shutdown());
  }
  process.once("beforeExit", () => void sdk.shutdown());
  return true;
}
