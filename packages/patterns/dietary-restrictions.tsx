/// <cts-enable />
/**
 * Dietary Restrictions Module - Pattern for tracking all dietary needs
 *
 * Handles allergies, intolerances, preferences, and lifestyle diets
 * with a unified severity system that adapts context to the restriction type.
 *
 * Features:
 * - Generic severity levels (Flexible → Prefer → Strict → Absolute)
 * - Contextual descriptions (e.g., "Absolute" shows as "Severe Allergy" for peanuts)
 * - Two-list UI: EXPLICIT (what you added) vs IMPLIED (what it expands to)
 * - Bidirectional autocomplete (typing "milk" suggests "dairy" and vice versa)
 * - Comprehensive dietary patterns (vegetarian, vegan, halal, kosher, keto, etc.)
 */
import {
  computed,
  type Default,
  handler,
  ifElse,
  lift,
  NAME,
  pattern,
  UI,
  Writable,
} from "commontools";
import type { ModuleMetadata } from "./container-protocol.ts";

// ===== Self-Describing Metadata =====
export const MODULE_METADATA: ModuleMetadata = {
  type: "dietary-restrictions",
  label: "Dietary Restrictions",
  icon: "\u{1F37D}\u{FE0F}", // 🍽️ plate with cutlery
  // NOTE: For LLM extraction, we accept structured objects with name and level.
  // The module also accepts plain strings for backwards compatibility,
  // converting them to RestrictionEntry objects with default levels.
  schema: {
    restrictions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description:
              "The restriction (e.g., 'nightshades', 'peanuts', 'vegetarian')",
          },
          level: {
            type: "string",
            enum: ["flexible", "prefer", "strict", "absolute"],
            description:
              "Severity: flexible (if convenient), prefer (unless inconvenient), strict (strong preference), absolute (no exceptions/allergy)",
          },
        },
      },
      description: "Dietary restrictions with severity levels",
    },
  },
  fieldMapping: ["restrictions", "dietary", "allergies", "diet"],
};

// ===== Data Types =====

/**
 * Generic restriction levels that work for both allergies and preferences:
 * - flexible: "If convenient" (e.g., "I'll eat vegetarian if it's easy")
 * - prefer: "Unless inconvenient" (e.g., "I prefer to avoid dairy")
 * - strict: "Strong preference" (e.g., "I don't eat meat")
 * - absolute: "No exceptions" (e.g., "Severe peanut allergy")
 */
export type RestrictionLevel = "flexible" | "prefer" | "strict" | "absolute";

export interface RestrictionEntry {
  name: string;
  level: RestrictionLevel;
}

// Input accepts either string[] (from LLM extraction) or RestrictionEntry[] (from UI)
// The module normalizes strings to RestrictionEntry objects internally
export type RestrictionInput = string | RestrictionEntry;

export interface DietaryRestrictionsInput {
  restrictions: Default<RestrictionInput[], []>;
}

// ===== Restriction Categories =====
// Categories determine contextual labels for severity levels

type RestrictionCategory = "allergy" | "intolerance" | "diet" | "medical";

interface RestrictionGroupInfo {
  members: string[];
  category: RestrictionCategory;
  defaultLevel: RestrictionLevel;
  description?: string;
}

// ===== Level Display Configuration =====

interface LevelConfig {
  bg: string;
  color: string;
  border: string;
  icon: string;
  labels: Record<RestrictionCategory, string>;
}

const LEVEL_CONFIG: Record<RestrictionLevel, LevelConfig> = {
  flexible: {
    bg: "#fef9c3", // yellow-100
    color: "#a16207", // yellow-700
    border: "#fde047", // yellow-300
    icon: "•", // yellow dot
    labels: {
      allergy: "Mild Sensitivity",
      intolerance: "Slight Intolerance",
      diet: "If Convenient",
      medical: "Slight Issue",
    },
  },
  prefer: {
    bg: "#ffedd5", // orange-100
    color: "#c2410c", // orange-700
    border: "#fdba74", // orange-300
    icon: "•", // orange dot
    labels: {
      allergy: "Sensitivity",
      intolerance: "Intolerance",
      diet: "Prefer to Avoid",
      medical: "Should Avoid",
    },
  },
  strict: {
    bg: "#fee2e2", // red-100
    color: "#b91c1c", // red-700
    border: "#fca5a5", // red-300
    icon: "•", // red dot
    labels: {
      allergy: "Allergy",
      intolerance: "Strong Intolerance",
      diet: "Strict",
      medical: "Must Avoid",
    },
  },
  absolute: {
    bg: "#1f2937", // gray-800
    color: "#ffffff", // white
    border: "#374151", // gray-700
    icon: "•", // black/white dot
    labels: {
      allergy: "Severe Allergy",
      intolerance: "Severe Intolerance",
      diet: "Absolute",
      medical: "Dangerous",
    },
  },
};

