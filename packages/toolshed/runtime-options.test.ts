import { assertEquals, assertStrictEquals } from "@std/assert";
import { Identity } from "@commonfabric/identity";
import {
  EXPERIMENTAL_ENV_VARS,
  type RuntimeOptions,
} from "@commonfabric/runner";
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
      name === EXPERIMENTAL_ENV_VARS.modernCellRep ||
        name === EXPERIMENTAL_ENV_VARS.serverPrimaryExecution
        ? "true"
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
  assertEquals(options.cfcEnforcementMode, "enforce-explicit");
  // Toolshed declares no egress authority UNDER SERVER-PRIMARY EXECUTION. A
  // webhook delivery starts the target piece in this process and runs its
  // effect builtins, so without the declaration those effects ride the client
  // posture and egress from the API server. What the declaration DOES — the
  // piece still starts, the sink is recorded and never released — is pinned
  // behaviourally in `routes/webhooks/webhooks.egress-authority.test.ts`; this
  // is the cheap guard that production is actually wired to it.
  assertEquals(options.externalSinkDisposition, "suppress");

  // THE OTHER CONFIGURATION, and it is the reason the declaration is derived
  // rather than constant. With server-primary execution off there is no
  // executor to relocate the effect to (`addExecutionDemand` is gated on the
  // same flag), so suppressing here would DELETE the webhook's side effect
  // instead of moving it. Toolshed keeps the pre-arc behaviour and egresses.
  // Reaching it takes an explicit `"false"` since 2026-08-01 — the flag
  // defaults ON.
  const withoutServerPrimary = toolshedRuntimeOptions(
    {
      MEMORY_URL: "http://memory.test:8000/",
      API_URL: "http://api.test:9000/",
    },
    storageManager,
    (name) =>
      name === EXPERIMENTAL_ENV_VARS.serverPrimaryExecution
        ? "false"
        : undefined,
  );
  assertEquals(
    withoutServerPrimary.experimental?.serverPrimaryExecution,
    false,
  );
  assertEquals(
    withoutServerPrimary.externalSinkDisposition,
    "claim-conditional",
  );

  // AND THE DEFAULT, which is what actually ships: with nothing set at all
  // the option stays `undefined` (tri-state fidelity is preserved — the
  // resolver applies the default, it does not write it into the bag) and the
  // disposition resolves to the server-primary posture. Reading the raw
  // option here instead of resolving it is the bug this pins: it would give
  // an unconfigured toolshed the flag-OFF egress posture inside the flag-ON
  // configuration, i.e. a double dispatch.
  const unconfigured = toolshedRuntimeOptions(
    {
      MEMORY_URL: "http://memory.test:8000/",
      API_URL: "http://api.test:9000/",
    },
    storageManager,
    () => undefined,
  );
  assertEquals(
    unconfigured.experimental?.serverPrimaryExecution,
    undefined,
  );
  assertEquals(unconfigured.externalSinkDisposition, "suppress");
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
