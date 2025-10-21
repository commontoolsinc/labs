/// <cts-enable />
/**
 * Simple Pattern Composition Example
 *
 * This example demonstrates the minimal pattern for composing two recipes together
 * so they share the same data and update in sync. This is much simpler than the
 * chatbot-note-composed.tsx example and focuses purely on the composition pattern.
 *
 * Key concepts demonstrated:
 * - Creating pattern instances with shared cell references
 * - Using ct-render with $cell attribute (not charm or pattern)
 * - Automatic synchronization between composed patterns
 */
import { Default, NAME, recipe, UI } from "commontools";
import ShoppingListBasic from "./shopping-list-basic.tsx";
import ShoppingListCategorized from "./shopping-list-categorized.tsx";

interface ShoppingItem {
  title: string;
  done: Default<boolean, false>;
  category: Default<string, "Uncategorized">;
}

interface ComposedInput {
  items: Default<ShoppingItem[], []>;
}

interface ComposedOutput extends ComposedInput {}

export default recipe<ComposedInput, ComposedOutput>(
  "Shopping List - Both Views",
  ({ items }) => {
    // Create pattern instances that share the same items cell
    // Both patterns will read from and write to the same underlying data
    const basicView = ShoppingListBasic({ items });
    const categoryView = ShoppingListCategorized({ items });

    return {
      [NAME]: "Shopping List - Both Views",
      [UI]: (
        <div style={{ display: "flex", gap: "2rem", padding: "1rem" }}>
          <div style={{ flex: 1, border: "1px solid #ddd", padding: "1rem", borderRadius: "4px" }}>
            {/* ✅ CORRECT - Use $cell attribute for pattern composition */}
            <ct-render $cell={basicView} />
          </div>
          <div style={{ flex: 1, border: "1px solid #ddd", padding: "1rem", borderRadius: "4px" }}>
            {/* ✅ CORRECT - Use $cell attribute, not charm or pattern */}
            <ct-render $cell={categoryView} />
          </div>
        </div>
      ),
      // Export the shared data so other charms can link to it
      items,
    };
  },
);
