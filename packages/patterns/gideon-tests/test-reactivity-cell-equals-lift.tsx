/// <cts-enable />
/**
 * TEST PATTERN: Cell.equals() Inside lift() Creates Undeclared Subscriptions
 *
 * CLAIM: Cell.equals() inside lift() creates undeclared subscriptions
 * that can cause infinite loops
 * SOURCE: superstitions/2026-01-05-cell-equals-in-lift-creates-subscriptions.md
 *
 * WHAT THIS TESTS:
 * - Using Cell.equals() vs === inside lift() for comparing cell references
 * - Cell.equals() internally reads cell values, creating hidden subscriptions
 * - This can cause re-evaluation loops when those hidden deps change
 *
 * EXPECTED BEHAVIOR:
 * - === version: Stable, predictable re-evaluations
 * - Cell.equals() version: May show more re-evaluations or loop behavior
 *
 * WARNING: This test is designed to demonstrate the issue WITHOUT causing
 * an actual infinite loop. In real code with cyclic dependencies,
 * Cell.equals() inside lift() can cause 100% CPU.
 *
 * MANUAL VERIFICATION STEPS:
 * 1. Load the pattern
 * 2. Click "Update Items" several times
 * 3. Observe evaluation counts - Cell.equals version may be higher
 * 4. The === version should have predictable, lower counts
 */
import {
  Cell,
  computed,
  Default,
  handler,
  lift,
  NAME,
  pattern,
  UI,
} from "commontools";

interface TestInput {
  items: Default<{ id: string; value: number }[], [{ id: "a"; value: 1 }]>;
}

// Global counters
let equalsEvalCount = 0;
let referenceEvalCount = 0;

const updateItems = handler<
  unknown,
  { items: Cell<{ id: string; value: number }[]> }
>(
  (_event, { items }) => {
    const current = items.get() || [];
    // Update values but keep same structure
    items.set(
      current.map((item) => ({
        ...item,
        value: item.value + 1,
      })),
    );
  },
);

const addItem = handler<
  unknown,
  { items: Cell<{ id: string; value: number }[]> }
>(
  (_event, { items }) => {
    const current = items.get() || [];
    const newId = String.fromCharCode(97 + current.length); // a, b, c...
    items.set([...current, { id: newId, value: 1 }]);
  },
);

const resetCounters = handler<unknown, { counterDisplay: Cell<number> }>(
  (_event, { counterDisplay }) => {
    equalsEvalCount = 0;
    referenceEvalCount = 0;
    counterDisplay.set(Date.now());
  },
);

