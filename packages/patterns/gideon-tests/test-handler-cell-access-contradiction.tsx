/// <cts-enable />
/**
 * TEST PATTERN: Handler Cell Access - Contradiction Cluster Resolution
 *
 * PURPOSE: Resolve conflicting claims about Cell closure access in handlers
 *
 * ============================================================================
 * VERIFIED RESULTS (2025-12-16)
 * ============================================================================
 *
 * | Context      | Inline Closures | Handler Params |
 * |--------------|-----------------|----------------|
 * | Top-level    | ✅ WORKS        | ✅ WORKS       |
 * | .map()       | ✅ WORKS        | ✅ WORKS       |
 * | ifElse()     | ❌ FAILS        | ✅ WORKS       |
 * | ternary      | ❌ FAILS        | ✅ WORKS       |
 * | computed()   | ✅ WORKS        | ✅ WORKS       |
 *
 * ROOT CAUSE:
 * The ts-transformers package has closure extraction strategies for:
 * - .map() → MapStrategy
 * - computed() → handled by CTS transformer
 * - handler() → HandlerStrategy
 *
 * But NO strategy exists for conditional branches (ifElse or ternary).
 * This is UNIMPLEMENTED functionality, not a bug.
 * Inside conditional branches, cells become opaque proxies that can't be accessed via closure.
 *
 * THE RULE:
 * Inside conditional branches (ifElse or ternary), always use handler() with explicit cell params.
 * In all other contexts (top-level, .map(), computed()), inline closures work fine.
 *
 * SUPERSTITION VERDICTS:
 * - #4 (pass cells as handler params): PARTIALLY_TRUE - only matters in ifElse
 * - #52 (handlers can't access cells via closure): WRONG - closures work in most contexts
 * - #68 (handler args unwrapped in ifElse): WRONG - had it backwards; closures fail, handler params work
 *
 * ============================================================================
 */
import {
  Cell,
  computed,
  Default,
  handler,
  ifElse,
  NAME,
  pattern,
  UI,
} from "commontools";

interface Input {
  inputCounter: Default<number, 0>;  // Default<> provides initial value + .get()/.set() methods
  items: Default<string[], ["Item A", "Item B", "Item C"]>;
  showButtons: Default<boolean, true>;
}

// Define handlers outside pattern for clarity
// Handler that takes cell as state parameter (with string label)
const handlerWithCellParam = handler<
  unknown,
  { targetCell: Cell<number>; label: string }
>((_, { targetCell, label }) => {
  try {
    const current = targetCell.get();
    targetCell.set(current + 1);
    console.log(`[${label}] SUCCESS: handler with cell param, value now: ${current + 1}`);
  } catch (e) {
    console.error(`[${label}] FAILED: handler with cell param`, e);
  }
});

// Handler that takes index directly (for use inside .map())
// This works because we pass index directly, then format inside the handler
const handlerWithIndexParam = handler<
  unknown,
  { targetCell: Cell<number>; prefix: string; index: number }
>((_, { targetCell, prefix, index }) => {
  const label = `${prefix}-${index}`;
  try {
    const current = targetCell.get();
    targetCell.set(current + 1);
    console.log(`[${label}] SUCCESS: handler with index param, value now: ${current + 1}`);
  } catch (e) {
    console.error(`[${label}] FAILED: handler with index param`, e);
  }
});

