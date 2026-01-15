/// <cts-enable />
/**
 * Test Pattern: Shopping List
 *
 * Tests the core shopping list functionality:
 * - Initial state (empty list)
 * - Adding items
 * - Marking items as done
 * - Removing items
 * - Statistics (totalCount, doneCount, remainingCount)
 *
 * Run: deno task ct test packages/patterns/shopping-list.test.tsx --verbose
 */
import { computed, handler, pattern, Writable } from "commontools";
import ShoppingList from "./shopping-list.tsx";

interface ShoppingItem {
  title: string;
  done: boolean;
  aisleSeed: number;
  aisleOverride: string;
}

// Handler to set items
const setItems = handler<
  void,
  { items: Writable<ShoppingItem[]>; data: ShoppingItem[] }
>(
  (_event, { items, data }) => {
    // Copy to make mutable
    items.set([...data]);
  },
);

// Handler to set store layout
const setLayout = handler<
  void,
  { storeLayout: Writable<string>; layout: string }
>(
  (_event, { storeLayout, layout }) => {
    storeLayout.set(layout);
  },
);

export default pattern(() => {
  // Create writable cells that we control
  const itemsCell = Writable.of<ShoppingItem[]>([]);
  const layoutCell = Writable.of("");

  // Instantiate the shopping list pattern
  const list = ShoppingList({
    items: itemsCell,
    storeLayout: layoutCell,
  });

  // ==========================================================================
  // Actions - bind handlers with hardcoded data
  // ==========================================================================

  const action_add_milk = setItems({
    items: itemsCell,
    data: [{ title: "Milk", done: false, aisleSeed: 0, aisleOverride: "" }],
  });

  const action_add_bread_eggs = setItems({
    items: itemsCell,
    data: [
      { title: "Milk", done: false, aisleSeed: 0, aisleOverride: "" },
      { title: "Bread", done: false, aisleSeed: 0, aisleOverride: "" },
      { title: "Eggs", done: false, aisleSeed: 0, aisleOverride: "" },
    ],
  });

  const action_mark_first_done = setItems({
    items: itemsCell,
    data: [
      { title: "Milk", done: true, aisleSeed: 0, aisleOverride: "" },
      { title: "Bread", done: false, aisleSeed: 0, aisleOverride: "" },
      { title: "Eggs", done: false, aisleSeed: 0, aisleOverride: "" },
    ],
  });

  const action_remove_first = setItems({
    items: itemsCell,
    data: [
      { title: "Bread", done: false, aisleSeed: 0, aisleOverride: "" },
      { title: "Eggs", done: false, aisleSeed: 0, aisleOverride: "" },
    ],
  });

  const action_set_store_layout = setLayout({
    storeLayout: layoutCell,
    layout: `# Aisle 1
Dairy, Milk, Eggs

# Aisle 2
Bread, Bakery

# Produce
Fresh vegetables and fruits
`,
  });

  const action_clear_store_layout = setLayout({
    storeLayout: layoutCell,
    layout: "",
  });

  // ==========================================================================
  // Assertions
  // ==========================================================================

  // Initial state - use totalCount which is computed from items.get().length
  const assert_initial_empty = computed(() => list.totalCount === 0);
  const assert_initial_total_zero = computed(() => list.totalCount === 0);
  const assert_initial_done_zero = computed(() => list.doneCount === 0);
  const assert_initial_remaining_zero = computed(() =>
    list.remainingCount === 0
  );

  // After adding one item
  const assert_one_item = computed(() => list.totalCount === 1);
  const assert_total_one = computed(() => list.totalCount === 1);
  const assert_remaining_one = computed(() => list.remainingCount === 1);
  const assert_first_item_milk = computed(() =>
    list.items[0]?.title === "Milk"
  );

  // After adding three items
  const assert_three_items = computed(() => list.totalCount === 3);
  const assert_total_three = computed(() => list.totalCount === 3);
  const assert_remaining_three = computed(() => list.remainingCount === 3);
  const assert_done_still_zero = computed(() => list.doneCount === 0);

  // After marking first done
  const assert_done_one = computed(() => list.doneCount === 1);
  const assert_remaining_two = computed(() => list.remainingCount === 2);
  const assert_first_is_done = computed(() => list.items[0]?.done === true);

  // After removing first item
  const assert_two_items = computed(() => list.totalCount === 2);
  const assert_total_two = computed(() => list.totalCount === 2);
  const assert_done_zero_after_remove = computed(() => list.doneCount === 0);
  const assert_first_now_bread = computed(() =>
    list.items[0]?.title === "Bread"
  );

  // Store layout
  const assert_no_layout_initially = computed(() =>
    String(list.storeLayout).trim().length === 0
  );
  const assert_has_layout = computed(() =>
    String(list.storeLayout).trim().length > 0
  );
  const assert_layout_cleared = computed(() =>
    String(list.storeLayout).trim().length === 0
  );

  // ==========================================================================
  // Test Sequence
  // ==========================================================================
  return {
    tests: [
      // === Test 1: Initial empty state ===
      { assertion: assert_initial_empty },
      { assertion: assert_initial_total_zero },
      { assertion: assert_initial_done_zero },
      { assertion: assert_initial_remaining_zero },
      { assertion: assert_no_layout_initially },

      // === Test 2: Add first item ===
      { action: action_add_milk },
      { assertion: assert_one_item },
      { assertion: assert_total_one },
      { assertion: assert_remaining_one },
      { assertion: assert_first_item_milk },

      // === Test 3: Add more items ===
      { action: action_add_bread_eggs },
      { assertion: assert_three_items },
      { assertion: assert_total_three },
      { assertion: assert_remaining_three },
      { assertion: assert_done_still_zero },

      // === Test 4: Mark item as done ===
      { action: action_mark_first_done },
      { assertion: assert_done_one },
      { assertion: assert_remaining_two },
      { assertion: assert_first_is_done },

      // === Test 5: Remove item ===
      { action: action_remove_first },
      { assertion: assert_two_items },
      { assertion: assert_total_two },
      { assertion: assert_done_zero_after_remove },
      { assertion: assert_first_now_bread },

      // === Test 6: Store layout ===
      { action: action_set_store_layout },
      { assertion: assert_has_layout },
      { action: action_clear_store_layout },
      { assertion: assert_layout_cleared },
    ],
    list,
  };
});
