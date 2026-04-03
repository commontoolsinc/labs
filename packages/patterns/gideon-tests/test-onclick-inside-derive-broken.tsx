/// <cts-enable />
/**
 * TEST PATTERN: onClick Handler Inside derive() - VERIFIED BROKEN
 *
 * CLAIM: onClick handlers inside derive() cause ReadOnlyAddressError
 * SOURCE: folk_wisdom/onclick-handlers-conditional-rendering.md
 * STATUS: ✅ VERIFIED (2024-12-11)
 *
 * VERIFIED BEHAVIOR:
 * - Test 1 (top-level): WORKS - count increments
 * - Test 2 (derive + closure): FAILS - ReadOnlyAddressError
 * - Test 3 (derive + param): FAILS - ReadOnlyAddressError
 *
 * CONCLUSION: Cell references passed to handlers when binding occurs inside derive()
 * become read-only proxies. Any subsequent .set() call on those cells fails with
 * ReadOnlyAddressError. The issue is not the handler definition or the button itself,
 * but the cell references captured at the point of handler binding inside derive().
 */
import {
  Default,
  derive,
  handler,
  NAME,
  pattern,
  UI,
  Writable,
} from "commontools";

interface State {
  count: Default<number, 0>;
}

const incrementHandler = handler<unknown, { count: Writable<number> }>(
  (_event, { count }) => {
    count.set(count.get() + 1);
  },
);

export default pattern<State>(({ count }) => {
  return {
    [NAME]: "TEST: onClick in derive() - Comparison",
    [UI]: (
      <div style={{ padding: "1rem", fontFamily: "system-ui" }}>
        <h2>Testing: Buttons Inside derive()</h2>
        <p style={{ fontSize: "24px", fontWeight: "bold" }}>
          Current count: {count}
        </p>

        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "20px",
            marginTop: "20px",
          }}
        >
          {/* TEST 1: Button at top level - CONTROL (should work) */}
          <div
            style={{
              padding: "15px",
              border: "2px solid #4CAF50",
              borderRadius: "8px",
            }}
          >
            <h3 style={{ color: "#4CAF50", margin: "0 0 10px 0" }}>
              Test 1: Top-level button (CONTROL)
            </h3>
            <p style={{ margin: "0 0 10px 0", fontSize: "14px" }}>
              Button outside derive() - expected to WORK
            </p>
            <ct-button onClick={incrementHandler({ count })}>
              Increment (Top-level)
            </ct-button>
          </div>

          {/* TEST 2: Button inside derive, using closure variable */}
          <div
            style={{
              padding: "15px",
              border: "2px solid #FF9800",
              borderRadius: "8px",
            }}
          >
            <h3 style={{ color: "#FF9800", margin: "0 0 10px 0" }}>
              Test 2: Inside derive(), closure variable
            </h3>
            <p style={{ margin: "0 0 10px 0", fontSize: "14px" }}>
              Button inside derive(), handler uses `count` from closure
            </p>
            {derive(
              { count },
              () => (
                <ct-button onClick={incrementHandler({ count })}>
                  Increment (derive + closure)
                </ct-button>
              ),
            )}
          </div>

          {/* TEST 3: Button inside derive, using derive parameter */}
          <div
            style={{
              padding: "15px",
              border: "2px solid #f44336",
              borderRadius: "8px",
            }}
          >
            <h3 style={{ color: "#f44336", margin: "0 0 10px 0" }}>
              Test 3: Inside derive(), derive parameter
            </h3>
            <p style={{ margin: "0 0 10px 0", fontSize: "14px" }}>
              Button inside derive(), handler uses `c` from derive params
            </p>
            {derive(
              { count },
              ({ count: c }) => (
                <ct-button onClick={incrementHandler({ count: c })}>
                  Increment (derive + param)
                </ct-button>
              ),
            )}
          </div>
        </div>

        <div
          style={{
            marginTop: "20px",
            padding: "15px",
            background: "#e3f2fd",
            borderRadius: "8px",
          }}
        >
          <h4 style={{ margin: "0 0 10px 0" }}>Instructions:</h4>
          <ol style={{ margin: 0, paddingLeft: "20px" }}>
            <li>Open browser DevTools Console (Cmd+Option+J)</li>
            <li>Click each button in order</li>
            <li>Note which ones increment the count vs show errors</li>
            <li>Record results to determine if claim is TRUE or FALSE</li>
          </ol>
        </div>
      </div>
    ),
    count,
  };
});
