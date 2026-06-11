/**
 * Test Pattern: EditableList primitive
 *
 * Exercises the composition contract via runSynced:
 * - empty → nonempty (counts, empty branch)
 * - add by text (convenience) + add by id-core stream
 * - toggle done by id (identity), counts react
 * - update by id (identity patch); id is never overwritten
 * - remove by id (identity)
 * - text-addressed convenience: updateItemByText / removeItemByText
 * - clearDone
 *
 * Run: deno task cf test packages/patterns/primitives/editable-list.test.tsx --verbose
 */
import { action, computed, pattern } from "commonfabric";
import EditableList, { type EditableListItem } from "./editable-list.tsx";

export default pattern(() => {
  const list = EditableList({});

  // ==========================================================================
  // Actions
  // ==========================================================================

  const add_alpha = action(() => {
    list.addItemByText.send({ text: "Alpha" });
  });
  const add_beta = action(() => {
    // core stream, label-only convenience form
    list.addItem.send({ label: "Beta" });
  });
  const add_gamma_with_extra = action(() => {
    // core stream carrying an extra (non-default-UI) field
    list.addItem.send({ item: { label: "Gamma", priority: 9 } });
  });

  // Identity-addressed: read the live id from the list, then act on it.
  const toggle_first_done = action(() => {
    const id = list.items[0]?.id;
    if (id) list.toggleItem.send({ id });
  });
  const update_first_label = action(() => {
    const id = list.items[0]?.id;
    if (id) list.updateItem.send({ id, changes: { label: "Alpha!" } });
  });
  const attempt_id_overwrite = action(() => {
    const id = list.items[0]?.id;
    // changes.id must be ignored — identity is immutable.
    if (id) list.updateItem.send({ id, changes: { id: "HACKED" } });
  });
  const remove_first = action(() => {
    const id = list.items[0]?.id;
    if (id) list.removeItem.send({ id });
  });

  // Text-addressed convenience (fuzzy).
  const rename_beta_by_text = action(() => {
    list.updateItemByText.send({ text: "Beta", newText: "Beta2" });
  });
  const done_beta_by_text = action(() => {
    list.updateItemByText.send({ text: "Beta2", done: true });
  });
  const remove_gamma_by_text = action(() => {
    list.removeItemByText.send({ text: "Gamma" });
  });

  const clear_done = action(() => {
    list.clearDone.send({});
  });

  // Whitespace add should be ignored.
  const add_blank = action(() => {
    list.addItemByText.send({ text: "   " });
  });

  // ==========================================================================
  // Assertions
  // ==========================================================================

  const assert_initial_empty = computed(() => list.total === 0);
  const assert_initial_active = computed(() => list.active === 0);

  const assert_one = computed(() => list.total === 1);
  const assert_first_label_alpha = computed(() =>
    list.items[0]?.label === "Alpha"
  );
  const assert_first_has_id = computed(() =>
    typeof list.items[0]?.id === "string" && list.items[0].id.length > 0
  );
  const assert_first_not_done = computed(() => list.items[0]?.done === false);

  const assert_two = computed(() => list.total === 2);
  const assert_three = computed(() => list.total === 3);

  const assert_gamma_present = computed(() => list.items[2]?.label === "Gamma");
  const assert_extra_passthrough = computed(() =>
    // gamma was added third (index 2) and carried priority:9 untouched.
    list.items[2]?.priority === 9
  );

  const assert_first_done = computed(() => list.items[0]?.done === true);
  const assert_active_after_toggle = computed(() => list.active === 2);
  const assert_done_count = computed(() => list.done === 1);

  const assert_first_renamed = computed(() =>
    list.items[0]?.label === "Alpha!"
  );
  const assert_id_not_overwritten = computed(() =>
    list.items[0]?.id !== "HACKED"
  );

  const assert_after_remove_two = computed(() => list.total === 2);
  const assert_alpha_gone = computed(() =>
    list.items.find((i: EditableListItem) => i.label === "Alpha!") === undefined
  );

  const assert_beta_renamed = computed(() =>
    list.items.find((i: EditableListItem) => i.label === "Beta2") !== undefined
  );
  const assert_beta_done = computed(() =>
    // After removing Alpha, the list is [Beta2, Gamma]; Beta2 is index 0.
    list.items[0]?.label === "Beta2" && list.items[0]?.done === true
  );

  const assert_gamma_removed = computed(() =>
    list.items.find((i: EditableListItem) => i.label === "Gamma") === undefined
  );
  const assert_one_after_text_remove = computed(() => list.total === 1);

  const assert_blank_ignored = computed(() => list.total === 1);

  const assert_empty_after_clear = computed(() => list.total === 0);

  // ==========================================================================
  // Test Sequence
  // ==========================================================================
  return {
    tests: [
      // Initial empty
      { assertion: assert_initial_empty },
      { assertion: assert_initial_active },

      // Add by text (convenience)
      { action: add_alpha },
      { assertion: assert_one },
      { assertion: assert_first_label_alpha },
      { assertion: assert_first_has_id },
      { assertion: assert_first_not_done },

      // Add by core stream
      { action: add_beta },
      { assertion: assert_two },

      // Add by core stream with extra field
      { action: add_gamma_with_extra },
      { assertion: assert_three },
      { assertion: assert_gamma_present },
      { assertion: assert_extra_passthrough },

      // Toggle done by id (identity)
      { action: toggle_first_done },
      { assertion: assert_first_done },
      { assertion: assert_active_after_toggle },
      { assertion: assert_done_count },

      // Update by id (identity patch) + id immutability
      { action: update_first_label },
      { assertion: assert_first_renamed },
      { action: attempt_id_overwrite },
      { assertion: assert_id_not_overwritten },

      // Remove by id (identity)
      { action: remove_first },
      { assertion: assert_after_remove_two },
      { assertion: assert_alpha_gone },

      // Text-addressed convenience
      { action: rename_beta_by_text },
      { assertion: assert_beta_renamed },
      { action: done_beta_by_text },
      { assertion: assert_beta_done },
      { action: remove_gamma_by_text },
      { assertion: assert_gamma_removed },
      { assertion: assert_one_after_text_remove },

      // Whitespace ignored
      { action: add_blank },
      { assertion: assert_blank_ignored },

      // clearDone wipes the (done) Beta2
      { action: clear_done },
      { assertion: assert_empty_after_clear },
    ],
    list,
  };
});
