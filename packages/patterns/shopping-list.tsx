/// <cts-enable />
import { Cell, Default, handler, NAME, OpaqueRef, recipe, UI } from "commontools";

interface ShoppingItem {
  title: string;
  done: Default<boolean, false>;
  category: Default<string, "Uncategorized">;
}

interface ShoppingListInput {
  title: Default<string, "Shopping List">;
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
  items.set([...currentItems, { title: itemName, done: false, category: "Uncategorized" }]);
});

const removeItem = handler<
  unknown,
  { items: Cell<ShoppingItem[]>; index: number }
>((_event, { items, index }) => {
  const currentItems = items.get();
  items.set(currentItems.filter((_, i) => i !== index));
});

export default recipe<ShoppingListInput, ShoppingListOutput>(
  "Shopping List",
  ({ title, items }) => {
    return {
      [NAME]: title,
      [UI]: (
        <common-vstack gap="md" style="padding: 1rem; max-width: 600px;">
          <ct-input
            $value={title}
            placeholder="Shopping list title"
            customStyle="font-size: 24px; font-weight: bold;"
          />

          <ct-card>
            <h3 style="margin-top: 0;">Items</h3>
            <common-vstack gap="sm">
              {items.map((item: OpaqueRef<ShoppingItem>, index) => (
                <div style="display: flex; align-items: center; gap: 8px;">
                  <ct-checkbox $checked={item.done}>
                    <span style={item.done ? "text-decoration: line-through; color: #999;" : ""}>
                      {item.title}
                    </span>
                  </ct-checkbox>
                  <ct-input
                    $value={item.category}
                    placeholder="Category"
                    customStyle="flex: 1; max-width: 150px;"
                  />
                  <ct-button
                    onClick={removeItem({ items, index })}
                    appearance="text"
                    customStyle="color: #999;"
                  >
                    ×
                  </ct-button>
                </div>
              ))}
            </common-vstack>

            <div style="margin-top: 1rem;">
              <ct-message-input
                placeholder="Add new item..."
                button-text="Add"
                appearance="rounded"
                onct-send={addItem({ items })}
              />
            </div>
          </ct-card>
        </common-vstack>
      ),
      title,
      items,
    };
  },
);
