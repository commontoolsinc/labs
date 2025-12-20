/// <cts-enable />
/**
 * Allergies Module - Pattern for tracking allergies and sensitivities
 *
 * A composable pattern that can be used standalone or embedded in containers
 * like Record. Features group-based allergies (e.g., "nightshades" includes
 * potatoes, tomatoes, etc.), severity levels, and comprehensive allergy database.
 */
import {
  Cell,
  computed,
  type Default,
  handler,
  lift,
  NAME,
  recipe,
  UI,
} from "commontools";
import type { ModuleMetadata } from "./container-protocol.ts";

// ===== Self-Describing Metadata =====
export const MODULE_METADATA: ModuleMetadata = {
  type: "allergies",
  label: "Allergies",
  icon: "\u{1F6A8}", // 🚨 warning emoji
  schema: {
    allergies: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string", description: "Allergy name or group" },
          severity: {
            type: "string",
            enum: ["mild", "moderate", "severe"],
            description: "Severity level",
          },
        },
      },
      description: "List of allergies with severity",
    },
  },
  fieldMapping: ["allergies"],
};

// ===== Data Types =====

export type AllergySeverity = "mild" | "moderate" | "severe";

export interface AllergyEntry {
  name: string;
  severity: AllergySeverity;
}

export interface AllergiesModuleInput {
  allergies: Default<AllergyEntry[], []>;
}

// ===== Comprehensive Allergy Groups Database =====
// LLM-curated configuration with accurate group memberships

interface AllergyGroupInfo {
  members: string[];
  defaultSeverity: AllergySeverity;
  description?: string;
}

