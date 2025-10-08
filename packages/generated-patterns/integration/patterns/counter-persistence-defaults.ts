import type { PatternIntegrationScenario } from "../pattern-harness.ts";

export const counterPersistenceDefaultsScenario: PatternIntegrationScenario<
  { value?: number; step?: number }
> = {
  name: "counter preserves provided persisted state",
  module: new URL(
    "./counter-persistence-defaults.pattern.ts",
    import.meta.url,
  ),
  exportName: "counterWithPersistenceDefaults",
  argument: { value: 7 },
  steps: [
    {
      expect: [
        { path: "value", value: 7 },
        { path: "currentStep", value: 1 },
        { path: "label", value: "Value 7 (step 1)" },
      ],
    },
    {
      events: [{ stream: "increment", payload: {} }],
      expect: [
        { path: "value", value: 8 },
        { path: "label", value: "Value 8 (step 1)" },
      ],
    },
    {
      events: [{ stream: "increment", payload: { amount: 2 } }],
      expect: [
        { path: "value", value: 10 },
        { path: "label", value: "Value 10 (step 1)" },
      ],
    },
  ],
};

export const scenarios = [counterPersistenceDefaultsScenario];
