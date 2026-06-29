import { context, diag, trace, type Tracer } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  BatchSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { Resource } from "@opentelemetry/resources";
import { AsyncHooksContextManager } from "@opentelemetry/context-async-hooks";
import { env } from "./env.ts";

// Ensure we only register once even during hot-reload.
let _providerRegistered = false;
let _provider: BasicTracerProvider | undefined;

const otlpExporter = new OTLPTraceExporter({
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
provider.addSpanProcessor(new BatchSpanProcessor(otlpExporter));

export function getTracerProvider(): BasicTracerProvider | undefined {
  return _provider;
}

/** Returns a tracer bound to the registered provider (or the no-op global one). */
export function getTracer(): Tracer {
  return _provider
    ? _provider.getTracer("bg-piece-service", "1.0.0")
    : trace.getTracer("bg-piece-service", "1.0.0");
}

// Prefer Deno's built-in context manager (Deno >= 2.2), falling back to the
// async-hooks based manager (e.g. under Node in tests). Mirrors toolshed's otel.ts.
const getContextManager = () => {
  try {
    // deno-lint-ignore no-explicit-any
    const cm = (globalThis as any)?.Deno?.telemetry?.contextManager;
    if (cm && typeof cm.enable === "function") {
      diag.debug("Using Deno's built-in telemetry context manager");
      return cm;
    }
  } catch (_) {
    // not running on Deno with telemetry support
  }
  diag.debug("Falling back to AsyncHooksContextManager");
  return new AsyncHooksContextManager();
};

export function initOpenTelemetry() {
  if (_providerRegistered || !env.OTEL_ENABLED) {
    if (!env.OTEL_ENABLED) {
      console.log("OpenTelemetry is disabled via OTEL_ENABLED env var");
    }
    return;
  }

  try {
    const contextManager = getContextManager();
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