const ALLERGY_GROUPS: Record<string, AllergyGroupInfo> = {
  // ===== Food Families =====
  nightshades: {
    members: [
      "potatoes",
      "tomatoes",
      "eggplant",
      "bell peppers",
      "chili peppers",
      "cayenne",
      "paprika",
      "goji berries",
      "tomatillos",
      "pimentos",
    ],
    defaultSeverity: "moderate",
    description: "Solanaceae family vegetables",
  },
  "tree nuts": {
    members: [
      "almonds",
      "cashews",
      "walnuts",
      "pecans",
      "pistachios",
      "macadamia nuts",
      "brazil nuts",
      "hazelnuts",
      "chestnuts",
      "pine nuts",
    ],
    defaultSeverity: "severe",
    description: "Common tree nut allergens",
  },
  shellfish: {
    members: [
      "shrimp",
      "crab",
      "lobster",
      "crawfish",
      "prawns",
      "oysters",
      "clams",
      "mussels",
      "scallops",
      "squid",
      "octopus",
    ],
    defaultSeverity: "severe",
    description: "Crustaceans and mollusks",
  },
  "stone fruits": {
    members: [
      "peaches",
      "plums",
      "cherries",
      "apricots",
      "nectarines",
      "mangoes",
      "lychee",
    ],
    defaultSeverity: "moderate",
    description: "Prunus family fruits",
  },
  dairy: {
    members: [
      "milk",
      "cheese",
      "butter",
      "yogurt",
      "cream",
      "ice cream",
      "whey",
      "casein",
      "lactose",
      "ghee",
    ],
    defaultSeverity: "moderate",
    description: "Milk-derived products",
  },
  "gluten grains": {
    members: [
      "wheat",
      "barley",
      "rye",
      "spelt",
      "kamut",
      "triticale",
      "semolina",
      "durum",
      "farro",
      "bulgur",
    ],
    defaultSeverity: "moderate",
    description: "Gluten-containing grains",
  },
  legumes: {
    members: [
      "peanuts",
      "soybeans",
      "lentils",
      "chickpeas",
      "black beans",
      "kidney beans",
      "lima beans",
      "peas",
      "navy beans",
      "pinto beans",
    ],
    defaultSeverity: "moderate",
    description: "Bean and legume family",
  },
  alliums: {
    members: ["onions", "garlic", "leeks", "shallots", "scallions", "chives"],
    defaultSeverity: "mild",
    description: "Onion family vegetables",
  },
  cruciferous: {
    members: [
      "broccoli",
      "cauliflower",
      "cabbage",
      "brussels sprouts",
      "kale",
      "bok choy",
      "radishes",
      "arugula",
      "watercress",
    ],
    defaultSeverity: "mild",
    description: "Brassica family vegetables",
  },
  citrus: {
    members: [
      "oranges",
      "lemons",
      "limes",
      "grapefruit",
      "tangerines",
      "clementines",
      "pomelos",
      "kumquats",
    ],
    defaultSeverity: "moderate",
    description: "Citrus fruits",
  },
  berries: {
    members: [
      "strawberries",
      "blueberries",
      "raspberries",
      "blackberries",
      "cranberries",
      "gooseberries",
      "elderberries",
    ],
    defaultSeverity: "moderate",
    description: "Berry fruits",
  },
  finfish: {
    members: [
      "salmon",
      "tuna",
      "cod",
      "halibut",
      "tilapia",
      "trout",
      "mackerel",
      "sardines",
      "anchovies",
      "bass",
    ],
    defaultSeverity: "severe",
    description: "Fish with fins",
  },
  "tropical fruits": {
    members: [
      "pineapple",
      "papaya",
      "kiwi",
      "passion fruit",
      "guava",
      "dragon fruit",
      "starfruit",
    ],
    defaultSeverity: "moderate",
    description: "Tropical and exotic fruits",
  },
  melons: {
    members: [
      "watermelon",
      "cantaloupe",
      "honeydew",
      "casaba",
      "crenshaw",
    ],
    defaultSeverity: "mild",
    description: "Cucurbitaceae melons",
  },
  seeds: {
    members: [
      "sesame",
      "sunflower seeds",
      "pumpkin seeds",
      "poppy seeds",
      "flax seeds",
      "chia seeds",
      "hemp seeds",
    ],
    defaultSeverity: "moderate",
    description: "Edible seeds",
  },

  // ===== Medications =====
  penicillins: {
    members: [
      "penicillin",
      "amoxicillin",
      "ampicillin",
      "piperacillin",
      "oxacillin",
    ],
    defaultSeverity: "severe",
    description: "Penicillin-class antibiotics",
  },
  sulfonamides: {
    members: [
      "sulfamethoxazole",
      "sulfasalazine",
      "sulfadiazine",
      "bactrim",
      "septra",
    ],
    defaultSeverity: "severe",
    description: "Sulfa antibiotics",
  },
  nsaids: {
    members: [
      "ibuprofen",
      "aspirin",
      "naproxen",
      "celecoxib",
      "meloxicam",
      "diclofenac",
      "advil",
      "motrin",
      "aleve",
    ],
    defaultSeverity: "moderate",
    description: "Non-steroidal anti-inflammatory drugs",
  },
  cephalosporins: {
    members: [
      "cephalexin",
      "cefdinir",
      "ceftriaxone",
      "cefuroxime",
      "cefazolin",
    ],
    defaultSeverity: "severe",
    description: "Cephalosporin antibiotics",
  },
  opioids: {
    members: [
      "morphine",
      "codeine",
      "hydrocodone",
      "oxycodone",
      "fentanyl",
      "tramadol",
    ],
    defaultSeverity: "moderate",
    description: "Opioid pain medications",
  },
  "local anesthetics": {
    members: [
      "lidocaine",
      "novocaine",
      "benzocaine",
      "procaine",
      "bupivacaine",
    ],
    defaultSeverity: "moderate",
    description: "Local anesthetic agents",
  },
  "contrast dyes": {
    members: [
      "iodine contrast",
      "gadolinium",
      "barium sulfate",
      "iohexol",
      "iopamidol",
    ],
    defaultSeverity: "severe",
    description: "Medical imaging contrast agents",
  },

  // ===== Environmental =====
  "grass pollens": {
    members: [
      "timothy grass",
      "bermuda grass",
      "kentucky bluegrass",
      "ryegrass",
      "fescue",
    ],
    defaultSeverity: "mild",
    description: "Common grass pollens",
  },
  "tree pollens": {
    members: [
      "oak pollen",
      "birch pollen",
      "cedar pollen",
      "maple pollen",
      "pine pollen",
      "elm pollen",
    ],
    defaultSeverity: "mild",
    description: "Common tree pollens",
  },
  "weed pollens": {
    members: [
      "ragweed",
      "sagebrush",
      "pigweed",
      "lamb's quarters",
      "tumbleweed",
    ],
    defaultSeverity: "mild",
    description: "Common weed pollens",
  },
  molds: {
    members: [
      "aspergillus",
      "penicillium",
      "cladosporium",
      "alternaria",
      "stachybotrys",
      "black mold",
    ],
    defaultSeverity: "moderate",
    description: "Common mold allergens",
  },
  "insect stings": {
    members: [
      "bee stings",
      "wasp stings",
      "hornet stings",
      "yellow jacket stings",
      "fire ant bites",
    ],
    defaultSeverity: "severe",
    description: "Stinging insect venoms",
  },
  "dust mites": {
    members: [
      "house dust mites",
      "dermatophagoides pteronyssinus",
      "dermatophagoides farinae",
    ],
    defaultSeverity: "mild",
    description: "Dust mite allergens",
  },
  "animal dander": {
    members: [
      "cat dander",
      "dog dander",
      "horse dander",
      "rabbit dander",
      "rodent dander",
    ],
    defaultSeverity: "moderate",
    description: "Pet and animal allergens",
  },

  // ===== Chemical/Material =====
  latex: {
    members: [
      "natural rubber latex",
      "latex gloves",
      "latex balloons",
      "rubber bands",
    ],
    defaultSeverity: "severe",
    description: "Natural rubber latex products",
  },
  fragrances: {
    members: [
      "perfumes",
      "colognes",
      "scented lotions",
      "air fresheners",
      "scented candles",
    ],
    defaultSeverity: "mild",
    description: "Artificial fragrances",
  },
  nickel: {
    members: [
      "nickel jewelry",
      "belt buckles",
      "watches",
      "coins",
      "zippers",
    ],
    defaultSeverity: "mild",
    description: "Nickel metal allergy",
  },
  preservatives: {
    members: [
      "parabens",
      "formaldehyde",
      "methylisothiazolinone",
      "benzalkonium chloride",
    ],
    defaultSeverity: "mild",
    description: "Chemical preservatives",
  },
  dyes: {
    members: [
      "hair dye",
      "fabric dye",
      "tattoo ink",
      "food coloring",
      "PPD",
    ],
    defaultSeverity: "moderate",
    description: "Synthetic dyes",
  },
};