export default pattern<TestInput>(({ items }) => {
  const counterDisplay = Cell.of(0);

  // A reference cell to compare against - initialized via computed
  const targetItem = computed(() => {
    const itemList = items;
    if (itemList && itemList.length > 0) {
      return itemList[0];
    }
    return null;
  });

  // VERSION 1: Using Cell.equals() inside lift (POTENTIALLY PROBLEMATIC)
  // Cell.equals() internally reads cell values, creating hidden subscriptions
  const equalsVersion = lift(({ itemList, target }) => {
    equalsEvalCount++;
    if (!itemList || !target) return null;

    for (const item of itemList) {
      // This COULD create hidden subscriptions if Cell.equals reads deeply
      // In this simple case it might be fine, but with nested cells it's dangerous
      try {
        if (Cell.equals(item, target)) {
          return `Found via Cell.equals: ${item.id}=${item.value}`;
        }
      } catch {
        return "Cell.equals threw error";
      }
    }
    return "Not found via Cell.equals";
  })({ itemList: items, target: targetItem });

  // VERSION 2: Using === reference equality (SAFE)
  // Only compares object references, no hidden subscriptions
  const referenceVersion = lift(({ itemList, target }) => {
    referenceEvalCount++;
    if (!itemList || !target) return null;

    for (const item of itemList) {
      // === compares references only, no side effects
      if (item === target) {
        return `Found via ===: ${item.id}=${item.value}`;
      }
      // Or compare by id for semantic equality
      if (item.id === target.id) {
        return `Found by id: ${item.id}=${item.value}`;
      }
    }
    return "Not found via ===";
  })({ itemList: items, target: targetItem });

  // Counter displays
  const equalsDisplay = computed(() => {
    counterDisplay;
    return equalsEvalCount;
  });

  const referenceDisplay = computed(() => {
    counterDisplay;
    return referenceEvalCount;
  });

  return {
    [NAME]: "Test: Cell.equals() in lift()",
    [UI]: (
      <div style={{ padding: "20px", fontFamily: "monospace" }}>
        <h2>Superstition: Cell.equals() in lift() Creates Subscriptions</h2>
        <p style={{ color: "#666", marginBottom: "20px" }}>
          CLAIM: Cell.equals() inside lift() creates hidden reactive
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
          <h3 style={{ margin: "0 0 10px 0" }}>Current Items</h3>
          <div
            style={{
              padding: "10px",
              backgroundColor: "#fff",
              borderRadius: "4px",
              marginBottom: "10px",
            }}
          >
            {(items || []).map((
              item: { id: string; value: number },
              idx: number,
            ) => (
              <span
                key={idx}
                style={{
                  display: "inline-block",
                  padding: "4px 8px",
                  margin: "2px",
                  backgroundColor: "#e3f2fd",
                  borderRadius: "4px",
                }}
              >
                {item.id}={item.value}
              </span>
            ))}
          </div>
          <div style={{ display: "flex", gap: "10px", flexWrap: "wrap" }}>
            <ct-button onClick={updateItems({ items })}>Update Items</ct-button>
            <ct-button onClick={addItem({ items })}>Add Item</ct-button>
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
          {/* Cell.equals VERSION */}
          <div
            style={{
              padding: "15px",
              backgroundColor: "#ffebee",
              borderRadius: "8px",
              border: "2px solid #f44336",
            }}
          >
            <h3 style={{ color: "#c62828", margin: "0 0 10px 0" }}>
              RISKY: Cell.equals() in lift
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
              {`lift(({ items, target }) => {
  for (const item of items) {
    if (Cell.equals(item, target)) {
      return item; // Hidden subscription!
    }
  }
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
              <div style={{ marginBottom: "5px" }}>
                Result: <strong>{equalsVersion}</strong>
              </div>
              <div style={{ color: "#c62828", fontWeight: "bold" }}>
                Evaluations: {equalsDisplay}
              </div>
            </div>
          </div>

          {/* === VERSION */}
          <div
            style={{
              padding: "15px",
              backgroundColor: "#e8f5e9",
              borderRadius: "8px",
              border: "2px solid #4caf50",
            }}
          >
            <h3 style={{ color: "#2e7d32", margin: "0 0 10px 0" }}>
              SAFE: === in lift
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
              {`lift(({ items, target }) => {
  for (const item of items) {
    if (item === target) {
      return item; // No hidden deps
    }
  }
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
              <div style={{ marginBottom: "5px" }}>
                Result: <strong>{referenceVersion}</strong>
              </div>
              <div style={{ color: "#2e7d32", fontWeight: "bold" }}>
                Evaluations: {referenceDisplay}
              </div>
            </div>
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
                If Cell.equals version has more evaluations, superstition is
                TRUE
              </li>
              <li>
                In severe cases (nested cells, cycles), Cell.equals can cause
                infinite loops
              </li>
              <li>
                The === version should have predictable evaluation counts
              </li>
            </ul>
          </div>
          <p style={{ marginTop: "10px", fontSize: "12px", color: "#666" }}>
            Note: This simplified test may not show the full severity. Real
            infinite loops occur when Cell.equals reads nested cells that form a
            cycle with the lift's output.
          </p>
        </div>
      </div>
    ),
    items,
    targetItem,
  };
});
