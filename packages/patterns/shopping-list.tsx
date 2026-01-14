/// <cts-enable />
/**
 * Shopping List Pattern
 *
 * A shopping list with two modes:
 * 1. Quick List Mode: Fast, frictionless item entry (default)
 * 2. Sorted Mode: Items grouped by aisle using AI categorization
 *
 * When a store layout is provided, items are categorized by aisle using AI.
 */
import {
  computed,
  Default,
  derive,
  equals,
  generateObject,
  handler,
  ifElse,
  NAME,
  pattern,
  UI,
  Writable,
} from "commontools";

// Item with optional aisle seed for forcing re-categorization
interface ShoppingItem {
  title: string;
  done: Default<boolean, false>;
  aisleSeed: Default<number, 0>;
}

// AI categorization result
interface AisleResult {
  location: string;
}

interface Input {
  items: Writable<Default<ShoppingItem[], []>>;
  storeLayout: Writable<Default<string, "">>; // Markdown store layout from Store Mapper
}

interface Output {
  items: ShoppingItem[];
  totalCount: number;
  doneCount: number;
  remainingCount: number;
  storeLayout: string;
}

// Handler for adding items via the message input
const addItem = handler<
  { detail: { message: string } },
  { items: Writable<ShoppingItem[]> }
>(({ detail }, { items }) => {
  const title = detail?.message?.trim();
  if (!title) return;

  items.push({
    title,
    done: false,
    aisleSeed: 0,
  });
});

// Handler for removing an item
const removeItem = handler<
  unknown,
  { items: Writable<ShoppingItem[]>; item: ShoppingItem }
>((_event, { items, item }) => {
  const current = items.get();
  const index = current.findIndex((el) => equals(item, el));
  if (index >= 0) {
    items.set(current.toSpliced(index, 1));
  }
});

