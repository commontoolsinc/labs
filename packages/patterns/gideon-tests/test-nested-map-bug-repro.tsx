/// <cts-enable />
/**
 * MINIMAL BUG REPRO: Nested map + ifElse + checkbox + delete
 *
 * BUG: Items disappear from CategoryList but remain in BasicList
 *
 * REPRO STEPS (automated via "Run Repro" button):
 * 1. Start with items: Milk (Dairy), Bread (Bakery), Cheese (Dairy, checked)
 * 2. Check Milk's done state
 * 3. Remove Milk (index 0)
 * 4. OBSERVE: CategoryList loses all items, BasicList shows remaining items
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

        <div style={{ display: "flex", gap: "20px", marginBottom: "20px" }}>
          {/* Basic List - simple items.map */}
          <div
            style={{
              flex: 1,
              padding: "12px",
              border: "2px solid #4caf50",
              borderRadius: "8px",
            }}
          >
            <h3 style={{ margin: "0 0 12px 0", color: "#2e7d32" }}>
              Basic List (simple map)
            </h3>
            {items.map((item, idx) => (
              <div style={{ margin: "4px 0" }}>
                <ct-checkbox $checked={item.done}>
                  [{idx}] {item.title} ({item.category})
                </ct-checkbox>
              </div>
            ))}
          </div>

          {/* Category List - nested map with ifElse */}
          <div
            style={{
              flex: 1,
              padding: "12px",
              border: "2px solid #2196f3",
              borderRadius: "8px",
            }}
          >
            <h3 style={{ margin: "0 0 12px 0", color: "#1565c0" }}>
              Category List (nested map + ifElse)
            </h3>
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
          <strong>Expected Bug:</strong>{" "}
          After "Run Repro Sequence", CategoryList should be empty while
          BasicList still shows Bread and Cheese.
        </div>
      </div>
    ),
    items,
    log,
  };
});
