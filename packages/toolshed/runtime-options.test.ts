import { assertEquals, assertStrictEquals } from "@std/assert";
import { Identity } from "@commonfabric/identity";
import type { RuntimeOptions } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import {
  attachRuntimeOtelBridge,
  createToolshedRuntime,
  detachRuntimeOtelBridgeIfAttached,
  toolshedRuntimeOptions,
} from "@/runtime-options.ts";

// Pins toolshed's runtime wiring decisions (CT-1814): the runtime's storage
// base is MEMORY_URL while patterns fetch against the public API_URL; the
// storage manager passes through untouched; EXPERIMENTAL_* flags come from
// the injected env reader via the canonical mapping; and the shared
// first-party posture (the CFC pin) rides along from the preset.
Deno.test("toolshedRuntimeOptions splits MEMORY_URL/API_URL and honors the env reader", () => {
  const storageManager = {
    sentinel: true,
  } as unknown as RuntimeOptions["storageManager"];

  const options = toolshedRuntimeOptions(
    {
      MEMORY_URL: "http://memory.test:8000/",
      API_URL: "http://api.test:9000/",
    },
    storageManager,
    (name) =>
      name === "EXPERIMENTAL_MODERN_CELL_REP"
        ? "true"
        : name === "COMMIT_SHA"
        ? "toolshed-source-sha"
        : undefined,
  );

  assertEquals(options.apiUrl.href, "http://memory.test:8000/");
  assertEquals(
    options.patternEnvironment?.apiUrl.href,
    "http://api.test:9000/",
  );
  assertStrictEquals(options.storageManager, storageManager);
  assertEquals(options.experimental?.modernCellRep, true);
  // Unset flags stay unset (tri-state fidelity), not coerced.
  assertEquals(options.experimental?.persistentSchedulerState, undefined);
  assertEquals(options.clientVersion, "toolshed-source-sha");
  assertEquals(options.cfcEnforcementMode, "enforce-explicit");
});

// The runtime→OTel bridge attach rides Runtime construction (CT plan: the
// bridge is a second consumer of the RuntimeTelemetry bus). Off by default;
// on OTEL_ENABLED it attaches and flips the preflight-telemetry gate. Without
// a registered OTel provider the API hands the bridge no-op instruments, so
// the enabled path is safe to exercise in a test.
Deno.test("createToolshedRuntime attaches the OTel bridge only when enabled", async () => {
  const signer = await Identity.fromPassphrase("runtime-options-otel-test");
  const config = {
    MEMORY_URL: "http://memory.test:8000/",
    API_URL: "http://api.test:9000/",
    OTEL_SERVICE_NAME: "toolshed-test",
    ENV: "test",
  };

  for (const enabled of [false, true]) {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = createToolshedRuntime(
      { ...config, OTEL_ENABLED: enabled },
      storageManager,
      () => undefined,
    );
    // The construction path fire-and-forgets the attach; assert the attach
    // behavior directly (same runtime, same config).
    assertEquals(
      await attachRuntimeOtelBridge(runtime, {
        ...config,
        OTEL_ENABLED: enabled,
      }),
      enabled,
    );
    await runtime.dispose();
    await storageManager.close();
  }

  // A successful attach registers the shutdown detach; detaching is
  // idempotent and reports whether a bridge was live.
  assertEquals(detachRuntimeOtelBridgeIfAttached(), true);
  assertEquals(detachRuntimeOtelBridgeIfAttached(), false);

  // Attach failures are logged, never fatal: a runtime whose preflight gate
  // throws must resolve false, not reject.
  const throwingRuntime = {
    telemetry: new EventTarget(),
    scheduler: {
      setEventPreflightTelemetryEnabled() {
        throw new Error("gate unavailable");
      },
    },
  } as unknown as Parameters<typeof attachRuntimeOtelBridge>[0];
  assertEquals(
    await attachRuntimeOtelBridge(throwingRuntime, {
      OTEL_ENABLED: true,
      OTEL_SERVICE_NAME: "toolshed-test",
      ENV: "test",
    }),
    false,
  );
});
