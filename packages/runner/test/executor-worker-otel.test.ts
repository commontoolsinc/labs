import { assertEquals, assertStrictEquals } from "@std/assert";
import type { OtelBridgeOptions } from "../src/telemetry-otel-bridge.ts";
import { maybeAttachExecutorOtelBridge } from "../src/executor/worker-otel.ts";

const runtimeStub = () => {
  const telemetry = new EventTarget();
  const preflight: boolean[] = [];
  return {
    runtime: {
      telemetry,
      scheduler: {
        setEventPreflightTelemetryEnabled(enabled: boolean) {
          preflight.push(enabled);
        },
      },
    },
    telemetry,
    preflight,
  };
};

Deno.test("executor worker OTel stays inert when the host is not exporting", async () => {
  const { runtime, preflight } = runtimeStub();
  let loads = 0;

  const detach = await maybeAttachExecutorOtelBridge(runtime, {
    envGet: () => undefined,
    load: () => {
      loads++;
      throw new Error("disabled bridge must not load dependencies");
    },
  });

  assertEquals(detach, undefined);
  assertEquals(loads, 0);
  assertEquals(preflight, []);
});

Deno.test("executor worker OTel bridges its isolated runtime and detaches", async () => {
  const { runtime, telemetry, preflight } = runtimeStub();
  const tracer = {} as OtelBridgeOptions["tracer"];
  const meter = {} as OtelBridgeOptions["meter"];
  let attachedTelemetry: EventTarget | undefined;
  let attachedOptions: OtelBridgeOptions | undefined;
  let detached = 0;

  const values: Record<string, string> = {
    OTEL_DENO: "1",
    OTEL_SERVICE_NAME: "toolshed-staging",
    ENV: "staging",
  };
  const detach = await maybeAttachExecutorOtelBridge(runtime, {
    envGet: (name: string) => values[name],
    spanAttributes: {
      "space.did": "did:key:z6Mk-space",
      "user.did": "did:key:z6Mk-sponsor",
    },
    load: () =>
      Promise.resolve({
        tracer,
        meter,
        attach(telemetry: EventTarget, options: OtelBridgeOptions) {
          attachedTelemetry = telemetry;
          attachedOptions = options;
          return () => detached++;
        },
      }),
  });

  assertStrictEquals(attachedTelemetry, telemetry);
  assertStrictEquals(attachedOptions?.tracer, tracer);
  assertStrictEquals(attachedOptions?.meter, meter);
  assertEquals(attachedOptions?.attributes, {
    "ct.runtime": "server-executor",
  });
  assertEquals(attachedOptions?.spanAttributes, {
    "space.did": "did:key:z6Mk-space",
    "user.did": "did:key:z6Mk-sponsor",
  });
  assertEquals(attachedOptions?.metricAttributes, {
    "service.name": "toolshed-staging",
    "deployment.environment": "staging",
  });
  assertEquals(preflight, [true]);

  detach?.();
  assertEquals(detached, 1);
});

Deno.test("executor worker OTel fails open when bridge loading fails", async () => {
  const { runtime, preflight } = runtimeStub();
  const warnings: unknown[][] = [];

  const detach = await maybeAttachExecutorOtelBridge(runtime, {
    envGet: (name: string) => name === "OTEL_ENABLED" ? "true" : undefined,
    load: () => Promise.reject(new Error("bridge unavailable")),
    warn: (...args: unknown[]) => warnings.push(args),
  });

  assertEquals(detach, undefined);
  assertEquals(preflight, []);
  assertEquals(warnings.length, 1);
});
