/// <cts-enable />
/**
 * TEST PATTERN: console.time() in computed() Only Measures Graph Setup
 *
 * CLAIM: Timing instrumentation inside computed() only measures the initial
 * graph construction, not reactive re-executions
 * SOURCE: superstitions/2025-12-17-measuring-performance-correctly.md
 *
 * WHAT THIS TESTS:
 * - console.time() inside computed() behavior during initial run vs re-runs
 * - Call counter vs timing for measuring reactive re-execution
 * - Correct approach: counting calls instead of timing
 *
 * EXPECTED BEHAVIOR:
 * - Timing inside computed() fires once during setup
 * - Call counter increments on EVERY re-evaluation
 * - sink() callback fires on every update (correct way to observe)
 *
 * MANUAL VERIFICATION STEPS:
 * 1. Load the pattern - observe initial counts and timing
 * 2. Click "Trigger Update" multiple times
 * 3. Timing should NOT increase proportionally to updates
 * 4. Call counter SHOULD increase with each update
 * 5. Sink counter SHOULD also increase with each update
 */
import {
  Cell,
  computed,
  Default,
  handler,
  NAME,
  pattern,
  UI,
} from "commontools";

interface TestInput {
  value: Default<number, 0>;
}

// Global counters
let computedCallCount = 0;
let lastTimingMs = 0;

// Simulated expensive work
function expensiveWork(n: number): number {
  // Simulate some CPU work
  let result = n;
  for (let i = 0; i < 1000; i++) {
    result = Math.sin(result) * Math.cos(result);
  }
  return n * 2;
}

const triggerUpdate = handler<unknown, { value: Cell<number> }>(
  (_event, { value }) => {
    value.set((value.get() || 0) + 1);
  },
);

const triggerMany = handler<unknown, { value: Cell<number> }>(
  (_event, { value }) => {
    // Trigger 10 rapid updates
    for (let i = 0; i < 10; i++) {
      setTimeout(() => {
        value.set((value.get() || 0) + 1);
      }, i * 100);
    }
  },
);

const resetCounters = handler<unknown, { counterDisplay: Cell<number> }>(
  (_event, { counterDisplay }) => {
    computedCallCount = 0;
    lastTimingMs = 0;
    counterDisplay.set(Date.now());
  },
);