// Extract valid locations from store layout
function extractLocations(layout: string): string[] {
  const locations: string[] = [];
  const lines = layout.split("\n");
  for (const line of lines) {
    const match = line.match(/^#\s*(Aisle \d+[A-Za-z]?|[A-Za-z\s&]+)\s*(\(|$)/);
    if (match) {
      locations.push(match[1].trim());
    }
  }
  locations.push("Other");
  return locations;
}

export default pattern<Input, Output>(({ items, storeLayout }) => {
  // UI state for view mode
  const viewMode = Writable.of<"quick" | "sorted">("quick");
  const correctionItem = Writable.of<ShoppingItem | null>(null);

  // Computed statistics
  const totalCount = computed(() => items.get().length);
  const doneCount = computed(() => items.get().filter((i) => i.done).length);
  const remainingCount = derive(
    [totalCount, doneCount],
    ([total, done]) => total - done,
  );
  // Combined stats string to avoid adjacent reactive text node rendering issues
  const statsText = derive(
    [remainingCount, doneCount],
    ([remaining, done]) => `${remaining} items to get • ${done} checked off`,
  );

  // Check if store layout is available
  const hasStoreLayout = computed(() => storeLayout.get().trim().length > 0);

  // Valid locations derived from layout
  const validLocations = derive(
    storeLayout,
    (layout: string) => extractLocations(layout),
  );

  // AI categorization for each item (only when store layout exists)
  const itemsWithAisles = items.map((item) => {
    // Build prompt using store layout + item
    const categorizePrompt = derive(
      [storeLayout, item.title, item.aisleSeed],
      ([layout, title, seed]: [string, string, number]) => {
        if (!layout.trim()) return "";
        return `Store layout:\n${layout}\n\nItem: ${title}\n\nSeed: ${seed}\n\nWhich aisle or department is this item most likely to be in? Respond with the exact location name.`;
      },
    );

    // Generate location using AI (only if layout exists)
    const aisleResult = generateObject<AisleResult>({
      system:
        "You are a grocery store assistant. Given a store layout and an item, determine which aisle or department the item is most likely to be in. You must respond with one of the exact locations from the store layout, or 'Other' if the item doesn't fit any category.",
      prompt: categorizePrompt,
      model: "anthropic:claude-haiku-4-5",
    });

    return {
      item,
      aisle: aisleResult,
    };
  });

  return {
    [NAME]: "Shopping List",
    [UI]: (
      <ct-screen>
        {/* Header with gradient background */}
        <div
          slot="header"
          style={{
            background: "linear-gradient(135deg, #667eea 0%, #764ba2 100%)",
            borderRadius: "8px",
            padding: "1rem",
            color: "white",
            boxShadow: "0 2px 8px rgba(0,0,0,0.15)",
          }}
        >
          <ct-hstack justify="between" align="center">
            <ct-hstack gap="2" align="center">
              <span style={{ fontSize: "1.5rem" }}>🛒</span>
              <ct-heading level={4} style="color: white; margin: 0;">
                Shopping List
              </ct-heading>
            </ct-hstack>
            {/* View toggle (only show if store layout exists) */}
            {ifElse(
              hasStoreLayout,
              <ct-hstack gap="1">
                <ct-button
                  variant={ifElse(
                    computed(() => viewMode.get() === "quick"),
                    "secondary",
                    "ghost",
                  )}
                  onClick={() => viewMode.set("quick")}
                  style="color: white; border-color: rgba(255,255,255,0.5);"
                >
                  Quick
                </ct-button>
                <ct-button
                  variant={ifElse(
                    computed(() => viewMode.get() === "sorted"),
                    "secondary",
                    "ghost",
                  )}
                  onClick={() => viewMode.set("sorted")}
                  style="color: white; border-color: rgba(255,255,255,0.5);"
                >
                  📍 Sorted
                </ct-button>
              </ct-hstack>,
              null,
            )}
          </ct-hstack>
          <div
            style={{
              fontSize: "13px",
              opacity: 0.9,
              marginTop: "0.5rem",
            }}
          >
            {statsText}
          </div>
        </div>

        {/* Main scrollable content */}
        <ct-vscroll flex showScrollbar fadeEdges>
          <ct-vstack gap="2" style="padding: 1rem; max-width: 800px;">
            {/* QUICK LIST VIEW */}
            {ifElse(
              computed(() => viewMode.get() === "quick"),
              <ct-vstack gap="2">
                {/* Empty state */}
                {ifElse(
                  computed(() => items.get().length === 0),
                  <div
                    style={{
                      textAlign: "center",
                      color: "var(--ct-color-gray-500)",
                      padding: "2rem",
                    }}
                  >
                    Your shopping list is empty. Add items below!
                  </div>,
                  null,
                )}

                {/* Item list */}
                {items.map((item) => (
                  <ct-card>
                    <ct-hstack gap="2" align="center">
                      <ct-checkbox $checked={item.done} />
                      <div
                        style={{
                          flex: 1,
                          textDecoration: ifElse(
                            item.done,
                            "line-through",
                            "none",
                          ),
                          opacity: ifElse(item.done, 0.6, 1),
                        }}
                      >
                        {item.title}
                      </div>
                      <ct-button
                        variant="ghost"
                        onClick={removeItem({ items, item })}
                      >
                        ×
                      </ct-button>
                    </ct-hstack>
                  </ct-card>
                ))}

                {/* Store layout hint */}
                {ifElse(
                  computed(() =>
                    storeLayout.get().trim().length === 0 &&
                    items.get().length > 0
                  ),
                  <div
                    style={{
                      textAlign: "center",
                      color: "var(--ct-color-gray-400)",
                      padding: "1rem",
                      fontSize: "13px",
                    }}
                  >
                    💡 Add a store layout to enable smart sorting by aisle
                  </div>,
                  null,
                )}
              </ct-vstack>,
              null,
            )}

            {/* SORTED VIEW - Shows items with their AI-assigned aisles */}
            {ifElse(
              computed(() => viewMode.get() === "sorted"),
              <ct-vstack gap="2">
                {/* Items with aisles */}
                {itemsWithAisles.map((itemWithAisle) => (
                  <ct-card>
                    <ct-hstack gap="2" align="center">
                      <ct-checkbox $checked={itemWithAisle.item.done} />
                      <div
                        style={{
                          flex: 1,
                          textDecoration: ifElse(
                            itemWithAisle.item.done,
                            "line-through",
                            "none",
                          ),
                          opacity: ifElse(itemWithAisle.item.done, 0.6, 1),
                        }}
                      >
                        {itemWithAisle.item.title}
                      </div>
                      {/* Show aisle */}
                      {ifElse(
                        itemWithAisle.aisle.pending,
                        <span
                          style={{
                            fontSize: "11px",
                            color: "#667eea",
                          }}
                        >
                          🔄 sorting...
                        </span>,
                        <span
                          style={{
                            fontSize: "12px",
                            padding: "4px 8px",
                            borderRadius: "4px",
                            background: "var(--ct-color-blue-100)",
                            color: "var(--ct-color-blue-700)",
                          }}
                        >
                          {derive(
                            itemWithAisle.aisle.result,
                            (r: AisleResult | undefined) =>
                              r?.location || "Other",
                          )}
                        </span>,
                      )}
                      {/* Correction button */}
                      <ct-button
                        variant="ghost"
                        onClick={() => correctionItem.set(itemWithAisle.item)}
                        style="font-size: 12px; padding: 4px;"
                      >
                        ✏️
                      </ct-button>
                    </ct-hstack>
                  </ct-card>
                ))}
              </ct-vstack>,
              null,
            )}
          </ct-vstack>
        </ct-vscroll>

        {/* Correction panel (shown when correcting an item) */}
        {ifElse(
          computed(() => correctionItem.get() !== null),
          <div
            style={{
              position: "fixed",
              bottom: 0,
              left: 0,
              right: 0,
              background: "white",
              borderTop: "3px solid #f59e0b",
              boxShadow: "0 -4px 12px rgba(0,0,0,0.15)",
              padding: "1rem",
              maxHeight: "50vh",
              overflow: "auto",
              zIndex: 1000,
            }}
          >
            <ct-vstack gap="2">
              <ct-hstack justify="between" align="center">
                <span style={{ fontWeight: 500 }}>
                  Where is "{derive(correctionItem, (c: ShoppingItem | null) =>
                    c?.title || "")}" actually located?
                </span>
                <ct-button
                  variant="ghost"
                  onClick={() =>
                    correctionItem.set(null)}
                >
                  ✕ Cancel
                </ct-button>
              </ct-hstack>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fill, minmax(120px, 1fr))",
                  gap: "0.5rem",
                }}
              >
                {validLocations.map((location) => (
                  <ct-button
                    variant="secondary"
                    onClick={() => {
                      // Force re-categorization by incrementing aisleSeed
                      const currentItem = correctionItem.get();
                      if (currentItem) {
                        const itemsList = items.get();
                        const index = itemsList.findIndex((i) =>
                          equals(i, currentItem)
                        );
                        if (index >= 0) {
                          const updated = itemsList.map((i, idx) =>
                            idx === index
                              ? {
                                ...i,
                                aisleSeed: (i.aisleSeed || 0) + 1,
                              }
                              : i
                          );
                          items.set(updated);
                        }
                      }
                      correctionItem.set(null);
                    }}
                  >
                    {location}
                  </ct-button>
                ))}
              </div>
            </ct-vstack>
          </div>,
          null,
        )}

        {/* Footer with input */}
        <div slot="footer" style="padding: 1rem;">
          <ct-message-input
            placeholder="Enter item..."
            appearance="rounded"
            onct-send={addItem({ items })}
          />
        </div>
      </ct-screen>
    ),
    items,
    totalCount,
    doneCount,
    remainingCount,
    storeLayout,
  };
});