// ===== Comprehensive Restriction Database =====

const RESTRICTION_GROUPS: Record<string, RestrictionGroupInfo> = {
  // ===== Lifestyle Diets =====
  vegetarian: {
    members: [
      "beef",
      "pork",
      "lamb",
      "chicken",
      "turkey",
      "duck",
      "veal",
      "venison",
      "bacon",
      "ham",
      "sausage",
      "hot dogs",
      "deli meats",
      "pepperoni",
      "salami",
      "prosciutto",
      "gelatin",
      "lard",
      "meat broth",
      "bone broth",
      "fish",
      "salmon",
      "tuna",
      "shrimp",
      "crab",
      "lobster",
      "oysters",
      "anchovies",
    ],
    category: "diet",
    defaultLevel: "strict",
    description: "No meat or fish",
  },
  vegan: {
    members: [
      // All meats
      "beef",
      "pork",
      "lamb",
      "chicken",
      "turkey",
      "duck",
      "veal",
      "venison",
      "bacon",
      "ham",
      "sausage",
      "hot dogs",
      "gelatin",
      "lard",
      // All seafood
      "fish",
      "salmon",
      "tuna",
      "shrimp",
      "crab",
      "lobster",
      "oysters",
      "anchovies",
      // All dairy
      "milk",
      "cheese",
      "butter",
      "yogurt",
      "cream",
      "ice cream",
      "whey",
      "casein",
      "ghee",
      // All eggs
      "eggs",
      "mayonnaise",
      // Other animal products
      "honey",
      "beeswax",
      "lanolin",
      "carmine",
      "shellac",
      "bone char",
    ],
    category: "diet",
    defaultLevel: "strict",
    description: "No animal products",
  },
  pescatarian: {
    members: [
      "beef",
      "pork",
      "lamb",
      "chicken",
      "turkey",
      "duck",
      "veal",
      "venison",
      "bacon",
      "ham",
      "sausage",
      "hot dogs",
      "deli meats",
      "pepperoni",
      "salami",
      "prosciutto",
      "gelatin",
      "lard",
    ],
    category: "diet",
    defaultLevel: "strict",
    description: "No land meat (fish okay)",
  },
  "poultry-free": {
    members: ["chicken", "turkey", "duck", "goose", "quail", "pheasant"],
    category: "diet",
    defaultLevel: "prefer",
    description: "No poultry",
  },
  halal: {
    members: [
      "pork",
      "bacon",
      "ham",
      "lard",
      "pepperoni",
      "salami",
      "prosciutto",
      "alcohol",
      "wine",
      "beer",
      "spirits",
      "gelatin",
      "non-halal meat",
      "blood",
    ],
    category: "diet",
    defaultLevel: "absolute",
    description: "Islamic dietary law",
  },
  kosher: {
    members: [
      "pork",
      "bacon",
      "ham",
      "lard",
      "shellfish",
      "shrimp",
      "crab",
      "lobster",
      "oysters",
      "clams",
      "mussels",
      "scallops",
      "mixing meat and dairy",
      "non-kosher meat",
      "blood",
    ],
    category: "diet",
    defaultLevel: "absolute",
    description: "Jewish dietary law",
  },
  keto: {
    members: [
      "bread",
      "pasta",
      "rice",
      "potatoes",
      "sugar",
      "honey",
      "maple syrup",
      "corn",
      "beans",
      "lentils",
      "oats",
      "cereal",
      "crackers",
      "chips",
      "fruit juice",
      "soda",
      "beer",
      "most fruits",
      "bananas",
      "grapes",
      "mangoes",
    ],
    category: "diet",
    defaultLevel: "prefer",
    description: "Low-carb, high-fat",
  },
  paleo: {
    members: [
      "grains",
      "wheat",
      "bread",
      "pasta",
      "rice",
      "oats",
      "legumes",
      "beans",
      "lentils",
      "peanuts",
      "dairy",
      "milk",
      "cheese",
      "yogurt",
      "refined sugar",
      "processed foods",
      "vegetable oils",
      "canola oil",
      "soybean oil",
    ],
    category: "diet",
    defaultLevel: "prefer",
    description: "Ancestral diet",
  },
  "whole30": {
    members: [
      "sugar",
      "alcohol",
      "grains",
      "legumes",
      "soy",
      "dairy",
      "carrageenan",
      "MSG",
      "sulfites",
      "baked goods",
      "junk food",
    ],
    category: "diet",
    defaultLevel: "strict",
    description: "30-day elimination diet",
  },
  fodmap: {
    members: [
      "garlic",
      "onions",
      "wheat",
      "rye",
      "lactose",
      "milk",
      "apples",
      "pears",
      "watermelon",
      "honey",
      "high fructose corn syrup",
      "beans",
      "lentils",
      "chickpeas",
      "cashews",
      "pistachios",
      "mushrooms",
      "cauliflower",
      "asparagus",
    ],
    category: "medical",
    defaultLevel: "strict",
    description: "Low FODMAP for IBS",
  },

  // ===== Food Allergies (Top 9 + Common) =====
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
      "sour cream",
      "cream cheese",
      "cottage cheese",
      "ricotta",
      "mozzarella",
      "parmesan",
      "brie",
      "gouda",
    ],
    category: "allergy",
    defaultLevel: "strict",
    description: "Milk and milk products",
  },
  eggs: {
    members: [
      "whole eggs",
      "egg whites",
      "egg yolks",
      "mayonnaise",
      "meringue",
      "custard",
      "hollandaise",
      "aioli",
      "egg wash",
      "albumin",
      "lysozyme",
      "globulin",
    ],
    category: "allergy",
    defaultLevel: "strict",
    description: "Eggs and egg-derived ingredients",
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
      "almond butter",
      "almond milk",
      "cashew milk",
      "walnut oil",
      "pralines",
      "marzipan",
      "nougat",
      "gianduja",
    ],
    category: "allergy",
    defaultLevel: "absolute",
    description: "Tree nut allergens",
  },
  peanuts: {
    members: [
      "peanut butter",
      "peanut oil",
      "peanut flour",
      "ground nuts",
      "beer nuts",
      "mixed nuts",
      "arachis oil",
      "monkey nuts",
    ],
    category: "allergy",
    defaultLevel: "absolute",
    description: "Peanut allergens",
  },
  shellfish: {
    members: [
      "shrimp",
      "crab",
      "lobster",
      "crawfish",
      "prawns",
      "langoustine",
      "oysters",
      "clams",
      "mussels",
      "scallops",
      "squid",
      "octopus",
      "abalone",
      "snails",
      "escargot",
    ],
    category: "allergy",
    defaultLevel: "absolute",
    description: "Crustaceans and mollusks",
  },
  fish: {
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
      "swordfish",
      "mahi mahi",
      "snapper",
      "flounder",
      "fish sauce",
      "fish oil",
      "omega-3 supplements",
      "caesar dressing",
      "worcestershire sauce",
    ],
    category: "allergy",
    defaultLevel: "strict",
    description: "Finfish allergens",
  },
  wheat: {
    members: [
      "bread",
      "pasta",
      "flour",
      "cereal",
      "crackers",
      "cookies",
      "cakes",
      "pastries",
      "couscous",
      "bulgur",
      "semolina",
      "durum",
      "farro",
      "seitan",
      "soy sauce",
      "beer",
    ],
    category: "allergy",
    defaultLevel: "strict",
    description: "Wheat allergens",
  },
  soy: {
    members: [
      "tofu",
      "tempeh",
      "edamame",
      "soy milk",
      "soy sauce",
      "miso",
      "soy lecithin",
      "soybean oil",
      "soy protein",
      "textured vegetable protein",
      "TVP",
    ],
    category: "allergy",
    defaultLevel: "strict",
    description: "Soy allergens",
  },
  sesame: {
    members: [
      "sesame seeds",
      "sesame oil",
      "tahini",
      "hummus",
      "halvah",
      "sesame paste",
      "benne seeds",
      "gingelly oil",
    ],
    category: "allergy",
    defaultLevel: "strict",
    description: "Sesame allergens",
  },

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
      "jalapeños",
      "habaneros",
      "hot sauce",
      "salsa",
      "ketchup",
      "marinara",
    ],
    category: "intolerance",
    defaultLevel: "prefer",
    description: "Solanaceae family",
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
      "beer",
      "malt",
      "seitan",
    ],
    category: "intolerance",
    defaultLevel: "strict",
    description: "Gluten-containing grains",
  },
  gluten: {
    members: [
      "wheat",
      "barley",
      "rye",
      "bread",
      "pasta",
      "beer",
      "flour",
      "cereal",
      "crackers",
      "cookies",
      "cakes",
      "soy sauce",
      "malt",
      "seitan",
    ],
    category: "intolerance",
    defaultLevel: "strict",
    description: "All gluten sources",
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
      "hummus",
      "falafel",
    ],
    category: "intolerance",
    defaultLevel: "prefer",
    description: "Bean and legume family",
  },
  alliums: {
    members: [
      "onions",
      "garlic",
      "leeks",
      "shallots",
      "scallions",
      "chives",
      "green onions",
      "spring onions",
    ],
    category: "intolerance",
    defaultLevel: "prefer",
    description: "Onion family",
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
      "collard greens",
      "horseradish",
      "wasabi",
    ],
    category: "intolerance",
    defaultLevel: "flexible",
    description: "Brassica family",
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
      "orange juice",
      "lemonade",
    ],
    category: "allergy",
    defaultLevel: "prefer",
    description: "Citrus fruits",
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
    category: "allergy",
    defaultLevel: "prefer",
    description: "Prunus family fruits",
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
    category: "allergy",
    defaultLevel: "prefer",
    description: "Berry fruits",
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
      "jackfruit",
    ],
    category: "allergy",
    defaultLevel: "prefer",
    description: "Tropical fruits",
  },
  melons: {
    members: [
      "watermelon",
      "cantaloupe",
      "honeydew",
      "casaba",
      "crenshaw",
    ],
    category: "allergy",
    defaultLevel: "flexible",
    description: "Melon family",
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
    category: "allergy",
    defaultLevel: "prefer",
    description: "Edible seeds",
  },
  corn: {
    members: [
      "corn",
      "popcorn",
      "corn syrup",
      "high fructose corn syrup",
      "cornstarch",
      "corn flour",
      "corn oil",
      "polenta",
      "grits",
      "tortillas",
      "corn chips",
      "dextrose",
      "maltodextrin",
    ],
    category: "allergy",
    defaultLevel: "prefer",
    description: "Corn and corn-derived",
  },

  // ===== Common Intolerances =====
  lactose: {
    members: [
      "milk",
      "cream",
      "ice cream",
      "soft cheese",
      "cottage cheese",
      "ricotta",
      "whey",
    ],
    category: "intolerance",
    defaultLevel: "prefer",
    description: "Lactose (milk sugar)",
  },
  fructose: {
    members: [
      "apples",
      "pears",
      "mangoes",
      "honey",
      "high fructose corn syrup",
      "agave",
      "fruit juice",
      "dried fruits",
    ],
    category: "intolerance",
    defaultLevel: "prefer",
    description: "Fructose intolerance",
  },
  histamine: {
    members: [
      "aged cheese",
      "fermented foods",
      "wine",
      "beer",
      "sauerkraut",
      "pickles",
      "smoked meats",
      "cured meats",
      "vinegar",
      "soy sauce",
      "canned fish",
      "avocado",
      "spinach",
      "tomatoes",
    ],
    category: "intolerance",
    defaultLevel: "prefer",
    description: "Histamine intolerance",
  },
  sulfites: {
    members: [
      "wine",
      "beer",
      "dried fruits",
      "grape juice",
      "pickles",
      "sauerkraut",
      "vinegar",
      "shrimp",
      "processed potatoes",
      "maraschino cherries",
    ],
    category: "intolerance",
    defaultLevel: "prefer",
    description: "Sulfite sensitivity",
  },
  caffeine: {
    members: [
      "coffee",
      "espresso",
      "tea",
      "black tea",
      "green tea",
      "energy drinks",
      "cola",
      "chocolate",
      "cocoa",
    ],
    category: "intolerance",
    defaultLevel: "flexible",
    description: "Caffeine sensitivity",
  },
  alcohol: {
    members: [
      "wine",
      "beer",
      "spirits",
      "liquor",
      "cocktails",
      "champagne",
      "sake",
      "cooking wine",
      "vanilla extract",
      "rum cake",
    ],
    category: "diet",
    defaultLevel: "strict",
    description: "Alcoholic beverages",
  },

  // ===== Medical Conditions =====
  "g6pd deficiency": {
    members: [
      "fava beans",
      "broad beans",
      "sulfa drugs",
      "certain legumes",
    ],
    category: "medical",
    defaultLevel: "absolute",
    description: "G6PD enzyme deficiency",
  },
  "mast cell": {
    members: [
      "alcohol",
      "fermented foods",
      "aged foods",
      "leftover food",
      "citrus",
      "tomatoes",
      "shellfish",
      "artificial colors",
      "preservatives",
    ],
    category: "medical",
    defaultLevel: "strict",
    description: "Mast cell activation",
  },
  salicylates: {
    members: [
      "aspirin",
      "berries",
      "grapes",
      "oranges",
      "apricots",
      "pineapple",
      "plums",
      "prunes",
      "raisins",
      "almonds",
      "honey",
      "wine",
      "vinegar",
      "mint",
      "spices",
    ],
    category: "intolerance",
    defaultLevel: "prefer",
    description: "Salicylate sensitivity",
  },
  tyramine: {
    members: [
      "aged cheese",
      "cured meats",
      "fermented foods",
      "soy sauce",
      "miso",
      "beer",
      "wine",
      "overripe bananas",
      "avocados",
      "sauerkraut",
    ],
    category: "medical",
    defaultLevel: "prefer",
    description: "Tyramine (MAOi diet)",
  },
  oxalates: {
    members: [
      "spinach",
      "rhubarb",
      "beets",
      "swiss chard",
      "nuts",
      "chocolate",
      "tea",
      "sweet potatoes",
      "beans",
    ],
    category: "medical",
    defaultLevel: "prefer",
    description: "Oxalate restriction",
  },
  purines: {
    members: [
      "organ meats",
      "anchovies",
      "sardines",
      "mussels",
      "scallops",
      "trout",
      "tuna",
      "bacon",
      "beer",
    ],
    category: "medical",
    defaultLevel: "prefer",
    description: "Low-purine (gout)",
  },
};