// Common individual allergens (not part of groups)
const COMMON_INDIVIDUAL: string[] = [
  "eggs",
  "soy",
  "wheat",
  "sesame",
  "mustard",
  "celery",
  "sulfites",
  "msg",
  "aspartame",
  "red meat",
  "gelatin",
  "corn",
  "yeast",
  "alcohol",
  "caffeine",
  "chocolate",
  "histamine",
  "salicylates",
  "tyramine",
  "coconut",
  "avocado",
  "banana",
];

// ===== Helper Functions =====

function isGroup(name: string): boolean {
  return name.toLowerCase() in ALLERGY_GROUPS;
}

function getGroupMembers(name: string): string[] {
  const group = ALLERGY_GROUPS[name.toLowerCase()];
  return group?.members || [];
}

function getGroupMemberCount(name: string): number {
  return getGroupMembers(name).length;
}

function getDefaultSeverity(name: string): AllergySeverity {
  const group = ALLERGY_GROUPS[name.toLowerCase()];
  return group?.defaultSeverity || "moderate";
}

// Get all suggestions for autocomplete
function getAllSuggestions(): string[] {
  const groups = Object.keys(ALLERGY_GROUPS);
  const allMembers = Object.values(ALLERGY_GROUPS).flatMap((g) => g.members);
  const unique = [...new Set([...groups, ...allMembers, ...COMMON_INDIVIDUAL])];
  return unique.sort();
}

// Filter suggestions based on input
function filterSuggestions(input: string, existing: string[]): string[] {
  const query = input.toLowerCase().trim();
  if (!query) return [];

  const existingLower = existing.map((e) => e.toLowerCase());
  return getAllSuggestions()
    .filter(
      (s) =>
        s.toLowerCase().includes(query) &&
        !existingLower.includes(s.toLowerCase()),
    )
    .slice(0, 10);
}

// ===== Severity Styling =====

const SEVERITY_STYLES: Record<
  AllergySeverity,
  { bg: string; color: string; icon: string }
> = {
  severe: { bg: "#fee2e2", color: "#991b1b", icon: "\u{1F534}" }, // red
  moderate: { bg: "#ffedd5", color: "#9a3412", icon: "\u{1F7E0}" }, // orange
  mild: { bg: "#fef9c3", color: "#854d0e", icon: "\u{1F7E1}" }, // yellow
};

