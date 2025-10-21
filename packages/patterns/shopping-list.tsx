/// <cts-enable />
import {
  Cell,
  Default,
  handler,
  lift,
  NAME,
  OpaqueRef,
  recipe,
  UI,
} from "commontools";

export interface ShoppingItem {
  name: string;
  checked: Default<boolean, false>;
  category: string;
}

interface ShoppingListInput {
  items: Default<ShoppingItem[], []>;
}

interface ShoppingListOutput extends ShoppingListInput {}

const removeItem = handler<
  unknown,
  { items: Cell<ShoppingItem[]>; index: number }
>((_event, { items, index }) => {
  const currentItems = items.get();
  items.set(currentItems.toSpliced(index, 1));
});

const itemCount = lift((items: ShoppingItem[]) => {
  const total = items.length;
  const checked = items.filter((item) => item.checked).length;
  return `${checked}/${total} items`;
});

export default recipe<ShoppingListInput, ShoppingListOutput>(
  "Shopping List",
  ({ items }) => {
    return {
      [NAME]: lift((items: ShoppingItem[]) => {
        const unchecked = items.filter((item) => !item.checked).length;
        return `Shopping List (${unchecked} remaining)`;
      })(items),
      [UI]: (
        <common-vstack gap="md" style="padding: 1rem; max-width: 600px;">
          <h3>Shopping List</h3>

          <ct-card>
            <common-vstack gap="sm">
              <div>Items: {itemCount(items)}</div>

              {items.map((item: OpaqueRef<ShoppingItem>, index) => (
                <common-hstack gap="sm" style="align-items: center;">
                  <ct-checkbox $checked={item.checked}>
                    {item.name}
                  </ct-checkbox>
                  <ct-button
                    size="sm"
                    onClick={removeItem({ items, index })}
                  >
                    Remove
                  </ct-button>
                </common-hstack>
              ))}
            </common-vstack>
          </ct-card>
        </common-vstack>
      ),
      items,
    };
  },
);
