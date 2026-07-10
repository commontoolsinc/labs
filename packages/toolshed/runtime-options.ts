import {
  type EnvReader,
  experimentalOptionsFromEnv,
  Runtime,
  type RuntimeOptions,
  runtimePresets,
} from "@commonfabric/runner";
import type { env as ToolshedEnv } from "@/env.ts";

/**
 * Assemble this toolshed's `RuntimeOptions` (CT-1814), extracted pure from
 * the server startup path so the wiring decisions are unit-testable:
 * `apiUrl` is the storage/memory base (MEMORY_URL), while patterns fetch
 * against the public API base (API_URL) — the builder/env.ts fallback is a
 * hardcoded `localhost:<ports.toolshed>`, wrong for any non-default port.
 * EXPERIMENTAL_* flags come from the injected env reader via the canonical
 * mapping.
 */
export function toolshedRuntimeOptions(
  config: Pick<ToolshedEnv, "MEMORY_URL" | "API_URL">,
  storageManager: RuntimeOptions["storageManager"],
  envGet: EnvReader = Deno.env.get,
): RuntimeOptions {
  return runtimePresets.productionServer({
    apiUrl: new URL(config.MEMORY_URL),
    patternApiUrl: new URL(config.API_URL),
    storageManager,
    experimental: experimentalOptionsFromEnv(envGet),
  });
}

type OtelEnv = Pick<ToolshedEnv, "OTEL_ENABLED" | "OTEL_SERVICE_NAME" | "ENV">;

/**
 * Construct this toolshed's Runtime and, when OTel is enabled, bridge its
 * telemetry bus to OpenTelemetry as a second consumer of the same marker
 * stream the debug tooling uses. Toolshed's Runtime only executes patterns
 * for webhook deliveries (interactive patterns run in browser/bg-piece
 * runtimes), so the bridge is low-volume — but without it those runs emit
 * markers into the void.
 *
 * The attach is fire-and-forget off the startup path (dynamic imports defer
 * OTel module load); the promise is returned so tests can await it. Failures
 * are logged, never fatal.
 */
export function createToolshedRuntime(
  config: Pick<ToolshedEnv, "MEMORY_URL" | "API_URL"> & OtelEnv,
  storageManager: RuntimeOptions["storageManager"],
  envGet: EnvReader = Deno.env.get,
): { runtime: Runtime; otelBridgeAttached: Promise<boolean> } {
  const runtime = new Runtime(
    toolshedRuntimeOptions(config, storageManager, envGet),
  );
  return {
    runtime,
    otelBridgeAttached: attachRuntimeOtelBridge(runtime, config),
  };
}

/**
 * Exported for tests; production reaches it through createToolshedRuntime.
 * Structural param so failure paths can be exercised with a stub.
 */
export async function attachRuntimeOtelBridge(
  runtime: Pick<Runtime, "telemetry" | "scheduler">,
  config: OtelEnv,
): Promise<boolean> {
  if (!config.OTEL_ENABLED) return false;
  try {
    const [{ attachRuntimeTelemetryOtelBridge }, { metrics, trace }] =
      await Promise.all([
        import("@commonfabric/runner/telemetry-otel-bridge"),
        import("@opentelemetry/api"),
      ]);
    attachRuntimeTelemetryOtelBridge(runtime.telemetry, {
      tracer: trace.getTracer("ct-runner-bridge"),
      meter: metrics.getMeter("ct-runner-bridge"),
      attributes: { "ct.runtime": "server" },
      metricAttributes: {
        "service.name": config.OTEL_SERVICE_NAME,
        "deployment.environment": config.ENV,
      },
    });
    // Preflight markers are gated; without the flip the event-admission
    // spans/histograms never fire.
    runtime.scheduler.setEventPreflightTelemetryEnabled(true);
    return true;
  } catch (error) {
    console.warn("Runtime OTel bridge attach failed:", error);
    return false;
  }
}
