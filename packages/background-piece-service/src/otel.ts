import { context, trace, type Tracer } from "@opentelemetry/api";
import { env, type EnvVars } from "./env.ts";

/** The subset of env the tracer setup needs (injectable for tests). */
export type OtelConfig = Pick<
  EnvVars,
  "OTEL_ENABLED" | "OTEL_SERVICE_NAME" | "OTEL_EXPORTER_OTLP_ENDPOINT" | "ENV"
>;

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

/**
 * Flush and shut down the tracer provider so buffered spans aren't dropped when
 * the process exits. No-op if telemetry was never initialized.
 */
export async function shutdownOpenTelemetry(): Promise<void> {
  if (!_provider) return;
  // Clear the reference up front so a second call (or a span created after
  // shutdown) is a no-op rather than touching a torn-down provider.
  const provider = _provider;
  _provider = undefined;
  await provider.forceFlush();
  await provider.shutdown();
}

export async function initOpenTelemetry(cfg: OtelConfig = env): Promise<void> {
  if (_providerRegistered || !cfg.OTEL_ENABLED) {
    if (!cfg.OTEL_ENABLED) {
      console.log("OpenTelemetry is disabled via OTEL_ENABLED env var");
    }
    return;
  }

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

  // env guarantees defaults for all of these (see env.ts), so no fallbacks needed.
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
  _providerRegistered = true;

  console.log(
    `OpenTelemetry initialized successfully with endpoint: ${cfg.OTEL_EXPORTER_OTLP_ENDPOINT}`,
  );
}
