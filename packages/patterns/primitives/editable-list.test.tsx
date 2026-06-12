/**
 * Test Pattern: EditableList primitive
 *
 * Exercises the composition contract via runSynced:
 * - empty → nonempty (counts, empty branch)
 * - add by core stream (label-only and item forms)
 * - toggle done by live item reference (equals() identity), counts react
 * - update by live item reference (identity patch)
 * - remove by live item reference (items.remove(item))
 * - duplicate labels distinguished by reference — equals() compares entity
 *   identity, not content, so two items with the SAME label stay addressable
 * - clearDone
 * - no-op safety: a detached object literal matches nothing
 * - held-reference survival: a reference stashed in a cell BEFORE an
 *   update/toggle (a selection cell, a MasterDetail holder, ...) must still
 *   `equals()`-match and still drive toggle/remove AFTER the item is patched.
 *   This guards the update-in-place contract: update/toggle write through the
 *   element's cells; replacing the array slot with a fresh object literal
 *   would re-mint entity identity and orphan every held reference.
 *
 * Run: deno task cf test packages/patterns/primitives/editable-list.test.tsx --verbose
 */
import { action, computed, equals, pattern, Writable } from "commonfabric";
import EditableList, { type EditableListItem } from "./editable-list.tsx";

export default pattern(() => {
  const list = EditableList({});

  // Simulates an external holder (selection cell / MasterDetail) that read an
  // item once and keeps the reference across later mutations.
  const held = new Writable<EditableListItem | null>(null);

  // ==========================================================================
  // Actions
  // ==========================================================================

  const add_alpha = action(() => {
    list.addItem.send({ label: "Alpha" });
  });
  const add_beta = action(() => {
    list.addItem.send({ label: "Beta" });
  });
  const add_gamma_with_extra = action(() => {
    // core stream carrying an extra (non-default-UI) field
    list.addItem.send({ item: { label: "Gamma", priority: 9 } });
  });

  // Reference-addressed: read the live item from the list, then send it.
  // The item arrives in the handler as a link; equals() resolves it back to
  // the same entity — no user-land id, no text matching.
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

  // After remove_first the list is [Beta, Gamma]; keep driving by reference.
  const rename_beta_by_ref = action(() => {
    const item = list.items[0];
    if (item) list.updateItem.send({ item, changes: { label: "Beta2" } });
  });
  const done_beta_by_ref = action(() => {
    const item = list.items[0];
    if (item) list.toggleItem.send({ item, done: true });
  });
  const remove_gamma_by_ref = action(() => {
    const item = list.items[1];
    if (item) list.removeItem.send({ item });
  });

  const clear_done = action(() => {
    list.clearDone.send({});
  });

  // Whitespace-only label with no item payload should be ignored.
  const add_blank = action(() => {
    list.addItem.send({ label: "   " });
  });

  // Identical labels, distinguished ONLY by entity identity: update the SECOND
  // "Dup" by reference and prove the first is untouched. (A text-matching
  // layer could never express this — equals() is the point.)
  const add_dup_a = action(() => {
    list.addItem.send({ item: { label: "Dup", done: false } });
  });
  const add_dup_b = action(() => {
    list.addItem.send({ item: { label: "Dup", done: true } });
  });
  const update_second_dup_by_ref = action(() => {
    const item = list.items[1];
    if (item) list.updateItem.send({ item, changes: { label: "DupChanged" } });
  });

  // No-op safety: a detached object literal has no entity identity in the
  // list, so equals()/remove() match nothing and the list is untouched —
  // even when its fields structurally mirror a real item.
  const remove_absent_item = action(() => {
    list.removeItem.send({ item: { label: "DupChanged", done: true } });
  });
  const update_absent_item = action(() => {
    list.updateItem.send({
      item: { label: "Dup", done: false },
      changes: { label: "ghost" },
    });
  });
  const toggle_absent_item = action(() => {
    list.toggleItem.send({ item: { label: "DupChanged", done: true } });
  });

  // Held-reference survival. Add a fresh target, STASH a reference to it in
  // the `held` cell, then patch the item via updateItem. If update replaced
  // the array slot with a fresh literal, the entity would be re-minted and
  // the held reference orphaned: equals() would stop matching and the
  // toggle/remove sent with the stale-but-once-valid reference would no-op.
  const add_held_target = action(() => {
    list.addItem.send({ label: "Held" });
  });
  const stash_held = action(() => {
    const item = list.items[2];
    if (item) held.set(item);
  });
  const update_held_target = action(() => {
    const item = list.items[2];
    if (item) list.updateItem.send({ item, changes: { label: "HeldRenamed" } });
  });
  const toggle_via_held = action(() => {
    const h = held.get();
    if (h) list.toggleItem.send({ item: h, done: true });
  });
  const remove_via_held = action(() => {
    const h = held.get();
    if (h) list.removeItem.send({ item: h });
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

  const assert_beta_renamed = computed(() => list.items[0]?.label === "Beta2");
  const assert_beta_done = computed(() =>
    list.items[0]?.label === "Beta2" && list.items[0]?.done === true
  );

  const assert_gamma_removed = computed(() =>
    list.items.find((i: EditableListItem) => i.label === "Gamma") === undefined
  );
  const assert_one_after_ref_remove = computed(() => list.total === 1);

  const assert_blank_ignored = computed(() => list.total === 1);

  const assert_empty_after_clear = computed(() => list.total === 0);

  // Duplicate-label identity assertions. After clearDone the list is empty;
  // we add two items both labelled "Dup" (first not-done, second done), then
  // update the SECOND by reference.
  const assert_two_dups = computed(() => list.total === 2);
  const assert_second_dup_changed = computed(() => {
    const changed = list.items.filter((i: EditableListItem) =>
      i.label === "DupChanged"
    );
    return changed.length === 1 && changed[0]?.done === true;
  });
  const assert_first_dup_unchanged = computed(() => {
    const still = list.items.filter((i: EditableListItem) => i.label === "Dup");
    return still.length === 1 && still[0]?.done === false;
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

  // Held-reference survival assertions.
  const assert_three_after_held_add = computed(() => list.total === 3);
  const assert_held_stashed = computed(() => {
    const h = held.get();
    return h !== null && equals(list.items[2], h);
  });
  const assert_held_renamed = computed(() =>
    list.items[2]?.label === "HeldRenamed"
  );
  // KEY: the stale-but-once-valid reference still equals()-matches the item
  // AFTER updateItem patched it.
  const assert_held_survives_update = computed(() => {
    const h = held.get();
    return h !== null && equals(list.items[2], h);
  });
  // KEY: the held reference still DRIVES mutations after the update.
  const assert_toggled_via_held = computed(() => list.items[2]?.done === true);
  const assert_removed_via_held = computed(() =>
    list.total === 2 &&
    list.items.find((i: EditableListItem) => i.label === "HeldRenamed") ===
      undefined
  );

  // ==========================================================================
  // Test Sequence
  // ==========================================================================
  return {
    tests: [
      // Initial empty
      { assertion: assert_initial_empty },
      { assertion: assert_initial_active },

      // Add via core stream (label-only form)
      { action: add_alpha },
      { assertion: assert_one },
      { assertion: assert_first_label_alpha },
      { assertion: assert_first_not_done },

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

      // Continue driving by reference after the list has shifted
      { action: rename_beta_by_ref },
      { assertion: assert_beta_renamed },
      { action: done_beta_by_ref },
      { assertion: assert_beta_done },
      { action: remove_gamma_by_ref },
      { assertion: assert_gamma_removed },
      { assertion: assert_one_after_ref_remove },

      // Whitespace ignored
      { action: add_blank },
      { assertion: assert_blank_ignored },

      // clearDone wipes the (done) Beta2
      { action: clear_done },
      { assertion: assert_empty_after_clear },

      // Identical labels distinguished by entity identity, not content
      { action: add_dup_a },
      { action: add_dup_b },
      { assertion: assert_two_dups },
      { action: update_second_dup_by_ref },
      { assertion: assert_second_dup_changed },
      { assertion: assert_first_dup_unchanged },

      // No-op safety: detached literals match nothing.
      { action: remove_absent_item },
      { action: update_absent_item },
      { action: toggle_absent_item },
      { assertion: assert_noop_count },
      { assertion: assert_noop_labels },
      { assertion: assert_noop_done_flags },

      // Held-reference survival: stash → update → the old reference still
      // matches and still drives toggle/remove.
      { action: add_held_target },
      { assertion: assert_three_after_held_add },
      { action: stash_held },
      { assertion: assert_held_stashed },
      { action: update_held_target },
      { assertion: assert_held_renamed },
      { assertion: assert_held_survives_update },
      { action: toggle_via_held },
      { assertion: assert_toggled_via_held },
      { action: remove_via_held },
      { assertion: assert_removed_via_held },
    ],
    list,
  };
});