// Common individual items (not part of groups)
const INDIVIDUAL_ITEMS: string[] = [
  "msg",
  "aspartame",
  "red meat",
  "coconut",
  "avocado",
  "banana",
  "mustard",
  "celery",
  "lupin",
  "mollusks",
  "buckwheat",
  "spelt",
];

// ===== Helper Functions =====

function isGroup(name: string | unknown): boolean {
  if (typeof name !== "string") return false;
  return name.toLowerCase() in RESTRICTION_GROUPS;
}

function getGroup(name: string | unknown): RestrictionGroupInfo | undefined {
  if (typeof name !== "string") return undefined;
  return RESTRICTION_GROUPS[name.toLowerCase()];
}

function getCategory(name: string): RestrictionCategory {
  return getGroup(name)?.category || "allergy";
}

function getDefaultLevel(name: string): RestrictionLevel {
  return getGroup(name)?.defaultLevel || "prefer";
}

/**
 * Normalize a single restriction item to RestrictionEntry format.
 * Accepts both string (from LLM extraction) and RestrictionEntry (from UI).
 * This enables the module to handle extraction data like ["nightshades", "dairy"]
 * as well as existing data like [{ name: "dairy", level: "strict" }].
 *
 * IMPORTANT: When iterating over reactive arrays inside computed(), each item
 * is a proxy object. `typeof item === "string"` returns false for proxies.
 * We must check for object properties first, then coerce to string.
 */
