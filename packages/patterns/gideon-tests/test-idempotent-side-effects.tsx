/// <cts-enable />
/**
 * Test Pattern: Idempotent Side Effects in computed()
 *
 * CLAIM TO VERIFY (from blessed/reactivity.md):
 * "computed, lift, and derive CAN have side effects - but they MUST be idempotent."
 *
 * This pattern demonstrates the difference between:
 * 1. NON-IDEMPOTENT side effects: Appending to an array on every run (causes thrashing)
 * 2. IDEMPOTENT side effects: Check-before-write with deterministic keys (settles properly)
 *
 * HOW TO MANUALLY VERIFY:
 * 1. Click "Trigger Re-computation" button multiple times
 * 2. Observe the "Non-Idempotent Run Count" - it will keep growing indefinitely
 * 3. Observe the "Non-Idempotent Data" array - it will accumulate duplicate entries
 * 4. Observe the "Idempotent Run Count" - it will stabilize after a few runs
 * 5. Observe the "Idempotent Data" map - it will contain only unique entries
 *
 * EXPECTED BEHAVIOR (confirms the claim):
 * - Non-idempotent approach: Run count grows without bound (thrashing)
 * - Idempotent approach: Run count stabilizes quickly (system settles)
 *
 * WHY THIS HAPPENS:
 * - Non-idempotent: Each run adds a new element, changing the array, triggering another run
 * - Idempotent: Check-before-write ensures no actual change after first run, system settles
 */
import {
  computed,
  Default,
  handler,
  ifElse,
  NAME,
  pattern,
  UI,
  Writable,
} from "commontools";

interface TestInput {
  // Trigger value that we can change to force re-computation
  triggerCount: Default<number, 0>;
}

interface TestOutput {
  // Note: Output types describe the inner value type, not the cell wrapper
  // The pattern returns OpaqueCell<number>, so the output is `number`
  triggerCount: number;
  nonIdempotentRunCount: number;
  idempotentRunCount: number;
  nonIdempotentData: unknown[];
  idempotentData: Record<string, unknown>;
}

const incrementTrigger = handler<unknown, { triggerCount: Writable<number> }>(
  (_args, state) => {
    state.triggerCount.set(state.triggerCount.get() + 1);
  },
);

