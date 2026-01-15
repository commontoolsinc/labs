/// <cts-enable />
/**
 * Test Pattern: Store Mapper
 *
 * Tests the store mapper functionality:
 * - Initial state
 * - Adding aisles
 * - Aisle descriptions
 * - Loading default departments
 * - Department location assignment
 * - Adding item corrections
 * - Outline generation
 * - AI photo import: addExtractedAisle with valid products
 * - AI photo import: addExtractedAisle with null products (graceful handling)
 * - AI photo import: addExtractedAisle duplicate prevention
 * - AI photo import: mergeExtractedAisle product merging
 *
 * Run: deno task ct test packages/patterns/store-mapper.test.tsx --verbose
 */
import { computed, handler, pattern, Writable } from "commontools";
import StoreMapper from "./store-mapper.tsx";

interface Aisle {
  name: string;
  description: string;
}

type WallPosition =
  | "front-left"
  | "front-center"
  | "front-right"
  | "back-left"
  | "back-center"
  | "back-right"
  | "left-front"
  | "left-center"
  | "left-back"
  | "right-front"
  | "right-center"
  | "right-back"
  | "unassigned"
  | "not-in-store"
  | "in-center-aisle";

interface Department {
  name: string;
  icon: string;
  location: WallPosition;
  description: string;
}

interface ItemLocation {
  itemName: string;
  correctAisle: string;
  incorrectAisle: string;
  timestamp: number;
}

// Handler to set aisles
const setAisles = handler<void, { aisles: Writable<Aisle[]>; data: Aisle[] }>(
  (_event, { aisles, data }) => {
    aisles.set([...data]);
  },
);

// Handler to set departments
const setDepts = handler<
  void,
  { departments: Writable<Department[]>; data: Department[] }
>(
  (_event, { departments, data }) => {
    departments.set([...data]);
  },
);

// Handler to set item corrections
const setCorrections = handler<
  void,
  { itemLocations: Writable<ItemLocation[]>; data: ItemLocation[] }
>(
  (_event, { itemLocations, data }) => {
    itemLocations.set([...data]);
  },
);

// Handler to set store name
const setStoreName = handler<
  void,
  { storeName: Writable<string>; name: string }
>(
  (_event, { storeName, name }) => {
    storeName.set(name);
  },
);

// Types for AI photo import testing
interface ExtractedAisle {
  name: string;
  products: string[] | null;
}

// Handler to simulate addExtractedAisle (mirrors store-mapper.tsx implementation)
const addExtractedAisle = handler<
  void,
  { aisles: Writable<Aisle[]>; extracted: ExtractedAisle }
>((_event, { aisles, extracted }) => {
  const current = aisles.get() || [];
  const exists = current.some(
    (a: Aisle) => a.name.toLowerCase() === extracted.name.toLowerCase(),
  );
  if (!exists) {
    aisles.push({
      name: extracted.name,
      description: (extracted.products || []).map((p: string) => `- ${p}`).join(
        "\n",
      ),
    });
  }
});

// Handler to simulate mergeExtractedAisle (mirrors store-mapper.tsx implementation)
const mergeExtractedAisle = handler<
  void,
  { aisles: Writable<Aisle[]>; extracted: ExtractedAisle }
>((_event, { aisles, extracted }) => {
  const current = aisles.get() || [];
  const idx = current.findIndex(
    (a: Aisle) => a.name.toLowerCase() === extracted.name.toLowerCase(),
  );
  if (idx >= 0) {
    const existing = current[idx];
    const existingItems = (existing.description || "")
      .split("\n")
      .map((l) => l.replace(/^-\s*/, "").trim().toLowerCase())
      .filter(Boolean);
    const newProducts = (extracted.products || []).filter(
      (p) => !existingItems.includes(p.toLowerCase()),
    );
    if (newProducts.length > 0) {
      const newDesc = existing.description
        ? existing.description + "\n" +
          newProducts.map((p) => `- ${p}`).join("\n")
        : newProducts.map((p) => `- ${p}`).join("\n");
      aisles.set(
        current.toSpliced(idx, 1, { ...existing, description: newDesc }),
      );
    }
  }
});

