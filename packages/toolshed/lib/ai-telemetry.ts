import type { Attributes, AttributeValue, Tracer } from "@opentelemetry/api";
import { OpenTelemetry } from "@ai-sdk/otel";

/**
 * Flattens one runtime-context value into span attributes under `key`, matching
 * how @ai-sdk/otel builds its own `ai.settings.context.*` attributes: null and
 * undefined are dropped, arrays and primitives are used as-is, and objects are
 * walked with their path joined by dots.
 */
function addContextAttribute(
  attributes: Attributes,
  key: string,
  value: unknown,
): void {
  if (value == null) return;
  if (Array.isArray(value) || typeof value !== "object") {
    attributes[key] = value as AttributeValue;
    return;
  }
  for (const [nestedKey, nestedValue] of Object.entries(value)) {
    addContextAttribute(attributes, `${key}.${nestedKey}`, nestedValue);
  }
}

/**
 * Splits per-request metadata into the two values a generation call needs to
 * get that metadata onto its spans: the runtime context to pass, and the list
 * telemetry consults to decide which of its properties may be recorded.
 *
 * Telemetry withholds runtime context unless a property is named in the list,
 * so every property carried is named. Values are limited to strings because
 * that is the only overlap between the metadata a request may carry and the
 * attribute values OpenTelemetry accepts.
 */
export function runtimeContextFromMetadata(
  metadata: Record<string, unknown> | undefined,
): {
  runtimeContext: Record<string, string> | undefined;
  includeRuntimeContext: Record<string, boolean> | undefined;
} {
  if (metadata == null) {
    return { runtimeContext: undefined, includeRuntimeContext: undefined };
  }
  const runtimeContext: Record<string, string> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (typeof value === "string") runtimeContext[key] = value;
  }
  return {
    runtimeContext,
    includeRuntimeContext: Object.fromEntries(
      Object.keys(runtimeContext).map((key) => [key, true]),
    ),
  };
}

/**
 * Builds the AI SDK telemetry integration that turns generation calls into
 * OpenTelemetry spans.
 *
 * The `ai` package emits no spans by itself: span collection lives in
 * @ai-sdk/otel and only runs once the integration is registered through
 * `registerTelemetry`.
 *
 * `runtimeContext: true` adds the supplemental `ai.settings.context.*`
 * attributes, which is where per-request metadata lands. The OpenInference
 * span processor maps those attributes onto its own `metadata.*` attributes.
 *
 * The supplemental attributes cover the operation and step spans. `enrichSpan`
 * puts the same attributes on the model-call span, which OpenInference labels
 * as the LLM span, so per-request metadata is available on every span of the
 * trace. `enrichSpan` receives the runtime context already filtered by the
 * call's `includeRuntimeContext`.
 *
 * This module has no side effects so it can be exercised against an in-memory
 * exporter; `lib/otel.ts` registers the result against the live provider.
 */
export function createAiSdkTelemetry(tracer: Tracer): OpenTelemetry {
  return new OpenTelemetry({
    tracer,
    runtimeContext: true,
    enrichSpan: ({ spanType, runtimeContext }) => {
      if (spanType !== "languageModel" || runtimeContext == null) {
        return undefined;
      }
      const attributes: Attributes = {};
      for (const [key, value] of Object.entries(runtimeContext)) {
        addContextAttribute(attributes, `ai.settings.context.${key}`, value);
      }
      return attributes;
    },
  });
}