function normalizeRestrictionItem(
  item: string | RestrictionEntry | unknown,
): RestrictionEntry {
  // Skip null/undefined
  if (item == null) {
    return { name: "", level: "prefer" };
  }

  // Handle RestrictionEntry format (from UI or LLM structured extraction) - check first since
  // proxies are objects, and we want to check for .name property explicitly
  if (typeof item === "object" && item !== null) {
    // Check if it has a 'name' property that is a non-empty string
    const maybeEntry = item as { name?: unknown; level?: unknown };
    if (
      maybeEntry.name !== undefined &&
      maybeEntry.name !== null &&
      String(maybeEntry.name).trim() !== ""
    ) {
      const name = String(maybeEntry.name);
      const level = (maybeEntry.level as RestrictionLevel) ||
        getDefaultLevel(name);
      return { name, level };
    }
    // Object without valid name property - coerce to string
    // This handles proxy objects wrapping string values
    const strValue = String(item);
    if (strValue && strValue !== "[object Object]") {
      return { name: strValue, level: getDefaultLevel(strValue) };
    }
    // Fallback for malformed objects
    return { name: "", level: "prefer" };
  }

  // Handle primitive string format (backwards compatibility)
  const strValue = String(item);
  if (strValue && strValue.trim()) {
    return { name: strValue, level: getDefaultLevel(strValue) };
  }

  // Fallback for empty strings or other edge cases
  return { name: "", level: "prefer" };
}

