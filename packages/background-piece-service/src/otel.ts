import { context, trace, type Tracer } from "@opentelemetry/api";
import { env } from "./env.ts";

// Ensure we only register once even during hot-reload.
let _providerRegistered = false;
let _provider:
  | import("@opentelemetry/sdk-trace-base").BasicTracerProvider
  | undefined;

export function getTracerProvider() {
  return _provider;
}

/** Returns a tracer bound to the registered provider (or the no-op global one). */
export function getTracer(): Tracer {
  return _provider
    ? _provider.getTracer("bg-piece-service", "1.0.0")
    : trace.getTracer("bg-piece-service", "1.0.0");
}

export async function initOpenTelemetry() {
  if (_providerRegistered || !env.OTEL_ENABLED) {
    if (!env.OTEL_ENABLED) {
      console.log("OpenTelemetry is disabled via OTEL_ENABLED env var");
    }
    return;
  }

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

    const exporter = new OTLPTraceExporter({
      url: env.OTEL_EXPORTER_OTLP_ENDPOINT
        ? `${env.OTEL_EXPORTER_OTLP_ENDPOINT.replace(/\/$/, "")}/v1/traces`
        : "http://localhost:4318/v1/traces",
    });
    const provider = new BasicTracerProvider({
      resource: new Resource({
        "service.name": env.OTEL_SERVICE_NAME || "bg-piece-service",
        "service.version": "1.0.0",
        "deployment.environment": env.ENV || "development",
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
    _providerRegistered = true;

    console.log(
      `OpenTelemetry initialized successfully with endpoint: ${env.OTEL_EXPORTER_OTLP_ENDPOINT}`,
    );
  } catch (error) {
    console.error("Failed to initialize OpenTelemetry:", error);
    // Don't crash the service if telemetry fails.
  }
}
