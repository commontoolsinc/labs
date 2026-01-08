/// <cts-enable />
/**
 * TEST PATTERN: Nested computed() in ifElse Causes Thrashing
 *
 * CLAIM: Multiple nested computed() in ifElse creates cascading subscriptions
 * causing UI thrashing
 * SOURCE: superstitions/2025-12-17-nested-computed-in-ifelse-causes-thrashing.md
 *
 * WHAT THIS TESTS:
 * - Nested ifElse with computed() conditions creates multiple subscriptions
 * - A single derive() returning JSX creates one subscription
 * - Update counters show how many times each approach re-evaluates
 *
 * EXPECTED BEHAVIOR:
 * - Nested computed: Multiple re-evaluations per state change
 * - Single derive: One re-evaluation per state change
 * - Under high-frequency updates, nested version may thrash
 *
 * MANUAL VERIFICATION STEPS:
 * 1. Load the pattern
 * 2. Click "Cycle State" multiple times
 * 3. Observe update counts - nested should be higher
 * 4. Click "Rapid Fire" to trigger many quick updates
 * 5. Compare final counts - nested should show more evaluations
 */
import {
  Cell,
  computed,
  Default,
  derive,
  handler,
  ifElse,
  NAME,
  pattern,
  UI,
} from "commontools";

interface TestInput {
  state: Default<string, "loading">;
}

// Global counters
let nestedComputedCount = 0;
let nestedInnerCount = 0;
let singleDeriveCount = 0;

const cycleState = handler<unknown, { state: Cell<string> }>(
  (_event, { state }) => {
    const current = state.get();
    const states = ["loading", "not-found", "found-not-auth", "authenticated"];
    const currentIndex = states.indexOf(current);
    const nextIndex = (currentIndex + 1) % states.length;
    state.set(states[nextIndex]);
  },
);

const rapidFire = handler<unknown, { state: Cell<string> }>(
  (_event, { state }) => {
    const states = ["loading", "not-found", "found-not-auth", "authenticated"];
    // Rapidly cycle through states
    for (let i = 0; i < 10; i++) {
      setTimeout(() => {
        state.set(states[i % states.length]);
      }, i * 50);
    }
  },
);

const resetCounters = handler<unknown, { counterDisplay: Cell<number> }>(
  (_event, { counterDisplay }) => {
    nestedComputedCount = 0;
    nestedInnerCount = 0;
    singleDeriveCount = 0;
    counterDisplay.set(Date.now());
  },
);

