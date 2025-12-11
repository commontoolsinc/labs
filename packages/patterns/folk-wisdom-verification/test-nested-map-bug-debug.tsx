/// <cts-enable />
/**
 * DEBUG VERSION: Nested map + ifElse bug with diagnostic output
 */
import { Cell, computed, Default, derive, handler, ifElse, NAME, pattern, UI } from "commontools";

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

export default pattern<Input>(({ items, log }) => {
  const runRepro = handler<unknown, { items: Cell<Item[]>; log: Cell<string[]> }>(
    (_event, { items: itemsList, log: logList }) => {
      const logMsg = (msg: string) => {
        logList.push(`${new Date().toISOString().slice(11, 19)} - ${msg}`);
      };

      logMsg("=== REPRO START ===");
      const initial = itemsList.get();
      logMsg(`Items: ${JSON.stringify(initial)}`);

      logMsg("Setting items[0].done = true");
      itemsList.key(0).key("done").set(true);

      logMsg("Removing items[0]");
      const current = itemsList.get();
      itemsList.set(current.toSpliced(0, 1));

      logMsg(`Final: ${JSON.stringify(itemsList.get())}`);
      logMsg("=== REPRO END ===");
    },
  );

  const resetItems = handler<unknown, { items: Cell<Item[]>; log: Cell<string[]> }>(
    (_event, { items: itemsList, log: logList }) => {
      itemsList.set([
        { title: "Milk", done: false, category: "Dairy" },
        { title: "Bread", done: false, category: "Bakery" },
        { title: "Cheese", done: true, category: "Dairy" },
      ]);
      logList.set(["Reset"]);
    },
  );

  // Derive categories - add logging
  const categories = derive({ items }, ({ items: arr }: { items: Item[] }) => {
    const cats = new Set<string>();
    for (const item of arr) {
      cats.add(item.category || "Uncategorized");
    }
    const result = Array.from(cats).sort();
    console.log("[categories derive] items:", arr, "-> categories:", result);
    return result;
  });

  // Diagnostic: derive that shows current state
  const diagnostics = derive(
    { items, categories },
    ({ items: itemsArr, categories: catsArr }: { items: Item[]; categories: string[] }) => {
      return {
        itemCount: itemsArr.length,
        items: itemsArr.map(i => `${i.title}(${i.category},done=${i.done})`),
        categories: catsArr,
      };
    }
  );

  return {
    [NAME]: "Bug Debug: Nested Map + ifElse",
    [UI]: (
      <div style={{ padding: "20px", fontFamily: "system-ui", fontSize: "14px" }}>
        <h2>Nested Map Bug - Debug Version</h2>

        <div style={{ marginBottom: "20px", display: "flex", gap: "10px" }}>
          <ct-button onClick={runRepro({ items, log })}>Run Repro</ct-button>
          <ct-button onClick={resetItems({ items, log })}>Reset</ct-button>
        </div>

        {/* Diagnostic panel - shows what derives see */}
        <div style={{ marginBottom: "20px", padding: "12px", background: "#e8f5e9", borderRadius: "8px", fontFamily: "monospace" }}>
          <strong>Diagnostics (what derives see):</strong>
          <div>Item count: {diagnostics.itemCount}</div>
          <div>Items: {diagnostics.items.map((s) => <span style={{ marginRight: "8px" }}>{s}</span>)}</div>
          <div>Categories: {diagnostics.categories.map((s) => <span style={{ marginRight: "8px" }}>{s}</span>)}</div>
        </div>

        <div style={{ display: "flex", gap: "20px", marginBottom: "20px" }}>
          {/* Basic List */}
          <div style={{ flex: 1, padding: "12px", border: "2px solid #4caf50", borderRadius: "8px" }}>
            <h3 style={{ margin: "0 0 12px 0" }}>Basic List</h3>
            <div style={{ marginBottom: "8px", fontSize: "12px", color: "#666" }}>
              items.length via derive: {derive({ items }, ({ items: a }: { items: Item[] }) => a.length)}
            </div>
            {items.map((item, idx) => (
              <div style={{ margin: "4px 0" }}>
                <ct-checkbox $checked={item.done}>
                  [{idx}] {item.title} ({item.category})
                </ct-checkbox>
              </div>
            ))}
          </div>

          {/* Category List with debugging */}
          <div style={{ flex: 1, padding: "12px", border: "2px solid #2196f3", borderRadius: "8px" }}>
            <h3 style={{ margin: "0 0 12px 0" }}>Category List</h3>
            <div style={{ marginBottom: "8px", fontSize: "12px", color: "#666" }}>
              categories.length: {derive({ categories }, ({ categories: c }: { categories: string[] }) => c.length)}
            </div>
            {categories.map((category) => (
              <div style={{ marginBottom: "12px", padding: "8px", background: "#f5f5f5", borderRadius: "4px" }}>
                <strong>{category}:</strong>
                <div style={{ fontSize: "11px", color: "#666" }}>
                  items in this category: {derive(
                    { items, category },
                    ({ items: arr, category: cat }: { items: Item[]; category: string }) =>
                      arr.filter(i => (i.category || "Uncategorized") === cat).length
                  )}
                </div>
                {items.map((item, idx) => {
                  // Debug: log what ifElse evaluates
                  const condition = computed(() => {
                    const match = (item.category || "Uncategorized") === category;
                    console.log(`[ifElse] item=${item.title}, category=${category}, match=${match}`);
                    return match;
                  });
                  return ifElse(
                    condition,
                    <div style={{ marginLeft: "16px" }}>
                      <ct-checkbox $checked={item.done}>
                        [{idx}] {item.title}
                      </ct-checkbox>
                    </div>,
                    null
                  );
                })}
              </div>
            ))}
          </div>
        </div>

        {/* Log */}
        <div style={{ padding: "12px", background: "#f5f5f5", borderRadius: "8px", fontFamily: "monospace", fontSize: "11px", maxHeight: "200px", overflow: "auto" }}>
          <strong>Log:</strong>
          {log.map((entry) => <div>{entry}</div>)}
        </div>
      </div>
    ),
    items,
    log,
  };
});
