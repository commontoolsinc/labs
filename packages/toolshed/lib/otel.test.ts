import { assert, assertEquals } from "@std/assert";
import {
  getTracerProvider,
  initOpenTelemetry,
  shutdownOpenTelemetry,
} from "@/lib/otel.ts";

Deno.test("shutdownOpenTelemetry is a no-op before init", async () => {
  assertEquals(getTracerProvider(), undefined);
  await shutdownOpenTelemetry();
  assertEquals(getTracerProvider(), undefined);
});

Deno.test(
  "registers a provider when enabled, then flushes and tears it down on shutdown",
  // The batch processor keeps a flush timer until shutdown; we tear it down
  // below via shutdownOpenTelemetry(), so disable the leak sanitizer here.
  { sanitizeOps: false, sanitizeResources: false },
  async () => {
    initOpenTelemetry(true);
    assert(getTracerProvider() !== undefined, "provider should be registered");

    // No span was emitted, so forceFlush makes no network call to the collector.
    await shutdownOpenTelemetry();
    assertEquals(getTracerProvider(), undefined);
  },
);
