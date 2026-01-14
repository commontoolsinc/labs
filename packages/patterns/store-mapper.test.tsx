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
  const assert_initial_no_departments = computed(() =>
    Number(store.deptCount) === 0
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
  // Test Sequence
  // ==========================================================================
  return {
    tests: [
      // === Test 1: Initial state ===
      { assertion: assert_initial_store_name },
      { assertion: assert_initial_no_aisles },
      { assertion: assert_initial_no_departments },
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
    ],
    store,
  };
});
