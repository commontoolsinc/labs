/// <cts-enable />
import {
  Cell,
  cell,
  Default,
  handler,
  NAME,
  OpaqueRef,
  recipe,
  UI,
} from "commontools";

interface ShoppingItem {
  name: string;
  checked: Default<boolean, false>;
  category: Default<string, "Other">;
}

interface ShoppingListInput {
  title: Default<string, "Shopping List">;
  items: Default<ShoppingItem[], []>;
}

interface ShoppingListOutput extends ShoppingListInput {}

// Handler to add a new item
const addItem = handler(
  (
    _event,
    { items, name, category }: {
      items: Cell<ShoppingItem[]>;
      name: Cell<string>;
      category: Cell<string>;
    },
  ) => {
    const nameValue = name.get();
    if (nameValue.trim()) {
      items.push({
        name: nameValue,
        category: category.get(),
        checked: false,
      });
      name.set("");
      category.set("Other");
    }
  },
);

// Handler to remove an item
const removeItem = handler(
  (
    _event,
    { items, item }: {
      items: Cell<Array<Cell<ShoppingItem>>>;
      item: Cell<ShoppingItem>;
    },
  ) => {
    const currentItems = items.get();
    const index = currentItems.findIndex((el) => item.equals(el));
    if (index >= 0) {
      items.set(currentItems.toSpliced(index, 1));
    }
  },
);

export default recipe<ShoppingListInput, ShoppingListOutput>(
  "shopping-list",
  ({ title, items }) => {
    // Input cells for adding new items
    const newItemName = cell("");
    const newItemCategory = cell("Other");

    return {
      [NAME]: title,
      [UI]: (
        <common-vstack gap="md" style="padding: 1rem; max-width: 600px;">
          <ct-input
            $value={title}
            placeholder="List title"
            customStyle="font-size: 24px; font-weight: bold;"
          />

          <ct-card>
            <h3>Items</h3>
            <common-vstack gap="sm">
              {items.map((item: OpaqueRef<ShoppingItem>) => (
                <common-hstack
                  gap="sm"
                  style="align-items: center; padding: 0.5rem; border-bottom: 1px solid #eee;"
                >
                  <ct-checkbox $checked={item.checked} />
                  <common-vstack gap="xs" style="flex: 1;">
                    <span
                      style={item.checked
                        ? "text-decoration: line-through; color: #999;"
                        : ""}
                    >
                      {item.name}
                    </span>
                    <small style="color: #666;">
                      Category: {item.category}
                    </small>
                  </common-vstack>
                  <ct-button
                    size="small"
                    onClick={removeItem({ items, item })}
                  >
                    Remove
                  </ct-button>
                </common-hstack>
              ))}
            </common-vstack>

            <common-hstack gap="sm" style="margin-top: 1rem;">
              <ct-input
                $value={newItemName}
                placeholder="Item name"
                style="flex: 1;"
              />
              <ct-select
                $value={newItemCategory}
                items={[
                  { label: "Produce", value: "Produce" },
                  { label: "Dairy", value: "Dairy" },
                  { label: "Meat", value: "Meat" },
                  { label: "Bakery", value: "Bakery" },
                  { label: "Pantry", value: "Pantry" },
                  { label: "Other", value: "Other" },
                ]}
                style="flex: 0 0 150px;"
              />
              <ct-button
                onClick={addItem({
                  items,
                  name: newItemName,
                  category: newItemCategory,
                })}
              >
                Add Item
              </ct-button>
            </common-hstack>
          </ct-card>
        </common-vstack>
      ),
      title,
      items,
    };
  },
);
