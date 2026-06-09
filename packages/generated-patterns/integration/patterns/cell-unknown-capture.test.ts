import { describe, it } from "@std/testing/bdd";
import { runPatternScenario } from "../pattern-harness.ts";
import type { PatternIntegrationScenario } from "../pattern-harness.ts";

// A Cell<unknown> capture carries a primitive through `.get()` but drops a
// structured payload to `undefined`. The loss is silent, which is why the
// unknown-capture diagnostic warns on Cell<unknown> captures rather than
// exempting `asCell`.
describe("Cell<unknown> capture: primitive survives, structured is dropped", () => {
  const scenario: PatternIntegrationScenario<Record<string, never>> = {
    name: "Cell<unknown> capture drops structured values but keeps primitives",
    module: new URL("./cell-unknown-capture.pattern.ts", import.meta.url),
    argument: {},
    steps: [
      {
        expect: [
          { path: "prim", value: 42 },
          // The structured payload is read back as undefined, so the body falls
          // through to its defaults.
          { path: "present", value: false },
          { path: "name", value: "MISSING" },
          { path: "list", value: [] },
          { path: "nestedOk", value: false },
        ],
      },
    ],
  };

  it(scenario.name, async () => {
    await runPatternScenario(scenario);
  });
});
