/**
 * Test Pattern: EditableList primitive
 *
 * Exercises the composition contract via runSynced:
 * - empty → nonempty (counts, empty branch)
 * - add by text (convenience) + add by core stream
 * - toggle done by live item reference (equals() identity), counts react
 * - update by live item reference (identity patch)
 * - remove by live item reference (items.remove(item))
 * - text-addressed convenience: updateItemByText / removeItemByText
 * - clearDone
 * - no-op safety: a detached object literal matches nothing
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

  // Reference-addressed: read the live item from the list, then send it.
  // The item arrives in the handler as a link; equals() resolves it back to
  // the same entity — no user-land id involved.
  const toggle_first_done = action(() => {
    const item = list.items[0];
    if (item) list.toggleItem.send({ item });
  });
  const update_first_label = action(() => {
    const item = list.items[0];
    if (item) list.updateItem.send({ item, changes: { label: "Alpha!" } });
  });
  const remove_first = action(() => {
    const item = list.items[0];
    if (item) list.removeItem.send({ item });
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

  // Duplicate-label fuzzy semantics: updateItemByText touches the FIRST match.
  // The two dups are distinguished by the declared `done` field (NOT an extra —
  // extras don't survive a full-array set, see the EditableListItem doc).
  const add_dup_a = action(() => {
    list.addItem.send({ item: { label: "Dup", done: false } });
  });
  const add_dup_b = action(() => {
    list.addItem.send({ item: { label: "Dup", done: true } });
  });
  const update_dup_by_text = action(() => {
    list.updateItemByText.send({ text: "Dup", newText: "DupChanged" });
  });

  // No-op safety: a detached object literal has no entity identity in the
  // list, so equals()/remove() match nothing and the list is untouched —
  // even when its fields structurally mirror a real item.
  const remove_absent_item = action(() => {
    list.removeItem.send({ item: { label: "DupChanged", done: false } });
  });
  const update_absent_item = action(() => {
    list.updateItem.send({
      item: { label: "Dup", done: true },
      changes: { label: "ghost" },
    });
  });
  const toggle_absent_item = action(() => {
    list.toggleItem.send({ item: { label: "DupChanged", done: false } });
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
  const assert_others_untouched = computed(() =>
    // The reference-addressed update patched ONLY the first item.
    list.items[1]?.label === "Beta" && list.items[2]?.label === "Gamma"
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

  // Duplicate-label first-match assertions. After clearDone the list is empty;
  // we add two items both labelled "Dup" (the first not-done, the second done).
  const assert_two_dups = computed(() => list.total === 2);
  // updateItemByText("Dup") must change ONLY the first match (the not-done one):
  // exactly one item now reads "DupChanged" and it is the not-done one; the
  // done one still reads "Dup".
  const assert_first_dup_changed = computed(() => {
    const changed = list.items.filter((i: EditableListItem) =>
      i.label === "DupChanged"
    );
    return changed.length === 1 && changed[0]?.done === false;
  });
  const assert_second_dup_unchanged = computed(() => {
    const still = list.items.filter((i: EditableListItem) => i.label === "Dup");
    return still.length === 1 && still[0]?.done === true;
  });

  // No-op: detached-literal remove/update/toggle leaves the list untouched.
  const assert_noop_count = computed(() => list.total === 2);
  const assert_noop_labels = computed(() =>
    list.items.find((i: EditableListItem) => i.label === "DupChanged") !==
      undefined &&
    list.items.find((i: EditableListItem) => i.label === "Dup") !== undefined
  );
  const assert_noop_done_flags = computed(() =>
    list.items[0]?.done === false && list.items[1]?.done === true
  );

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
      { assertion: assert_first_not_done },

      // Add by core stream
      { action: add_beta },
      { assertion: assert_two },

      // Add by core stream with extra field
      { action: add_gamma_with_extra },
      { assertion: assert_three },
      { assertion: assert_gamma_present },
      { assertion: assert_extra_passthrough },

      // Toggle done by live item reference (equals() identity)
      { action: toggle_first_done },
      { assertion: assert_first_done },
      { assertion: assert_active_after_toggle },
      { assertion: assert_done_count },

      // Update by live item reference (identity patch)
      { action: update_first_label },
      { assertion: assert_first_renamed },
      { assertion: assert_others_untouched },

      // Remove by live item reference (items.remove(item))
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

      // Duplicate-label fuzzy semantics: updateItemByText hits the first match.
      { action: add_dup_a },
      { action: add_dup_b },
      { assertion: assert_two_dups },
      { action: update_dup_by_text },
      { assertion: assert_first_dup_changed },
      { assertion: assert_second_dup_unchanged },

      // No-op safety: detached literals match nothing.
      { action: remove_absent_item },
      { action: update_absent_item },
      { action: toggle_absent_item },
      { assertion: assert_noop_count },
      { assertion: assert_noop_labels },
      { assertion: assert_noop_done_flags },
    ],
    list,
  };
});