export default pattern<TestInput, TestOutput>(({ triggerCount }) => {
  // Shared state for tracking
  const nonIdempotentArray = Writable.of<unknown[]>([]);
  const nonIdempotentCounter = Writable.of(0);

  const idempotentMap = Writable.of<Record<string, unknown>>({});
  const idempotentCounter = Writable.of(0);

  // Computed values for conditional rendering
  const isThrashing = computed(() => nonIdempotentCounter.get() > 10);
  const isSettling = computed(() => {
    const count = idempotentCounter.get();
    return count > 2 && count < 10;
  });

  // NON-IDEMPOTENT APPROACH: Append to array on every run
  // This causes thrashing - the computed keeps running forever because
  // it modifies the array, which triggers another run, which modifies again, etc.
  // NOTE: Only triggers when triggerCount > 0 to avoid thrashing on initial load
  const nonIdempotentComputed = computed(() => {
    // Read the trigger to create a dependency
    const trigger = triggerCount;

    // Only run side effect after user clicks (triggerCount > 0)
    // This prevents thrashing during initial load
    if (trigger > 0) {
      // NON-IDEMPOTENT SIDE EFFECT: Always append
      const current = nonIdempotentArray.get();
      nonIdempotentArray.set([...current, {
        trigger,
        timestamp: Temporal.Now.instant().epochMilliseconds,
      }]);

      // Increment counter to show how many times this ran
      nonIdempotentCounter.set(nonIdempotentCounter.get() + 1);
    }

    return nonIdempotentCounter.get() > 0
      ? `Non-idempotent computed ran ${nonIdempotentCounter.get()} times`
      : "Click trigger to start";
  });

  // IDEMPOTENT APPROACH: Check-before-write with deterministic keys
  // This settles - the computed runs a few times but then stops because
  // after the first run, the check-before-write prevents actual mutation
  const idempotentComputed = computed(() => {
    // Read the trigger to create a dependency
    const trigger = triggerCount;

    // Only run side effect after user clicks (triggerCount > 0)
    if (trigger > 0) {
      // IDEMPOTENT SIDE EFFECT: Only write if key doesn't exist
      const current = idempotentMap.get();
      const key = `trigger-${trigger}`; // Deterministic key based on input

      // Check before write - idempotent!
      if (!(key in current)) {
        idempotentMap.set({
          ...current,
          [key]: {
            trigger,
            timestamp: Temporal.Now.instant().epochMilliseconds,
          },
        });
      }

      // Increment counter to show how many times this ran
      idempotentCounter.set(idempotentCounter.get() + 1);
    }

    return idempotentCounter.get() > 0
      ? `Idempotent computed ran ${idempotentCounter.get()} times`
      : "Click trigger to start";
  });

  return {
    [NAME]: "Test: Idempotent Side Effects",
    [UI]: (
      <div style={{ padding: "20px", fontFamily: "system-ui, sans-serif" }}>
        <h2>Idempotent Side Effects Test</h2>

        <div
          style={{
            marginBottom: "20px",
            padding: "10px",
            backgroundColor: "#f0f0f0",
            borderRadius: "5px",
          }}
        >
          <p>
            <strong>Trigger Count:</strong> {triggerCount}
          </p>
          <ct-button
            onClick={incrementTrigger({ triggerCount })}
            style={{ padding: "10px 20px", fontSize: "16px" }}
          >
            Trigger Re-computation
          </ct-button>
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: "20px",
          }}
        >
          {/* Non-Idempotent Column */}
          <div
            style={{
              padding: "15px",
              backgroundColor: "#fee",
              borderRadius: "5px",
              border: "2px solid #f88",
            }}
          >
            <h3 style={{ color: "#c00" }}>❌ Non-Idempotent (Thrashing)</h3>
            <p>
              <strong>Status:</strong> {nonIdempotentComputed}
            </p>
            <p>
              <strong>Run Count:</strong> {nonIdempotentCounter}
            </p>
            <p>
              <strong>Array Length:</strong> {nonIdempotentArray.get().length}
            </p>

            <div
              style={{
                marginTop: "10px",
                padding: "10px",
                backgroundColor: "white",
                borderRadius: "3px",
                maxHeight: "200px",
                overflow: "auto",
              }}
            >
              <strong>Data (keeps growing):</strong>
              <pre style={{ fontSize: "11px", margin: "5px 0" }}>
                {JSON.stringify(nonIdempotentArray.get(), null, 2)}
              </pre>
            </div>

            {ifElse(
              isThrashing,
              <div
                style={{
                  marginTop: "10px",
                  padding: "10px",
                  backgroundColor: "#fdd",
                  borderRadius: "3px",
                }}
              >
                ⚠️ THRASHING DETECTED! Run count: {nonIdempotentCounter}
              </div>,
              null,
            )}
          </div>

          {/* Idempotent Column */}
          <div
            style={{
              padding: "15px",
              backgroundColor: "#efe",
              borderRadius: "5px",
              border: "2px solid #8f8",
            }}
          >
            <h3 style={{ color: "#080" }}>✅ Idempotent (Settles)</h3>
            <p>
              <strong>Status:</strong> {idempotentComputed}
            </p>
            <p>
              <strong>Run Count:</strong> {idempotentCounter}
            </p>
            <p>
              <strong>Unique Keys:</strong>{" "}
              {Object.keys(idempotentMap.get()).length}
            </p>

            <div
              style={{
                marginTop: "10px",
                padding: "10px",
                backgroundColor: "white",
                borderRadius: "3px",
                maxHeight: "200px",
                overflow: "auto",
              }}
            >
              <strong>Data (stable):</strong>
              <pre style={{ fontSize: "11px", margin: "5px 0" }}>
                {JSON.stringify(idempotentMap.get(), null, 2)}
              </pre>
            </div>

            {ifElse(
              isSettling,
              <div
                style={{
                  marginTop: "10px",
                  padding: "10px",
                  backgroundColor: "#dfd",
                  borderRadius: "3px",
                }}
              >
                ✓ System settling (ran {idempotentCounter} times)
              </div>,
              null,
            )}
          </div>
        </div>

        <div
          style={{
            marginTop: "20px",
            padding: "15px",
            backgroundColor: "#e8f4f8",
            borderRadius: "5px",
          }}
        >
          <h3>📚 Explanation</h3>
          <p>
            <strong>Non-Idempotent:</strong>{" "}
            Always appends to array → changes data → triggers re-run → appends
            again → infinite loop
          </p>
          <p>
            <strong>Idempotent:</strong>{" "}
            Checks if key exists before writing → no change after first run →
            system settles
          </p>
          <p>
            <strong>Key Insight:</strong>{" "}
            Side effects in computed() must be idempotent (same inputs = same
            state) to avoid thrashing
          </p>
        </div>
      </div>
    ),
    triggerCount,
    nonIdempotentRunCount: nonIdempotentCounter,
    idempotentRunCount: idempotentCounter,
    nonIdempotentData: nonIdempotentArray,
    idempotentData: idempotentMap,
  };
});
