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
  navigateTo,
  OpaqueRef,
  pattern,
  patternTool,
  Stream,
  UI,
  Writable,
} from "commontools";
import StoreMapper from "./store-mapper.tsx";

// Item with optional aisle override for manual corrections
interface ShoppingItem {
  title: string;
  done: Default<boolean, false>;
  aisleSeed: Default<number, 0>;
  aisleOverride: Default<string, "">; // User's manual aisle selection
}

// AI categorization result
interface AisleResult {
  location: string;
}

interface Input {
  items: Writable<Default<ShoppingItem[], []>>;
  storeLayout: Writable<Default<string, "">>; // Markdown store layout from Store Mapper
}

/** Shopping list with AI-powered aisle sorting. #shoppingList */
interface Output {
  items: ShoppingItem[];
  totalCount: number;
  doneCount: number;
  remainingCount: number;
  storeLayout: string;
  // Omnibot handlers
  addItem: OpaqueRef<Stream<{ detail: { message: string } }>>;
  addItemForOmnibot: OpaqueRef<Stream<{ itemText: string }>>;
  addItems: OpaqueRef<Stream<{ itemNames: string[] }>>;
}

// Demo store layout from Andronico's on Shattuck (community-patterns)
// Used as fallback when no actual store layout is connected
const DEMO_STORE_LAYOUT = `# Aisle 1
Soda & Beverages
- Soda
- Sparkling Water
- Soft Drinks
- Beverages

# Aisle 2
Frozen Foods
- Breakfast
- Pizza
- Vegetables
- Frozen Dinners

# Aisle 3
Cleaning & Paper
- Charcoal / Logs
- Paper Towels
- Bath Tissue
- Cleaning Supplies
- Laundry

# Aisle 4
Health & Beauty
- Oral Care
- Skin Care
- Shampoo
- Hair Care

# Aisle 5
Pet & Baby
- Cat Food
- Dog Food
- Baby Food
- Feminine Care
- Diapers

# Aisle 6
International & Pasta
- Asian
- Hispanic
- Packaged Dinners
- Soups
- Pasta

# Aisle 7
Condiments & Cereal
- Condiments
- Pickles & Olives
- Cereal
- Hot Cereal

# Aisle 8
Baking & Spices
- Cups & Plates
- Peanut Butter & Jam
- Flour
- Cooking Oil
- Spices

# Aisle 9
Coffee & Snacks
- Coffee
- Tea
- Crackers
- Cookies
- Popcorn & Nuts

# Aisle 10
Wine & Candy
- Wine
- Juices
- Candy

# Aisle 11
Spirits
- Champagne
- Spirits
- Wine
- Mixers

# Aisle 12
Beer & Chips
- Beer
- Cold Beverages
- Chips & Salsa
- Water

# Bakery (right)
Fresh baked goods

# Produce (right)
Fresh fruits and vegetables

# Bulk Bins (right)
Bulk dry goods, nuts, grains

# Deli (back)
Prepared foods and deli meats

# Fromagerie (back)
Artisan cheese counter

# Butcher (back)
Meat counter

# Seafood (back)
Fresh seafood counter

# Dairy (left)
Milk, yogurt, cheese

# Eggs (left)
Fresh eggs

# Breakfast Meats & Sausage (left)
Bacon, sausage, breakfast meats
`;

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
    aisleOverride: "",
  });
});

// Handler for omnibot to add a single item
const addItemForOmnibot = handler<
  { itemText: string },
  { items: Writable<ShoppingItem[]> }
>(({ itemText }, { items }) => {
  if (itemText && itemText.trim()) {
    items.push({
      title: itemText.trim(),
      done: false,
      aisleSeed: 0,
      aisleOverride: "",
    });
  }
});

// Handler for omnibot to add multiple items at once
const addItems = handler<
  { itemNames: string[] },
  { items: Writable<ShoppingItem[]> }
>(({ itemNames }, { items }) => {
  itemNames.forEach((name) => {
    if (name && name.trim()) {
      items.push({
        title: name.trim(),
        done: false,
        aisleSeed: 0,
        aisleOverride: "",
      });
    }
  });
});

// Search sub-pattern for patternTool - filters items by query
const searchItemsPattern = pattern<
  { items: ShoppingItem[]; query: string },
  ShoppingItem[]
