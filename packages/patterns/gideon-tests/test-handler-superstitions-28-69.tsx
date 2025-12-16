/// <cts-enable />
/**
 * TEST PATTERN: Handler Superstitions #28 and #69
 *
 * #28: Handler data-* attributes unreliable
 *   Claim: event.target.dataset.xxx returns undefined in handlers
 *   Expected: FAIL (dataset not accessible), use handler context instead
 *
 * #69: Handler with computed state causes CPU loop
 *   Claim: Passing computed to handler that writes to cells the computed depends on
 *          causes infinite re-evaluation and 100% CPU
 *   Expected: CPU spike if bug exists, works fine if fixed pattern used
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

interface Input {
  counter: Default<number, 0>;
  overrides: Default<Record<number, boolean>, {}>;
  items: Default<string[], ["Apple", "Banana", "Cherry"]>;
}

export default pattern<Input>(({ counter, overrides, items }) => {
  // ============================================================
  // TEST #28: data-* attributes in handlers
  // ============================================================

  // Handler that tries to read data-* attribute from event
  const handleDataAttrClick = handler<
    { target?: { dataset?: { testvalue?: string } } },
    { counter: Cell<number> }
  >((event, { counter }) => {
    const dataValue = event?.target?.dataset?.testvalue;
    console.log("[#28] event.target.dataset.testvalue =", dataValue);

    if (dataValue !== undefined) {
      console.log("[#28] SUCCESS: data-* attribute IS accessible!");
      counter.set(counter.get() + 1);
    } else {
      console.log("[#28] CONFIRMED: data-* attribute is undefined (superstition is TRUE)");
      // Still increment to show handler fired
      counter.set(counter.get() + 100);
    }
  });

  // Handler that uses context instead (the recommended pattern)
  const handleContextClick = handler<
    unknown,
    { counter: Cell<number>; testValue: string }
  >((_, { counter, testValue }) => {
    console.log("[#28] Handler context testValue =", testValue);
    console.log("[#28] SUCCESS: Context-based approach works!");
    counter.set(counter.get() + 1);
  });

  // ============================================================
  // TEST #69: computed passed to handler circular dependency
  // ============================================================

  // Computed that depends on overrides
  const computedItems = computed(() => {
    const currentOverrides = overrides;
    return items.map((item, idx) => ({
      name: item,
      selected: idx in currentOverrides ? currentOverrides[idx] : false,
    }));
  });

  // ❌ DANGEROUS: Handler that receives computed and writes to its dependency
  // This SHOULD cause CPU loop according to superstition #69
  const toggleDangerous = handler<
    unknown,
    { overrides: Cell<Record<number, boolean>>; list: unknown; idx: number }
  >((_, { overrides, list, idx }) => {
    console.log("[#69-DANGEROUS] Handler called with idx:", idx);
    const typedList = list as { name: string; selected: boolean }[];
    const currentSelected = typedList[idx]?.selected ?? false;
    const current = overrides.get();
    overrides.set({ ...current, [idx]: !currentSelected });
    console.log("[#69-DANGEROUS] Set overrides, new value:", !currentSelected);
  });

  // ✅ SAFE: Handler that receives primitive values at render time
  const toggleSafe = handler<
    unknown,
    { overrides: Cell<Record<number, boolean>>; idx: number; currentlySelected: boolean }
  >((_, { overrides, idx, currentlySelected }) => {
    console.log("[#69-SAFE] Handler called with idx:", idx, "currentlySelected:", currentlySelected);
    const current = overrides.get();
    overrides.set({ ...current, [idx]: !currentlySelected });
    console.log("[#69-SAFE] Set overrides, new value:", !currentlySelected);
  });

  return {
    [NAME]: "TEST: Handler Superstitions #28, #69",
    [UI]: (
      <div style={{ padding: "1rem", maxWidth: "600px" }}>
        <h2>Handler Superstitions Test</h2>
        <p style={{ color: "#666", fontSize: "0.9rem" }}>
          Check browser console for detailed logs
        </p>

        {/* ========== TEST #28: data-* attributes ========== */}
        <div style={{ border: "2px solid blue", padding: "1rem", marginBottom: "1rem", borderRadius: "8px" }}>
          <h3 style={{ color: "blue" }}>#28: data-* Attributes in Handlers</h3>
          <p style={{ fontSize: "0.8rem", color: "#666" }}>
            Claim: event.target.dataset is undefined in handlers
          </p>

          <div style={{ marginBottom: "0.5rem" }}>
            <strong>Counter: {counter}</strong>
            <span style={{ fontSize: "0.8rem", color: "#666", marginLeft: "1rem" }}>
              (+1 = data attr worked, +100 = data attr undefined)
            </span>
          </div>

          <div style={{ marginBottom: "0.5rem" }}>
            <ct-button
              onClick={handleDataAttrClick({ counter })}
              data-testvalue="hello123"
            >
              Test data-testvalue="hello123"
            </ct-button>
          </div>

          <div style={{ marginBottom: "0.5rem" }}>
            <ct-button onClick={handleContextClick({ counter, testValue: "hello123" })}>
              Test via context (recommended)
            </ct-button>
          </div>
        </div>

        {/* ========== TEST #69: computed circular dependency ========== */}
        <div style={{ border: "2px solid orange", padding: "1rem", marginBottom: "1rem", borderRadius: "8px" }}>
          <h3 style={{ color: "orange" }}>#69: Computed → Handler Circular Dependency</h3>
          <p style={{ fontSize: "0.8rem", color: "#666" }}>
            Claim: Passing computed to handler that writes to its dependencies causes CPU loop
          </p>

          <div style={{ marginBottom: "1rem" }}>
            <strong>⚠️ DANGEROUS Pattern (may cause CPU spike):</strong>
            <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.5rem" }}>
              {computedItems.map((item, idx) => (
                <ct-button
                  onClick={toggleDangerous({
                    overrides,
                    list: computedItems, // ❌ Passing computed
                    idx,
                  })}
                  style={`background: ${item.selected ? "#ffc107" : "#e0e0e0"};`}
                >
                  {item.name} {item.selected ? "✓" : ""}
                </ct-button>
              ))}
            </div>
          </div>

          <div style={{ marginBottom: "1rem" }}>
            <strong>✅ SAFE Pattern (pass values at render time):</strong>
            <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.5rem" }}>
              {computedItems.map((item, idx) => (
                <ct-button
                  onClick={toggleSafe({
                    overrides,
                    idx,
                    currentlySelected: item.selected, // ✅ Passing value
                  })}
                  style={`background: ${item.selected ? "#4caf50" : "#e0e0e0"};`}
                >
                  {item.name} {item.selected ? "✓" : ""}
                </ct-button>
              ))}
            </div>
          </div>

          <div style={{ fontSize: "0.8rem", color: "#666" }}>
            Current overrides: {JSON.stringify(overrides)}
          </div>
        </div>

        {/* ========== EXPECTED RESULTS ========== */}
        <div style={{ border: "2px solid #333", padding: "1rem", borderRadius: "8px", background: "#f9f9f9" }}>
          <h3>Expected Results</h3>
          <pre style={{ fontSize: "0.75rem", background: "#fff", padding: "0.5rem" }}>
{`#28 (data-* attributes):
  - First button: counter +100 (dataset undefined) → SUPERSTITION TRUE
  - Second button: counter +1 → Context approach works

#69 (computed circular dependency):
  - DANGEROUS buttons: May cause CPU spike / lag
  - SAFE buttons: Should work smoothly`}
          </pre>
        </div>
      </div>
    ),
    counter,
    overrides,
  };
});
