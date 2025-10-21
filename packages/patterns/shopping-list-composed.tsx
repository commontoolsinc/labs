/// <cts-enable />
import { Default, NAME, recipe, UI } from "commontools";
import ShoppingList from "./shopping-list.tsx";
import ShoppingListCategorized from "./shopping-list-categorized.tsx";

interface ShoppingItem {
  name: string;
  done: Default<boolean, false>;
  category: Default<string, "Other">;
}

interface ComposedInput {
  items: Default<ShoppingItem[], []>;
}

interface ComposedOutput extends ComposedInput {}

export default recipe<ComposedInput, ComposedOutput>(
  "Shopping List - Both Views",
  ({ items }) => {
    // Create pattern instances that share the same items cell
    const basicView = ShoppingList({ items });
    const categoryView = ShoppingListCategorized({ items });

    return {
      [NAME]: "Shopping List - Both Views",
      [UI]: (
        <div style={{ display: "flex", gap: "2rem", padding: "1rem" }}>
          <div style={{ flex: 1 }}>
            <ct-render $cell={basicView} />
          </div>
          <div style={{ flex: 1 }}>
            <ct-render $cell={categoryView} />
          </div>
        </div>
      ),
      items,
    };
  },
);