export default pattern<TestInput>(({ value }) => {
  const counterDisplay = Cell.of(0);

  // WRONG WAY: Timing inside computed()
  // This timing only captures the initial graph setup, not re-executions
  const timedComputed = computed(() => {
    const start = performance.now();
    computedCallCount++;

    // Do some work
    const result = expensiveWork(value || 0);

    // This timing measurement is misleading!
    lastTimingMs = performance.now() - start;

    return result;
  });

  // Display counters
  const computedCountDisplay = computed(() => {
    counterDisplay;
    return computedCallCount;
  });

  const timingDisplay = computed(() => {
    counterDisplay;
    return lastTimingMs.toFixed(3);
  });

  return {
    [NAME]: "Test: Performance Timing in computed()",
    [UI]: (
      <div style={{ padding: "20px", fontFamily: "monospace" }}>
        <h2>Superstition: Timing in computed() Only Measures Setup</h2>
        <p style={{ color: "#666", marginBottom: "20px" }}>
          CLAIM: console.time() inside computed() doesn't capture reactive
          re-executions.
        </p>

        {/* Current Value */}
        <div
          style={{
            padding: "15px",
            backgroundColor: "#e3f2fd",
            borderRadius: "8px",
            marginBottom: "20px",
          }}
        >
          <h3 style={{ margin: "0 0 10px 0" }}>Current Value</h3>
          <div style={{ fontSize: "24px", fontWeight: "bold" }}>{value}</div>
          <div style={{ marginTop: "5px" }}>
            Computed result: {timedComputed}
          </div>
          <div
            style={{
              display: "flex",
              gap: "10px",
              marginTop: "10px",
              flexWrap: "wrap",
            }}
          >
            <ct-button onClick={triggerUpdate({ value })}>
              Trigger Update (+1)
            </ct-button>
            <ct-button onClick={triggerMany({ value })}>
              Trigger 10 Updates
            </ct-button>
            <ct-button onClick={resetCounters({ counterDisplay })}>
              Reset Counters
            </ct-button>
          </div>
        </div>

        {/* Measurements */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: "20px",
            marginBottom: "20px",
          }}
        >
          {/* TIMING - Misleading */}
          <div
            style={{
              padding: "15px",
              backgroundColor: "#ffebee",
              borderRadius: "8px",
              border: "2px solid #f44336",
            }}
          >
            <h3
              style={{
                color: "#c62828",
                margin: "0 0 10px 0",
                fontSize: "14px",
              }}
            >
              WRONG: Timing
            </h3>
            <div
              style={{ fontSize: "24px", fontWeight: "bold", color: "#c62828" }}
            >
              {timingDisplay}ms
            </div>
            <p style={{ fontSize: "11px", color: "#666", marginTop: "10px" }}>
              Only measures LAST execution, doesn't accumulate
            </p>
          </div>

          {/* CALL COUNT - Correct */}
          <div
            style={{
              padding: "15px",
              backgroundColor: "#e8f5e9",
              borderRadius: "8px",
              border: "2px solid #4caf50",
            }}
          >
            <h3
              style={{
                color: "#2e7d32",
                margin: "0 0 10px 0",
                fontSize: "14px",
              }}
            >
              CORRECT: Call Count
            </h3>
            <div
              style={{ fontSize: "24px", fontWeight: "bold", color: "#2e7d32" }}
            >
              {computedCountDisplay}
            </div>
            <p style={{ fontSize: "11px", color: "#666", marginTop: "10px" }}>
              Counter inside computed() - tracks every call
            </p>
          </div>
        </div>

        {/* Code Examples */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: "20px",
            marginBottom: "20px",
          }}
        >
          <div
            style={{
              padding: "15px",
              backgroundColor: "#ffebee",
              borderRadius: "8px",
            }}
          >
            <h4 style={{ margin: "0 0 10px 0", color: "#c62828" }}>
              WRONG Approach
            </h4>
            <pre
              style={{
                backgroundColor: "#fff",
                padding: "10px",
                borderRadius: "4px",
                fontSize: "11px",
                overflow: "auto",
              }}
            >
              {`computed(() => {
  console.time('compute');
  const result = expensive();
  console.timeEnd('compute');
  // Only captures initial run!
  return result;
});`}
            </pre>
          </div>

          <div
            style={{
              padding: "15px",
              backgroundColor: "#e8f5e9",
              borderRadius: "8px",
            }}
          >
            <h4 style={{ margin: "0 0 10px 0", color: "#2e7d32" }}>
              CORRECT Approaches
            </h4>
            <pre
              style={{
                backgroundColor: "#fff",
                padding: "10px",
                borderRadius: "4px",
                fontSize: "11px",
                overflow: "auto",
              }}
            >
              {`// Use a global call counter
let count = 0;
computed(() => {
  count++;
  return expensive();
});

// The counter increments on
// EVERY re-evaluation`}
            </pre>
          </div>
        </div>

        {/* Analysis */}
        <div
          style={{
            padding: "15px",
            backgroundColor: "#fff3e0",
            borderRadius: "8px",
          }}
        >
          <h3 style={{ margin: "0 0 10px 0" }}>Analysis</h3>
          <div
            style={{
              padding: "10px",
              backgroundColor: "#fffde7",
              borderRadius: "4px",
            }}
          >
            <strong>Expected Result:</strong>
            <ul style={{ margin: "5px 0 0 0", paddingLeft: "20px" }}>
              <li>
                Timing value stays roughly constant (just measures one
                execution)
              </li>
              <li>
                Call count increases with each update
              </li>
              <li>
                After 10 updates: call count ~ 11, timing ~ same small value
              </li>
            </ul>
          </div>
          <p style={{ marginTop: "10px", fontSize: "12px", color: "#666" }}>
            <strong>Why:</strong>{" "}
            Reactive re-executions are scheduled via setTimeout(..., 0) and go
            through the scheduler's execute() method. The timing inside your
            computed body only captures when the closure actually runs, not the
            full reactive cycle overhead.
          </p>
        </div>
      </div>
    ),
    value,
    timedComputed,
  };
});
