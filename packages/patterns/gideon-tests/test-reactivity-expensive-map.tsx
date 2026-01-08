/// <cts-enable />
/**
 * TEST PATTERN: Expensive Computation Inside .map() JSX Causes N^2 CPU Spikes
 *
 * CLAIM: Expensive computation inline in .map() JSX causes N^2 CPU spikes
 * because closures are evaluated for every mapped item
 * SOURCE: superstitions/2025-12-16-expensive-computation-inside-map-jsx.md
 *
 * HOW TO TEST:
 * 1. Open browser devtools console
 * 2. Load this pattern
 * 3. Watch console for "INLINE:" and "PRECOMPUTED:" messages
 * 4. Click "Add Item" or "Trigger Update"
 * 5. Count how many times each type appears per action
 *
 * EXPECTED BEHAVIOR:
 * - "INLINE:" should appear N times per update (once per item)
 * - "PRECOMPUTED:" should appear 1 time per update
 *
 * If both appear the same number of times, the superstition is FALSE.
 * If INLINE appears N times more, the superstition is TRUE.
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
  items: Default<string[], ["A", "B", "C", "D", "E"]>;
}

// Simulated "expensive" function that logs when called
function expensiveInline(item: string): string {
  console.log("INLINE: processing", item);
  return String(item).toUpperCase() + "!";
}

function expensivePrecomputed(item: string): string {
  console.log("PRECOMPUTED: processing", item);
  return String(item).toUpperCase() + "!";
}

const addItem = handler<unknown, { items: Cell<string[]> }>(
  (_event, { items }) => {
    const current = items.get() || [];
    const newItem = String.fromCharCode(65 + current.length); // A, B, C...
    console.log("--- ADD ITEM ---");
    items.set([...current, newItem]);
  },
);

const triggerUpdate = handler<unknown, { items: Cell<string[]> }>(
  (_event, { items }) => {
    // Force a reactive update by setting the same items (with new array reference)
    const current = items.get() || [];
    console.log("--- TRIGGER UPDATE ---");
    items.set([...current]);
  },
);

export default pattern<TestInput>(({ items }) => {
  // PRE-COMPUTED: Process items once in a computed() outside the map
  const precomputedResults = computed(() => {
    console.log("precomputedResults computed() running...");
    return items.map((item) => {
      // This function call happens once per item during precomputation
      return expensivePrecomputed(String(item));
    });
  });

  const itemCount = computed(() => items.length);

  return {
    [NAME]: "Test: Expensive Map Computation",
    [UI]: (
      <div style={{ padding: "20px", fontFamily: "monospace" }}>
        <h2>Superstition: Expensive Computation in .map() JSX</h2>
        <p style={{ color: "#666", marginBottom: "20px" }}>
          <strong>Open browser devtools console</strong> to see call counts.
          <br />
          CLAIM: Inline computation in .map() runs N times per update.
        </p>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: "20px",
            marginBottom: "20px",
          }}
        >
          {/* INLINE VERSION - BAD PATTERN */}
          <div
            style={{
              padding: "15px",
              backgroundColor: "#ffebee",
              borderRadius: "8px",
              border: "2px solid #f44336",
            }}
          >
            <h3 style={{ color: "#c62828", margin: "0 0 10px 0" }}>
              BAD: Inline in .map()
            </h3>
            <div
              style={{
                padding: "10px",
                backgroundColor: "#fff",
                borderRadius: "4px",
              }}
            >
              {items.map((item, idx: number) => (
                <div key={idx} style={{ padding: "2px 0" }}>
                  {computed(() => expensiveInline(String(item)))}
                </div>
              ))}
            </div>
            <p style={{ fontSize: "12px", color: "#666", marginTop: "10px" }}>
              Watch console for "INLINE:" messages
            </p>
          </div>

          {/* PRE-COMPUTED VERSION - GOOD PATTERN */}
          <div
            style={{
              padding: "15px",
              backgroundColor: "#e8f5e9",
              borderRadius: "8px",
              border: "2px solid #4caf50",
            }}
          >
            <h3 style={{ color: "#2e7d32", margin: "0 0 10px 0" }}>
              GOOD: Pre-computed()
            </h3>
            <div
              style={{
                padding: "10px",
                backgroundColor: "#fff",
                borderRadius: "4px",
              }}
            >
              {precomputedResults.map((result: string, idx: number) => (
                <div key={idx} style={{ padding: "2px 0" }}>
                  {result}
                </div>
              ))}
            </div>
            <p style={{ fontSize: "12px", color: "#666", marginTop: "10px" }}>
              Watch console for "PRECOMPUTED:" messages
            </p>
          </div>
        </div>

        {/* CONTROLS */}
        <div
          style={{
            padding: "15px",
            backgroundColor: "#e3f2fd",
            borderRadius: "8px",
            marginBottom: "20px",
          }}
        >
          <h3 style={{ margin: "0 0 10px 0" }}>Controls</h3>
          <div style={{ display: "flex", gap: "10px", flexWrap: "wrap" }}>
            <ct-button onClick={addItem({ items })}>Add Item</ct-button>
            <ct-button onClick={triggerUpdate({ items })}>
              Trigger Update
            </ct-button>
          </div>
          <p style={{ marginTop: "10px", color: "#666" }}>
            Current items: {itemCount}
          </p>
        </div>

        {/* INSTRUCTIONS */}
        <div
          style={{
            padding: "15px",
            backgroundColor: "#fff3e0",
            borderRadius: "8px",
          }}
        >
          <h3 style={{ margin: "0 0 10px 0" }}>How to Verify</h3>
          <ol style={{ margin: "0", paddingLeft: "20px" }}>
            <li>Open browser devtools console (F12 or Cmd+Option+I)</li>
            <li>Clear the console</li>
            <li>Click "Trigger Update" button</li>
            <li>Count "INLINE:" vs "PRECOMPUTED:" messages</li>
          </ol>
          <div style={{ marginTop: "15px", padding: "10px", backgroundColor: "#fffde7", borderRadius: "4px" }}>
            <strong>Expected Result:</strong>
            <ul style={{ margin: "5px 0 0 0", paddingLeft: "20px" }}>
              <li>If INLINE appears ~N times more than PRECOMPUTED → superstition TRUE</li>
              <li>If both appear same number of times → superstition FALSE</li>
            </ul>
          </div>
        </div>
      </div>
    ),
    items,
    precomputedResults,
  };
});
