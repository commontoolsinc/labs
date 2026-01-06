/// <cts-enable />
/**
 * TEST PATTERN: Pattern Composition - Index-Based Removal
 *
 * HYPOTHESIS TEST: Is the aliasing bug causing issues with .equals()?
 *
 * This version uses INDEX-BASED removal instead of .equals() to see
 * if the bug goes away. If it does, it confirms .equals() / cell identity
 * is the root cause.
 */
import {
  Cell, Writable,
  computed,
  Default,
  derive,
  handler,
  ifElse,
  NAME,
  pattern,
  UI,
} from "commontools";

interface ShoppingItem {
  title: string;
  done: Default<boolean, false>;
  category: Default<string, "Uncategorized">;
}

// Sub-pattern 1: Basic list view
interface BasicListInput {
  items: Writable<ShoppingItem[]>;
}

const BasicList = pattern<BasicListInput>(({ items }) => {
  // INDEX-BASED removal - no .equals() needed
  const removeItemByIndex = handler<
    unknown,
    { items: Writable<ShoppingItem[]>; index: number }
  >(
    (_event, { items: itemsList, index }) => {
      const current = itemsList.get();
      if (index >= 0 && index < current.length) {
        itemsList.set(current.toSpliced(index, 1));
      }
    },
  );

  const addItem = handler<
    { detail: { message: string } },
    { items: Writable<ShoppingItem[]> }
  >(
    ({ detail }, { items: itemsList }) => {
      const input = detail?.message?.trim();
      if (input) {
        const [title, category = "Uncategorized"] = input.split(":");
        itemsList.push({
          title: title.trim(),
          done: false,
          category: category.trim(),
        });
      }
    },
  );

  return {
    [NAME]: "Basic Shopping List (Index)",
    [UI]: (
      <div
        style={{
          padding: "12px",
          border: "2px solid #4caf50",
          borderRadius: "8px",
        }}
      >
        <h3 style={{ margin: "0 0 12px 0", color: "#2e7d32" }}>
          Basic List View (Index-Based)
        </h3>
        <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
          {items.map((item, index) => (
            <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
              <ct-checkbox $checked={item.done}>
                <span
                  style={computed(
                    () => (item.done ? { textDecoration: "line-through" } : {}),
                  )}
                >
                  [{index}] {item.title} ({item.category})
                </span>
              </ct-checkbox>
              <ct-button onClick={removeItemByIndex({ items, index })}>
                x
              </ct-button>
            </div>
          ))}
        </div>

        <ct-message-input
          placeholder="Add item (e.g., Apples:Produce)..."
          onct-send={addItem({ items })}
        />
      </div>
    ),
    items,
  };
});

// Sub-pattern 2: Categorized view - ALSO index-based
interface CategoryListInput {
  items: Writable<ShoppingItem[]>;
}

const CategoryList = pattern<CategoryListInput>(({ items }) => {
  const categories = derive(
    { items },
    ({ items: itemsArray }: { items: ShoppingItem[] }) => {
      const cats = new Set<string>();
      for (const item of itemsArray) {
        cats.add(item.category || "Uncategorized");
      }
      return Array.from(cats).sort();
    },
  );

  // INDEX-BASED removal - no .equals() needed
  const removeItemByIndex = handler<
    unknown,
    { items: Writable<ShoppingItem[]>; index: number }
  >(
    (_event, { items: itemsList, index }) => {
      const current = itemsList.get();
      if (index >= 0 && index < current.length) {
        itemsList.set(current.toSpliced(index, 1));
      }
    },
  );

  return {
    [NAME]: "Shopping List by Category (Index)",
    [UI]: (
      <div
        style={{
          padding: "12px",
          border: "2px solid #2196f3",
          borderRadius: "8px",
        }}
      >
        <h3 style={{ margin: "0 0 12px 0", color: "#1565c0" }}>
          Category List View (Index-Based)
        </h3>
        {categories.map((category) => (
          <div style={{ marginBottom: "12px" }}>
            <h4 style={{ margin: "0 0 8px 0", color: "#666" }}>{category}</h4>
            {items.map((item, index) =>
              ifElse(
                computed(() => (item.category || "Uncategorized") === category),
                <div
                  style={{
                    display: "flex",
                    gap: "8px",
                    alignItems: "center",
                    marginLeft: "16px",
                  }}
                >
                  <ct-checkbox $checked={item.done}>
                    <span
                      style={computed(() => (item.done
                        ? { textDecoration: "line-through" }
                        : {})
                      )}
                    >
                      [{index}] {item.title}
                    </span>
                  </ct-checkbox>
                  <ct-button onClick={removeItemByIndex({ items, index })}>
                    x
                  </ct-button>
                </div>,
                null,
              )
            )}
          </div>
        ))}
      </div>
    ),
    items,
  };
});

// Main pattern
interface ComposedInput {
  items: Default<
    ShoppingItem[],
    [
      { title: "Milk"; done: false; category: "Dairy" },
      { title: "Bread"; done: false; category: "Bakery" },
      { title: "Cheese"; done: true; category: "Dairy" },
    ]
  >;
}

export default pattern<ComposedInput>(({ items }) => {
  const basicView = BasicList({ items });
  const categoryView = CategoryList({ items });

  return {
    [NAME]: "Test: Index-Based Removal (Aliasing Test)",
    [UI]: (
      <div style={{ padding: "20px", fontFamily: "system-ui, sans-serif" }}>
        <h2>Index-Based Removal Test</h2>

        <div
          style={{
            marginBottom: "20px",
            padding: "12px",
            backgroundColor: "#fff3e0",
            borderRadius: "8px",
          }}
        >
          <p>
            <strong>Hypothesis Test:</strong>{" "}
            Does using index-based removal (instead of .equals()) fix the bug
            where items disappear from one view but not the other?
          </p>
          <ol style={{ margin: "8px 0 0 0", paddingLeft: "20px" }}>
            <li>Add items, check/uncheck them</li>
            <li>Delete items from either view</li>
            <li>
              If both views stay in sync → .equals() / aliasing is the bug
            </li>
            <li>If still broken → deeper reactivity issue</li>
          </ol>
        </div>

        <div style={{ display: "flex", gap: "20px", flexWrap: "wrap" }}>
          <div style={{ flex: "1 1 300px" }}>{basicView}</div>
          <div style={{ flex: "1 1 300px" }}>{categoryView}</div>
        </div>
      </div>
    ),
    items,
  };
});