export default pattern(() => {
  // Create writable cells that we control
  const storeNameCell = Writable.of("Test Store");
  const aislesCell = Writable.of<Aisle[]>([]);
  const departmentsCell = Writable.of<Department[]>([]);
  const entrancesCell = Writable.of<{ position: WallPosition }[]>([]);
  const itemLocationsCell = Writable.of<ItemLocation[]>([]);

  // Instantiate the store mapper pattern
  const store = StoreMapper({
    storeName: storeNameCell,
    aisles: aislesCell,
    departments: departmentsCell,
    entrances: entrancesCell,
    itemLocations: itemLocationsCell,
  });

  // ==========================================================================
  // Actions
  // ==========================================================================

  const action_add_aisle_1 = setAisles({
    aisles: aislesCell,
    data: [{ name: "1", description: "" }],
  });

  const action_add_aisle_2 = setAisles({
    aisles: aislesCell,
    data: [
      { name: "1", description: "" },
      { name: "2", description: "" },
    ],
  });

  const action_add_aisle_5 = setAisles({
    aisles: aislesCell,
    data: [
      { name: "1", description: "" },
      { name: "2", description: "" },
      { name: "5", description: "" },
    ],
  });

  const action_set_aisle_1_description = setAisles({
    aisles: aislesCell,
    data: [
      { name: "1", description: "Dairy & Eggs" },
      { name: "2", description: "" },
      { name: "5", description: "" },
    ],
  });

  const action_load_departments = setDepts({
    departments: departmentsCell,
    data: [
      { name: "Bakery", icon: "🥖", location: "unassigned", description: "" },
      { name: "Deli", icon: "🥪", location: "unassigned", description: "" },
      { name: "Produce", icon: "🥬", location: "unassigned", description: "" },
    ],
  });

  const action_assign_bakery = setDepts({
    departments: departmentsCell,
    data: [
      { name: "Bakery", icon: "🥖", location: "front-left", description: "" },
      { name: "Deli", icon: "🥪", location: "unassigned", description: "" },
      { name: "Produce", icon: "🥬", location: "unassigned", description: "" },
    ],
  });

  const action_add_coffee_correction = setCorrections({
    itemLocations: itemLocationsCell,
    data: [
      {
        itemName: "Coffee",
        correctAisle: "Aisle 5",
        incorrectAisle: "",
        timestamp: Date.now(),
      },
    ],
  });

  const action_change_store_name = setStoreName({
    storeName: storeNameCell,
    name: "My Grocery Store",
  });

  // ==========================================================================
  // Assertions - use store's computed values where available
  // ==========================================================================

  // Initial state - use computed count values for reliable reactive array length checks
  const assert_initial_store_name = computed(() =>
    String(store.storeName) === "Test Store"
  );
  const assert_initial_no_aisles = computed(() =>
    Number(store.aisleCount) === 0
  );
  // With auto-populated default departments (7 total)
  const assert_initial_default_departments = computed(() =>
    Number(store.deptCount) === 7
  );
  const assert_initial_no_corrections = computed(() =>
    Number(store.correctionCount) === 0
  );

  // After adding aisles - use computed aisleCount for reliable reactive array length checks
  const assert_one_aisle = computed(() => Number(store.aisleCount) === 1);
  const assert_two_aisles = computed(() => Number(store.aisleCount) === 2);
  const assert_three_aisles = computed(() => Number(store.aisleCount) === 3);
  const assert_first_aisle_is_1 = computed(() => store.aisles[0]?.name === "1");

  // After setting description
  const assert_aisle_1_has_description = computed(() =>
    store.aisles[0]?.description === "Dairy & Eggs"
  );

  // After loading departments - use computed deptCount for reliable reactive array length checks
  const assert_three_departments = computed(() =>
    Number(store.deptCount) === 3
  );
  const assert_bakery_exists = computed(() =>
    store.departments[0]?.name === "Bakery"
  );
  const assert_bakery_unassigned = computed(() =>
    store.departments[0]?.location === "unassigned"
  );

  // After assigning location
  const assert_bakery_assigned = computed(() =>
    store.departments[0]?.location === "front-left"
  );

  // After adding correction - use computed correctionCount for reliable reactive array length checks
  const assert_one_correction = computed(() =>
    Number(store.correctionCount) === 1
  );
  const assert_coffee_correction = computed(() =>
    store.itemLocations[0]?.itemName === "Coffee" &&
    store.itemLocations[0]?.correctAisle === "Aisle 5"
  );

  // Outline generation
  const assert_outline_contains_aisle_1 = computed(() =>
    String(store.outline).includes("# Aisle 1")
  );
  const assert_outline_contains_description = computed(() =>
    String(store.outline).includes("Dairy & Eggs")
  );
  const assert_outline_contains_bakery = computed(() =>
    String(store.outline).includes("# Bakery")
  );
  const assert_outline_contains_coffee = computed(() =>
    String(store.outline).includes("Coffee")
  );

  // Store name change
  const assert_store_name_changed = computed(() =>
    String(store.storeName) === "My Grocery Store"
  );

  // ==========================================================================
  // AI Photo Import Handler Actions
  // ==========================================================================

  // Test 9: addExtractedAisle with valid products
  const action_add_extracted_aisle_8 = addExtractedAisle({
    aisles: aislesCell,
    extracted: { name: "8", products: ["Bread", "Cereal", "Coffee"] },
  });

  // Test 10: addExtractedAisle with null products (should not crash)
  const action_add_extracted_aisle_9_null_products = addExtractedAisle({
    aisles: aislesCell,
    extracted: { name: "9", products: null },
  });

  // Test 11: addExtractedAisle duplicate (should not add - aisle "8" already exists)
  const action_add_extracted_aisle_8_duplicate = addExtractedAisle({
    aisles: aislesCell,
    extracted: { name: "8", products: ["Snacks", "Chips"] },
  });

  // Test 12: mergeExtractedAisle - merge new products into existing aisle 8
  const action_merge_extracted_aisle_8 = mergeExtractedAisle({
    aisles: aislesCell,
    extracted: { name: "8", products: ["Tea", "Coffee", "Sugar"] }, // Coffee is duplicate, Tea and Sugar are new
  });

  // ==========================================================================
  // AI Photo Import Handler Assertions
  // ==========================================================================

  // After adding extracted aisle 8
  const assert_four_aisles = computed(() => Number(store.aisleCount) === 4);
  const assert_aisle_8_exists = computed(() =>
    store.aisles.some((a: Aisle) => a.name === "8")
  );
  const assert_aisle_8_has_products = computed(() => {
    const aisle8 = store.aisles.find((a: Aisle) => a.name === "8");
    return aisle8 &&
      String(aisle8.description).includes("Bread") &&
      String(aisle8.description).includes("Cereal") &&
      String(aisle8.description).includes("Coffee");
  });

  // After adding extracted aisle 9 with null products
  const assert_five_aisles = computed(() => Number(store.aisleCount) === 5);
  const assert_aisle_9_exists = computed(() =>
    store.aisles.some((a: Aisle) => a.name === "9")
  );
  const assert_aisle_9_empty_description = computed(() => {
    const aisle9 = store.aisles.find((a: Aisle) => a.name === "9");
    return aisle9 && String(aisle9.description) === "";
  });

  // After attempting to add duplicate aisle 8 (count should remain 5)
  const assert_still_five_aisles = computed(() =>
    Number(store.aisleCount) === 5
  );
  const assert_aisle_8_unchanged = computed(() => {
    const aisle8 = store.aisles.find((a: Aisle) => a.name === "8");
    // Description should NOT contain Snacks or Chips from the duplicate attempt
    return aisle8 &&
      !String(aisle8.description).includes("Snacks") &&
      !String(aisle8.description).includes("Chips");
  });

  // After merging into aisle 8
  const assert_aisle_8_merged = computed(() => {
    const aisle8 = store.aisles.find((a: Aisle) => a.name === "8");
    // Should have original items plus Tea and Sugar, but Coffee only once
    return aisle8 &&
      String(aisle8.description).includes("Bread") &&
      String(aisle8.description).includes("Tea") &&
      String(aisle8.description).includes("Sugar");
  });
  const assert_aisle_8_no_duplicate_coffee = computed(() => {
    const aisle8 = store.aisles.find((a: Aisle) => a.name === "8");
    if (!aisle8) return false;
    // Count occurrences of "Coffee" in description
    const matches = String(aisle8.description).match(/Coffee/g);
    return matches && matches.length === 1;
  });

  // ==========================================================================
  // Test Sequence
  // ==========================================================================
  return {
    tests: [
      // === Test 1: Initial state ===
      { assertion: assert_initial_store_name },
      { assertion: assert_initial_no_aisles },
      { assertion: assert_initial_default_departments },
      { assertion: assert_initial_no_corrections },

      // === Test 2: Add aisles ===
      { action: action_add_aisle_1 },
      { assertion: assert_one_aisle },
      { assertion: assert_first_aisle_is_1 },
      { action: action_add_aisle_2 },
      { assertion: assert_two_aisles },
      { action: action_add_aisle_5 },
      { assertion: assert_three_aisles },

      // === Test 3: Set aisle description ===
      { action: action_set_aisle_1_description },
      { assertion: assert_aisle_1_has_description },

      // === Test 4: Load departments ===
      { action: action_load_departments },
      { assertion: assert_three_departments },
      { assertion: assert_bakery_exists },
      { assertion: assert_bakery_unassigned },

      // === Test 5: Assign department location ===
      { action: action_assign_bakery },
      { assertion: assert_bakery_assigned },

      // === Test 6: Add item correction ===
      { action: action_add_coffee_correction },
      { assertion: assert_one_correction },
      { assertion: assert_coffee_correction },

      // === Test 7: Verify outline generation ===
      { assertion: assert_outline_contains_aisle_1 },
      { assertion: assert_outline_contains_description },
      { assertion: assert_outline_contains_bakery },
      { assertion: assert_outline_contains_coffee },

      // === Test 8: Store name change ===
      { action: action_change_store_name },
      { assertion: assert_store_name_changed },

      // === Test 9: Add extracted aisle with valid products ===
      { action: action_add_extracted_aisle_8 },
      { assertion: assert_four_aisles },
      { assertion: assert_aisle_8_exists },
      { assertion: assert_aisle_8_has_products },

      // === Test 10: Add extracted aisle with null products (should not crash) ===
      { action: action_add_extracted_aisle_9_null_products },
      { assertion: assert_five_aisles },
      { assertion: assert_aisle_9_exists },
      { assertion: assert_aisle_9_empty_description },

      // === Test 11: Add duplicate extracted aisle (should not add) ===
      { action: action_add_extracted_aisle_8_duplicate },
      { assertion: assert_still_five_aisles },
      { assertion: assert_aisle_8_unchanged },

      // === Test 12: Merge products into existing aisle ===
      { action: action_merge_extracted_aisle_8 },
      { assertion: assert_aisle_8_merged },
      { assertion: assert_aisle_8_no_duplicate_coffee },
    ],
    store,
  };
});