// Build reverse index: member -> parent groups
function buildParentIndex(): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const [groupName, group] of Object.entries(RESTRICTION_GROUPS)) {
    for (const member of group.members) {
      const lower = member.toLowerCase();
      const parents = index.get(lower) || [];
      parents.push(groupName);
      index.set(lower, parents);
    }
  }
  return index;
}

const PARENT_INDEX = buildParentIndex();

function getParentGroups(item: string | unknown): string[] {
  if (typeof item !== "string") return [];
  return PARENT_INDEX.get(item.toLowerCase()) || [];
}

// Get all searchable items for autocomplete
function getAllSearchableItems(): string[] {
  const groups = Object.keys(RESTRICTION_GROUPS);
  const allMembers = Object.values(RESTRICTION_GROUPS).flatMap((g) =>
    g.members
  );
  const unique = [...new Set([...groups, ...allMembers, ...INDIVIDUAL_ITEMS])];
  return unique.sort();
}

/**
 * Bidirectional search:
 * - Matches items containing query
 * - If query matches a group, also suggests its members
 * - If query matches a member, also suggests its parent groups
 */
function _searchRestrictions(input: string, existing: string[]): string[] {
  const query = input.toLowerCase().trim();
  if (!query || query.length < 2) return [];

  const existingLower = new Set(existing.map((e) => e.toLowerCase()));
  const results = new Set<string>();

  // Direct matches
  for (const item of getAllSearchableItems()) {
    if (
      item.toLowerCase().includes(query) &&
      !existingLower.has(item.toLowerCase())
    ) {
      results.add(item);
    }
  }

  // If query matches a group name, suggest its top members
  for (const [groupName, group] of Object.entries(RESTRICTION_GROUPS)) {
    if (groupName.includes(query)) {
      for (const member of group.members.slice(0, 5)) {
        if (!existingLower.has(member.toLowerCase())) {
          results.add(member);
        }
      }
    }
  }

  // If query matches a member, suggest parent groups
  for (const [member, parents] of PARENT_INDEX.entries()) {
    if (member.includes(query)) {
      for (const parent of parents) {
        if (!existingLower.has(parent.toLowerCase())) {
          results.add(parent);
        }
      }
    }
  }

  // Sort: groups first, then members
  return [...results]
    .sort((a, b) => {
      const aIsGroup = isGroup(a);
      const bIsGroup = isGroup(b);
      if (aIsGroup && !bIsGroup) return -1;
      if (!aIsGroup && bIsGroup) return 1;
      return a.localeCompare(b);
    })
    .slice(0, 12);
}