>(({ items, query }) => {
  return computed(() =>
    items.filter((item: ShoppingItem) =>
      item.title.toLowerCase().includes(query.toLowerCase())
    )
  );
});

// Handler to navigate to store mapper
const openStoreMapper = handler<unknown, Record<string, never>>(
  (_event, _state) => {
    return navigateTo(
      StoreMapper({
        storeName: "My Store",
        aisles: [],
        departments: [],
        entrances: [],
        itemLocations: [],
      }),
    );
  },
);

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

// Handler for opening correction panel
const openCorrection = handler<
  unknown,
  {
    items: Writable<ShoppingItem[]>;
    item: ShoppingItem;
    correctionIndex: Writable<number>;
    correctionTitle: Writable<string>;
  }
>((_event, { items, item, correctionIndex, correctionTitle }) => {
  const current = items.get();
  const index = current.findIndex((el) => equals(item, el));
  if (index >= 0) {
    correctionTitle.set(current[index]?.title || "");
    correctionIndex.set(index);
  }
});

// Handler for closing correction panel
const closeCorrection = handler<
  unknown,
  { correctionIndex: Writable<number> }
>((_event, { correctionIndex }) => {
  correctionIndex.set(-1);
});

// Handler for selecting an aisle correction
const selectAisle = handler<
  unknown,
  {
    items: Writable<ShoppingItem[]>;
    correctionIndex: Writable<number>;
    selectedAisle: string;
  }
