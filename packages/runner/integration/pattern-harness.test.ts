import { describe, it } from "@std/testing/bdd";
import { runPatternScenario } from "./pattern-harness.ts";
import { scenarios as boundedCounterScenarios } from "./patterns/bounded-counter.ts";
import {
  scenarios as counterBatchedHandlerUpdatesScenarios,
} from "./patterns/counter-batched-handler-updates.ts";
import {
  scenarios as counterAggregateScenarios,
} from "./patterns/counter-aggregate.ts";
import {
  scenarios as counterDeduplicatedListScenarios,
} from "./patterns/counter-deduplicated-list.ts";
import {
  scenarios as counterComputedDefaultStringsScenarios,
} from "./patterns/counter-computed-default-strings.ts";
import {
  scenarios as counterComplexUnionStateScenarios,
} from "./patterns/counter-complex-union-state.ts";
import {
  scenarios as counterConditionalBranchScenarios,
} from "./patterns/counter-conditional-branch.ts";
import {
  scenarios as counterDelayedComputeScenarios,
} from "./patterns/counter-delayed-compute.ts";
import {
  scenarios as counterDerivedColorScenarios,
} from "./patterns/counter-derived-color.ts";
import {
  scenarios as counterDerivedChecksumScenarios,
} from "./patterns/counter-derived-checksum.ts";
import {
  scenarios as counterDerivedCanonicalFormScenarios,
} from "./patterns/counter-derived-canonical-form.ts";
import {
  scenarios as counterDerivedMinMaxScenarios,
} from "./patterns/counter-derived-min-max.ts";
import {
  scenarios as counterDerivedSummaryScenarios,
} from "./patterns/counter-derived-summary.ts";
import {
  scenarios as counterDynamicHandlerListScenarios,
} from "./patterns/counter-dynamic-handler-list.ts";
import {
  scenarios as counterDynamicStepScenarios,
} from "./patterns/counter-dynamic-step.ts";
import {
  scenarios as counterFilteredProjectionScenarios,
} from "./patterns/counter-filtered-projection.ts";
import {
  scenarios as counterHandlerSpawnScenarios,
} from "./patterns/counter-handler-spawn.ts";
import {
  scenarios as counterHierarchicalDefaultsScenarios,
} from "./patterns/counter-hierarchical-defaults.ts";
import {
  scenarios as counterGroupedSummaryScenarios,
} from "./patterns/counter-grouped-summary.ts";
import {
  scenarios as counterHierarchicalKeyPathScenarios,
} from "./patterns/counter-hierarchical-key-path.ts";
import {
  scenarios as counterHistoryScenarios,
} from "./patterns/counter-history-tracker.ts";
import {
  scenarios as counterKeyedMapScenarios,
} from "./patterns/counter-keyed-map.ts";
import {
  scenarios as counterLiftFormattingScenarios,
} from "./patterns/counter-lift-formatting.ts";
import {
  scenarios as counterMutableTupleScenarios,
} from "./patterns/counter-mutable-tuple.ts";
import {
  scenarios as counterNestedArrayObjectsScenarios,
} from "./patterns/counter-nested-array-objects.ts";
import {
  scenarios as counterNestedHandlerCompositionScenarios,
} from "./patterns/counter-nested-handler-composition.ts";
import {
  scenarios as counterNestedParameterizedScenarios,
} from "./patterns/counter-nested-parameterized.ts";
import {
  scenarios as counterNestedOptionalCellsScenarios,
} from "./patterns/counter-nested-optional-cells.ts";
import {
  scenarios as counterNestedStreamScenarios,
} from "./patterns/counter-nested-stream.ts";
import {
  scenarios as counterNoOpEventsScenarios,
} from "./patterns/counter-no-op-events.ts";
import {
  scenarios as counterOpaqueRefMapScenarios,
} from "./patterns/counter-opaque-ref-map.ts";
import {
  scenarios as counterOptionalFallbackScenarios,
} from "./patterns/counter-optional-fallback.ts";
import {
  scenarios as counterPersistenceDefaultsScenarios,
} from "./patterns/counter-persistence-defaults.ts";
import {
  scenarios as counterRenderTreeScenarios,
} from "./patterns/counter-render-tree.ts";
import {
  scenarios as counterReplicatorScenarios,
} from "./patterns/counter-replicator.ts";
import {
  scenarios as counterReorderableListScenarios,
} from "./patterns/counter-reorderable-list.ts";
import {
  scenarios as counterResetScenarios,
} from "./patterns/counter-reset.ts";
import {
  scenarios as counterRichLabelScenarios,
} from "./patterns/counter-rich-label.ts";
import {
  scenarios as counterRollingAverageScenarios,
} from "./patterns/counter-rolling-average.ts";
import {
  scenarios as counterRangeSliderScenarios,
} from "./patterns/counter-range-slider.ts";
import {
  scenarios as counterRingBufferHistoryScenarios,
} from "./patterns/counter-ring-buffer-history.ts";
import {
  scenarios as counterSharedAliasScenarios,
} from "./patterns/counter-shared-alias.ts";
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
  scenarios as securityVulnerabilityTrackerScenarios,
} from "./patterns/security-vulnerability-tracker.ts";
import {
  scenarios as sleepJournalScenarios,
} from "./patterns/sleep-journal.ts";
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
  ...securityVulnerabilityTrackerScenarios,
  ...sleepJournalScenarios,
  ...toggleScenarios,
  ...doubleCounterSharedIncrementScenarios,
  ...counterAggregateScenarios,
  ...counterBatchedHandlerUpdatesScenarios,
  ...counterDeduplicatedListScenarios,
  ...counterComputedDefaultStringsScenarios,
  ...counterComplexUnionStateScenarios,
  ...counterConditionalBranchScenarios,
  ...counterDelayedComputeScenarios,
  ...counterDerivedColorScenarios,
  ...counterDerivedChecksumScenarios,
  ...counterDerivedCanonicalFormScenarios,
  ...counterDerivedMinMaxScenarios,
  ...counterDerivedSummaryScenarios,
  ...counterDynamicHandlerListScenarios,
  ...counterDynamicStepScenarios,
  ...counterFilteredProjectionScenarios,
  ...counterHandlerSpawnScenarios,
  ...counterHierarchicalDefaultsScenarios,
  ...counterGroupedSummaryScenarios,
  ...counterHierarchicalKeyPathScenarios,
  ...counterHistoryScenarios,
  ...counterKeyedMapScenarios,
  ...boundedCounterScenarios,
  ...counterLiftFormattingScenarios,
  ...counterMutableTupleScenarios,
  ...counterNestedArrayObjectsScenarios,
  ...counterNestedHandlerCompositionScenarios,
  ...counterNestedParameterizedScenarios,
  ...counterNestedOptionalCellsScenarios,
  ...counterNestedStreamScenarios,
  ...counterNoOpEventsScenarios,
  ...counterOptionalFallbackScenarios,
  ...counterOpaqueRefMapScenarios,
  ...counterPersistenceDefaultsScenarios,
  ...counterRichLabelScenarios,
  ...counterRenderTreeScenarios,
  ...counterRollingAverageScenarios,
  ...counterRangeSliderScenarios,
  ...counterRingBufferHistoryScenarios,
  ...counterReplicatorScenarios,
  ...counterReorderableListScenarios,
  ...counterSharedAliasScenarios,
  ...counterResetScenarios,
];

describe("Pattern integration harness", () => {
  for (const scenario of allScenarios) {
    it(scenario.name, async () => {
      await runPatternScenario(scenario);
    });
  }
});