// Get contextual label for a restriction
function _getContextualLabel(name: string, level: RestrictionLevel): string {
  const category = getCategory(name);
  return LEVEL_CONFIG[level].labels[category];
}

// ===== Autocomplete Items =====
// Build items for ct-autocomplete with searchAliases for bidirectional search

interface AutocompleteItem {
  value: string;
  label: string;
  group?: string;
  searchAliases?: string[];
}

function buildAutocompleteItems(): AutocompleteItem[] {
  const items: AutocompleteItem[] = [];
  const allMembers = new Set<string>();

  // Add all groups WITHOUT member aliases (too expensive for large groups)
  // Groups are found by their name directly; members are separate items
  for (const [groupName, info] of Object.entries(RESTRICTION_GROUPS)) {
    items.push({
      value: groupName,
      label: `📦 ${groupName}`,
      group: info.category,
      // No searchAliases - typing "milk" finds "milk" item, "dairy" finds "dairy" group
    });
    info.members.forEach((m) => allMembers.add(m));
  }

  // Add individual members with parent groups as searchAliases
  for (const member of allMembers) {
    const parents = getParentGroups(member);
    items.push({
      value: member,
      label: member,
      group: getCategory(member),
      searchAliases: parents, // Typing "dairy" will match "milk"
    });
  }

  return items;
}

// Lazy-init singleton for autocomplete items (defers work until first use)
let _cachedAutocompleteItems: AutocompleteItem[] | null = null;
function getAutocompleteItems(): AutocompleteItem[] {
  if (!_cachedAutocompleteItems) {
    _cachedAutocompleteItems = buildAutocompleteItems();
  }
  return _cachedAutocompleteItems;
}

// ===== Computed UI helpers (stable identity, no inline callbacks) =====

// Empty state for when no restrictions
const emptyState = (
  <ct-vstack style="padding: 24px; text-align: center; color: #9ca3af;">
    <span style="font-size: 32px; margin-bottom: 8px;">🍽️</span>
    <span>No dietary restrictions added</span>
    <span style="font-size: 13px;">
      Search for allergies, diets (vegetarian, keto), or intolerances
    </span>
  </ct-vstack>
);

// ===== Handlers =====

const _addRestriction = handler<
  unknown,
  {
    restrictions: Writable<RestrictionEntry[]>;
    input: Writable<string>;
    selectedLevel: Writable<RestrictionLevel>;
  }
>((_event, { restrictions, input, selectedLevel }) => {
  const name = input.get().trim();
  if (!name) return;

  // Normalize to handle both string[] and RestrictionEntry[] from storage
  // Filter out null items and empty names to match normalizedRestrictions computed
  const current = (restrictions.get() || [])
    .filter((item) => item != null)
    .map(normalizeRestrictionItem)
    .filter((entry) => entry.name && entry.name.trim() !== "");
  if (current.some((r) => r.name.toLowerCase() === name.toLowerCase())) {
    input.set("");
    return;
  }

  // Use group default level if available
  const level = isGroup(name) ? getDefaultLevel(name) : selectedLevel.get();

  restrictions.set([...current, { name, level }]);
  input.set("");
});

const removeRestriction = handler<
  unknown,
  { restrictions: Writable<RestrictionInput[]>; index: number }
>((_event, { restrictions, index }) => {
  // Use raw index directly since UI iterates over raw restrictions array
  const current = restrictions.get() || [];
  restrictions.set(current.toSpliced(index, 1));
});

const _selectSuggestion = handler<
  unknown,
  {
    restrictions: Writable<RestrictionEntry[]>;
    input: Writable<string>;
    selectedLevel: Writable<RestrictionLevel>;
    suggestion: string;
  }
