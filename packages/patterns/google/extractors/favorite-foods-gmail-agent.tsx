/// <cts-enable />
/**
 * Favorite Foods Extractor
 *
 * Uses gmail-agentic-search to find food preferences from emails.
 * Looks for restaurant reservations, food delivery orders, recipe emails, etc.
 *
 * UPDATED: Now uses the elegant agentic-tools API (defineItemSchema + listTool)
 * which eliminates the 3x redundancy of interface + input type + schema.
 */
import { computed, Default, NAME, pattern, UI } from "commontools";
import GmailAgenticSearch from "../building-blocks/experimental/gmail-agentic-search.tsx";
import {
  defineItemSchema,
  InferItem,
  listTool,
} from "../building-blocks/util/agentic-tools.ts";

// ============================================================================
// SUGGESTED QUERIES
// ============================================================================
const FOOD_QUERIES = [
  "from:doordash.com subject:order",
  "from:ubereats.com subject:order",
  "from:grubhub.com subject:order",
  "from:opentable.com subject:reservation",
  "from:resy.com subject:reservation",
  "from:yelp.com subject:reservation",
  "subject:recipe from:newsletter",
  'subject:"food delivery" OR subject:"your order"',
  "from:instacart.com subject:order",
  'from:amazon.com subject:"whole foods"',
];

// ============================================================================
// SCHEMA - DEFINED ONCE! (replaces interface + input type + JSON schema)
// ============================================================================
// The new elegant API: define schema once, get type-checked dedupe fields
const FoodSchema = defineItemSchema({
  foodName: {
    type: "string",
    description: "The specific food, cuisine, or restaurant name",
  },
  category: {
    type: "string",
    description: "One of: 'cuisine', 'dish', 'ingredient', 'restaurant'",
  },
  confidence: {
    type: "number",
    description: "0-100 confidence based on frequency",
  },
  sourceEmailId: {
    type: "string",
    description: "The email ID from searchGmail",
  },
  sourceEmailSubject: { type: "string", description: "The email subject" },
  sourceEmailDate: { type: "string", description: "The email date" },
  notes: {
    type: "string",
    description: "Optional context (e.g., 'ordered 5 times')",
  },
}, [
  "foodName",
  "category",
  "confidence",
  "sourceEmailId",
  "sourceEmailSubject",
  "sourceEmailDate",
]);

// Derive TypeScript type from schema (for UI code)
type FoodPreference = InferItem<typeof FoodSchema> & { extractedAt: number };

// ============================================================================
// PATTERN INPUT/OUTPUT
// ============================================================================
interface FavoriteFoodsInput {
  foods?: Default<FoodPreference[], []>;
  lastScanAt?: Default<number, 0>;
  isScanning?: Default<boolean, false>;
  maxSearches?: Default<number, 5>;
}

/** Favorite foods extractor from Gmail. #favoriteFoods */
interface FavoriteFoodsOutput {
  foods: FoodPreference[];
  lastScanAt: number;
  count: number;
}

// ============================================================================
// RESULT SCHEMA
// ============================================================================
const FOODS_RESULT_SCHEMA = {
  type: "object",
  properties: {
    searchesPerformed: {
      type: "array",
      items: {
        type: "object",
        properties: {
          query: { type: "string" },
          emailsFound: { type: "number" },
        },
      },
    },
    foodsFound: {
      type: "number",
      description: "Total count of food preferences found via reportFood",
    },
    summary: {
      type: "string",
      description: "Brief summary of food preferences discovered",
    },
  },
  required: ["foodsFound", "summary"],
};

// ============================================================================
// PATTERN
// ============================================================================

