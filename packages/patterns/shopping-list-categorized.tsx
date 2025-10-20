/// <cts-enable />
import { Default, derive, NAME, OpaqueRef, recipe, UI } from "commontools";

interface ShoppingItem {
  title: string;
  done: Default<boolean, false>;
  category: Default<string, "Uncategorized">;
}

interface CategorizedListInput {
  title: Default<string, "Shopping List (by Category)">;
  items: Default<ShoppingItem[], []>;
}

interface CategorizedListOutput extends CategorizedListInput {}

export default recipe<CategorizedListInput, CategorizedListOutput>(
  "Shopping List (Categorized)",
  ({ title, items }) => {
    // Group items by category
    const groupedItems = derive(items, (itemsList) => {
      const groups: Record<string, ShoppingItem[]> = {};

      for (const item of itemsList) {
        const category = item.category || "Uncategorized";
        if (!groups[category]) {
          groups[category] = [];
        }
        groups[category].push(item);
      }

      return groups;
    });

    // Get sorted category names
    const categories = derive(groupedItems, (groups) => {
      return Object.keys(groups).sort();
    });

    return {
      [NAME]: title,
      [UI]: (
        <common-vstack gap="md" style="padding: 1rem; max-width: 600px;">
          <ct-input
            $value={title}
            placeholder="Shopping list title"
            customStyle="font-size: 24px; font-weight: bold;"
          />

          <common-vstack gap="md">
            {categories.map((category) => (
              <ct-card>
                <h3 style="margin-top: 0;">{category}</h3>
                <common-vstack gap="sm">
                  {(groupedItems[category] ?? []).map((item: OpaqueRef<ShoppingItem>) => (
                    <div style="display: flex; align-items: center; gap: 8px;">
                      <ct-checkbox $checked={item.done}>
                        <span style={item.done ? "text-decoration: line-through; color: #999;" : ""}>
                          {item.title}
                        </span>
                      </ct-checkbox>
                    </div>
                  ))}
                </common-vstack>
              </ct-card>
            ))}
          </common-vstack>
        </common-vstack>
      ),
      title,
      items,
    };
  },
);