>((_event, { restrictions, input, selectedLevel, suggestion }) => {
  // Normalize to handle both string[] and RestrictionEntry[] from storage
  const current = (restrictions.get() || []).map(normalizeRestrictionItem);
  if (current.some((r) => r.name.toLowerCase() === suggestion.toLowerCase())) {
    input.set("");
    return;
  }

  const level = isGroup(suggestion)
    ? getDefaultLevel(suggestion)
    : selectedLevel.get();
  restrictions.set([...current, { name: suggestion, level }]);
  input.set("");
});

// Handler for ct-autocomplete's ct-select event
const onSelectRestriction = handler<
  CustomEvent<{ value: string; label: string; isCustom?: boolean }>,
  {
    restrictions: Writable<RestrictionInput[]>;
    selectedLevel: Writable<RestrictionLevel>;
  }
>((event, { restrictions, selectedLevel }) => {
  const { value } = event.detail;
  // Normalize to handle both string[] and RestrictionEntry[] from storage
  const current = (restrictions.get() || []).map(normalizeRestrictionItem);

  // Don't add duplicates
  if (current.some((r) => r.name.toLowerCase() === value.toLowerCase())) {
    return;
  }

  // Use group default level if available, otherwise use selected level
  const level = isGroup(value) ? getDefaultLevel(value) : selectedLevel.get();
  restrictions.set([...current, { name: value, level }]);
});

// ===== Module Pattern =====

// Level priority lookup for fast comparison (avoids indexOf on every comparison)
const LEVEL_PRIORITY: Record<RestrictionLevel, number> = {
  flexible: 0,
  prefer: 1,
  strict: 2,
  absolute: 3,
};

// Helper to get style config for a level - used in UI (module scope for transformer)
const getLevelStyle = lift<RestrictionLevel | string, LevelConfig>(
  (level) => {
    const l = (level || "prefer") as RestrictionLevel;
    return LEVEL_CONFIG[l] || LEVEL_CONFIG.prefer;
  },
);

// Type for implied items array
type ImpliedItemsArray = Array<{
  name: string;
  level: RestrictionLevel;
  sources: string[];
}>;

// Check if implied items array has entries (module scope for transformer)
const hasImpliedItems = lift<ImpliedItemsArray, boolean>(
  (implied) => implied && implied.length > 0,
);

export const DietaryRestrictionsModule = pattern<
  DietaryRestrictionsInput,
  DietaryRestrictionsInput
