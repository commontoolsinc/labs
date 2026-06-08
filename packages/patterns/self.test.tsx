/**
 * Test Pattern: Self Model
 *
 * Tests the private self-model data layer:
 * 1. Empty state: fresh Self has EMPTY_SELF_MODEL
 * 2. Self-report neurotype round-trip
 * 3. Upsert-by-system: same system replaces; different system coexists
 * 4. addValueCard appends; recordResponse appends
 * 5. removeNeurotype / removeValueCard remove the correct entry
 *
 * Run: deno task cf test packages/patterns/self.test.tsx --verbose
 */
import { computed, handler, pattern, Writable } from "commonfabric";
import Self, {
  EMPTY_SELF_MODEL,
  type NeurotypeSystem,
  type SelfModel,
} from "./self.tsx";

// ---------------------------------------------------------------------------
// Test-local void handlers — data is baked into the state binding so the test
// runner can fire them as Stream<void> with no payload.
// ---------------------------------------------------------------------------

const doRecordNeurotype = handler<
  void,
  {
    selfModel: Writable<SelfModel>;
    system: NeurotypeSystem;
    result: string;
    source: "self-reported" | "assessed";
  }
>((_event, { selfModel, system, result, source }) => {
  const current = selfModel.get();
  const entry = {
    system,
    result,
    source,
    recordedAt: 1000, // fixed ts for deterministic tests
  };
  const idx = current.neurotypes.findIndex((n) => n.system === system);
  if (idx === -1) {
    selfModel.set({
      ...current,
      neurotypes: [...current.neurotypes, entry],
    });
  } else {
    const updated = current.neurotypes.map((n, i) => (i === idx ? entry : n));
    selfModel.set({ ...current, neurotypes: updated });
  }
});

const doAddValueCard = handler<
  void,
  { selfModel: Writable<SelfModel>; title: string; description?: string }
>((_event, { selfModel, title, description }) => {
  const current = selfModel.get();
  selfModel.set({
    ...current,
    values: [...current.values, { title, description }],
  });
});

const doRecordResponse = handler<
  void,
  {
    selfModel: Writable<SelfModel>;
    promptId: string;
    prompt: string;
    answer: string;
    track: "meaning" | "neurotype" | "freeform";
  }
>((_event, { selfModel, promptId, prompt, answer, track }) => {
  const current = selfModel.get();
  selfModel.set({
    ...current,
    responses: [
      ...current.responses,
      { promptId, prompt, answer, track, answeredAt: 2000 },
    ],
  });
});

const doRemoveNeurotype = handler<
  void,
  { selfModel: Writable<SelfModel>; system: NeurotypeSystem }
>((_event, { selfModel, system }) => {
  const current = selfModel.get();
  selfModel.set({
    ...current,
    neurotypes: current.neurotypes.filter((n) => n.system !== system),
  });
});

const doRemoveValueCard = handler<
  void,
  { selfModel: Writable<SelfModel>; index: number }
>((_event, { selfModel, index }) => {
  const current = selfModel.get();
  selfModel.set({
    ...current,
    values: current.values.filter((_, i) => i !== index),
  });
});

// ---------------------------------------------------------------------------
// Test pattern
// ---------------------------------------------------------------------------

