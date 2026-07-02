import { describe, it } from "@std/testing/bdd";
import { assert, assertEquals } from "@std/assert";
import {
  getTracer,
  getTracerProvider,
  initOpenTelemetry,
  type OtelConfig,
  shutdownOpenTelemetry,
} from "../src/otel.ts";

const cfg = (enabled: boolean): OtelConfig => ({
  OTEL_ENABLED: enabled,
  OTEL_SERVICE_NAME: "bg-piece-test",
  OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4318",
  ENV: "test",
});

describe("OpenTelemetry setup", () => {
  it("exposes a no-op tracer and no provider before init", () => {
    assertEquals(getTracerProvider(), undefined);
    const tracer = getTracer();
    assert(typeof tracer.startSpan === "function");
  });

  it("is a no-op when disabled", async () => {
    await initOpenTelemetry(cfg(false));
    assertEquals(getTracerProvider(), undefined);
    // shutdown with no provider returns immediately.
    await shutdownOpenTelemetry();
  });

  it("fails open when setup throws (telemetry must not block startup)", async () => {
    // A malformed endpoint makes the exporter URL construction throw inside
    // init; init should swallow it and leave telemetry off rather than crash.
    await initOpenTelemetry({
      OTEL_ENABLED: true,
      OTEL_SERVICE_NAME: "bg-piece-test",
      OTEL_EXPORTER_OTLP_ENDPOINT: undefined as unknown as string,
      ENV: "test",
    });
    assertEquals(getTracerProvider(), undefined);
  });

  it(
    "registers a provider when enabled and tears it down on shutdown",
    // The BatchSpanProcessor keeps a flush timer until shutdown; disable the
    // leak sanitizer since we tear it down via shutdownOpenTelemetry() below.
    { sanitizeOps: false, sanitizeResources: false },
    async () => {
      await initOpenTelemetry(cfg(true));
      const provider = getTracerProvider();
      assert(provider !== undefined, "provider should be registered");

      // getTracer now binds to the registered provider (no span emitted, so the
      // flush below makes no network call to the collector).
      const tracer = getTracer();
      assert(typeof tracer.startSpan === "function");

      // forceFlush (empty) + shutdown clears the provider.
      await shutdownOpenTelemetry();
      assertEquals(getTracerProvider(), undefined);
    },
  );

  it(
    "re-initializes cleanly after shutdown",
    { sanitizeOps: false, sanitizeResources: false },
    async () => {
      await initOpenTelemetry(cfg(true));
      assert(getTracerProvider() !== undefined, "first init should register");
      await shutdownOpenTelemetry();
      assertEquals(getTracerProvider(), undefined);

      // A second init after shutdown must rebuild a working provider. The old
      // `_providerRegistered` guard was never reset, so this silently no-op'd
      // and left the service running with no tracing.
      await initOpenTelemetry(cfg(true));
      assert(
        getTracerProvider() !== undefined,
        "init after shutdown should rebuild the provider",
      );
      await shutdownOpenTelemetry();
      assertEquals(getTracerProvider(), undefined);
    },
  );
});
