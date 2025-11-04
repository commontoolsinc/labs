/// <cts-enable />
import {
  Default,
  derive,
  generateObject,
  NAME,
  recipe,
  str,
  UI,
} from "commontools";

interface ShoppingItem {
  title: string;
  done: Default<boolean, false>;
}

interface AisleSortedInput {
  items: Default<ShoppingItem[], []>;
  storeOutline: string;
  storeName: string;
}

interface AisleSortedOutput {
  items: ShoppingItem[];
  aisleGroups: Record<string, ShoppingItem[]>;
}

export default recipe<AisleSortedInput, AisleSortedOutput>(
  "Aisle-Sorted Shopping List",
  ({ items, storeOutline, storeName }) => {
    // For each item, call generateObject() to get aisle assignment
    const itemAssignments = items.map((item) => {
      const { pending, result } = generateObject({
        schema: { type: "object", properties: { aisle: { type: "string" } } },
        prompt:
          str`Store layout:\n${storeOutline}\n\nItem: ${item.title}\n\nWhich aisle is this item in?`,
        model: "anthropic:claude-sonnet-4-5",
      });

      return {
        item,
        aisle: result?.aisle,
        isPending: pending,
      };
    });

    return {
      [NAME]: derive(storeName, (n) => `${n} List`),
      [UI]: (
        <common-vstack gap="md" style="padding: 1rem;">
          <h2>{derive(storeName, (n) => n)}</h2>
          <common-vstack gap="md">
            {itemAssignments.map((ia) => (
              <ct-card>
                <div style={{ padding: "12px" }}>
                  <div
                    style={{
                      fontWeight: "600",
                      marginBottom: "8px",
                      fontSize: "14px",
                      color: "#666",
                    }}
                  >
                    {ia.isPending ? "Categorizing..." : ia.aisle}
                  </div>
                  <ct-checkbox $checked={ia.item.done}>
                    <span
                      style={ia.item.done
                        ? { textDecoration: "line-through" }
                        : {}}
                    >
                      {ia.item.title}
                    </span>
                  </ct-checkbox>
                </div>
              </ct-card>
            ))}
          </common-vstack>
        </common-vstack>
      ),
      items,
      aisleGroups: {},
    };
  },
);
