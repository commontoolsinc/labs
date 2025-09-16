import { describe, it } from "@std/testing/bdd";
import { runPatternScenario } from "./pattern-harness.ts";
import { scenarios as echoScenarios } from "./patterns/echo.ts";
import { scenarios as counterScenarios } from "./patterns/simple-counter.ts";
import { scenarios as composedCounterScenarios } from "./patterns/composed-counter.ts";
import { scenarios as listManagerScenarios } from "./patterns/list-manager.ts";
import { scenarios as nestedCounterScenarios } from "./patterns/nested-counters.ts";

const allScenarios = [
  ...echoScenarios,
  ...counterScenarios,
  ...nestedCounterScenarios,
  ...composedCounterScenarios,
  ...listManagerScenarios,
];

describe("Pattern integration harness", () => {
  for (const scenario of allScenarios) {
    it(scenario.name, async () => {
      await runPatternScenario(scenario);
    });
  }
});