const FavoriteFoodsExtractor = pattern<FavoriteFoodsInput, FavoriteFoodsOutput>(
  ({ foods, lastScanAt, isScanning, maxSearches }) => {
    // ========================================================================
    // CUSTOM TOOL: Report Food Preference
    // NEW ELEGANT API: Single call with type-checked dedupe fields!
    // ========================================================================
    const reportFood = listTool(FoodSchema, {
      items: foods,
      dedupe: ["foodName"], // TypeScript checks this against FoodSchema fields!
      idPrefix: "food",
      timestamp: "extractedAt",
    });

    // ========================================================================
    // DYNAMIC AGENT GOAL
    // ========================================================================
    const agentGoal = computed(() => {
      const found = foods as FoodPreference[];
      const max = maxSearches as number;
      const categories = [...new Set(found.map((f) => f.category))];
      const isQuickMode = max > 0;

      return `Analyze my Gmail to discover my food preferences and favorite foods.

Already discovered: ${found.length} food preferences
Categories found: ${categories.join(", ") || "none yet"}
${isQuickMode ? `\n⚠️ QUICK MODE: Limited to ${max} searches.\n` : ""}

Your task:
1. Search for food delivery orders (DoorDash, UberEats, Grubhub, Instacart)
2. Search for restaurant reservations (OpenTable, Resy, Yelp)
3. Search for recipe newsletters
4. Analyze the emails to identify food preferences

When you find a food preference, call reportFood with:
- foodName: The specific food, cuisine, or restaurant (e.g., "Thai food", "Pizza", "Sushi", "Chipotle")
- category: One of "cuisine", "dish", "ingredient", "restaurant"
- confidence: 0-100 based on how often it appears
- sourceEmailId: The email ID
- sourceEmailSubject: The email subject
- sourceEmailDate: The email date
- notes: Optional context (e.g., "ordered 5 times in past month")

Look for patterns:
- Frequently ordered dishes or restaurants
- Cuisine types that appear often
- Specific ingredients or dietary preferences
- Restaurant reservations

IMPORTANT: Call reportFood for EACH preference as you find it. Don't wait!`;
    });

    // ========================================================================
    // CREATE BASE SEARCHER
    // ========================================================================
    const searcher = GmailAgenticSearch({
      agentGoal,
      systemPrompt: `You are a food preference analyzer.
Your job: Search Gmail to discover the user's favorite foods, cuisines, and restaurants.

You have TWO tools:
1. searchGmail({ query: string }) - Search Gmail and return matching emails
2. reportFood({ foodName, category, confidence, sourceEmailId, sourceEmailSubject, sourceEmailDate, notes? }) - SAVE a discovered food preference

Categories:
- "cuisine": A type of food (Thai, Italian, Mexican, etc.)
- "dish": A specific dish (Pizza, Tacos, Pad Thai, etc.)
- "ingredient": A specific ingredient they seem to prefer
- "restaurant": A specific restaurant they frequent

Report each discovery immediately. Focus on patterns - if someone orders from the same place 3 times, that's a strong signal!`,
      suggestedQueries: FOOD_QUERIES,
      resultSchema: FOODS_RESULT_SCHEMA,
      additionalTools: {
        reportFood: {
          description:
            "Report a discovered food preference. Call this IMMEDIATELY when you identify a food the user likes.",
          handler: reportFood, // Already bound - no second call needed!
        },
      },
      title: "🍕 Favorite Foods Finder",
      scanButtonLabel: "🔍 Discover My Food Preferences",
      maxSearches,
      isScanning,
      lastScanAt,
    });

    // ========================================================================
    // DERIVED VALUES
    // ========================================================================
    const totalFoods = computed(() => (foods as FoodPreference[])?.length || 0);

    const groupedFoods = computed(() => {
      const list = foods as FoodPreference[];
      const groups: Record<string, FoodPreference[]> = {};
      if (!list) return groups;
      for (const f of list) {
        const cat = f.category || "other";
        if (!groups[cat]) groups[cat] = [];
        groups[cat].push(f);
      }
      return groups;
    });

    const categoryLabels: Record<string, string> = {
      cuisine: "🌍 Cuisines",
      dish: "🍽️ Dishes",
      ingredient: "🥗 Ingredients",
      restaurant: "🏪 Restaurants",
      other: "📝 Other",
    };

    // ========================================================================
    // UI
    // ========================================================================

    return {
      [NAME]: "🍕 Favorite Foods Finder",

      // Output
      foods,
      lastScanAt,
      count: totalFoods,

      [UI]: (
        <ct-screen>
          <div slot="header">
            <h2 style={{ margin: "0", fontSize: "18px" }}>
              My Food Preferences
            </h2>
          </div>

          <ct-vscroll flex showScrollbar>
            <ct-vstack style="padding: 16px; gap: 16px;">
              {/* Embed the base searcher - provides auth + scan UI */}
              {searcher as any}

              {/* Stats */}
              <div style={{ fontSize: "13px", color: "#666" }}>
                <div>Total Preferences: {totalFoods}</div>
              </div>

              {/* Foods List - Custom UI */}
              <div>
                <h3 style={{ margin: "0 0 12px 0", fontSize: "15px" }}>
                  Discovered Preferences
                </h3>
                {computed(() => {
                  const groups = groupedFoods as Record<
                    string,
                    FoodPreference[]
                  >;
                  const categories = Object.keys(groups).sort();
                  if (categories.length === 0) {
                    return (
                      <div
                        style={{
                          padding: "24px",
                          textAlign: "center",
                          color: "#999",
                        }}
                      >
                        No food preferences found yet. Click "Discover" to
                        search your emails.
                      </div>
                    );
                  }

                  return categories.map((category) => (
                    <details
                      open
                      style={{
                        border: "1px solid #e0e0e0",
                        borderRadius: "8px",
                        marginBottom: "12px",
                        padding: "12px",
                      }}
                    >
                      <summary
                        style={{
                          cursor: "pointer",
                          fontWeight: "600",
                          fontSize: "14px",
                          marginBottom: "8px",
                        }}
                      >
                        {categoryLabels[category] || category}{" "}
                        ({groups[category].length})
                      </summary>
                      <ct-vstack gap={2} style="padding-left: 16px;">
                        {groups[category].map((f: FoodPreference) => (
                          <div
                            style={{
                              padding: "8px",
                              background: "#f8f9fa",
                              borderRadius: "4px",
                              display: "flex",
                              justifyContent: "space-between",
                              alignItems: "center",
                            }}
                          >
                            <div>
                              <div
                                style={{
                                  fontWeight: "600",
                                  fontSize: "14px",
                                }}
                              >
                                {f.foodName}
                              </div>
                              {f.notes && (
                                <div
                                  style={{
                                    fontSize: "12px",
                                    color: "#666",
                                    marginTop: "2px",
                                  }}
                                >
                                  {f.notes}
                                </div>
                              )}
                              <div style={{ fontSize: "11px", color: "#999" }}>
                                📧 {f.sourceEmailSubject || "Unknown"}
                              </div>
                            </div>
                            <div
                              style={{
                                fontSize: "12px",
                                color: f.confidence >= 80
                                  ? "#059669"
                                  : f.confidence >= 50
                                  ? "#d97706"
                                  : "#6b7280",
                                fontWeight: "600",
                              }}
                            >
                              {f.confidence}%
                            </div>
                          </div>
                        ))}
                      </ct-vstack>
                    </details>
                  ));
                })}
              </div>
            </ct-vstack>
          </ct-vscroll>
        </ct-screen>
      ),
    };
  },
);

export default FavoriteFoodsExtractor;
