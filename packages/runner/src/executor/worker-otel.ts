import type { OtelBridgeOptions } from "../telemetry-otel-bridge.ts";

type ExecutorTelemetryRuntime = {
  telemetry: EventTarget;
  scheduler: {
    setEventPreflightTelemetryEnabled(enabled: boolean): void;
  };
};

type ExecutorOtelDependencies = {
  tracer: OtelBridgeOptions["tracer"];
  meter: OtelBridgeOptions["meter"];
  attach(
    telemetry: EventTarget,
    options: OtelBridgeOptions,
  ): () => void;
};

type ExecutorOtelOptions = {
  envGet?: (name: string) => string | undefined;
  load?: () => Promise<ExecutorOtelDependencies>;
  spanAttributes?: OtelBridgeOptions["spanAttributes"];
  warn?: (...args: unknown[]) => void;
};

const enabled = (value: string | undefined): boolean =>
  value === "true" || value === "1";

const loadExecutorOtel = async (): Promise<ExecutorOtelDependencies> => {
  const [{ attachRuntimeTelemetryOtelBridge }, { metrics, trace }] =
    await Promise.all([
      import("../telemetry-otel-bridge.ts"),
      import("@opentelemetry/api"),
    ]);
  return {
    tracer: trace.getTracer("ct-runner-bridge"),
    meter: metrics.getMeter("ct-runner-bridge"),
    attach: attachRuntimeTelemetryOtelBridge,
  };
};

/**
 * Attach the executor Worker's isolated Runtime to the host's OTel globals.
 * Deno Workers do not share the process-global Runtime telemetry bus, so each
 * worker needs its own bridge when native or toolshed OTel export is enabled.
 * Loading and attachment are fail-open so observability never blocks serving.
 */
export async function maybeAttachExecutorOtelBridge(
  runtime: ExecutorTelemetryRuntime,
  options: ExecutorOtelOptions = {},
): Promise<(() => void) | undefined> {
  const envGet = options.envGet ?? ((name: string) => Deno.env.get(name));
  const warn = options.warn ?? ((...args: unknown[]) => console.warn(...args));
  let detach: (() => void) | undefined;
  try {
    if (!enabled(envGet("OTEL_DENO")) && !enabled(envGet("OTEL_ENABLED"))) {
      return undefined;
    }

    const dependencies = await (options.load ?? loadExecutorOtel)();
    const metricAttributes: NonNullable<OtelBridgeOptions["metricAttributes"]> =
      {};
    const serviceName = envGet("OTEL_SERVICE_NAME");
    const deploymentEnvironment = envGet("ENV");
    if (serviceName !== undefined) {
      metricAttributes["service.name"] = serviceName;
    }
    if (deploymentEnvironment !== undefined) {
      metricAttributes["deployment.environment"] = deploymentEnvironment;
    }

    detach = dependencies.attach(runtime.telemetry, {
      tracer: dependencies.tracer,
      meter: dependencies.meter,
      attributes: {
        "ct.runtime": "server-executor",
      },
      ...(options.spanAttributes !== undefined
        ? { spanAttributes: options.spanAttributes }
        : {}),
      ...(Object.keys(metricAttributes).length > 0 ? { metricAttributes } : {}),
    });
    runtime.scheduler.setEventPreflightTelemetryEnabled(true);
    return detach;
  } catch (error) {
    detach?.();
    warn("Executor runtime OTel bridge attach failed:", error);
    return undefined;
  }
}