>((_event, { items, correctionIndex, selectedAisle }) => {
  const idx = correctionIndex.get();
  if (idx >= 0) {
    const itemsList = items.get();
    const item = itemsList[idx];
    if (item) {
      const updated = itemsList.map((i, index) =>
        index === idx
          ? {
            ...i,
            aisleOverride: selectedAisle, // Store user's selection
          }
          : i
      );
      items.set(updated);
    }
  }
  correctionIndex.set(-1);
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
  // Store both index and title when opening correction panel
  const correctionIndex = Writable.of<number>(-1);
  const correctionTitle = Writable.of<string>("");

  // Create search tool for omnibot
  const searchItems = patternTool(searchItemsPattern, { items });

  // Computed for whether correction panel is open
  const isCorrecting = computed(() => correctionIndex.get() >= 0);

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
    ([remaining, done]) => {
      const itemWord = remaining === 1 ? "item" : "items";
      return `${remaining} ${itemWord} to get • ${done} checked off`;
    },
  );

  // Check if a real store layout is connected (not using demo fallback)
  const hasConnectedStore = computed(() => storeLayout.get().trim().length > 0);

  // Effective layout: use connected store or demo fallback
  const effectiveLayout = derive(
    storeLayout,
    (layout: string) => layout.trim().length > 0 ? layout : DEMO_STORE_LAYOUT,
  );

  // Valid locations derived from effective layout
  const validLocations = derive(
    effectiveLayout,
    (layout: string) => extractLocations(layout),
  );

  // AI categorization for each item (uses effectiveLayout which always has a value)
  const itemsWithAisles = items.map((item) => {
    // Build prompt using effective layout + item
    const categorizePrompt = derive(
      [effectiveLayout, item.title, item.aisleSeed],
      ([layout, title, seed]: [string, string, number]) => {
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
        {/* Header */}
        <ct-vstack slot="header" gap="2">
          <ct-hstack justify="between" align="center">
            <ct-heading level={4}>🛒 Shopping List</ct-heading>
          </ct-hstack>
          <ct-hstack gap="2" align="center">
            <span
              style={{
                fontSize: "13px",
                color: "var(--ct-color-gray-500)",
                flex: 1,
              }}
            >
              {statsText}
            </span>
            <ct-button
              variant={ifElse(
                computed(() => viewMode.get() === "quick"),
                "primary",
                "secondary",
              )}
              size="sm"
              onClick={() => viewMode.set("quick")}
            >
              Quick
            </ct-button>
            <ct-button
              variant={ifElse(
                computed(() => viewMode.get() === "sorted"),
                "primary",
                "secondary",
              )}
              size="sm"
              onClick={() => viewMode.set("sorted")}
            >
              📍 Sorted
            </ct-button>
            <ct-button
              variant="secondary"
              size="sm"
              onClick={openStoreMapper({})}
            >
              🗺️ Store
            </ct-button>
          </ct-hstack>
        </ct-vstack>

        {/* Main scrollable content */}
        <ct-vscroll flex showScrollbar fadeEdges>
          <ct-vstack gap="2" style="padding: 1rem; max-width: 800px;">
            {/* Input field at top - with right padding to avoid FAB */}
            <div style={{ paddingRight: "60px" }}>
              <ct-message-input
                placeholder="Type to add item, or ask omnibot..."
                appearance="rounded"
                onct-send={addItem({ items })}
              />
            </div>

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
                    Your shopping list is empty. Type above to add items!
                  </div>,
                  null,
                )}

                {/* Item list */}
                {items.map((item) => (
                  <ct-card>
                    <ct-hstack gap="2" align="center">
                      <ct-checkbox $checked={item.done} />
                      <ct-input
                        $value={item.title}
                        placeholder="Enter item..."
                        style={{
                          flex: 1,
                          border: "none",
                          background: "transparent",
                          textDecoration: ifElse(
                            item.done,
                            "line-through",
                            "none",
                          ),
                          opacity: ifElse(item.done, 0.6, 1),
                        }}
                      />
                      <ct-button
                        variant="ghost"
                        onClick={removeItem({ items, item })}
                      >
                        ×
                      </ct-button>
                    </ct-hstack>
                  </ct-card>
                ))}

                {/* Demo layout notice */}
                {ifElse(
                  derive(hasConnectedStore, (connected: boolean) => !connected),
                  <div
                    style={{
                      textAlign: "center",
                      color: "#f59e0b",
                      background: "#fef3c7",
                      padding: "0.75rem",
                      fontSize: "13px",
                      borderRadius: "6px",
                      border: "1px solid #fcd34d",
                    }}
                  >
                    ⚠️ Using demo store layout (Andronico's). Connect a Store
                    Mapper for your actual store.
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
                          color: "#111827",
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
                      {/* Show aisle - prefer user override, then AI result */}
                      {ifElse(
                        derive(
                          itemWithAisle.item.aisleOverride,
                          (override: string) => !!override,
                        ),
                        <span
                          style={{
                            fontSize: "12px",
                            padding: "4px 8px",
                            borderRadius: "4px",
                            background: "var(--ct-color-green-100)",
                            color: "var(--ct-color-green-700)",
                          }}
                        >
                          {itemWithAisle.item.aisleOverride}
                        </span>,
                        ifElse(
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
                        ),
                      )}
                      {/* Correction button */}
                      <ct-button
                        variant="ghost"
                        onClick={openCorrection({
                          items,
                          item: itemWithAisle.item,
                          correctionIndex,
                          correctionTitle,
                        })}
                        style="font-size: 12px; padding: 4px;"
                      >
                        ✏️
                      </ct-button>
                    </ct-hstack>
                  </ct-card>
                ))}

                {/* Demo layout notice */}
                {ifElse(
                  derive(hasConnectedStore, (connected: boolean) => !connected),
                  <div
                    style={{
                      textAlign: "center",
                      color: "#f59e0b",
                      background: "#fef3c7",
                      padding: "0.75rem",
                      fontSize: "13px",
                      borderRadius: "6px",
                      border: "1px solid #fcd34d",
                    }}
                  >
                    ⚠️ Using demo store layout (Andronico's). Connect a Store
                    Mapper for your actual store.
                  </div>,
                  null,
                )}
              </ct-vstack>,
              null,
            )}
          </ct-vstack>
        </ct-vscroll>

        {/* Correction panel (shown when correcting an item) */}
        {ifElse(
          isCorrecting,
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
                  Where is "{correctionTitle}" actually located?
                </span>
                <ct-button
                  variant="ghost"
                  onClick={closeCorrection({ correctionIndex })}
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
                {validLocations.map((location) => {
                  // Extract raw location string for handler
                  const locationStr = derive(location, (l: string) => l);
                  return (
                    <ct-button
                      variant="secondary"
                      onClick={selectAisle({
                        items,
                        correctionIndex,
                        selectedAisle: locationStr,
                      })}
                    >
                      {location}
                    </ct-button>
                  );
                })}
              </div>
            </ct-vstack>
          </div>,
          null,
        )}
      </ct-screen>
    ),
    items,
    totalCount,
    doneCount,
    remainingCount,
    storeLayout,
    // Omnibot integration
    addItem: addItem({ items }),
    addItemForOmnibot: addItemForOmnibot({ items }),
    addItems: addItems({ items }),
    searchItems,
  };
});
