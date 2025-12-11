/// <cts-enable />
/**
 * TEST PATTERN: Cell.equals() vs Manual IDs
 *
 * WHAT THIS TESTS:
 * This pattern demonstrates that the framework tracks object identity internally,
 * and manual ID generation is unnecessary. Using Cell.equals() for item comparison
 * is the recommended approach.
 *
 * MANUAL VERIFICATION STEPS:
 * 1. Click "Add Item" several times to add items to the list
 * 2. Click on different items to select them
 * 3. Verify that:
 *    - Only one item is highlighted at a time (green background)
 *    - The selected item title appears at the top
 *    - Clicking a selected item deselects it
 * 4. Click "Remove Selected" to remove the selected item
 * 5. Verify the item is removed and selection clears
 * 6. Select an item, then add a new item at the start
 * 7. Verify the selected item remains correctly highlighted
 *
 * WHAT CONFIRMS IT WORKS:
 * - Items can be selected/deselected by clicking
 * - Selection highlighting follows the correct item even after list changes
 * - Items can be removed using Cell.equals() to find them
 * - No manual ID generation is needed for any of this to work
 * - The pattern uses object references (cells) instead of string IDs
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
  title: string;
  description: string;
}

interface TestCellEqualsInput {
  items: Cell<Item[]>;
  selectedItem: Cell<Item | null>;
}

interface TestCellEqualsOutput extends TestCellEqualsInput {}

// Handler to add a new item at the start of the list
const addItem = handler<unknown, { items: Cell<Item[]> }>(
  (_, { items }) => {
    const timestamp = new Date().toLocaleTimeString();
    const newItem: Item = {
      title: `Item ${timestamp}`,
      description: `Created at ${timestamp}`,
    };
    items.set([newItem, ...items.get()]);
  },
);

// Handler to select an item (or deselect if already selected)
const selectItem = handler<
  unknown,
  { selectedItem: Cell<Item | null>; item: Cell<Item> }
>(
  (_, { selectedItem, item }) => {
    const current = selectedItem.get();
    // Use Cell.equals() to check if this item is already selected
    if (current && Cell.equals(current, item)) {
      // Deselect if clicking the same item
      selectedItem.set(null);
    } else {
      // Select the clicked item
      selectedItem.set(item.get());
    }
  },
);

// Handler to remove the selected item
const removeSelected = handler<
  unknown,
  { items: Cell<Item[]>; selectedItem: Cell<Item | null> }
>(
  (_, { items, selectedItem }) => {
    const selected = selectedItem.get();
    if (!selected) return;

    const current = items.get();
    // Use Cell.equals() to find the item in the array
    const index = current.findIndex((el) => Cell.equals(selected, el));
    if (index >= 0) {
      items.set(current.toSpliced(index, 1));
      selectedItem.set(null);
    }
  },
);

export default pattern<TestCellEqualsInput, TestCellEqualsOutput>(
  ({ items, selectedItem }) => {
    // Create computed values for display
    const hasSelection = computed(() => selectedItem.get() !== null);
    const selectedTitle = computed(() => {
      const selected = selectedItem.get();
      return selected ? selected.title : "";
    });

    return {
      [NAME]: "Test Cell.equals()",
      [UI]: (
        <div style={{ padding: "1rem" }}>
          <h2>Cell.equals() Test Pattern</h2>
          <p style={{ color: "#666", fontSize: "0.9rem" }}>
            This pattern demonstrates using Cell.equals() for item identification
            instead of manual ID generation.
          </p>

          {/* Controls */}
          <div style={{ marginBottom: "1rem", display: "flex", gap: "0.5rem" }}>
            <ct-button onClick={addItem({ items })}>Add Item</ct-button>
            <ct-button onClick={removeSelected({ items, selectedItem })}>
              Remove Selected
            </ct-button>
          </div>

          {/* Selected item display */}
          {ifElse(
            hasSelection,
            <div
              style={{
                padding: "0.75rem",
                marginBottom: "1rem",
                background: "#e3f2fd",
                borderRadius: "4px",
                border: "1px solid #2196f3",
              }}
            >
              <strong>Selected:</strong> {selectedTitle}
            </div>,
            <div
              style={{
                padding: "0.75rem",
                marginBottom: "1rem",
                background: "#f5f5f5",
                borderRadius: "4px",
                fontStyle: "italic",
                color: "#999",
              }}
            >
              No item selected
            </div>,
          )}

          {/* Items list */}
          <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
            {items.map((item) => {
              // Use Cell.equals() to determine if this item is selected
              const selected = selectedItem.get();
              const isSelected = selected !== null && Cell.equals(selected, item);

              return (
                <div
                  onClick={selectItem({ selectedItem, item })}
                  style={{
                    padding: "0.75rem",
                    background: isSelected ? "#c8e6c9" : "#f9f9f9",
                    borderRadius: "4px",
                    border: isSelected
                      ? "2px solid #4caf50"
                      : "1px solid #ddd",
                    cursor: "pointer",
                    transition: "all 0.2s",
                  }}
                >
                  <div style={{ fontWeight: isSelected ? "bold" : "normal" }}>
                    {item.title}
                  </div>
                  <div style={{ fontSize: "0.85rem", color: "#666" }}>
                    {item.description}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Show count */}
          <div
            style={{
              marginTop: "1rem",
              padding: "0.5rem",
              background: "#fff3e0",
              borderRadius: "4px",
              fontSize: "0.9rem",
            }}
          >
            Total items: {computed(() => items.get().length)}
          </div>
        </div>
      ),
      items,
      selectedItem,
    };
  },
);
