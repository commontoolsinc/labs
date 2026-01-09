/// <cts-enable />
/**
 * TEST PATTERN: Early Returns in computed() Prevent Dependency Tracking
 *
 * CLAIM: Dependencies accessed after an early return are never tracked,
 * causing computed values to not update when those dependencies change.
 * SOURCE: superstitions/2026-01-05-computed-early-return-dependency-tracking.md
 *
 * WHAT THIS TESTS:
 * - A computed() with early return before accessing a dependency
 * - The same logic with dependency accessed first (before early return)
 * - Visual comparison showing when computed values update correctly
 *
 * EXPECTED BEHAVIOR:
 * - BROKEN: computed doesn't update when dependency after early return changes
 * - FIXED: computed updates correctly when dependency is accessed first
 *
 * MANUAL VERIFICATION STEPS:
 * 1. Load the pattern - both show "loading"
 * 2. Click "Set Ready" - phase changes to "ready"
 * 3. Click "Set Data" - BROKEN version may stay "ready", FIXED shows "has-data"
 * 4. The BROKEN version doesn't "see" the data change because it was never tracked
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
  isReady: Default<boolean, false>;
}

const setReady = handler<unknown, { isReady: Cell<boolean> }>(
  (_event, { isReady }) => {
    isReady.set(true);
  },
);

const setNotReady = handler<unknown, { isReady: Cell<boolean> }>(
  (_event, { isReady }) => {
    isReady.set(false);
  },
);

const setData = handler<unknown, { data: Cell<string | undefined> }>(
  (_event, { data }) => {
    data.set("Hello World!");
  },
);

const clearData = handler<unknown, { data: Cell<string | undefined> }>(
  (_event, { data }) => {
    data.set(undefined);
  },
);

const resetAll = handler<
  unknown,
  { isReady: Cell<boolean>; data: Cell<string | undefined> }
>((_event, { isReady, data }) => {
  isReady.set(false);
  data.set(undefined);
});

export default pattern<TestInput>(({ isReady }) => {
  // Separate cell for data (not in inputs so we control it)
  const data = Cell.of<string | undefined>();

  // BROKEN: Early return prevents `data` dependency tracking
  // When isReady is false, we return early BEFORE accessing `data`
  // So `data` is never tracked as a dependency
  const brokenPhase = computed(() => {
    const ready = isReady;
    if (!ready) {
      return "loading"; // Early return!
    }
    // This line only executes when ready=true
    // If we got here via ready changing from false->true,
    // `data` is tracked. But if `data` changes while ready=true,
    // it depends on whether `data` was accessed in the first tracked run.
    const d = data.get();
    if (d) {
      return "has-data";
    }
    return "ready";
  });

  // FIXED: Access `data` BEFORE any early returns
  // This ensures `data` is always tracked as a dependency
  const fixedPhase = computed(() => {
    // Access ALL dependencies first, before any conditional logic
    const d = data.get(); // Track `data` dependency FIRST
    const ready = isReady;

    if (!ready) {
      return "loading";
    }
    if (d) {
      return "has-data";
    }
    return "ready";
  });

  return {
    [NAME]: "Test: Early Return Dependency Tracking",
    [UI]: (
      <div style={{ padding: "20px", fontFamily: "monospace" }}>
        <h2>Superstition: Early Returns Prevent Dependency Tracking</h2>
        <p style={{ color: "#666", marginBottom: "20px" }}>
          CLAIM: Dependencies accessed after early returns are never tracked.
        </p>

        {/* State Display */}
        <div
          style={{
            padding: "15px",
            backgroundColor: "#e3f2fd",
            borderRadius: "8px",
            marginBottom: "20px",
          }}
        >
          <h3 style={{ margin: "0 0 10px 0" }}>Current State</h3>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: "20px",
            }}
          >
            <div>
              <strong>isReady:</strong>{" "}
              <span style={{ color: isReady ? "#2e7d32" : "#c62828" }}>
                {isReady ? "true" : "false"}
              </span>
            </div>
            <div>
              <strong>data:</strong>{" "}
              <span style={{ color: data.get() ? "#2e7d32" : "#9e9e9e" }}>
                {data.get() || "(undefined)"}
              </span>
            </div>
          </div>
        </div>

        {/* Controls */}
        <div
          style={{
            padding: "15px",
            backgroundColor: "#f5f5f5",
            borderRadius: "8px",
            marginBottom: "20px",
          }}
        >
          <h3 style={{ margin: "0 0 10px 0" }}>Controls</h3>
          <div style={{ display: "flex", gap: "10px", flexWrap: "wrap" }}>
            <ct-button onClick={setReady({ isReady })}>Set Ready</ct-button>
            <ct-button onClick={setNotReady({ isReady })}>
              Set Not Ready
            </ct-button>
            <ct-button onClick={setData({ data })}>Set Data</ct-button>
            <ct-button onClick={clearData({ data })}>Clear Data</ct-button>
            <ct-button onClick={resetAll({ isReady, data })}>
              Reset All
            </ct-button>
          </div>
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: "20px",
            marginBottom: "20px",
          }}
        >
          {/* BROKEN VERSION */}
          <div
            style={{
              padding: "15px",
              backgroundColor: "#ffebee",
              borderRadius: "8px",
              border: "2px solid #f44336",
            }}
          >
            <h3 style={{ color: "#c62828", margin: "0 0 10px 0" }}>
              BROKEN: Early Return Pattern
            </h3>
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
  if (!isReady) {
    return "loading"; // EARLY!
  }
  // data accessed AFTER early return
  if (data.get()) {
    return "has-data";
  }
  return "ready";
})`}
            </pre>
            <div
              style={{
                marginTop: "15px",
                padding: "10px",
                backgroundColor: "#fff",
                borderRadius: "4px",
              }}
            >
              <div style={{ fontSize: "20px", fontWeight: "bold" }}>
                Phase: {brokenPhase}
              </div>
            </div>
          </div>

          {/* FIXED VERSION */}
          <div
            style={{
              padding: "15px",
              backgroundColor: "#e8f5e9",
              borderRadius: "8px",
              border: "2px solid #4caf50",
            }}
          >
            <h3 style={{ color: "#2e7d32", margin: "0 0 10px 0" }}>
              FIXED: Access Deps First
            </h3>
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
  // Access ALL deps FIRST
  const d = data.get();
  const ready = isReady;

  if (!ready) return "loading";
  if (d) return "has-data";
  return "ready";
})`}
            </pre>
            <div
              style={{
                marginTop: "15px",
                padding: "10px",
                backgroundColor: "#fff",
                borderRadius: "4px",
              }}
            >
              <div style={{ fontSize: "20px", fontWeight: "bold" }}>
                Phase: {fixedPhase}
              </div>
            </div>
          </div>
        </div>

        {/* Instructions */}
        <div
          style={{
            padding: "15px",
            backgroundColor: "#fff3e0",
            borderRadius: "8px",
          }}
        >
          <h3 style={{ margin: "0 0 10px 0" }}>Test Procedure</h3>
          <ol style={{ margin: "0", paddingLeft: "20px" }}>
            <li>Click "Reset All" to start fresh</li>
            <li>Both should show "loading"</li>
            <li>Click "Set Ready" - both should show "ready"</li>
            <li>Click "Set Data" - observe the difference:</li>
          </ol>
          <div
            style={{
              marginTop: "10px",
              padding: "10px",
              backgroundColor: "#fffde7",
              borderRadius: "4px",
            }}
          >
            <strong>Expected Result:</strong>
            <ul style={{ margin: "5px 0 0 0", paddingLeft: "20px" }}>
              <li>
                If BROKEN stays "ready" while FIXED shows "has-data",
                superstition is TRUE
              </li>
              <li>If both show "has-data", framework may have improved</li>
            </ul>
          </div>
        </div>
      </div>
    ),
    isReady,
    data,
    brokenPhase,
    fixedPhase,
  };
});
