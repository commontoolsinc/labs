/// <cts-enable />
import { Default, derive, NAME, OpaqueRef, recipe, UI } from "commontools";

interface ShoppingItem {
  title: string;
  done: Default<boolean, false>;
  category: Default<string, "Uncategorized">;
}

interface CategorizedListInput {
  items: Default<ShoppingItem[], []>;
}

interface CategorizedListOutput extends CategorizedListInput {}

export default recipe<CategorizedListInput, CategorizedListOutput>(
  "Shopping List (by Category)",
  ({ items }) => {
    // Group items by category using derive
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
      [NAME]: "Shopping List (by Category)",
      [UI]: (
        <div>
          <h3>By Category</h3>
          {categories.map((category) => (
            <div style={{ marginBottom: "1rem" }}>
              <h4>{category}</h4>
              {(groupedItems[category] ?? []).map((item: OpaqueRef<ShoppingItem>) => (
                <ct-checkbox $checked={item.done}>
                  <span style={item.done ? { textDecoration: "line-through" } : {}}>
                    {item.title}
                  </span>
                </ct-checkbox>
              ))}
            </div>
          ))}
        </div>
      ),
      items,
    };
  },
);