export default pattern<TestInput>(({ state }) => {
  const counterDisplay = Cell.of(0);

  // Counter displays
  const nestedOuterDisplay = computed(() => {
    counterDisplay;
    return nestedComputedCount;
  });

  const nestedInnerDisplay = computed(() => {
    counterDisplay;
    return nestedInnerCount;
  });

  const singleDisplay = computed(() => {
    counterDisplay;
    return singleDeriveCount;
  });

  // NESTED COMPUTED VERSION - potentially problematic
  // Each computed() creates its own subscription to `state`
  const nestedVersion = ifElse(
    computed(() => {
      nestedComputedCount++;
      const s = state;
      return s === "not-found" || s === "found-not-auth";
    }),
    <div
      style={{
        padding: "10px",
        backgroundColor: "#fff",
        borderRadius: "4px",
      }}
    >
      {ifElse(
        computed(() => {
          nestedInnerCount++;
          return state === "not-found";
        }),
        <div>
          <strong>State: NOT FOUND</strong>
          <p>No auth charm found. Create one?</p>
        </div>,
        <div>
          <strong>State: FOUND BUT NOT AUTH</strong>
          <p>Found auth but not signed in.</p>
        </div>,
      )}
    </div>,
    ifElse(
      computed(() => state === "loading"),
      <div>
        <strong>State: LOADING</strong>
      </div>,
      <div>
        <strong>State: AUTHENTICATED</strong>
      </div>,
    ),
  );

  // SINGLE DERIVE VERSION - recommended pattern
  // One subscription, all conditional logic inside
  const singleVersion = derive({ s: state }, ({ s }) => {
    singleDeriveCount++;

    if (s === "not-found") {
      return (
        <div
          style={{
            padding: "10px",
            backgroundColor: "#fff",
            borderRadius: "4px",
          }}
        >
          <strong>State: NOT FOUND</strong>
          <p>No auth charm found. Create one?</p>
        </div>
      );
    }

    if (s === "found-not-auth") {
      return (
        <div
          style={{
            padding: "10px",
            backgroundColor: "#fff",
            borderRadius: "4px",
          }}
        >
          <strong>State: FOUND BUT NOT AUTH</strong>
          <p>Found auth but not signed in.</p>
        </div>
      );
    }

    if (s === "loading") {
      return (
        <div>
          <strong>State: LOADING</strong>
        </div>
      );
    }

    return (
      <div>
        <strong>State: AUTHENTICATED</strong>
      </div>
    );
  });

  return {
    [NAME]: "Test: Nested computed() in ifElse",
    [UI]: (
      <div style={{ padding: "20px", fontFamily: "monospace" }}>
        <h2>Superstition: Nested computed() in ifElse Causes Thrashing</h2>
        <p style={{ color: "#666", marginBottom: "20px" }}>
          CLAIM: Multiple nested computed() conditions create cascading
          subscriptions.
        </p>

        {/* Current State */}
        <div
          style={{
            padding: "15px",
            backgroundColor: "#e3f2fd",
            borderRadius: "8px",
            marginBottom: "20px",
          }}
        >
          <h3 style={{ margin: "0 0 10px 0" }}>Current State</h3>
          <div style={{ fontSize: "24px", fontWeight: "bold" }}>{state}</div>
          <div
            style={{
              display: "flex",
              gap: "10px",
              marginTop: "10px",
              flexWrap: "wrap",
            }}
          >
            <ct-button onClick={cycleState({ state })}>Cycle State</ct-button>
            <ct-button onClick={rapidFire({ state })}>
              Rapid Fire (10x)
            </ct-button>
            <ct-button onClick={resetCounters({ counterDisplay })}>
              Reset Counters
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
          {/* NESTED VERSION */}
          <div
            style={{
              padding: "15px",
              backgroundColor: "#ffebee",
              borderRadius: "8px",
              border: "2px solid #f44336",
            }}
          >
            <h3 style={{ color: "#c62828", margin: "0 0 10px 0" }}>
              BAD: Nested ifElse(computed())
            </h3>
            {nestedVersion}
            <div
              style={{
                marginTop: "15px",
                borderTop: "1px solid #ffcdd2",
                paddingTop: "10px",
              }}
            >
              <div>
                Outer computed() calls: <strong>{nestedOuterDisplay}</strong>
              </div>
              <div>
                Inner computed() calls: <strong>{nestedInnerDisplay}</strong>
              </div>
              <div style={{ color: "#c62828", fontWeight: "bold" }}>
                Total: {computed(() => nestedComputedCount + nestedInnerCount)}
              </div>
            </div>
          </div>

          {/* SINGLE DERIVE VERSION */}
          <div
            style={{
              padding: "15px",
              backgroundColor: "#e8f5e9",
              borderRadius: "8px",
              border: "2px solid #4caf50",
            }}
          >
            <h3 style={{ color: "#2e7d32", margin: "0 0 10px 0" }}>
              GOOD: Single derive()
            </h3>
            {singleVersion}
            <div
              style={{
                marginTop: "15px",
                borderTop: "1px solid #c8e6c9",
                paddingTop: "10px",
              }}
            >
              <div>
                derive() calls: <strong>{singleDisplay}</strong>
              </div>
              <div style={{ color: "#2e7d32", fontWeight: "bold" }}>
                Total: {singleDisplay}
              </div>
            </div>
          </div>
        </div>

        {/* ANALYSIS */}
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
              <li>If nested total {">"} single total, superstition is TRUE</li>
              <li>The ratio shows the subscription cascade effect</li>
              <li>
                Under rapid updates, nested may show significantly more calls
              </li>
            </ul>
          </div>
          <p style={{ marginTop: "10px", fontSize: "12px", color: "#666" }}>
            Note: Both approaches are semantically equivalent - they show the
            same UI. The difference is in reactive efficiency.
          </p>
        </div>
      </div>
    ),
    state,
  };
});