// Lifted helper to get style from severity (handles reactive values)
const getEntryStyle = lift(({ severity }: { severity: AllergySeverity }) => {
  return SEVERITY_STYLES[severity] || SEVERITY_STYLES.moderate;
});

// Lifted helper to get group info (handles reactive values)
const getEntryInfo = lift(({ name }: { name: string }) => {
  const isGroupEntry = isGroup(name);
  const memberCount = isGroupEntry ? getGroupMemberCount(name) : 0;
  const members = isGroupEntry ? getGroupMembers(name) : [];
  return { isGroupEntry, memberCount, members };
});

// ===== Handlers =====

const addAllergy = handler<
  unknown,
  {
    allergies: Cell<AllergyEntry[]>;
    input: Cell<string>;
    selectedSeverity: Cell<AllergySeverity>;
  }
>((_event, { allergies, input, selectedSeverity }) => {
  const name = input.get().trim();
  if (!name) return;

  const current = allergies.get() || [];
  // Check for duplicate (case-insensitive)
  if (current.some((a) => a.name.toLowerCase() === name.toLowerCase())) {
    input.set("");
    return;
  }

  // Use group default severity if available, otherwise use selected
  const severity = isGroup(name)
    ? getDefaultSeverity(name)
    : selectedSeverity.get();

  allergies.set([...current, { name, severity }]);
  input.set("");
});

const removeAllergy = handler<
  unknown,
  { allergies: Cell<AllergyEntry[]>; index: number }
>((_event, { allergies, index }) => {
  const current = allergies.get() || [];
  allergies.set(current.toSpliced(index, 1));
});

const expandGroup = handler<
  unknown,
  { allergies: Cell<AllergyEntry[]>; index: number }
>((_event, { allergies, index }) => {
  const current = allergies.get() || [];
  const entry = current[index];
  if (!entry || !isGroup(entry.name)) return;

  const members = getGroupMembers(entry.name);
  const existingNames = current.map((a) => a.name.toLowerCase());

  // Replace group with individual members (that aren't already present)
  const newMembers = members
    .filter((m) => !existingNames.includes(m.toLowerCase()))
    .map((m) => ({ name: m, severity: entry.severity }));

  const updated = [
    ...current.slice(0, index),
    ...newMembers,
    ...current.slice(index + 1),
  ];
  allergies.set(updated);
});

const selectSuggestion = handler<
  unknown,
  {
    allergies: Cell<AllergyEntry[]>;
    input: Cell<string>;
    selectedSeverity: Cell<AllergySeverity>;
    suggestion: string;
  }
>((_event, { allergies, input, selectedSeverity, suggestion }) => {
  const current = allergies.get() || [];
  if (current.some((a) => a.name.toLowerCase() === suggestion.toLowerCase())) {
    input.set("");
    return;
  }

  const severity = isGroup(suggestion)
    ? getDefaultSeverity(suggestion)
    : selectedSeverity.get();

  allergies.set([...current, { name: suggestion, severity }]);
  input.set("");
});

// ===== Module Recipe =====

export const AllergiesModule = recipe<
  AllergiesModuleInput,
  AllergiesModuleInput
