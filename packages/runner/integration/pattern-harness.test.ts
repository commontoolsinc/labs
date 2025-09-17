import { describe, it } from "@std/testing/bdd";
import { runPatternScenario } from "./pattern-harness.ts";
import { scenarios as boundedCounterScenarios } from "./patterns/bounded-counter.ts";
import {
  scenarios as counterDelayedComputeScenarios,
} from "./patterns/counter-delayed-compute.ts";
import {
  scenarios as counterDerivedColorScenarios,
} from "./patterns/counter-derived-color.ts";
import {
  scenarios as counterDynamicStepScenarios,
} from "./patterns/counter-dynamic-step.ts";
import {
  scenarios as counterHistoryScenarios,
} from "./patterns/counter-history-tracker.ts";
import {
  scenarios as counterLiftFormattingScenarios,
} from "./patterns/counter-lift-formatting.ts";
import {
  scenarios as counterNestedStreamScenarios,
} from "./patterns/counter-nested-stream.ts";
import {
  scenarios as counterResetScenarios,
} from "./patterns/counter-reset.ts";
import { scenarios as counterScenarios } from "./patterns/simple-counter.ts";
import {
  scenarios as doubleCounterSharedIncrementScenarios,
} from "./patterns/double-counter-shared-increment.ts";
import { scenarios as echoScenarios } from "./patterns/echo.ts";
import { scenarios as listManagerScenarios } from "./patterns/list-manager.ts";
import {
  scenarios as nestedCounterScenarios,
} from "./patterns/nested-counters.ts";
import {
  scenarios as toggleScenarios,
} from "./patterns/toggle-derive-label.ts";
import {
  scenarios as composedCounterScenarios,
} from "./patterns/composed-counter.ts";

const allScenarios = [
  ...echoScenarios,
  ...counterScenarios,
  ...nestedCounterScenarios,
  ...composedCounterScenarios,
  ...listManagerScenarios,
  ...toggleScenarios,
  ...doubleCounterSharedIncrementScenarios,
  ...counterDelayedComputeScenarios,
  ...counterHistoryScenarios,
  ...boundedCounterScenarios,
  ...counterDynamicStepScenarios,
  ...counterLiftFormattingScenarios,
  ...counterNestedStreamScenarios,
  ...counterDerivedColorScenarios,
  ...counterResetScenarios,
];

describe("Pattern integration harness", () => {
  for (const scenario of allScenarios) {
    it(scenario.name, async () => {
      await runPatternScenario(scenario);
    });
  }
});
