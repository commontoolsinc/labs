import { context, diag, trace } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  BatchSpanProcessor,
  ReadableSpan,
} from "@opentelemetry/sdk-trace-base";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { Resource } from "@opentelemetry/resources";
import { AsyncHooksContextManager } from "@opentelemetry/context-async-hooks";
import env from "@/env.ts";
import {
  isOpenInferenceSpan,
  OpenInferenceBatchSpanProcessor,
} from "@arizeai/openinference-vercel";

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
    "openinference.project.name": env.CTTS_AI_LLM_PHOENIX_PROJECT,
  }),
  spanProcessors: [
    new OpenInferenceBatchSpanProcessor({
      exporter: otlpExporter,
      spanFilter: (span) => {
        return isOpenInferenceSpan(span);
      },
    }),
  ],
});

export function getTracerProvider() {
  return _provider;
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

export function initOpenTelemetry() {
  if (_providerRegistered || !env.OTEL_ENABLED) {
    if (!env.OTEL_ENABLED) {
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
