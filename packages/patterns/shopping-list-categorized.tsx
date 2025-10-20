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

interface ShoppingItem {
  name: string;
  checked: Default<boolean, false>;
  category: Default<string, "Other">;
}

interface CategorizedListInput {
  title: Default<string, "Shopping List (By Category)">;
  items: Default<ShoppingItem[], []>;
}

interface CategorizedListOutput extends CategorizedListInput {
  itemsByCategory: Record<string, ShoppingItem[]>;
}

// Group items by category using lift
const groupByCategory = lift((itemsArray: ShoppingItem[]) => {
  const grouped: Record<string, ShoppingItem[]> = {};

  for (const item of itemsArray) {
    const category = item.category || "Other";
    if (!grouped[category]) {
      grouped[category] = [];
    }
    grouped[category].push(item);
  }

  return grouped;
});

// Get items for a specific category
const getItemsForCategory = lift(
  (grouped: Record<string, ShoppingItem[]>, category: string) => {
    return grouped[category] || [];
  },
);

export default recipe<CategorizedListInput, CategorizedListOutput>(
  "shopping-list-categorized",
  ({ title, items }) => {
    const itemsByCategory = groupByCategory(items);

    // Get sorted category names
    const categories = derive(itemsByCategory, (grouped) => {
      return Object.keys(grouped).sort();
    });

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
            <common-vstack gap="lg">
              {categories.map((category) => (
                <common-vstack gap="sm">
                  <h3 style="margin: 0; color: #333; border-bottom: 2px solid #007bff; padding-bottom: 0.25rem;">
                    {category}
                  </h3>
                  <common-vstack gap="xs">
                    {itemsByCategory[category].map(
                      (item: OpaqueRef<ShoppingItem>) => (
                        <common-hstack
                          gap="sm"
                          style="align-items: center; padding: 0.5rem; background: #f9f9f9; border-radius: 4px;"
                        >
                          <ct-checkbox $checked={item.checked} />
                          <span
                            style={
                              item.checked
                                ? "text-decoration: line-through; color: #999; flex: 1;"
                                : "flex: 1;"
                            }
                          >
                            {item.name}
                          </span>
                        </common-hstack>
                      ),
                    )}
                  </common-vstack>
                </common-vstack>
              ))}
            </common-vstack>

            {derive(items, (itemsArray) => itemsArray.length === 0 && (
              <p style="text-align: center; color: #999; padding: 2rem;">
                No items yet. Add items in the main shopping list.
              </p>
            ))}
          </ct-card>
        </common-vstack>
      ),
      title,
      items,
      itemsByCategory,
    };
  },
);
