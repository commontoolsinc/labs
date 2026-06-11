/**
 * Test Pattern: Do List (post-CT-1712 EditableList migration)
 *
 * Proves behavior parity after migrating the id-keyed model onto the
 * EditableList primitive while do-list keeps its rich rows headless:
 * - add (carries indent), addItems (batch)
 * - stable ids minted on add (identity model)
 * - update by id (title / done), toggle done
 * - cascade remove by id (item + indent-children)
 * - title-addressed convenience (removeItemByTitle / updateItemByTitle)
 * - archiveCompleted drops done items
 * - counts via the embedded primitive
 *
 * Run: deno task cf test packages/patterns/do-list/do-list.test.tsx \
 *   --root packages/patterns --verbose
 */
import { action, computed, pattern } from "commonfabric";
import DoList, { type DoItem } from "./do-list.tsx";

export default pattern(() => {
  const list = DoList({});

  // ==========================================================================
  // Actions
  // ==========================================================================

  const add_parent = action(() => {
    list.addItem.send({ title: "Parent" });
  });
  const add_child = action(() => {
    list.addItem.send({ title: "Child", indent: 1 });
  });
  const add_sibling = action(() => {
    list.addItem.send({ title: "Sibling" });
  });

  const add_batch = action(() => {
    list.addItems.send({
      items: [{ title: "BatchA" }, { title: "BatchB", indent: 1 }],
    });
  });

  // Identity-addressed: read the live id back before sending.
  const update_first_title = action(() => {
    const id = list.items[0]?.id;
    if (id) list.updateItem.send({ id, title: "Parent!" });
  });
  const done_first = action(() => {
    const id = list.items[0]?.id;
    if (id) list.updateItem.send({ id, done: true });
  });

  // Cascade remove: removing "Parent!" (index 0) must also drop its indent-1
  // "Child" (index 1) but NOT the un-indented "Sibling".
  const remove_parent_cascade = action(() => {
    const id = list.items[0]?.id;
    if (id) list.removeItem.send({ id });
  });

  // Title-addressed convenience layer.
  const rename_sibling_by_title = action(() => {
    list.updateItemByTitle.send({ title: "Sibling", newTitle: "Sibling2" });
  });
  const done_sibling_by_title = action(() => {
    list.updateItemByTitle.send({ title: "Sibling2", done: true });
  });
  const remove_batcha_by_title = action(() => {
    // BatchA has an indent-1 child BatchB → cascade removes both.
    list.removeItemByTitle.send({ title: "BatchA" });
  });

  const archive = action(() => {
    list.archiveCompleted.send({});
  });

  // ==========================================================================
  // Assertions
  // ==========================================================================

  const assert_initial_empty = computed(() => list.itemCount === 0);

  const assert_three = computed(() => list.itemCount === 3);
  const assert_parent_first = computed(() => list.items[0]?.title === "Parent");
  const assert_child_indent = computed(() => list.items[1]?.indent === 1);
  const assert_first_has_id = computed(() =>
    typeof list.items[0]?.id === "string" && list.items[0].id.length > 0
  );
  const assert_unique_ids = computed(() => {
    const ids = list.items.map((i: DoItem) => i.id);
    return new Set(ids).size === ids.length;
  });

  const assert_five = computed(() => list.itemCount === 5);

  const assert_first_renamed = computed(() =>
    list.items[0]?.title === "Parent!"
  );
  const assert_first_done = computed(() => list.items[0]?.done === true);

  // After cascade-removing Parent! + Child: [Sibling, BatchA, BatchB] = 3.
  const assert_after_cascade_three = computed(() => list.itemCount === 3);
  const assert_parent_gone = computed(() =>
    list.items.find((i: DoItem) => i.title === "Parent!") === undefined
  );
  const assert_child_gone = computed(() =>
    list.items.find((i: DoItem) => i.title === "Child") === undefined
  );
  const assert_sibling_survives = computed(() =>
    list.items.find((i: DoItem) => i.title === "Sibling") !== undefined
  );

  const assert_sibling_renamed = computed(() =>
    list.items.find((i: DoItem) => i.title === "Sibling2") !== undefined
  );
  const assert_sibling_done = computed(() =>
    list.items.find((i: DoItem) => i.title === "Sibling2")?.done === true
  );

  // removeItemByTitle("BatchA") cascades BatchB → only Sibling2 remains.
  const assert_one_after_title_remove = computed(() => list.itemCount === 1);
  const assert_batch_gone = computed(() =>
    list.items.find((i: DoItem) =>
      i.title === "BatchA" || i.title === "BatchB"
    ) === undefined
  );

  // Sibling2 is done → archiveCompleted empties the list.
  const assert_empty_after_archive = computed(() => list.itemCount === 0);

  // ==========================================================================
  // Test Sequence
  // ==========================================================================
  return {
    tests: [
      { assertion: assert_initial_empty },

      { action: add_parent },
      { action: add_child },
      { action: add_sibling },
      { assertion: assert_three },
      { assertion: assert_parent_first },
      { assertion: assert_child_indent },
      { assertion: assert_first_has_id },
      { assertion: assert_unique_ids },

      { action: add_batch },
      { assertion: assert_five },

      { action: update_first_title },
      { assertion: assert_first_renamed },
      { action: done_first },
      { assertion: assert_first_done },

      { action: remove_parent_cascade },
      { assertion: assert_after_cascade_three },
      { assertion: assert_parent_gone },
      { assertion: assert_child_gone },
      { assertion: assert_sibling_survives },

      { action: rename_sibling_by_title },
      { assertion: assert_sibling_renamed },
      { action: done_sibling_by_title },
      { assertion: assert_sibling_done },

      { action: remove_batcha_by_title },
      { assertion: assert_one_after_title_remove },
      { assertion: assert_batch_gone },

      { action: archive },
      { assertion: assert_empty_after_archive },
    ],
    list,
  };
});