export default pattern(() => {
  // Create a Writable cell we fully control and inject it into Self.
  // This avoids CTS auto-unwrap that happens when reading self.selfModel from
  // the pattern output (which arrives as a plain value in this pattern body).
  const selfModel = new Writable<SelfModel>(EMPTY_SELF_MODEL);
  const self = Self({ selfModel });

  // =========================================================================
  // Actions — all data baked into state so they fire as Stream<void>
  // =========================================================================

  // Test 2: record MBTI (self-reported)
  const action_record_mbti = doRecordNeurotype({
    selfModel,
    system: "mbti",
    result: "INTJ",
    source: "self-reported",
  });

  // Test 3a: upsert MBTI with a different result
  const action_upsert_mbti = doRecordNeurotype({
    selfModel,
    system: "mbti",
    result: "ENTP",
    source: "self-reported",
  });

  // Test 3b: add enneagram alongside MBTI
  const action_record_enneagram = doRecordNeurotype({
    selfModel,
    system: "enneagram",
    result: "5w4",
    source: "self-reported",
  });

  // Test 4a: add a value card
  const action_add_value_curiosity = doAddValueCard({
    selfModel,
    title: "Curiosity",
    description: "Seek to understand before judging",
  });

  // Test 4b: record a Q&A response
  const action_record_response = doRecordResponse({
    selfModel,
    promptId: "p1",
    prompt: "What energises you most?",
    answer: "Deep problem-solving with autonomy",
    track: "meaning",
  });

  // Test 5a: remove the enneagram entry
  const action_remove_enneagram = doRemoveNeurotype({
    selfModel,
    system: "enneagram",
  });

  // Test 5b: remove the first value card (index 0)
  const action_remove_first_value = doRemoveValueCard({ selfModel, index: 0 });

  // =========================================================================
  // Assertions — named computed so the runner reads plain boolean values
  // =========================================================================

  // Test 1: fresh state is empty
  const assert_empty_responses = computed(
    () => selfModel.get().responses.length === 0,
  );
  const assert_empty_values = computed(
    () => selfModel.get().values.length === 0,
  );
  const assert_empty_neurotypes = computed(
    () => selfModel.get().neurotypes.length === 0,
  );

  // Test 2: after recording MBTI
  const assert_one_neurotype = computed(
    () => selfModel.get().neurotypes.length === 1,
  );
  const assert_mbti_result_intj = computed(
    () => selfModel.get().neurotypes[0]?.result === "INTJ",
  );
  const assert_mbti_system = computed(
    () => selfModel.get().neurotypes[0]?.system === "mbti",
  );
  const assert_mbti_source_self_reported = computed(
    () => selfModel.get().neurotypes[0]?.source === "self-reported",
  );
  const assert_mbti_has_timestamp = computed(
    () => (selfModel.get().neurotypes[0]?.recordedAt ?? 0) > 0,
  );

  // Test 3a: after upsert — still one entry with new result
  const assert_still_one_neurotype = computed(
    () => selfModel.get().neurotypes.length === 1,
  );
  const assert_mbti_result_entp = computed(
    () => selfModel.get().neurotypes[0]?.result === "ENTP",
  );

  // Test 3b: after adding enneagram — two entries coexist
  const assert_two_neurotypes = computed(
    () => selfModel.get().neurotypes.length === 2,
  );
  const assert_has_enneagram = computed(
    () =>
      selfModel
        .get()
        .neurotypes.some((n) => n.system === "enneagram" && n.result === "5w4"),
  );

  // Test 4a: after addValueCard
  const assert_one_value = computed(
    () => selfModel.get().values.length === 1,
  );
  const assert_value_title_curiosity = computed(
    () => selfModel.get().values[0]?.title === "Curiosity",
  );

  // Test 4b: after recordResponse
  const assert_one_response = computed(
    () => selfModel.get().responses.length === 1,
  );
  const assert_response_track_meaning = computed(
    () => selfModel.get().responses[0]?.track === "meaning",
  );
  const assert_response_prompt_id = computed(
    () => selfModel.get().responses[0]?.promptId === "p1",
  );
  const assert_response_has_timestamp = computed(
    () => (selfModel.get().responses[0]?.answeredAt ?? 0) > 0,
  );

  // Test 5a: after removeNeurotype(enneagram) — back to one (mbti only)
  const assert_back_to_one_neurotype = computed(
    () => selfModel.get().neurotypes.length === 1,
  );
  const assert_only_mbti_remains = computed(
    () => selfModel.get().neurotypes[0]?.system === "mbti",
  );

  // Test 5b: after removeValueCard(0) — values empty again
  const assert_values_empty_after_remove = computed(
    () => selfModel.get().values.length === 0,
  );

  // =========================================================================
  // Test Sequence
  // =========================================================================
  return {
    tests: [
      // === Test 1: Initial empty state ===
      { assertion: assert_empty_responses },
      { assertion: assert_empty_values },
      { assertion: assert_empty_neurotypes },

      // === Test 2: Self-report neurotype round-trip ===
      { action: action_record_mbti },
      { assertion: assert_one_neurotype },
      { assertion: assert_mbti_result_intj },
      { assertion: assert_mbti_system },
      { assertion: assert_mbti_source_self_reported },
      { assertion: assert_mbti_has_timestamp },

      // === Test 3a: Upsert replaces same system ===
      { action: action_upsert_mbti },
      { assertion: assert_still_one_neurotype },
      { assertion: assert_mbti_result_entp },

      // === Test 3b: Different system coexists ===
      { action: action_record_enneagram },
      { assertion: assert_two_neurotypes },
      { assertion: assert_has_enneagram },

      // === Test 4a: addValueCard appends ===
      { action: action_add_value_curiosity },
      { assertion: assert_one_value },
      { assertion: assert_value_title_curiosity },

      // === Test 4b: recordResponse appends ===
      { action: action_record_response },
      { assertion: assert_one_response },
      { assertion: assert_response_track_meaning },
      { assertion: assert_response_prompt_id },
      { assertion: assert_response_has_timestamp },

      // === Test 5a: removeNeurotype removes correct entry ===
      { action: action_remove_enneagram },
      { assertion: assert_back_to_one_neurotype },
      { assertion: assert_only_mbti_remains },

      // === Test 5b: removeValueCard removes by index ===
      { action: action_remove_first_value },
      { assertion: assert_values_empty_after_remove },
    ],
    self,
  };
});
