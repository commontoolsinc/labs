/// <cts-enable />
import {
  Default,
  derive,
  lift,
  NAME,
  OpaqueRef,
  recipe,
  UI,
} from "commontools";
import type { ShoppingItem } from "./shopping-list.tsx";

interface ShoppingListInput {
  items: Default<ShoppingItem[], []>;
}

interface ShoppingListOutput extends ShoppingListInput {}

interface CategoryGroup {
  category: string;
  items: ShoppingItem[];
}

const groupByCategory = (items: ShoppingItem[]): CategoryGroup[] => {
  const groups = new Map<string, ShoppingItem[]>();

  for (const item of items) {
    const category = item.category || "uncategorized";
    if (!groups.has(category)) {
      groups.set(category, []);
    }
    groups.get(category)!.push(item);
  }

  return Array.from(groups.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([category, items]) => ({
      category,
      items,
    }));
};

const itemCount = lift((items: ShoppingItem[]) => {
  const total = items.length;
  const checked = items.filter((item) => item.checked).length;
  return `${checked}/${total} items`;
});

export default recipe<ShoppingListInput, ShoppingListOutput>(
  "Shopping List by Category",
  ({ items }) => {
    const groupedItems = derive(items, groupByCategory);

    return {
      [NAME]: lift((items: ShoppingItem[]) => {
        const unchecked = items.filter((item) => !item.checked).length;
        return `Shopping List by Category (${unchecked} remaining)`;
      })(items),
      [UI]: (
        <common-vstack gap="md" style="padding: 1rem; max-width: 600px;">
          <h3>Shopping List by Category</h3>

          <ct-card>
            <strong>Total: {itemCount(items)}</strong>

            {groupedItems.map((group: OpaqueRef<CategoryGroup>) => (
              <common-vstack gap="sm" style="margin-bottom: 1.5rem;">
                <strong
                  style={{
                    textTransform: "capitalize",
                    color: "#333",
                    borderBottom: "2px solid #ddd",
                    paddingBottom: "0.25rem",
                    display: "block",
                  }}
                >
                  {group.category}
                </strong>

                {(group.items ?? []).map((item: OpaqueRef<ShoppingItem>) => (
                  <common-hstack
                    gap="sm"
                    style="align-items: center; padding-left: 1rem;"
                  >
                    <ct-checkbox $checked={item.checked}>
                      {item.name}
                    </ct-checkbox>
                  </common-hstack>
                ))}
              </common-vstack>
            ))}
          </ct-card>
        </common-vstack>
      ),
      items,
    };
  },
);
