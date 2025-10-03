import type { PatternIntegrationScenario } from "../pattern-harness.ts";

export const counterWithNestedStreamScenario: PatternIntegrationScenario<
  { value?: number }
> = {
  name: "counter exposes nested increment stream",
  module: new URL(
    "./counter-nested-stream.pattern.ts",
    import.meta.url,
  ),
  exportName: "counterWithNestedStream",
  argument: { value: 0 },
  steps: [
    { expect: [{ path: "value", value: 0 }] },
    {
      events: [{ stream: "streams.increment", payload: { amount: 2 } }],
      expect: [{ path: "value", value: 2 }],
    },
    {
      events: [{ stream: "streams.increment", payload: {} }],
      expect: [{ path: "value", value: 3 }],
    },
  ],
};

export const scenarios = [counterWithNestedStreamScenario];
