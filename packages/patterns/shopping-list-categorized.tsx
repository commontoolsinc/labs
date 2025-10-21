/// <cts-enable />
import { Default, derive, NAME, OpaqueRef, recipe, UI } from "commontools";

interface ShoppingItem {
  name: string;
  done: Default<boolean, false>;
  category: Default<string, "Other">;
}

interface CategorizedShoppingListInput {
  items: Default<ShoppingItem[], []>;
}

interface CategorizedShoppingListOutput extends CategorizedShoppingListInput {}

export default recipe<
  CategorizedShoppingListInput,
  CategorizedShoppingListOutput
>(
  "Shopping List (By Category)",
  ({ items }) => {
    // Group items by category using derive
    const groupedItems = derive(items, (itemsList) => {
      const groups: Record<string, ShoppingItem[]> = {};

      for (const item of itemsList) {
        const category = item.category || "Other";
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
        <div style={{ padding: "1rem", maxWidth: "600px" }}>
          <h2>Shopping List by Category</h2>
          {categories.map((category) => (
            <div style={{ marginBottom: "1.5rem" }}>
              <h3
                style={{
                  marginTop: 0,
                  color: "#666",
                  fontSize: "14px",
                  textTransform: "uppercase",
                  letterSpacing: "0.5px",
                  borderBottom: "2px solid #eee",
                  paddingBottom: "0.5rem",
                }}
              >
                {category}
              </h3>
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: "8px",
                  marginTop: "0.75rem",
                }}
              >
                {(groupedItems[category] ?? []).map((
                  item: OpaqueRef<ShoppingItem>,
                ) => (
                  <ct-checkbox $checked={item.done}>
                    <span
                      style={item.done ? "text-decoration: line-through;" : ""}
                    >
                      {item.name}
                    </span>
                  </ct-checkbox>
                ))}
              </div>
            </div>
          ))}
        </div>
      ),
      items,
    };
  },
);
