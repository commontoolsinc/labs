/// <cts-enable />
/**
 * MINIMAL REPRO: Unexpected aliasing when setting cell to array element
 *
 * BUG: When you set a cell to a value from array.get()[index], it creates
 * a bidirectional alias. Future .set() calls write through the alias,
 * corrupting the original array element.
 *
 * STEPS TO REPRODUCE:
 * 1. Click "Add Item" 3 times to create items A, B, C
 * 2. Click "Select" on item A (index 0)
 * 3. Click "Select" on item B (index 1)
 * 4. OBSERVE: Item A now has Item B's content!
 *
 * EXPECTED: Selecting B should just change selectedItem to B
 * ACTUAL: Selecting B overwrites A's data with B's data
 */
import { Cell, Default, handler, NAME, pattern, UI } from "commontools";

interface Item {
  name: string;
}

interface Input {
  items: Default<Item[], []>;
  selectedItem: Default<Item | null, null>;
}

let counter = 0;

const addItem = handler<unknown, { items: Cell<Item[]> }>(
  (_, { items }) => {
    items.push({ name: `Item-${String.fromCharCode(65 + counter++)}` });
  },
);

const selectItem = handler<
  unknown,
  { items: Cell<Item[]>; selectedItem: Cell<Item | null>; index: number }
>(
  (_, { items, selectedItem, index }) => {
    // THIS IS THE BUG: items.get()[index] has a toCell symbol
    // .set() creates an alias instead of copying
    const item = items.get()[index];
    selectedItem.set(item);
  },
);

export default pattern<Input, Input>(({ items, selectedItem }) => {
  return {
    [NAME]: "Alias Bug Repro",
    [UI]: (
      <div style={{ padding: "1rem", fontFamily: "monospace" }}>
        <h2>Alias Bug Minimal Repro</h2>
        <p style={{ color: "#666", marginBottom: "1rem" }}>
          1. Add 3 items → 2. Select first → 3. Select second → 4. First item is corrupted
        </p>

        <ct-button onClick={addItem({ items })}>Add Item</ct-button>

        <div style={{ marginTop: "1rem" }}>
          <strong>Items:</strong>
          {items.map((item, index) => (
            <div style={{ display: "flex", gap: "0.5rem", margin: "0.25rem 0" }}>
              <span>[{index}] {item.name}</span>
              <ct-button onClick={selectItem({ items, selectedItem, index })}>
                Select
              </ct-button>
            </div>
          ))}
        </div>

        <div style={{ marginTop: "1rem", padding: "0.5rem", background: "#e3f2fd" }}>
          <strong>Selected:</strong> {selectedItem?.name ?? "none"}
        </div>
      </div>
    ),
    items,
    selectedItem,
  };
});
