/**
 * Pattern tests for the exemplar board and its item: allocation on create,
 * density, a name never reused, a name kept whatever happens to its item, the
 * backfill and its idempotence, index rows and the default an unnamed
 * member's row reads as, the item reading its own name out of the board's
 * table, the declaration, the bound on what a read of the namespace expands,
 * and the rejections. Every rejection here is a thrown verb, so the runtime
 * errors are required, and the count is exact: a guard quietly reverting to
 * a silent return fails the suite.
 */

import {
  action,
  assert,
  Default,
  equals,
  NAME,
  pattern,
  TESTS,
  UI,
  Writable,
} from "commonfabric";
import { findElement, hasText } from "../test/vnode-helpers.ts";
import Board, { indexRowsOf, type ItemDemand } from "./board.tsx";
import Item from "./item.tsx";
import { backfillNames, type NamesMap } from "./naming.ts";

export default pattern(() => {
  const items = new Writable<ItemDemand[] | Default<[]>>([]);
  const names = new Writable<NamesMap>({});
  const board = Board({ items, names });

  const assert_initial = assert(() =>
    board.itemCount === 0 &&
    (board.index ?? []).length === 0 &&
    (board.namesTable ?? []).length === 0 &&
    Object.keys((board.names ?? {}) as NamesMap).length === 0 &&
    board[NAME] === "Items (0)"
  );
  const assert_empty_board_renders_empty_state = assert(() =>
    findElement(board[UI], "cf-empty-state") !== undefined &&
    findElement(board[UI], "cf-badge") === undefined
  );

  // Allocation on create: the created item is reachable at `names["1"]`,
  // and its index row and its names-table row both carry the name.
  const action_add_first = action(() => {
    board.addItem.send({
      title: "  First item  ",
      body: "The first body.",
      agentName: "Sol",
    });
  });
  const assert_first_is_named_one = assert(() =>
    board.itemCount === 1 &&
    board.items?.[0]?.title === "First item" &&
    board.index?.[0]?.name === "1" &&
    board.index?.[0]?.title === "First item" &&
    (board.index?.[0]?.createdAt ?? 0) > 0 &&
    equals(board.index?.[0]?.member as object, board.items?.[0] as object) &&
    equals(
      ((board.names ?? {}) as NamesMap)["1"] as object,
      board.items?.[0] as object,
    ) &&
    board.namesTable?.[0]?.name === "1" &&
    equals(
      board.namesTable?.[0]?.member as object,
      board.items?.[0] as object,
    )
  );

  const action_add_second = action(() => {
    board.addItem.send({ title: "Second item", agentName: "Fable" });
  });
  const assert_second_is_named_two = assert(() =>
    board.itemCount === 2 &&
    board.index?.[0]?.name === "1" &&
    board.index?.[1]?.name === "2" &&
    Object.keys((board.names ?? {}) as NamesMap).join(",") === "1,2" &&
    board[NAME] === "Items (2)"
  );
  const assert_cards_carry_names = assert(() =>
    findElement(board[UI], "cf-empty-state") === undefined &&
    hasText(board[UI], "First item") &&
    hasText(board[UI], "Second item") &&
    findElement(board[UI], "cf-badge") !== undefined &&
    hasText(findElement(board[UI], "cf-badge"), "1")
  );

  // One more than the largest name present, whatever the list holds: a name
  // the map carries for a member the list does not is still a name in use.
  const stray = new Writable({ title: "Stray" });
  const action_hold_a_stray_name = action(() => {
    names.key("7").set(stray);
  });
  const action_add_third = action(() => {
    board.addItem.send({ title: "Third item", agentName: "Sol" });
  });
  const assert_third_follows_the_largest = assert(() =>
    board.itemCount === 3 &&
    board.index?.[2]?.name === "8" &&
    (board.namesTable ?? []).length === 4 &&
    Object.keys((board.names ?? {}) as NamesMap).join(",") === "1,2,7,8"
  );

  // A name survives what happens to its item: a rename leaves it, and so
  // does leaving the list — the entry stays, and the next create skips past
  // it rather than reusing the freed name.
  const action_rename_first = action(() => {
    items.key(0).key("title").set("First item, renamed");
  });
  const assert_renamed_item_keeps_its_name = assert(() =>
    board.index?.[0]?.title === "First item, renamed" &&
    board.index?.[0]?.name === "1"
  );
  const action_remove_second = action(() => {
    items.removeByValue(items.key(1));
  });
  const assert_removed_item_keeps_its_entry = assert(() =>
    board.itemCount === 2 &&
    (board.index ?? []).length === 2 &&
    board.index?.[1]?.name === "8" &&
    (board.namesTable ?? []).length === 4 &&
    Object.keys((board.names ?? {}) as NamesMap).join(",") === "1,2,7,8"
  );
  const action_add_fourth = action(() => {
    board.addItem.send({ title: "Fourth item", agentName: "Sol" });
  });
  const assert_fourth_does_not_reuse_two = assert(() =>
    board.itemCount === 3 &&
    board.index?.[2]?.name === "9" &&
    Object.keys((board.names ?? {}) as NamesMap).join(",") === "1,2,7,8,9"
  );

  // The bound: a read of the namespace carries links and nothing behind
  // them. The stray entry is a cell with a title, so a title in the
  // serialization would mean a member was expanded. The index carries its
  // copied scalars and, likewise, nothing behind its references.
  const assert_namespace_read_expands_no_member = assert(() => {
    const serialized = JSON.stringify(board.names);
    return Object.keys((board.names ?? {}) as NamesMap).length === 5 &&
      !serialized.includes('"title"') &&
      !serialized.includes('"body"') &&
      !serialized.includes("vnode");
  });
  const assert_index_read_expands_no_member = assert(() => {
    const serialized = JSON.stringify(board.index);
    return (board.index ?? []).length === 3 &&
      serialized.includes('"title"') &&
      !serialized.includes('"body"') &&
      !serialized.includes('"shortName"') &&
      !serialized.includes("vnode");
  });

  // An item wired to the board's table reads its own name out of it by
  // identity, and renders it as a badge; an item wired to nothing has no
  // name, renders no badge, and does not fail.
  const wired = Item({
    title: "Wired item",
    body: "",
    boardNames: board.namesTable,
  });
  const action_name_the_wired_item = action(() => {
    names.key("12").set(wired);
  });
  const assert_wired_item_reads_its_name = assert(() =>
    wired.shortName === "12" &&
    wired[NAME] === "Wired item"
  );
  const assert_wired_item_renders_its_badge = assert(() =>
    findElement(wired[UI], "cf-badge") !== undefined &&
    hasText(findElement(wired[UI], "cf-badge"), "12") &&
    hasText(wired[UI], "Wired item") &&
    hasText(wired[UI], "No body yet.")
  );
  // The index skips a member with nothing behind it yet — one appended a
  // moment ago, still mid-sync, which reads as `undefined` — and rows the
  // rest.
  const midSyncNeighbor = new Writable({ title: "Settled", createdAt: 4 });
  const assert_index_skips_a_mid_sync_member = assert(() =>
    indexRowsOf([undefined, midSyncNeighbor], []).length === 1
  );

  const solo = Item({ title: "Solo item", body: "A body of its own." });
  const assert_solo_item_has_no_name = assert(() =>
    solo.shortName === undefined &&
    solo[NAME] === "Solo item"
  );
  const assert_solo_item_renders_no_badge = assert(() =>
    findElement(solo[UI], "cf-badge") === undefined &&
    findElement(solo[UI], "cf-markdown") !== undefined &&
    hasText(solo[UI], "Solo item")
  );
  const untitled = Item({ title: "   " });
  const assert_untitled_item_has_a_display_name = assert(() =>
    untitled[NAME] === "(untitled item)"
  );

  // The backfill, on a board that held items before it numbered anything.
  // The items are pushed straight into the list, past `addItem`, which is
  // how a board from before the namespace holds its members.
  const legacyItems = new Writable<ItemDemand[] | Default<[]>>([]);
  const legacyNames = new Writable<NamesMap>({});
  const legacy = Board({ items: legacyItems, names: legacyNames });
  const assigned = new Writable<string[]>([]);

  const action_file_two_unnamed = action(() => {
    legacyItems.push(Item({ title: "Older one", createdAt: 1 }));
    legacyItems.push(Item({ title: "Older two", createdAt: 2 }));
  });
  // An unnamed member's row reads its name as the default, so the board
  // reads whole before anything names it.
  const assert_unnamed_rows_read_the_default = assert(() =>
    legacy.itemCount === 2 &&
    (legacy.index ?? []).length === 2 &&
    legacy.index?.[0]?.name === "" &&
    legacy.index?.[1]?.name === "" &&
    legacy.index?.[1]?.title === "Older two" &&
    (legacy.namesTable ?? []).length === 0
  );
  // The library call itself, so its return is observable: the names it
  // wrote, in filing order.
  const action_backfill_directly = action(() => {
    assigned.set(backfillNames(legacyItems, legacyNames));
  });
  const assert_backfill_named_in_filing_order = assert(() =>
    assigned.get().join(",") === "1,2" &&
    legacy.index?.[0]?.name === "1" &&
    legacy.index?.[1]?.name === "2" &&
    equals(
      ((legacy.names ?? {}) as NamesMap)["1"] as object,
      legacy.items?.[0] as object,
    ) &&
    equals(
      ((legacy.names ?? {}) as NamesMap)["2"] as object,
      legacy.items?.[1] as object,
    )
  );
  // Idempotent: the second run returns no names — it writes exactly the
  // names it returns — and the map holds what the first run left.
  const action_backfill_again = action(() => {
    assigned.set(backfillNames(legacyItems, legacyNames));
  });
  const assert_second_backfill_writes_nothing = assert(() =>
    assigned.get().length === 0 &&
    Object.keys((legacy.names ?? {}) as NamesMap).join(",") === "1,2" &&
    equals(
      ((legacy.names ?? {}) as NamesMap)["1"] as object,
      legacy.items?.[0] as object,
    ) &&
    equals(
      ((legacy.names ?? {}) as NamesMap)["2"] as object,
      legacy.items?.[1] as object,
    )
  );
  // The verb, over a list holding a member the create named and one filed
  // past it: the backfill names the second and skips the first.
  const action_create_a_named_item = action(() => {
    legacy.addItem.send({ title: "Named by create", agentName: "Sol" });
  });
  const action_file_a_late_unnamed = action(() => {
    legacyItems.push(Item({ title: "Older three", createdAt: 3 }));
  });
  const action_backfill_verb = action(() => {
    legacy.backfillNames.send({ agentName: "Sol" });
  });
  const assert_backfill_skips_the_named = assert(() =>
    legacy.itemCount === 4 &&
    legacy.index?.[2]?.name === "3" &&
    legacy.index?.[2]?.title === "Named by create" &&
    legacy.index?.[3]?.name === "4" &&
    legacy.index?.[3]?.title === "Older three" &&
    Object.keys((legacy.names ?? {}) as NamesMap).join(",") === "1,2,3,4"
  );

  // One member at two positions, backfilled over an empty namespace: named
  // once. Membership is asked of identity, never of position, so the second
  // position finds the name the first one took in this same run.
  const twinItems = new Writable<ItemDemand[] | Default<[]>>([]);
  const twinNames = new Writable<NamesMap>({});
  const twinBoard = Board({ items: twinItems, names: twinNames });
  const action_list_one_item_twice = action(() => {
    const twin = Item({ title: "Twin", createdAt: 1 });
    twinItems.push(twin);
    twinItems.push(twin);
  });
  const action_backfill_the_twins = action(() => {
    assigned.set(backfillNames(twinItems, twinNames));
  });
  const assert_twin_is_named_once = assert(() =>
    twinBoard.itemCount === 2 &&
    equals(twinItems.key(0), twinItems.key(1)) &&
    assigned.get().join(",") === "1" &&
    Object.keys((twinBoard.names ?? {}) as NamesMap).join(",") === "1" &&
    (twinBoard.namesTable ?? []).length === 1 &&
    twinBoard.index?.[0]?.name === "1" &&
    twinBoard.index?.[1]?.name === "1"
  );

  // A board given no namespace at all — the shape of one deployed before it
  // numbered anything — reads as having no names, and its first create
  // materializes the map with the first name.
  const bare = Board({});
  const assert_bare_board_has_no_items = assert(() =>
    bare.itemCount === 0 &&
    (bare.namesTable ?? []).length === 0
  );
  const assert_bare_board_names_read_empty = assert(() => {
    const map = bare.names;
    return map === undefined || Object.keys(map).length === 0;
  });
  const action_bare_board_creates = action(() => {
    bare.addItem.send({ title: "First on a bare board", agentName: "Sol" });
  });
  const assert_bare_board_wrote_the_map = assert(() =>
    bare.itemCount === 1 &&
    Object.keys((bare.names ?? {}) as NamesMap).join(",") === "1"
  );
  const assert_bare_board_table_has_the_row = assert(() =>
    (bare.namesTable ?? []).length === 1 &&
    bare.namesTable?.[0]?.name === "1"
  );
  const assert_bare_board_materialized_its_map = assert(() =>
    bare.index?.[0]?.name === "1" &&
    equals(
      ((bare.names ?? {}) as NamesMap)["1"] as object,
      bare.items?.[0] as object,
    )
  );

  const assert_declaration = assert(() =>
    board.naming?.policy?.unique === "history" &&
    board.naming?.policy?.permanent === true &&
    board.naming?.policy?.reuse === false &&
    board.naming?.policy?.allocator === "sequence" &&
    board.naming?.compact === true &&
    board.naming?.name === undefined
  );

  // Rejections: each throws, and the assertion after each proves the write
  // did not land — no item, no name.
  const action_add_unsigned = action(() => {
    board.addItem.send({ title: "Unsigned", agentName: "   " });
  });
  const action_add_blank_title = action(() => {
    board.addItem.send({ title: "   ", agentName: "Sol" });
  });
  const action_backfill_unsigned = action(() => {
    legacy.backfillNames.send({ agentName: " " });
  });
  const assert_rejections_wrote_nothing = assert(() =>
    board.itemCount === 3 &&
    Object.keys((board.names ?? {}) as NamesMap).join(",") ===
      "1,2,7,8,9,12" &&
    legacy.itemCount === 4 &&
    Object.keys((legacy.names ?? {}) as NamesMap).join(",") === "1,2,3,4"
  );

  return {
    [UI]: board[UI],
    expectRuntimeErrors: 3,
    [TESTS]: [
      { assertion: assert_initial },
      { render: board[UI] },
      { assertion: assert_empty_board_renders_empty_state },
      { action: action_add_first },
      { assertion: assert_first_is_named_one },
      { action: action_add_second },
      { assertion: assert_second_is_named_two },
      { render: board[UI] },
      { assertion: assert_cards_carry_names },
      { action: action_hold_a_stray_name },
      { action: action_add_third },
      { assertion: assert_third_follows_the_largest },
      { action: action_rename_first },
      { assertion: assert_renamed_item_keeps_its_name },
      { action: action_remove_second },
      { assertion: assert_removed_item_keeps_its_entry },
      { action: action_add_fourth },
      { assertion: assert_fourth_does_not_reuse_two },
      { assertion: assert_namespace_read_expands_no_member },
      { assertion: assert_index_read_expands_no_member },
      { render: board[UI] },
      { action: action_name_the_wired_item },
      { assertion: assert_wired_item_reads_its_name },
      { render: wired[UI] },
      { assertion: assert_wired_item_renders_its_badge },
      { assertion: assert_index_skips_a_mid_sync_member },
      { assertion: assert_solo_item_has_no_name },
      { render: solo[UI] },
      { assertion: assert_solo_item_renders_no_badge },
      { assertion: assert_untitled_item_has_a_display_name },
      { action: action_file_two_unnamed },
      { assertion: assert_unnamed_rows_read_the_default },
      { action: action_backfill_directly },
      { assertion: assert_backfill_named_in_filing_order },
      { action: action_backfill_again },
      { assertion: assert_second_backfill_writes_nothing },
      { action: action_create_a_named_item },
      { action: action_file_a_late_unnamed },
      { action: action_backfill_verb },
      { assertion: assert_backfill_skips_the_named },
      { action: action_list_one_item_twice },
      { action: action_backfill_the_twins },
      { assertion: assert_twin_is_named_once },
      { assertion: assert_bare_board_has_no_items },
      { assertion: assert_bare_board_names_read_empty },
      { action: action_bare_board_creates },
      { assertion: assert_bare_board_wrote_the_map },
      { assertion: assert_bare_board_table_has_the_row },
      { assertion: assert_bare_board_materialized_its_map },
      { assertion: assert_declaration },
      { action: action_add_unsigned },
      { action: action_add_blank_title },
      { action: action_backfill_unsigned },
      { assertion: assert_rejections_wrote_nothing },
    ],
  };
});
