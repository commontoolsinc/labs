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
  const experimental = experimentalOptionsFromEnv(envGet);
  return runtimePresets.productionServer({
    apiUrl: new URL(config.MEMORY_URL),
    patternApiUrl: new URL(config.API_URL),
    storageManager,
    experimental,
    // Toolshed does not egress WHEN SOMETHING ELSE WILL. It is not obvious
    // that it ever could: nothing here calls an effect builtin. But a webhook
    // delivery is a plain stream write, and a plain stream write is a
    // pattern-execution entry point — the scheduler finds no local handler,
    // `ensurePieceRunning` loads the pattern and starts the piece INSIDE THIS
    // PROCESS, and the piece's whole reactive graph runs here, effect builtins
    // included. Undeclared, those effects ride the client posture
    // (`"claim-conditional"`), which egresses unless a server effect claim
    // happens to exist for the action — i.e. the correctness of a webhook side
    // effect would depend on winning a race with the space executor.
    //
    // Suppressing is right only when the effect still happens elsewhere: the
    // same `runtime.start()` that runs the piece is also the runner's demand
    // publisher, so the space executor picks the closure up and performs the
    // egress under its own claim. Suppressing the START instead would look
    // cleaner and fail silently — it is the demand publication, so nothing
    // would ever run the hook.
    //
    // WHICH IS WHY THIS IS NOW CONDITIONAL, on the same flag and for the same
    // reason as the constructor default in `runner/src/runtime.ts`. The arc
    // has exactly two configurations: with `serverPrimaryExecution` OFF there
    // is no executor to pick the closure up (`addExecutionDemand` is gated on
    // that flag), so an unconditional suppression here would delete the
    // webhook's side effect outright rather than relocate it — the silent
    // failure the arc rates strictly worse than a duplicated one. Flag off,
    // toolshed keeps today's behaviour and egresses itself.
    //
    // Pinned end to end by `routes/webhooks/webhooks.egress-authority.test.ts`
    // (both arms: suppressed-and-relocated under the flag, egressing without
    // it) and `patterns/integration/server-execution-webhook-egress-gate.test.ts`
    // (flag on: exactly one broker egress, performed by the executor).
    externalSinkDisposition: experimental.serverPrimaryExecution
      ? "suppress"
      : "claim-conditional",
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
): Runtime {
  const runtime = new Runtime(
    toolshedRuntimeOptions(config, storageManager, envGet),
  );
  // Fire-and-forget; the attach itself is exported and unit-tested.
  void attachRuntimeOtelBridge(runtime, config);
  return runtime;
}

// The one live bridge detach (toolshed runs a single Runtime); invoked from
// shutdownOpenTelemetry so in-flight storage spans are ended before the final
// flush instead of being dropped with the process.
let activeOtelBridgeDetach: (() => void) | undefined;

/** Idempotent; returns whether a bridge was attached. */
export function detachRuntimeOtelBridgeIfAttached(): boolean {
  const detach = activeOtelBridgeDetach;
  activeOtelBridgeDetach = undefined;
  detach?.();
  return detach !== undefined;
}

/**
 * Exported for tests; production reaches it through createToolshedRuntime.
 * Structural param so failure paths can be exercised with a stub.
 *
 * Metrics caveat: toolshed's own OTel setup (lib/otel.ts) registers a tracer
 * provider only, so with OTEL_ENABLED alone the bridge's ct.* instruments are
 * API no-ops. On the VMs the process also runs under Deno native OTel
 * (OTEL_DENO + --unstable-otel), whose global MeterProvider makes them real —
 * spans work either way. Deliberate: a second SDK MeterProvider here would
 * duplicate what Deno native already exports.
 */
export async function attachRuntimeOtelBridge(
  runtime: Pick<Runtime, "telemetry" | "scheduler">,
  config: OtelEnv,
): Promise<boolean> {
  if (!config.OTEL_ENABLED) return false;
  let detach: (() => void) | undefined;
  try {
    const [{ attachRuntimeTelemetryOtelBridge }, { metrics, trace }] =
      await Promise.all([
        import("@commonfabric/runner/telemetry-otel-bridge"),
        import("@opentelemetry/api"),
      ]);
    detach = attachRuntimeTelemetryOtelBridge(runtime.telemetry, {
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
    // Registered only after full success so a failed attach never leaves a
    // half-wired bridge behind for shutdown to detach.
    activeOtelBridgeDetach = detach;
    return true;
  } catch (error) {
    detach?.();
    console.warn("Runtime OTel bridge attach failed:", error);
    return false;
  }
}
