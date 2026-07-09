import { assertEquals, assertStrictEquals } from "@std/assert";
import type { RuntimeOptions } from "@commonfabric/runner";
import { toolshedRuntimeOptions } from "@/runtime-options.ts";

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
    (name) => name === "EXPERIMENTAL_MODERN_CELL_REP" ? "true" : undefined,
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
});
