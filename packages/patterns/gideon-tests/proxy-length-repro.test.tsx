/// <cts-enable />
/**
 * Test: .length on reactive proxy values from pattern instances.
 *
 * This covers the proxy access patterns we currently rely on:
 * - Direct array outputs support .length and iteration
 * - Computed array outputs support direct .length access
 * - String outputs support direct value comparisons
 *
 * Each approach is tested side-by-side with a workaround so we can
 * see exactly which cases fail.
 *
 * Run: deno task ct test packages/patterns/gideon-tests/proxy-length-repro.test.tsx --verbose
 */
import { action, computed, pattern } from "commontools";
import ProxyLengthRepro from "./proxy-length-repro.tsx";

export default pattern(() => {
  const subject = ProxyLengthRepro({ items: [] });

  const action_add_item = action(() => {
    subject.addItem.send();
  });

  // =========================================================================
  // Group 1: Initial state (empty)
  // =========================================================================

  // Direct .length on array output
  const assert_items_length_direct = computed(
    () => subject.items.length === 0,
  );

  // Spread workaround on array output
  const assert_items_length_spread = computed(
    () => [...subject.items].length === 0,
  );

  // Direct .length on COMPUTED array output
  const assert_filtered_length_direct = computed(
    () => subject.filteredItems.length === 0,
  );

  // String comparison workaround
  const assert_label_not_empty = computed(() => subject.label !== "");

  // Numeric output (no .length needed — control test)
  const assert_count_direct = computed(() => subject.itemCount === 0);

  // =========================================================================
  // Group 2: After adding one item
  // =========================================================================

  // Direct .length on array output after add
  const assert_items_length_direct_after = computed(
    () => subject.items.length === 1,
  );

  // Spread workaround after add
  const assert_items_length_spread_after = computed(
    () => [...subject.items].length === 1,
  );

  // Direct .length on COMPUTED array after add
  const assert_filtered_length_direct_after = computed(
    () => subject.filteredItems.length === 1,
  );

  // String comparison after add
  const assert_label_after = computed(() => subject.label === "Total: 1");

  // Numeric output after add (control)
  const assert_count_after = computed(() => subject.itemCount === 1);

  return {
    tests: [
      // === Initial state ===
      { assertion: assert_items_length_direct },
      { assertion: assert_items_length_spread },
      { assertion: assert_filtered_length_direct },
      { assertion: assert_label_not_empty },
      { assertion: assert_count_direct },

      // === Add one item ===
      { action: action_add_item },

      // === After add ===
      { assertion: assert_items_length_direct_after },
      { assertion: assert_items_length_spread_after },
      { assertion: assert_filtered_length_direct_after },
      { assertion: assert_label_after },
      { assertion: assert_count_after },
    ],
  };
});
