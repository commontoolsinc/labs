/// <cts-enable />
import {
  Cell,
  Default,
  handler,
  NAME,
  OpaqueRef,
  recipe,
  UI,
} from "commontools";

interface ShoppingItem {
  name: string;
  done: Default<boolean, false>;
  category: Default<string, "Other">;
}

interface ShoppingListInput {
  items: Default<ShoppingItem[], []>;
}

interface ShoppingListOutput extends ShoppingListInput {}

const addItem = handler<
  { detail: { message: string } },
  { items: Cell<ShoppingItem[]> }
>(({ detail }, { items }) => {
  const itemName = detail?.message?.trim();
  if (!itemName) return;

  const currentItems = items.get();
  items.set([...currentItems, {
    name: itemName,
    done: false,
    category: "Other",
  }]);
});

const removeItem = handler<
  unknown,
  { items: Cell<ShoppingItem[]>; index: number }
>((_event, { items, index }) => {
  const currentItems = items.get();
  items.set(currentItems.toSpliced(index, 1));
});

export default recipe<ShoppingListInput, ShoppingListOutput>(
  "Shopping List",
  ({ items }) => {
    return {
      [NAME]: "Shopping List",
      [UI]: (
        <div style={{ padding: "1rem", maxWidth: "600px" }}>
          <h2>Shopping List</h2>
          <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
            {items.map((item: OpaqueRef<ShoppingItem>, index) => (
              <div
                style={{ display: "flex", gap: "8px", alignItems: "center" }}
              >
                <ct-checkbox $checked={item.done}>
                  <span
                    style={item.done ? { textDecoration: "line-through" } : {}}
                  >
                    {item.name}
                  </span>
                </ct-checkbox>
                <ct-input
                  $value={item.category}
                  placeholder="Category"
                  customStyle="width: 120px;"
                />
                <ct-button onClick={removeItem({ items, index })}>×</ct-button>
              </div>
            ))}
          </div>

          <ct-message-input
            placeholder="Add item..."
            onct-send={addItem({ items })}
          />
        </div>
      ),
      items,
    };
  },
);
