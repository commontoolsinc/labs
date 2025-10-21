/// <cts-enable />
import { Cell, Default, handler, NAME, OpaqueRef, recipe, UI } from "commontools";

interface ShoppingItem {
  title: string;
  done: Default<boolean, false>;
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
  items.set([...currentItems, { title: itemName, done: false }]);
});

const removeItem = handler<
  unknown,
  { items: Cell<ShoppingItem[]>; index: number }
>((_event, { items, index }) => {
  const currentItems = items.get();
  items.set(currentItems.toSpliced(index, 1));
});

export default recipe<ShoppingListInput, ShoppingListOutput>(
  "Shopping List (Basic)",
  ({ items }) => {
    return {
      [NAME]: "Shopping List",
      [UI]: (
        <div>
          <h3>Shopping List</h3>
          <div>
            {items.map((item: OpaqueRef<ShoppingItem>, index) => (
              <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                <ct-checkbox $checked={item.done}>
                  <span style={item.done ? { textDecoration: "line-through" } : {}}>
                    {item.title}
                  </span>
                </ct-checkbox>
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