export default pattern<Input>(({ inputCounter, items, showButtons }) => {
  // Local cell created with Cell.of()
  const localCounter = Cell.of<number>(0);

  // Plain function that captures cells via closure (for ifElse workaround test)
  const plainFunctionWithClosure = (label: string) => {
    try {
      const inputVal = inputCounter.get();
      inputCounter.set(inputVal + 1);
      console.log(`[${label}] SUCCESS: plain function closure (input), value now: ${inputVal + 1}`);
    } catch (e) {
      console.error(`[${label}] FAILED: plain function closure (input)`, e);
    }
    try {
      const localVal = localCounter.get();
      localCounter.set(localVal + 1);
      console.log(`[${label}] SUCCESS: plain function closure (local), value now: ${localVal + 1}`);
    } catch (e) {
      console.error(`[${label}] FAILED: plain function closure (local)`, e);
    }
  };

  // Results display - inside computed(), values are already unwrapped (no .get() needed)
  const resultsUI = computed(() => {
    return (
      <div style={{ background: "#f0f0f0", padding: "1rem", marginBottom: "1rem", borderRadius: "8px" }}>
        <strong>Current Values:</strong>
        <div>Input Counter: {inputCounter}</div>
        <div>Local Counter: {localCounter}</div>
        <div style={{ fontSize: "0.8rem", color: "#666" }}>
          Check browser console for detailed success/failure logs
        </div>
      </div>
    );
  });

  return {
    [NAME]: "TEST: Handler Cell Access Contradiction",
    [UI]: (
      <div style={{ padding: "1rem", maxWidth: "800px" }}>
        <h2>Handler Cell Access Test</h2>
        <p style={{ color: "#666" }}>
          Testing which combinations of handler styles and reactive contexts work.
          Check browser console for detailed logs.
        </p>

        {resultsUI}

        {/* ========== SECTION A: TOP-LEVEL (CONTROL) ========== */}
        {/* VERIFIED: All tests PASS - both inline closures and handler params work */}
        <div style={{ border: "2px solid blue", padding: "1rem", marginBottom: "1rem", borderRadius: "8px" }}>
          <h3 style={{ color: "blue" }}>A. Top-Level (Control - No Reactive Context) ✅</h3>

          <div style={{ marginBottom: "0.5rem" }}>
            <strong>A1. Inline arrow with closure (input cell):</strong>
            <ct-button
              onClick={() => {
                try {
                  const val = inputCounter.get();
                  inputCounter.set(val + 1);
                  console.log("[A1] SUCCESS: inline closure (input), value now:", val + 1);
                } catch (e) {
                  console.error("[A1] FAILED: inline closure (input)", e);
                }
              }}
            >
              Test A1
            </ct-button>
          </div>

          <div style={{ marginBottom: "0.5rem" }}>
            <strong>A2. Inline arrow with closure (local cell):</strong>
            <ct-button
              onClick={() => {
                try {
                  const val = localCounter.get();
                  localCounter.set(val + 1);
                  console.log("[A2] SUCCESS: inline closure (local), value now:", val + 1);
                } catch (e) {
                  console.error("[A2] FAILED: inline closure (local)", e);
                }
              }}
            >
              Test A2
            </ct-button>
          </div>

          <div style={{ marginBottom: "0.5rem" }}>
            <strong>A3. Handler with cell param (input):</strong>
            <ct-button onClick={handlerWithCellParam({ targetCell: inputCounter, label: "A3-input" })}>
              Test A3
            </ct-button>
          </div>

          <div style={{ marginBottom: "0.5rem" }}>
            <strong>A4. Handler with cell param (local):</strong>
            <ct-button onClick={handlerWithCellParam({ targetCell: localCounter, label: "A4-local" })}>
              Test A4
            </ct-button>
          </div>
        </div>

        {/* ========== SECTION B: INSIDE .map() ========== */}
        {/* VERIFIED: All tests PASS - MapStrategy extracts closures automatically */}
        <div style={{ border: "2px solid green", padding: "1rem", marginBottom: "1rem", borderRadius: "8px" }}>
          <h3 style={{ color: "green" }}>B. Inside .map() Context ✅</h3>
          <p style={{ fontSize: "0.8rem", color: "#666" }}>
            Key insight: `index` is an opaque proxy. You can pass it directly but NOT operate on it
            (no string concat, no arithmetic). Use computed() or pass index to handler and format inside.
            MapStrategy handles closure extraction automatically.
          </p>

          {items.map((item, index) => (
            <div style={{ marginBottom: "0.5rem", paddingLeft: "1rem", borderLeft: "2px solid #ccc" }}>
              <div><strong>{item} (index: {index})</strong></div>

              <span style={{ marginRight: "0.5rem" }}>
                B1. Inline closure (input):
                <ct-button
                  onClick={() => inputCounter.set(inputCounter.get() + 1)}
                >
                  B1
                </ct-button>
              </span>

              <span style={{ marginRight: "0.5rem" }}>
                B2. Inline closure (local):
                <ct-button
                  onClick={() => localCounter.set(localCounter.get() + 1)}
                >
                  B2
                </ct-button>
              </span>

              <span style={{ marginRight: "0.5rem" }}>
                B3. Handler with index param (input):
                <ct-button onClick={handlerWithIndexParam({ targetCell: inputCounter, prefix: "B3-input", index })}>
                  B3
                </ct-button>
              </span>

              <span>
                B4. Handler with index param (local):
                <ct-button onClick={handlerWithIndexParam({ targetCell: localCounter, prefix: "B4-local", index })}>
                  B4
                </ct-button>
              </span>
            </div>
          ))}
        </div>

        {/* ========== SECTION C: INSIDE ifElse() ========== */}
        {/* VERIFIED: Inline closures FAIL, handler params WORK */}
        {/* ROOT CAUSE: No IfElseStrategy in ts-transformers - closure extraction unimplemented */}
        <div style={{ border: "2px solid orange", padding: "1rem", marginBottom: "1rem", borderRadius: "8px" }}>
          <h3 style={{ color: "orange" }}>C. Inside ifElse() Context ⚠️</h3>
          <p style={{ fontSize: "0.8rem", color: "#666" }}>
            <strong>VERIFIED:</strong> Inline closures (C1, C2, C5) FAIL with "opaque value" error.
            Handler params (C3, C4) WORK. This is because no IfElseStrategy exists in ts-transformers.
            Use handler() with explicit cell params inside ifElse branches.
          </p>

          <div style={{ marginBottom: "0.5rem" }}>
            <ct-checkbox $checked={showButtons}>Toggle ifElse visibility</ct-checkbox>
          </div>

          {ifElse(
            showButtons,
            <div style={{ background: "#fff3cd", padding: "0.5rem", borderRadius: "4px" }}>
              <div style={{ marginBottom: "0.5rem" }}>
                <strong>C1. Inline closure (input):</strong>
                <ct-button
                  onClick={() => {
                    try {
                      const val = inputCounter.get();
                      inputCounter.set(val + 1);
                      console.log("[C1] SUCCESS: inline in ifElse (input), value now:", val + 1);
                    } catch (e) {
                      console.error("[C1] FAILED: inline in ifElse (input)", e);
                    }
                  }}
                >
                  Test C1
                </ct-button>
              </div>

              <div style={{ marginBottom: "0.5rem" }}>
                <strong>C2. Inline closure (local):</strong>
                <ct-button
                  onClick={() => {
                    try {
                      const val = localCounter.get();
                      localCounter.set(val + 1);
                      console.log("[C2] SUCCESS: inline in ifElse (local), value now:", val + 1);
                    } catch (e) {
                      console.error("[C2] FAILED: inline in ifElse (local)", e);
                    }
                  }}
                >
                  Test C2
                </ct-button>
              </div>

              <div style={{ marginBottom: "0.5rem" }}>
                <strong>C3. Handler with cell param (input):</strong>
                <ct-button onClick={handlerWithCellParam({ targetCell: inputCounter, label: "C3-input" })}>
                  Test C3
                </ct-button>
              </div>

              <div style={{ marginBottom: "0.5rem" }}>
                <strong>C4. Handler with cell param (local):</strong>
                <ct-button onClick={handlerWithCellParam({ targetCell: localCounter, label: "C4-local" })}>
                  Test C4
                </ct-button>
              </div>

              <div style={{ marginBottom: "0.5rem" }}>
                <strong>C5. Plain function closure (superstition #68 workaround):</strong>
                <ct-button onClick={() => plainFunctionWithClosure("C5")}>
                  Test C5
                </ct-button>
              </div>
            </div>,
            <div style={{ background: "#f8d7da", padding: "0.5rem", borderRadius: "4px" }}>
              Buttons hidden by ifElse. Toggle checkbox to show.
            </div>
          )}

          {/* C6: Test ternary operator instead of ifElse - ALSO FAILS */}
          <div style={{ marginTop: "1rem", borderTop: "1px dashed orange", paddingTop: "0.5rem" }}>
            <strong>C6. Ternary operator (instead of ifElse):</strong>
            <p style={{ fontSize: "0.8rem", color: "#666" }}>
              <strong>VERIFIED:</strong> Ternary also fails - same "opaque value" error.
              The limitation is in the transformer, not the ifElse helper.
            </p>
            {showButtons ? (
              <ct-button
                onClick={() => {
                  try {
                    const val = inputCounter.get();
                    inputCounter.set(val + 1);
                    console.log("[C6] SUCCESS: ternary closure (input), value now:", val + 1);
                  } catch (e) {
                    console.error("[C6] FAILED: ternary closure (input)", e);
                  }
                }}
              >
                Test C6 (ternary)
              </ct-button>
            ) : (
              <span>Hidden by ternary</span>
            )}
          </div>
        </div>

        {/* ========== SECTION D: INSIDE computed() ========== */}
        {/* VERIFIED: All tests PASS - CTS transformer handles closures automatically */}
        <div style={{ border: "2px solid purple", padding: "1rem", marginBottom: "1rem", borderRadius: "8px" }}>
          <h3 style={{ color: "purple" }}>D. Inside computed() Context ✅</h3>
          <p style={{ fontSize: "0.8rem", color: "#666" }}>
            <strong>VERIFIED:</strong> Both inline closures and handler params work.
            The CTS transformer automatically extracts closures from computed() functions.
          </p>

          {computed(() => {
            const itemCount = items.length;
            return (
              <div style={{ background: "#e2d5f0", padding: "0.5rem", borderRadius: "4px" }}>
                <div>Items in array: {itemCount}</div>

                <div style={{ marginBottom: "0.5rem" }}>
                  <strong>D1. Inline closure (input):</strong>
                  <ct-button
                    onClick={() => {
                      try {
                        const val = inputCounter.get();
                        inputCounter.set(val + 1);
                        console.log("[D1] SUCCESS: inline in computed (input), value now:", val + 1);
                      } catch (e) {
                        console.error("[D1] FAILED: inline in computed (input)", e);
                      }
                    }}
                  >
                    Test D1
                  </ct-button>
                </div>

                <div style={{ marginBottom: "0.5rem" }}>
                  <strong>D2. Inline closure (local):</strong>
                  <ct-button
                    onClick={() => {
                      try {
                        const val = localCounter.get();
                        localCounter.set(val + 1);
                        console.log("[D2] SUCCESS: inline in computed (local), value now:", val + 1);
                      } catch (e) {
                        console.error("[D2] FAILED: inline in computed (local)", e);
                      }
                    }}
                  >
                    Test D2
                  </ct-button>
                </div>

                <div style={{ marginBottom: "0.5rem" }}>
                  <strong>D3. Handler with cell param (input):</strong>
                  <ct-button onClick={handlerWithCellParam({ targetCell: inputCounter, label: "D3-input" })}>
                    Test D3
                  </ct-button>
                </div>

                <div style={{ marginBottom: "0.5rem" }}>
                  <strong>D4. Handler with cell param (local):</strong>
                  <ct-button onClick={handlerWithCellParam({ targetCell: localCounter, label: "D4-local" })}>
                    Test D4
                  </ct-button>
                </div>
              </div>
            );
          })}
        </div>

        {/* ========== VERIFIED RESULTS ========== */}
        <div style={{ border: "2px solid #333", padding: "1rem", borderRadius: "8px", background: "#f9f9f9" }}>
          <h3>Verified Results (2025-12-16)</h3>
          <pre style={{ fontSize: "0.7rem", background: "#fff", padding: "0.5rem", overflow: "auto" }}>
{`| Test | Context    | Style            | Cell Source | Result |
|------|------------|------------------|-------------|--------|
| A1   | top-level  | inline closure   | input       | ✅ PASS |
| A2   | top-level  | inline closure   | local       | ✅ PASS |
| A3   | top-level  | handler param    | input       | ✅ PASS |
| A4   | top-level  | handler param    | local       | ✅ PASS |
| B1   | .map()     | inline closure   | input       | ✅ PASS |
| B2   | .map()     | inline closure   | local       | ✅ PASS |
| B3   | .map()     | handler param    | input       | ✅ PASS |
| B4   | .map()     | handler param    | local       | ✅ PASS |
| C1   | ifElse()   | inline closure   | input       | ❌ FAIL |
| C2   | ifElse()   | inline closure   | local       | ❌ FAIL |
| C3   | ifElse()   | handler param    | input       | ✅ PASS |
| C4   | ifElse()   | handler param    | local       | ✅ PASS |
| C5   | ifElse()   | plain fn closure | both        | ❌ FAIL |
| C6   | ternary    | inline closure   | input       | ❌ FAIL |
| D1   | computed() | inline closure   | input       | ✅ PASS |
| D2   | computed() | inline closure   | local       | ✅ PASS |
| D3   | computed() | handler param    | input       | ✅ PASS |
| D4   | computed() | handler param    | local       | ✅ PASS |

Summary: Only ifElse() has closure limitations. Use handler() with explicit
cell params inside ifElse branches. All other contexts work with closures.`}
          </pre>
        </div>
      </div>
    ),
    inputCounter: inputCounter,
    localCounter,
    showButtons: showButtons,
  };
});
