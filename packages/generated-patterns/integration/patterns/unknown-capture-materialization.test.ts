import { describe, it } from "@std/testing/bdd";
import { runPatternScenario } from "../pattern-harness.ts";
import type { PatternIntegrationScenario } from "../pattern-harness.ts";

// A structured value typed `unknown`, captured into computed(), is silently
// dropped to `undefined` at runtime — the exact failure the compile-time
// unknown-capture diagnostic exists to surface. A typed capture in the same
// body survives, confirming the drop is specific to `unknown`.
describe("unknown capture materializes as undefined at runtime", () => {
  const scenario: PatternIntegrationScenario<
    { payload: unknown; typed: { name: string } }
  > = {
    name:
      "structured unknown capture drops to undefined; typed capture survives",
    module: new URL(
      "./unknown-capture-materialization.pattern.ts",
      import.meta.url,
    ),
    argument: {
      payload: { name: "Alice", tags: [1, 2, 3] },
      typed: { name: "Bob" },
    },
    steps: [
      {
        expect: [
          { path: "unknownPresent", value: false },
          { path: "unknownName", value: "MISSING" },
          { path: "typedName", value: "Bob" },
        ],
      },
    ],
  };

  it(scenario.name, async () => {
    await runPatternScenario(scenario);
  });
});
