import { describe, it } from "@std/testing/bdd";
import { assert, assertEquals } from "@std/assert";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import {
  getMeter,
  getMeterProvider,
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
    // The provider takes the configured resource as given, so the service
    // attributes and the SDK's own defaults have to be merged before it is
    // handed over. Both halves are read off a span the real provider produced,
    // since a span carries the resource the exporter will stamp on it. The span
    // is left unended so nothing is queued for export.
    "stamps spans with both the service attributes and the SDK defaults",
    { sanitizeOps: false, sanitizeResources: false },
    async () => {
      await initOpenTelemetry(cfg(true));
      const span = getTracer().startSpan(
        "resource-probe",
      ) as unknown as ReadableSpan;
      const attributes = span.resource.attributes;

      assertEquals(attributes["service.name"], "bg-piece-test");
      assertEquals(attributes["service.version"], "1.0.0");
      assertEquals(attributes["deployment.environment"], "test");

      // Dropping these still exports spans, just anonymous ones, so nothing
      // else here would notice their absence.
      assertEquals(attributes["telemetry.sdk.language"], "nodejs");
      assertEquals(attributes["telemetry.sdk.name"], "opentelemetry");
      assert(
        typeof attributes["telemetry.sdk.version"] === "string",
        "telemetry.sdk.version should be set by the SDK's default resource",
      );

      await shutdownOpenTelemetry();
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

// The setup tests above only prove a provider object exists, which stays true
// even if nothing is wired to an exporter. These drive the real span processor,
// metric reader and OTLP exporters against a receiver on the loopback interface
// and check what actually lands on the wire.
describe("OpenTelemetry export", () => {
  interface Request {
    path: string;
    body: string;
  }

  // Runs `body` against a receiver standing in for the OTLP collector, and
  // hands back every request it got.
  async function withReceiver(
    body: (endpoint: string) => Promise<void>,
  ): Promise<Request[]> {
    const requests: Request[] = [];
    const decoder = new TextDecoder("utf-8", { fatal: false });
    // Bound to loopback so the receiver is never reachable from another host
    // while the test runs; the endpoint below uses the same address so the
    // process stays within a --allow-net=127.0.0.1 grant.
    const server = Deno.serve(
      { hostname: "127.0.0.1", port: 0, onListen: () => {} },
      async (request) => {
        requests.push({
          path: new URL(request.url).pathname,
          body: decoder.decode(new Uint8Array(await request.arrayBuffer())),
        });
        return new Response(null, { status: 200 });
      },
    );
    try {
      await body(`http://127.0.0.1:${server.addr.port}`);
    } finally {
      await server.shutdown();
    }
    return requests;
  }

  it(
    "sends spans and metrics to the collector, carrying the merged resource",
    // The batch processor and metric reader hold timers until shutdown, which
    // the body below performs.
    { sanitizeOps: false, sanitizeResources: false },
    async () => {
      const requests = await withReceiver(async (endpoint) => {
        await initOpenTelemetry({
          OTEL_ENABLED: true,
          OTEL_SERVICE_NAME: "bg-piece-export-test",
          OTEL_EXPORTER_OTLP_ENDPOINT: endpoint,
          ENV: "test",
        });

        getTracer().startSpan("export-probe-span").end();
        getMeter().createCounter("export_probe_counter").add(1);

        // Both flushes resolve only once the exporter has its response, so the
        // receiver has already recorded the requests by the time these return.
        await getTracerProvider()!.forceFlush();
        await getMeterProvider()!.forceFlush();
        await shutdownOpenTelemetry();
      });

      const traces = requests.find((r) => r.path === "/v1/traces");
      const metrics = requests.find((r) => r.path === "/v1/metrics");
      assert(traces !== undefined, "no span export reached the collector");
      assert(metrics !== undefined, "no metric export reached the collector");

      // Protocol buffers hold these strings verbatim, so the payload can be
      // checked for them without decoding it.
      assert(
        traces.body.includes("export-probe-span"),
        "the span export did not carry the span",
      );
      assert(
        metrics.body.includes("export_probe_counter"),
        "the metric export did not carry the counter",
      );
      for (const request of [traces, metrics]) {
        assert(
          request.body.includes("bg-piece-export-test"),
          `${request.path} did not carry service.name`,
        );
        assert(
          request.body.includes("telemetry.sdk.version"),
          `${request.path} did not carry the SDK's default resource attributes`,
        );
      }
    },
  );
});