>("DietaryRestrictionsModule", ({ restrictions }) => {
  const selectedLevel = Writable.of<RestrictionLevel>("prefer");

  // Normalize raw restrictions to RestrictionEntry[] format
  // Handles both string[] (from LLM extraction) and RestrictionEntry[] (from UI)
  const normalizedRestrictions = computed(() => {
    // Inside computed(), access restrictions directly (framework auto-proxies)
    // Cast to expected array type for iteration
    const raw = (restrictions || []) as Array<string | RestrictionEntry>;

    // Defensively filter out null/undefined items (can occur during hydration)
    // Then normalize each item to RestrictionEntry format
    // Finally filter out entries with empty names (can result from malformed data)
    return raw
      .filter((item) => item != null)
      .map(normalizeRestrictionItem)
      .filter((entry) => entry.name && entry.name.trim() !== "");
  });

  // Cache for impliedItems to avoid recomputation when restrictions haven't changed
  let _cachedImpliedItems: Array<{
    name: string;
    level: RestrictionLevel;
    sources: string[];
  }> = [];
  let _lastRestrictionsHash = "";

  // Compute implied items (expanded from groups) - memoized
  // VERIFIED: This computed() only runs when restrictions change, not on autocomplete keypress.
  // Console instrumentation confirmed memoization works correctly (Dec 2025).
  const impliedItems = computed(() => {
    // Access the normalized array - normalizedRestrictions is already a computed OpaqueRef
    const current = (normalizedRestrictions || []) as RestrictionEntry[];

    // Full hash to catch ALL item changes (including middle items)
    // Defensive: handle potentially missing name/level
    const hash = current
      .filter((e) => e?.name)
      .map((e) => `${e.name}:${e.level || "prefer"}`)
      .join("|");
    if (hash === _lastRestrictionsHash) {
      return _cachedImpliedItems;
    }
    _lastRestrictionsHash = hash;

    const implied = new Map<
      string,
      { level: RestrictionLevel; sources: string[] }
    >();

    // Optimized loop with hoisted lookups
    for (let i = 0; i < current.length; i++) {
      const entry = current[i];
      if (!entry?.name) continue; // Skip malformed entries
      const entryName = entry.name;
      const entryLevel = entry.level || "prefer";
      const entryPriority = LEVEL_PRIORITY[entryLevel] || 1;

      const group = getGroup(entryName);
      if (!group) continue; // Skip non-groups early

      const members = group.members;
      for (let j = 0; j < members.length; j++) {
        const lower = members[j].toLowerCase();
        const existing = implied.get(lower);
        if (!existing) {
          implied.set(lower, { level: entryLevel, sources: [entryName] });
        } else if (entryPriority > LEVEL_PRIORITY[existing.level]) {
          existing.level = entryLevel;
          existing.sources.push(entryName); // Mutate instead of spread copy
        } else {
          existing.sources.push(entryName); // Mutate instead of spread copy
        }
      }
    }

    _cachedImpliedItems = [...implied.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([name, info]) => ({ name, ...info }));

    return _cachedImpliedItems;
  });

  const displayText = computed(() => {
    const count = (normalizedRestrictions || []).length || 0;
    if (count === 0) return "None";
    return `${count} restriction${count !== 1 ? "s" : ""}`;
  });

  // Compute whether we have restrictions for conditional rendering
  const hasRestrictions = computed(() => {
    const raw = (restrictions || []) as Array<string | RestrictionEntry>;
    return raw.filter((item) => item != null).length > 0;
  });

  // Level options for ct-select
  const levelOptions = [
    { value: "flexible", label: "Flexible" },
    { value: "prefer", label: "Prefer" },
    { value: "strict", label: "Strict" },
    { value: "absolute", label: "Absolute" },
  ];

  return {
    [NAME]: computed(() => `🍽️ Dietary: ${displayText}`),
    [UI]: (
      <ct-vstack gap="4">
        {/* Input row */}
        <ct-hstack gap="2" align="center">
          <ct-autocomplete
            items={getAutocompleteItems()}
            placeholder="Search allergies, diets, intolerances..."
            allowCustom
            onct-select={onSelectRestriction({ restrictions, selectedLevel })}
            style="flex: 1;"
          />

          <ct-select
            $value={selectedLevel}
            items={levelOptions}
            style="width: 120px;"
          />
        </ct-hstack>

        {/* Restrictions list - map directly over Cell for reactive $value binding */}
        {ifElse(
          hasRestrictions,
          <ct-vstack gap="2">
            <span style="font-size: 12px; font-weight: 600; color: #6b7280; text-transform: uppercase;">
              Your Restrictions
            </span>
            <ct-hstack gap="2" wrap>
              {restrictions.map(
                // deno-lint-ignore no-explicit-any
                (item: any, index: number) => {
                  // Get style reactively based on item.level
                  const style = getLevelStyle(item.level);
                  return (
                    <span
                      key={index}
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: "6px",
                        background: style.bg,
                        color: style.color,
                        border: `1px solid ${style.border}`,
                        borderRadius: "20px",
                        padding: "4px 10px 4px 6px",
                        fontSize: "14px",
                        flexShrink: "0",
                        whiteSpace: "nowrap",
                      }}
                    >
                      <ct-select
                        $value={item.level}
                        items={levelOptions}
                        style={{
                          background: "transparent",
                          border: "none",
                          cursor: "pointer",
                          fontSize: "11px",
                          color: style.color,
                          padding: "2px",
                          borderRadius: "4px",
                          minWidth: "70px",
                        }}
                      />
                      <span style="font-weight: 500;">{item.name}</span>
                      <button
                        type="button"
                        onClick={removeRestriction({
                          restrictions,
                          index,
                        })}
                        style={{
                          background: "none",
                          border: "none",
                          cursor: "pointer",
                          padding: "0",
                          fontSize: "16px",
                          color: style.color,
                          lineHeight: "1",
                          marginLeft: "2px",
                        }}
                        title="Remove"
                      >
                        ×
                      </button>
                    </span>
                  );
                },
              )}
            </ct-hstack>
          </ct-vstack>,
          emptyState,
        )}

        {/* Implied items section */}
        {ifElse(
          hasImpliedItems(impliedItems),
          <ct-vstack
            gap="2"
            style="padding-top: 8px; border-top: 1px solid #e5e7eb;"
          >
            <span style="font-size: 12px; font-weight: 600; color: #6b7280; text-transform: uppercase;">
              What This Means (Avoid These)
            </span>
            <ct-hstack gap="1" wrap>
              {impliedItems.map(
                (
                  item: {
                    name: string;
                    level: RestrictionLevel;
                    sources: string[];
                  },
                  idx: number,
                ) => {
                  const style = getLevelStyle(item.level);
                  return (
                    <span
                      key={idx}
                      style={`display: inline-flex; align-items: center; gap: 4px; background: ${style.bg}; color: ${style.color}; border-radius: 12px; padding: 3px 8px; font-size: 12px;`}
                      title={`From: ${item.sources.join(", ")}`}
                    >
                      {item.name}
                    </span>
                  );
                },
              )}
            </ct-hstack>
          </ct-vstack>,
          null,
        )}
      </ct-vstack>
    ),
    restrictions,
  };
});

export default DietaryRestrictionsModule;
