/// <cts-enable />
/**
 * CT-1158 BUG REPRO: Map truncation loses cell references when ifElse returns null
 *
 * ROOT CAUSE: In map.ts, truncation uses .get().slice() which dereferences cell
 * links. When ifElse returns null (falsy branch), the cell reference is lost and
 * literal null is stored instead.
 *
 * TEST CASES:
 * 1. Basic List (simple map) - WORKS: No ifElse, no nulls
 * 2. Category List (nested map + ifElse null) - FAILS: ifElse returns null
 * 3. Single Map + ifElse null - FAILS: Proves nesting isn't required
 * 4. Single Map + ifElse empty span - WORKS: Non-null falsy branch survives
 *
 * REPRO: Click "Run Repro Sequence" to check item[0] then remove it
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

interface Item {
  title: string;
  done: Default<boolean, false>;
  category: Default<string, "Uncategorized">;
}

interface Input {
  items: Default<Item[], [
    { title: "Milk"; done: false; category: "Dairy" },
    { title: "Bread"; done: false; category: "Bakery" },
    { title: "Cheese"; done: true; category: "Dairy" },
  ]>;
  log: Default<string[], []>;
}

// Handler to run the exact repro sequence (moved to module scope)
const runRepro = handler<unknown, { items: Cell<Item[]>; log: Cell<string[]> }>(
  (_event, { items: itemsList, log: logList }) => {
    const logMsg = (msg: string) => {
      logList.push(`${new Date().toISOString().slice(11, 19)} - ${msg}`);
    };

    logMsg("Starting repro sequence...");

    // Step 1: Log initial state
    const initial = itemsList.get();
    logMsg(
      `Initial items: ${
        initial.map((i) => `${i.title}(done=${i.done})`).join(", ")
      }`,
    );

    // Step 2: Check Milk (index 0)
    logMsg("Setting items[0].done = true (checking Milk)");
    itemsList.key(0).key("done").set(true);

    // Log state after check
    const afterCheck = itemsList.get();
    logMsg(
      `After check: ${
        afterCheck.map((i) => `${i.title}(done=${i.done})`).join(", ")
      }`,
    );

    // Step 3: Remove Milk (index 0)
    logMsg("Removing items[0] (Milk)");
    const current = itemsList.get();
    itemsList.set(current.toSpliced(0, 1));

    // Log final state
    const final = itemsList.get();
    logMsg(
      `Final items: ${
        final.map((i) => `${i.title}(done=${i.done})`).join(", ")
      }`,
    );
    logMsg("Repro complete - check if CategoryList shows items");
  },
);

// Handler to reset items (moved to module scope)
const resetItems = handler<
  unknown,
  { items: Cell<Item[]>; log: Cell<string[]> }
>(
  (_event, { items: itemsList, log: logList }) => {
    itemsList.set([
      { title: "Milk", done: false, category: "Dairy" },
      { title: "Bread", done: false, category: "Bakery" },
      { title: "Cheese", done: true, category: "Dairy" },
    ]);
    logList.set(["Reset to initial state"]);
  },
);

export default pattern<Input>(({ items, log }) => {
  // Derive categories from items
  const categories = derive({ items }, ({ items: arr }: { items: Item[] }) => {
    const cats = new Set<string>();
    for (const item of arr) {
      cats.add(item.category || "Uncategorized");
    }
    return Array.from(cats).sort();
  });

  return {
    [NAME]: "Bug Repro: Nested Map + ifElse",
    [UI]: (
      <div style={{ padding: "20px", fontFamily: "system-ui" }}>
        <h2>Nested Map Bug Repro</h2>

        <div style={{ marginBottom: "20px", display: "flex", gap: "10px" }}>
          <ct-button onClick={runRepro({ items, log })}>
            Run Repro Sequence
          </ct-button>
          <ct-button onClick={resetItems({ items, log })}>
            Reset
          </ct-button>
        </div>

        {/* Row 1: Basic List vs Category List (original repro) */}
        <div style={{ display: "flex", gap: "20px", marginBottom: "20px" }}>
          {/* Test 1: Basic List - simple items.map (WORKS) */}
          <div
            style={{
              flex: 1,
              padding: "12px",
              border: "2px solid #4caf50",
              borderRadius: "8px",
            }}
          >
            <h3 style={{ margin: "0 0 12px 0", color: "#2e7d32" }}>
              1. Basic List (simple map)
            </h3>
            <div style={{ fontSize: "11px", color: "#666", marginBottom: "8px" }}>
              No ifElse → no nulls → WORKS
            </div>
            {items.map((item, idx) => (
              <div style={{ margin: "4px 0" }}>
                <ct-checkbox $checked={item.done}>
                  [{idx}] {item.title} ({item.category})
                </ct-checkbox>
              </div>
            ))}
          </div>

          {/* Test 2: Category List - nested map with ifElse null (FAILS) */}
          <div
            style={{
              flex: 1,
              padding: "12px",
              border: "2px solid #f44336",
              borderRadius: "8px",
            }}
          >
            <h3 style={{ margin: "0 0 12px 0", color: "#c62828" }}>
              2. Category List (nested map + ifElse null)
            </h3>
            <div style={{ fontSize: "11px", color: "#666", marginBottom: "8px" }}>
              ifElse returns null → cell ref lost → FAILS
            </div>
            {categories.map((category) => (
              <div style={{ marginBottom: "8px" }}>
                <strong>{category}:</strong>
                {items.map((item, idx) =>
                  ifElse(
                    computed(() =>
                      (item.category || "Uncategorized") === category
                    ),
                    <div style={{ marginLeft: "16px" }}>
                      <ct-checkbox $checked={item.done}>
                        [{idx}] {item.title}
                      </ct-checkbox>
                    </div>,
                    null,
                  )
                )}
              </div>
            ))}
          </div>
        </div>

        {/* Row 2: Single map tests to prove nesting isn't required */}
        <div style={{ display: "flex", gap: "20px", marginBottom: "20px" }}>
          {/* Test 3: Single map + ifElse null (FAILS) - proves nesting not required */}
          <div
            style={{
              flex: 1,
              padding: "12px",
              border: "2px solid #f44336",
              borderRadius: "8px",
            }}
          >
            <h3 style={{ margin: "0 0 12px 0", color: "#c62828" }}>
              3. Single Map + ifElse null
            </h3>
            <div style={{ fontSize: "11px", color: "#666", marginBottom: "8px" }}>
              Shows only done items. No nesting → still FAILS
            </div>
            {items.map((item, idx) =>
              ifElse(
                computed(() => item.done),
                <div style={{ margin: "4px 0" }}>
                  <ct-checkbox $checked={item.done}>
                    [{idx}] {item.title} (done)
                  </ct-checkbox>
                </div>,
                null,
              )
            )}
            <div style={{ fontSize: "11px", color: "#999", marginTop: "8px" }}>
              (Shows only checked items)
            </div>
          </div>

          {/* Test 4: Single map + ifElse empty span (WORKS) - proves null is the issue */}
          <div
            style={{
              flex: 1,
              padding: "12px",
              border: "2px solid #4caf50",
              borderRadius: "8px",
            }}
          >
            <h3 style={{ margin: "0 0 12px 0", color: "#2e7d32" }}>
              4. Single Map + ifElse empty span
            </h3>
            <div style={{ fontSize: "11px", color: "#666", marginBottom: "8px" }}>
              Non-null false branch → survives round-trip → WORKS
            </div>
            {items.map((item, idx) =>
              ifElse(
                computed(() => item.done),
                <div style={{ margin: "4px 0" }}>
                  <ct-checkbox $checked={item.done}>
                    [{idx}] {item.title} (done)
                  </ct-checkbox>
                </div>,
                <span style={{ display: "none" }} />,
              )
            )}
            <div style={{ fontSize: "11px", color: "#999", marginTop: "8px" }}>
              (Shows only checked items)
            </div>
          </div>
        </div>

        {/* Log output */}
        <div
          style={{
            padding: "12px",
            background: "#f5f5f5",
            borderRadius: "8px",
            fontFamily: "monospace",
            fontSize: "12px",
          }}
        >
          <strong>Log:</strong>
          {log.map((entry) => <div>{entry}</div>)}
        </div>

        <div
          style={{
            marginTop: "20px",
            padding: "12px",
            background: "#ffebee",
            borderRadius: "8px",
          }}
        >
          <strong>Expected after "Run Repro Sequence":</strong>
          <ul style={{ margin: "8px 0 0 0", paddingLeft: "20px" }}>
            <li><strong>Test 1 (Basic):</strong> Shows Bread, Cheese ✓</li>
            <li><strong>Test 2 (Nested + null):</strong> Empty or broken ✗</li>
            <li><strong>Test 3 (Single + null):</strong> Empty or broken ✗</li>
            <li><strong>Test 4 (Single + span):</strong> Shows Cheese ✓</li>
          </ul>
        </div>
      </div>
    ),
    items,
    log,
  };
});
