/// <cts-enable />
import { Cell, Default, handler, NAME, recipe, UI } from "commontools";
import ShoppingList, { type ShoppingItem } from "./shopping-list.tsx";
import ShoppingListByCategory from "./shopping-list-by-category.tsx";

interface DemoInput {
  items: Default<ShoppingItem[], []>;
  newItemName: Default<string, "">;
  newItemCategory: Default<string, "groceries">;
}

interface DemoOutput extends DemoInput {
  basicList: any;
  categoryList: any;
}

const addItem = handler<
  unknown,
  {
    items: Cell<ShoppingItem[]>;
    newItemName: Cell<string>;
    newItemCategory: Cell<string>;
  }
>((_event, state) => {
  const name = state.newItemName.get().trim();
  const category = state.newItemCategory.get().trim();
  if (!name) return;

  const currentItems = state.items.get();
  const newItem: ShoppingItem = {
    name,
    checked: false,
    category: category || "uncategorized",
  };

  state.items.set([...currentItems, newItem]);
  state.newItemName.set("");
});

const addSampleItems = handler<unknown, { items: Cell<ShoppingItem[]> }>(
  (_event, state) => {
    const sampleItems: ShoppingItem[] = [
      { name: "Apples", checked: false, category: "produce" },
      { name: "Bananas", checked: false, category: "produce" },
      { name: "Milk", checked: false, category: "dairy" },
      { name: "Cheese", checked: false, category: "dairy" },
      { name: "Bread", checked: false, category: "bakery" },
      { name: "Chicken", checked: false, category: "meat" },
      { name: "Carrots", checked: false, category: "produce" },
      { name: "Yogurt", checked: false, category: "dairy" },
    ];
    state.items.set(sampleItems);
  },
);

const clearAll = handler<unknown, { items: Cell<ShoppingItem[]> }>(
  (_event, state) => {
    state.items.set([]);
  },
);

export default recipe<DemoInput, DemoOutput>(
  "Shopping List Composed Demo",
  ({ items, newItemName, newItemCategory }) => {
    // Create two separate pattern instances that share the same items
    const basicList = ShoppingList({ items });
    const categoryList = ShoppingListByCategory({ items });

    return {
      [NAME]: "Shopping List Composed - Shared Data",
      [UI]: (
        <common-vstack gap="lg" style="padding: 1rem;">
          <h2>Shopping List Demo - Composed Patterns</h2>
          <p>
            This demo uses two separate patterns composed together. Check an
            item in either view and watch it update in both!
          </p>

          <ct-card>
            <h4>Add New Item</h4>
            <common-vstack gap="sm">
              <common-hstack gap="sm">
                <ct-input
                  $value={newItemName}
                  placeholder="Item name (e.g., Tomatoes, Eggs, etc.)"
                  style="flex: 1; min-width: 250px;"
                />
                <ct-select
                  $value={newItemCategory}
                  items={[
                    { label: "Produce", value: "produce" },
                    { label: "Dairy", value: "dairy" },
                    { label: "Bakery", value: "bakery" },
                    { label: "Meat", value: "meat" },
                    { label: "Groceries", value: "groceries" },
                    { label: "Uncategorized", value: "uncategorized" },
                  ]}
                />
                <ct-button
                  onClick={addItem({ items, newItemName, newItemCategory })}
                >
                  Add Item
                </ct-button>
              </common-hstack>

              <common-hstack gap="sm">
                <ct-button onClick={addSampleItems({ items })}>
                  Load Sample Items
                </ct-button>
                <ct-button onClick={clearAll({ items })}>Clear All</ct-button>
              </common-hstack>
            </common-vstack>
          </ct-card>

          <common-hstack gap="lg" style="align-items: flex-start;">
            <div style={{ flex: 1 }}>
              <ct-render $cell={basicList} />
            </div>
            <div style={{ flex: 1 }}>
              <ct-render $cell={categoryList} />
            </div>
          </common-hstack>
        </common-vstack>
      ),
      items,
      newItemName,
      newItemCategory,
      basicList,
      categoryList,
    };
  },
);