>(
  "AllergiesModule",
  ({ allergies }) => {
    const input = Cell.of<string>("");
    const selectedSeverity = Cell.of<AllergySeverity>("moderate");

    const suggestions = computed(() => {
      const query = input.get();
      if (!query || query.length < 2) return [];
      const existing = (allergies || []).map((a: AllergyEntry) => a.name);
      return filterSuggestions(query, existing);
    });

    const displayText = computed(() => {
      const count = (allergies || []).length || 0;
      if (count === 0) return "None";
      return `${count} allerg${count !== 1 ? "ies" : "y"}`;
    });

    return {
      [NAME]: computed(() => `\u{1F6A8} Allergies: ${displayText}`),
      [UI]: (
        <ct-vstack style={{ gap: "16px" }}>
          {/* Input row */}
          <ct-hstack style={{ gap: "8px", alignItems: "flex-start" }}>
            <ct-vstack style={{ flex: "1", position: "relative" }}>
              <ct-input
                $value={input}
                placeholder="Add allergy..."
                style={{ width: "100%" }}
              />
              {/* Suggestions dropdown - shows when input has 2+ chars */}
              {computed(() => {
                const suggs = suggestions as unknown as string[];
                if (!suggs || suggs.length === 0) return null;

                return (
                  <ct-vstack
                    style={{
                      position: "absolute",
                      top: "100%",
                      left: "0",
                      right: "0",
                      background: "white",
                      border: "1px solid #e5e7eb",
                      borderRadius: "6px",
                      boxShadow: "0 4px 6px -1px rgba(0,0,0,0.1)",
                      zIndex: "100",
                      maxHeight: "200px",
                      overflow: "auto",
                    }}
                  >
                    {suggs.map((suggestion: string) => {
                      const isGroupSugg = isGroup(suggestion);
                      const memberCount = isGroupSugg
                        ? getGroupMemberCount(suggestion)
                        : 0;

                      return (
                        <button
                          type="button"
                          onClick={selectSuggestion({
                            allergies,
                            input,
                            selectedSeverity,
                            suggestion,
                          })}
                          style={{
                            padding: "8px 12px",
                            textAlign: "left",
                            background: "none",
                            border: "none",
                            cursor: "pointer",
                            display: "flex",
                            justifyContent: "space-between",
                            alignItems: "center",
                            borderBottom: "1px solid #f3f4f6",
                          }}
                        >
                          <span>
                            {isGroupSugg ? "\u{1F3F7}\u{FE0F} " : ""}
                            {suggestion}
                          </span>
                          {isGroupSugg && (
                            <span
                              style={{ fontSize: "12px", color: "#6b7280" }}
                            >
                              ({memberCount} items)
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </ct-vstack>
                );
              })}
            </ct-vstack>

            {/* Severity selector */}
            <ct-select
              $value={selectedSeverity}
              items={[
                { value: "mild", label: "\u{1F7E1} Mild" },
                { value: "moderate", label: "\u{1F7E0} Moderate" },
                { value: "severe", label: "\u{1F534} Severe" },
              ]}
              style={{ width: "130px" }}
            />

            <ct-button
              onClick={addAllergy({ allergies, input, selectedSeverity })}
            >
              Add
            </ct-button>
          </ct-hstack>

          {/* Allergy chips */}
          <ct-hstack style={{ gap: "8px", flexWrap: "wrap" }}>
            {allergies.map((entry: AllergyEntry, index: number) => {
              // Use lifted helpers to handle reactive values
              const style = getEntryStyle({ severity: entry.severity });
              const info = getEntryInfo({ name: entry.name });

              return (
                <span
                  key={index}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "6px",
                    background: style.bg,
                    color: style.color,
                    borderRadius: "16px",
                    padding: "6px 12px",
                    fontSize: "14px",
                    position: "relative",
                  }}
                >
                  <span>{style.icon}</span>
                  <span>
                    {entry.name}
                    {info.isGroupEntry && (
                      <span style={{ opacity: "0.7" }}>
                        ({info.memberCount})
                      </span>
                    )}
                  </span>

                  {/* Expand button for groups */}
                  {info.isGroupEntry && (
                    <button
                      type="button"
                      onClick={expandGroup({ allergies, index })}
                      style={{
                        background: "none",
                        border: "none",
                        cursor: "pointer",
                        padding: "0",
                        fontSize: "12px",
                        color: style.color,
                        opacity: "0.7",
                      }}
                      title="Expand to individual items"
                    >
                      ▼
                    </button>
                  )}

                  {/* Remove button */}
                  <button
                    type="button"
                    onClick={removeAllergy({ allergies, index })}
                    style={{
                      background: "none",
                      border: "none",
                      cursor: "pointer",
                      padding: "0",
                      fontSize: "16px",
                      color: style.color,
                      lineHeight: "1",
                    }}
                    title="Remove"
                  >
                    ×
                  </button>
                </span>
              );
            })}
          </ct-hstack>

          {/* Legend */}
          {computed(() => {
            const count = (allergies || []).length || 0;
            if (count === 0) return null;

            return (
              <ct-hstack
                style={{
                  gap: "16px",
                  fontSize: "12px",
                  color: "#6b7280",
                  paddingTop: "8px",
                  borderTop: "1px solid #f3f4f6",
                }}
              >
                <span>🔴 Severe (anaphylaxis risk)</span>
                <span>🟠 Moderate (significant reaction)</span>
                <span>🟡 Mild (discomfort/intolerance)</span>
              </ct-hstack>
            );
          })}
        </ct-vstack>
      ),
      allergies,
    };
  },
);

export default AllergiesModule;
