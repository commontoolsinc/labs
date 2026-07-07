import {
  context,
  type Meter,
  metrics,
  trace,
  type Tracer,
} from "@opentelemetry/api";
import { env, type EnvVars } from "./env.ts";

/** The subset of env the tracer setup needs (injectable for tests). */
export type OtelConfig = Pick<
  EnvVars,
  "OTEL_ENABLED" | "OTEL_SERVICE_NAME" | "OTEL_EXPORTER_OTLP_ENDPOINT" | "ENV"
>;

// The single registered provider, or undefined when telemetry is off or has been
// shut down. init/shutdown guard on this so they stay idempotent and re-init-safe
// (e.g. across a hot-reload or an init -> shutdown -> init cycle in tests).
let _provider:
  | import("@opentelemetry/sdk-trace-base").BasicTracerProvider
  | undefined;

// The registered metrics provider, mirroring `_provider` for traces. Undefined
// when telemetry is off or has been shut down, so init/shutdown stay idempotent.
let _meterProvider:
  | import("@opentelemetry/sdk-metrics").MeterProvider
  | undefined;

export function getTracerProvider() {
  return _provider;
}

export function getMeterProvider() {
  return _meterProvider;
}

/** Returns a tracer bound to the registered provider (or the no-op global one). */
export function getTracer(): Tracer {
  return _provider
    ? _provider.getTracer("bg-piece-service", "1.0.0")
    : trace.getTracer("bg-piece-service", "1.0.0");
}

/** Returns a meter bound to the registered provider (or the no-op global one). */
export function getMeter(): Meter {
  return _meterProvider
    ? _meterProvider.getMeter("bg-piece-service", "1.0.0")
    : metrics.getMeter("bg-piece-service", "1.0.0");
}

/**
 * Flush and shut down the tracer provider so buffered spans aren't dropped when
 * the process exits. No-op if telemetry was never initialized.
 */
export async function shutdownOpenTelemetry(): Promise<void> {
  if (!_provider && !_meterProvider) return;
  // Clear the references up front so a second call (or a span/metric created
  // after shutdown) is a no-op rather than touching a torn-down provider.
  const provider = _provider;
  const meterProvider = _meterProvider;
  _provider = undefined;
  _meterProvider = undefined;
  // Flush/shutdown each provider independently: a failure tearing down traces
  // must not silently skip the metrics flush (or vice versa). The first error
  // is rethrown after both have been attempted — callers decide (see main.ts).
  const errors: unknown[] = [];
  try {
    if (provider) {
      try {
        await provider.forceFlush();
        await provider.shutdown();
      } catch (error) {
        errors.push(error);
      }
    }
    if (meterProvider) {
      try {
        await meterProvider.forceFlush();
        await meterProvider.shutdown();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) {
      if (errors.length > 1) {
        console.error("OpenTelemetry shutdown: additional error:", errors[1]);
      }
      throw errors[0];
    }
  } finally {
    // Reset the global API state too, so a later initOpenTelemetry() can register
    // fresh providers + context manager cleanly, and getTracer()/getMeter() fall
    // back to the API no-op instruments until then. (We don't swallow
    // flush/shutdown errors — the caller decides; see main.ts's shutdown
    // handler.)
    trace.disable();
    context.disable();
    metrics.disable();
  }
}

export async function initOpenTelemetry(cfg: OtelConfig = env): Promise<void> {
  if (_provider || !cfg.OTEL_ENABLED) {
    if (!cfg.OTEL_ENABLED) {
      console.log("OpenTelemetry is disabled via OTEL_ENABLED env var");
    }
    return;
  }

  // Fail open: telemetry is optional, so a setup error must not block the
  // service from booting — log it and carry on without tracing.
  try {
    // Import the OTel SDK lazily, only when telemetry is enabled. The SDK probes
    // the environment at import time (e.g. os.hostname()), which requires Deno's
    // --allow-sys; static imports would force that on every consumer/test that
    // imports this module even with telemetry disabled. Only @opentelemetry/api
    // (side-effect free) is imported statically above.
    const { BasicTracerProvider, BatchSpanProcessor } = await import(
      "@opentelemetry/sdk-trace-base"
    );
    const { OTLPTraceExporter } = await import(
      "@opentelemetry/exporter-trace-otlp-proto"
    );
    const { Resource } = await import("@opentelemetry/resources");
    const { AsyncHooksContextManager } = await import(
      "@opentelemetry/context-async-hooks"
    );

    // env guarantees defaults for all of these (see env.ts), so no fallbacks.
    const exporter = new OTLPTraceExporter({
      url: `${cfg.OTEL_EXPORTER_OTLP_ENDPOINT.replace(/\/$/, "")}/v1/traces`,
    });
    const provider = new BasicTracerProvider({
      resource: new Resource({
        "service.name": cfg.OTEL_SERVICE_NAME,
        "service.version": "1.0.0",
        "deployment.environment": cfg.ENV,
      }),
    });
    // Export all spans to the local OTLP collector, which forwards to SigNoz.
    provider.addSpanProcessor(new BatchSpanProcessor(exporter));

    // Prefer Deno's built-in context manager (Deno >= 2.2); fall back to the
    // async-hooks manager otherwise.
    // deno-lint-ignore no-explicit-any
    const denoCm = (globalThis as any)?.Deno?.telemetry?.contextManager;
    const contextManager = denoCm && typeof denoCm.enable === "function"
      ? denoCm
      : new AsyncHooksContextManager();
    context.setGlobalContextManager(contextManager.enable());

    trace.setGlobalTracerProvider(provider);
    _provider = provider;

    console.log(
      `OpenTelemetry initialized successfully with endpoint: ${cfg.OTEL_EXPORTER_OTLP_ENDPOINT}`,
    );

    // Metrics setup is independently fail-open: a MeterProvider error must not
    // tear down the tracer that just registered successfully, so it gets its own
    // try/catch nested inside the outer one.
    try {
      const {
        AggregationTemporality,
        MeterProvider,
        PeriodicExportingMetricReader,
      } = await import(
        "@opentelemetry/sdk-metrics"
      );
      const { OTLPMetricExporter } = await import(
        "@opentelemetry/exporter-metrics-otlp-proto"
      );

      const metricExporter = new OTLPMetricExporter({
        url: `${cfg.OTEL_EXPORTER_OTLP_ENDPOINT.replace(/\/$/, "")}/v1/metrics`,
        // Delta temporality: without it the exporter sends cumulative points
        // that SigNoz records as "unspecified", which breaks rate()/increase()
        // over our counters (only raw per-interval sums work).
        temporalityPreference: AggregationTemporality.DELTA,
      });
      const meterProvider = new MeterProvider({
        resource: new Resource({
          "service.name": cfg.OTEL_SERVICE_NAME,
          "service.version": "1.0.0",
          "deployment.environment": cfg.ENV,
        }),
      });
      // Periodically export metrics to the local OTLP collector, which forwards
      // to SigNoz. (This SDK version registers readers post-construction.)
      meterProvider.addMetricReader(
        new PeriodicExportingMetricReader({ exporter: metricExporter }),
      );

      metrics.setGlobalMeterProvider(meterProvider);
      _meterProvider = meterProvider;

      console.log(
        `OpenTelemetry metrics initialized successfully with endpoint: ${cfg.OTEL_EXPORTER_OTLP_ENDPOINT}`,
      );
    } catch (metricsError) {
      console.error(
        "Failed to initialize OpenTelemetry metrics:",
        metricsError,
      );
    }
  } catch (error) {
    console.error("Failed to initialize OpenTelemetry:", error);
  }
}
