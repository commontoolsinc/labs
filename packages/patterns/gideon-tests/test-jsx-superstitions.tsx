/// <cts-enable />
/**
 * Test Pattern: JSX + COMPONENTS Superstition Verification
 *
 * Tests three superstitions:
 * 1. conditional-and-in-map-leaks-alias - && operator leaks $alias and breaks handlers
 * 2. ct-vstack-hstack-collapse-in-flex-items - stack components collapse in flex
 * 3. helper-functions-jsx-not-rendering - helper functions returning JSX don't render
 *
 * Deploy: deno task ct charm new packages/patterns/gideon-tests/test-jsx-superstitions.tsx -i claude.key -a http://localhost:8000 -s gideon-test
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

interface Item {
  id: number;
  name: string;
  show: Default<boolean, true>;
}

interface Input {
  items: Default<Item[], [
    { id: 1; name: "Item One"; show: true },
    { id: 2; name: "Item Two"; show: true },
    { id: 3; name: "Item Three"; show: false },
  ]>;
  clickCounts: Cell<
    Default<Record<string, number>, Record<PropertyKey, never>>
  >;
  helperClicks: Cell<Default<number, 0>>;
}

// Handler defined at MODULE SCOPE - this is the pattern from group-chat-room.tsx
const onItemClick = handler<
  unknown,
  { counts: Cell<Record<string, number>>; itemId: number }
>((_event, { counts, itemId }) => {
  const current = counts.get() || {};
  const key = `item-${itemId}`;
  counts.set({ ...current, [key]: (current[key] || 0) + 1 });
});

// Handler for helper click test
const onHelperClick = handler<
  unknown,
  { helperClicks: Cell<number> }
>((_event, { helperClicks }) => {
  helperClicks.set((helperClicks.get() || 0) + 1);
});

export default pattern<Input, Input>(({ items, clickCounts, helperClicks }) => {
  // clickCounts and helperClicks are already Cell<> from Input type

  // Helper function returning JSX (TEST #3)
  const renderHelperButton = (label: string, clickHandler: any) => (
    <button
      type="button"
      onClick={clickHandler}
      style={{
        padding: "8px 16px",
        backgroundColor: "#ffc107",
        border: "none",
        borderRadius: "4px",
      }}
    >
      {label}
    </button>
  );

  const totalClicks = computed(() => {
    const counts = clickCounts.get();
    if (!counts) return 0;
    let sum = 0;
    for (const key of Object.keys(counts)) {
      sum += counts[key] || 0;
    }
    return sum;
  });

  return {
    [NAME]: "JSX Superstition Tests",
    [UI]: (
      <div
        style={{
          padding: "20px",
          fontFamily: "sans-serif",
          display: "flex",
          flexDirection: "column",
          gap: "24px",
        }}
      >
        <h2>JSX + COMPONENTS Superstition Tests</h2>

        {/* ===== TEST 1: && Conditional in .map() ===== */}
        <div
          style={{
            border: "2px solid #dc3545",
            padding: "16px",
            borderRadius: "8px",
          }}
        >
          <h3 style={{ color: "#dc3545" }}>
            TEST 1: && Conditional in .map() (Alleged: Leaks $alias, breaks
            handlers)
          </h3>
          <p>
            Click the buttons below. If handlers don't fire, the superstition is
            confirmed.
          </p>

          <div style={{ marginTop: "12px" }}>
            <strong>Using && operator (ALLEGEDLY BROKEN):</strong>
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: "8px",
                marginTop: "8px",
              }}
            >
              {items.map((item) => (
                <div
                  key={item.id}
                  style={{ display: "flex", gap: "8px", alignItems: "center" }}
                >
                  <span>{item.name}:</span>
                  {/* This allegedly breaks handler binding */}
                  {item.show && (
                    <button
                      type="button"
                      onClick={onItemClick({
                        counts: clickCounts,
                        itemId: item.id,
                      })}
                      style={{
                        padding: "4px 12px",
                        backgroundColor: "#dc3545",
                        color: "white",
                        border: "none",
                        borderRadius: "4px",
                      }}
                    >
                      Click (&&)
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>

          <div style={{ marginTop: "16px" }}>
            <strong>Using ifElse (ALLEGEDLY WORKS):</strong>
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: "8px",
                marginTop: "8px",
              }}
            >
              {items.map((item) => (
                <div
                  key={item.id}
                  style={{ display: "flex", gap: "8px", alignItems: "center" }}
                >
                  <span>{item.name}:</span>
                  {ifElse(
                    item.show,
                    <button
                      type="button"
                      onClick={onItemClick({
                        counts: clickCounts,
                        itemId: item.id,
                      })}
                      style={{
                        padding: "4px 12px",
                        backgroundColor: "#28a745",
                        color: "white",
                        border: "none",
                        borderRadius: "4px",
                      }}
                    >
                      Click (ifElse)
                    </button>,
                    null,
                  )}
                </div>
              ))}
            </div>
          </div>

          <div
            style={{
              marginTop: "12px",
              padding: "8px",
              backgroundColor: "#f8f9fa",
              borderRadius: "4px",
            }}
          >
            <strong>Click counts:</strong> {JSON.stringify(clickCounts)}
            <br />
            <strong>Total clicks:</strong> {totalClicks}
          </div>
        </div>

        {/* ===== TEST 2: ct-vstack/ct-hstack in flex container ===== */}
        <div
          style={{
            border: "2px solid #007bff",
            padding: "16px",
            borderRadius: "8px",
          }}
        >
          <h3 style={{ color: "#007bff" }}>
            TEST 2: ct-vstack in Flex Container (Alleged: Collapses to 0px)
          </h3>
          <p>
            If the middle section is invisible, the superstition is confirmed.
          </p>

          <div style={{ marginTop: "12px" }}>
            <strong>Using ct-vstack in inline-flex (ALLEGEDLY BROKEN):</strong>
            <div style={{ marginTop: "8px" }}>
              <span style="display: inline-flex; align-items: center; gap: 6px; border: 1px dashed #007bff; padding: 4px;">
                <button type="button">Left</button>
                <ct-vstack gap="0">
                  <span>Stack Item 1</span>
                  <span>Stack Item 2</span>
                </ct-vstack>
                <button type="button">Right</button>
              </span>
            </div>
          </div>

          <div style={{ marginTop: "16px" }}>
            <strong>Using span with flex styles (ALLEGEDLY WORKS):</strong>
            <div style={{ marginTop: "8px" }}>
              <span style="display: inline-flex; align-items: center; gap: 6px; border: 1px dashed #28a745; padding: 4px;">
                <button type="button">Left</button>
                <span style="display: flex; flex-direction: column;">
                  <span>Stack Item 1</span>
                  <span>Stack Item 2</span>
                </span>
                <button type="button">Right</button>
              </span>
            </div>
          </div>

          <div style={{ marginTop: "16px" }}>
            <strong>Using ct-vstack with min-width workaround:</strong>
            <div style={{ marginTop: "8px" }}>
              <span style="display: inline-flex; align-items: center; gap: 6px; border: 1px dashed #ffc107; padding: 4px;">
                <button type="button">Left</button>
                <ct-vstack gap="0" style="min-width: max-content;">
                  <span>Stack Item 1</span>
                  <span>Stack Item 2</span>
                </ct-vstack>
                <button type="button">Right</button>
              </span>
            </div>
          </div>
        </div>

        {/* ===== TEST 3: Helper functions returning JSX ===== */}
        <div
          style={{
            border: "2px solid #6f42c1",
            padding: "16px",
            borderRadius: "8px",
          }}
        >
          <h3 style={{ color: "#6f42c1" }}>
            TEST 3: Helper Functions Returning JSX (Alleged: Don't render)
          </h3>
          <p>
            If the yellow button is invisible, the superstition is confirmed.
          </p>

          <div style={{ marginTop: "12px" }}>
            <strong>Helper function button (ALLEGEDLY BROKEN):</strong>
            <div
              style={{
                marginTop: "8px",
                display: "flex",
                gap: "8px",
                alignItems: "center",
              }}
            >
              <span>→</span>
              {renderHelperButton(
                "Click Me (Helper)",
                onHelperClick({ helperClicks }),
              )}
              <span>←</span>
            </div>
          </div>

          <div style={{ marginTop: "16px" }}>
            <strong>Inline button (CONTROL - should work):</strong>
            <div
              style={{
                marginTop: "8px",
                display: "flex",
                gap: "8px",
                alignItems: "center",
              }}
            >
              <span>→</span>
              <button
                type="button"
                onClick={onHelperClick({ helperClicks })}
                style={{
                  padding: "8px 16px",
                  backgroundColor: "#28a745",
                  color: "white",
                  border: "none",
                  borderRadius: "4px",
                }}
              >
                Click Me (Inline)
              </button>
              <span>←</span>
            </div>
          </div>

          <div
            style={{
              marginTop: "12px",
              padding: "8px",
              backgroundColor: "#f8f9fa",
              borderRadius: "4px",
            }}
          >
            <strong>Helper clicks:</strong> {helperClicks}
          </div>
        </div>

        {/* ===== SUMMARY ===== */}
        <div
          style={{
            border: "2px solid #333",
            padding: "16px",
            borderRadius: "8px",
            backgroundColor: "#f8f9fa",
          }}
        >
          <h3>Test Summary</h3>
          <ul style={{ margin: "8px 0", paddingLeft: "20px" }}>
            <li>
              <strong>Test 1 (&&):</strong>{" "}
              Compare red vs green button clicks. If only green works,
              CONFIRMED.
            </li>
            <li>
              <strong>Test 2 (flex):</strong>{" "}
              If blue border shows "Left Right" with no content between,
              CONFIRMED.
            </li>
            <li>
              <strong>Test 3 (helper):</strong>{" "}
              If yellow button is invisible, CONFIRMED.
            </li>
          </ul>
        </div>
      </div>
    ),
    items,
    clickCounts: clickCounts,
    helperClicks: helperClicks,
  };
});
