import { context, diag, trace } from "@opentelemetry/api";
import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { Resource } from "@opentelemetry/resources";
import { AsyncHooksContextManager } from "@opentelemetry/context-async-hooks";
import env from "@/env.ts";
import { OpenInferenceBatchSpanProcessor } from "@arizeai/openinference-vercel";
import { samplerFromEnv } from "@/lib/otel-sampler.ts";

// Ensure we only register once even during hot-reload
let _providerRegistered = false;
let _provider: BasicTracerProvider | undefined;

export const otlpExporter = new OTLPTraceExporter({
  url: env.OTEL_EXPORTER_OTLP_ENDPOINT
    ? `${env.OTEL_EXPORTER_OTLP_ENDPOINT.replace(/\/$/, "")}/v1/traces`
    : "http://localhost:4318/v1/traces",
});

export const provider = new BasicTracerProvider({
  resource: new Resource({
    "service.name": env.OTEL_SERVICE_NAME || "toolshed-dev",
    "service.version": "1.0.0",
    "deployment.environment": env.ENV || "development",
    "openinference.project.name": env.CFTS_AI_LLM_PHOENIX_PROJECT,
  }),
  // The SDK doesn't read OTEL_TRACES_SAMPLER from the env under Deno, so build
  // the sampler explicitly. Defaults (always_on / 1.0) keep 100% sampling.
  // NOTE: head sampling here applies to LLM/OpenInference spans too, so a ratio
  // below 1.0 also thins the spans the collector forwards to Phoenix.
  sampler: samplerFromEnv(env.OTEL_TRACES_SAMPLER, env.OTEL_TRACES_SAMPLER_ARG),
});

// Add span processor after construction (API changed in newer SDK versions)
//
// Export ALL spans (HTTP request spans from the otel middleware AND LLM spans) to
// the OTLP collector. The collector fans them out: its Phoenix pipeline filters to
// LLM/OpenInference spans, while its SigNoz pipeline ingests everything. We keep the
// OpenInferenceBatchSpanProcessor (rather than a plain BatchSpanProcessor) so LLM
// spans still get OpenInference semantic-convention formatting for Phoenix; a
// pass-through spanFilter lets non-LLM spans through to SigNoz as well. (The
// processor tags passed-through spans with an `openinference.span.kind`
// attribute, so they are not strictly byte-for-byte unchanged.)
provider.addSpanProcessor(
  new OpenInferenceBatchSpanProcessor({
    exporter: otlpExporter,
    spanFilter: () => true,
  }),
);

export function getTracerProvider() {
  return _provider;
}

/**
 * Flush and shut down the tracer provider so buffered spans aren't dropped when
 * the process exits. No-op if telemetry was never initialized. Mirrors the
 * bg-piece-service shutdown so toolshed doesn't lose its last span batch on
 * deploy/restart.
 */
export async function shutdownOpenTelemetry(): Promise<void> {
  if (!_provider) return;
  const p = _provider;
  _provider = undefined;
  try {
    await p.forceFlush();
    await p.shutdown();
  } finally {
    // Reset the global API state so getTracer() falls back to the API no-op
    // after shutdown. We deliberately do NOT reset _providerRegistered: the
    // `provider` above is a module-level const that init can't rebuild, so a
    // re-init must stay a guarded no-op rather than re-register a torn-down
    // instance. Shutdown here is process-exit-only.
    trace.disable();
    context.disable();
  }
}

// Prefer Deno's built-in context manager when running on Deno ≥2.2.
// It properly hooks into the runtime's AsyncContext implementation so
// tracing context survives across *all* async boundaries.
// Falls back to the Node/async-hooks based manager when not available
// (eg. unit tests executed under Node).
const getContextManager = () => {
  try {
    // deno-lint-ignore no-explicit-any
    const cm = (globalThis as any)?.Deno?.telemetry?.contextManager;
    if (cm && typeof cm.enable === "function") {
      diag.debug("Using Deno's built-in telemetry context manager");
      return cm;
    }
  } catch (_) {
    // ignored – not running on Deno with telemetry support
  }
  diag.debug("Falling back to AsyncHooksContextManager");
  return new AsyncHooksContextManager();
};

export function initOpenTelemetry(enabled: boolean = env.OTEL_ENABLED) {
  if (_providerRegistered || !enabled) {
    if (!enabled) {
      console.log("OpenTelemetry is disabled via OTEL_ENABLED env var");
    } else {
      console.log("OpenTelemetry already initialized, skipping");
    }
    return;
  }

  try {
    // Set up context manager
    const contextManager = getContextManager();
    context.setGlobalContextManager(contextManager.enable());

    // Register provider globally
    trace.setGlobalTracerProvider(provider);
    _provider = provider;
    _providerRegistered = true;

    console.log(
      `OpenTelemetry initialized successfully with endpoint: ${env.OTEL_EXPORTER_OTLP_ENDPOINT}`,
    );

    diag.debug("OpenTelemetry configuration details:", {
      exporter: env.OTEL_EXPORTER_OTLP_ENDPOINT,
      service: env.OTEL_SERVICE_NAME || "toolshed-dev",
      environment: env.ENV || "development",
    });
  } catch (error) {
    console.error("Failed to initialize OpenTelemetry:", error);
    // Don't crash the app if telemetry fails
  }
}
