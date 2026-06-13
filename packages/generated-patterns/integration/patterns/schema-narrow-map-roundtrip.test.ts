import { describe, it } from "@std/testing/bdd";
import { runPatternScenario } from "../pattern-harness.ts";
import type { PatternIntegrationScenario } from "../pattern-harness.ts";

// Minimal reproduction of the usage-based schema-narrowing bug that also
// corrupts library-checkout-system. See schema-narrow-map-roundtrip.pattern.ts
// for the mechanism. Both lifts read element fields of the same input array;
// the only difference is whether the field is reached directly or via a local
// `Map`. The transformer's capability analysis tracks the direct read but not
// the Map round-trip, so it prunes the round-tripped field from the lift's
// input schema, and the field arrives `undefined`.

// Control — passes today. `valuesDirect` reads `entry.value` directly off the
// element, so `value` stays in the input schema and the output is correct.
// This proves the pattern is wired correctly and isolates the bug below to the
// Map round-trip alone.
const directScenario: PatternIntegrationScenario = {
  name: "schema-narrow: directly-read element fields are preserved",
  module: new URL(
    "./schema-narrow-map-roundtrip.pattern.ts",
    import.meta.url,
  ),
  exportName: "schemaNarrowMapRoundtrip",
  steps: [
    {
      expect: [
        { path: "valuesDirect", value: ["alpha", "beta"] },
      ],
    },
  ],
};

// Regression — fails until the capability-analysis fix lands. `valuesViaMap`
// reads `entry.value` only after the element round-trips through a `Map`, so
// the transformer prunes `value` from the input schema. Expected output is
// [["alpha"], ["beta"]]; actual is [[undefined], [undefined]], which on main
// is laundered toward empties and on the undefined-preserving runtime is
// rejected (the whole structure reads as `undefined`). Either way this is
// wrong. Un-ignore when the transformer tracks Map values (or conservatively
// widens on untracked escapes). See the schema-narrowing transformer issue.
const mapRoundtripScenario: PatternIntegrationScenario = {
  name:
    "schema-narrow: fields read only via a Map round-trip are dropped (transformer regression)",
  module: new URL(
    "./schema-narrow-map-roundtrip.pattern.ts",
    import.meta.url,
  ),
  exportName: "schemaNarrowMapRoundtrip",
  steps: [
    {
      expect: [
        { path: "valuesViaMap", value: [["alpha"], ["beta"]] },
      ],
    },
  ],
};

describe("schema-narrow-map-roundtrip", () => {
  it(directScenario.name, async () => {
    await runPatternScenario(directScenario);
  });

  it.ignore(mapRoundtripScenario.name, async () => {
    await runPatternScenario(mapRoundtripScenario);
  });
});
