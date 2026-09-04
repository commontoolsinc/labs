/**
 * Pattern tests for the exemplar board and its item: allocation on create,
 * density, a name never reused, a name kept whatever happens to its item, the
 * backfill and its idempotence, index rows that are the members and the
 * default an unnamed member's `shortName` reads as, the mention universe and
 * the name each of its rows carries, the item reading its own name out of the
 * board's table, the declaration, the bound on what a read of the namespace or
 * the universe expands, and the rejections. Every rejection here is a thrown
 * verb, so the runtime errors are required, and the count is exact: a guard
 * quietly reverting to a silent return fails the suite.
 *
 * A property worth knowing before adding another guard test here: a guard that
 * PREVENTS a write can only be caught where the value it would have written
 * differs from the value already stored. Where the two are equal — a draft
 * seeded from the very field it would overwrite — removing the guard changes
 * nothing observable, and the test passes against a system carrying the
 * defect. Move the stored value between the seeding and the guarded call, then
 * assert the stored value survives rather than the draft.
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
import Board, { type ItemDemand } from "./board.tsx";
import Item, { type ItemMentionRefMap } from "./item.tsx";
import { backfillNames, nameOf, type NamesMap } from "./naming.ts";

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

  // Allocation on create: the created item is reachable at `names["1"]`, its
  // index row — the item itself — reads the name as `shortName` once the
  // item's own lookup has run, and its names-table row carries the name.
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
    board.index?.[0]?.shortName === "1" &&
    board.index?.[0]?.title === "First item" &&
    (board.index?.[0]?.createdAt ?? 0) > 0 &&
    equals(board.index?.[0] as object, board.items?.[0] as object) &&
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
    board.index?.[0]?.shortName === "1" &&
    board.index?.[1]?.shortName === "2" &&
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
    board.index?.[2]?.shortName === "8" &&
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
    board.index?.[0]?.shortName === "1"
  );
  const action_remove_second = action(() => {
    items.removeByValue(items.key(1));
  });
  const assert_removed_item_keeps_its_entry = assert(() =>
    board.itemCount === 2 &&
    (board.index ?? []).length === 2 &&
    board.index?.[1]?.shortName === "8" &&
    (board.namesTable ?? []).length === 4 &&
    Object.keys((board.names ?? {}) as NamesMap).join(",") === "1,2,7,8"
  );
  const action_add_fourth = action(() => {
    board.addItem.send({ title: "Fourth item", agentName: "Sol" });
  });
  const assert_fourth_does_not_reuse_two = assert(() =>
    board.itemCount === 3 &&
    board.index?.[2]?.shortName === "9" &&
    Object.keys((board.names ?? {}) as NamesMap).join(",") === "1,2,7,8,9"
  );

  // The bound: a read of the namespace carries links and nothing behind
  // them. The stray entry is a cell with a title, so a title in the
  // serialization would mean a member was expanded. The index is the items
  // through the row schema, so it carries their titles and names and nothing
  // the schema does not name — no body, no verbs, no rendered view.
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
      serialized.includes('"shortName"') &&
      !serialized.includes('"body"') &&
      !serialized.includes("vnode");
  });

  // The mention universe: one row per member, carrying the board's name for
  // it and the member itself as a reference. This is what an item's editor
  // completes a `#42` citation over.
  const assert_mentionable_rows_carry_names = assert(() =>
    (board.mentionable ?? []).length === 3 &&
    board.mentionable?.[0]?.[NAME] === "First item, renamed" &&
    board.mentionable?.[0]?.title === "First item, renamed" &&
    board.mentionable?.[0]?.shortName === "1" &&
    board.mentionable?.[1]?.shortName === "8" &&
    board.mentionable?.[2]?.shortName === "9" &&
    equals(
      board.mentionable?.[0]?.piece as object,
      board.items?.[0] as object,
    )
  );
  // The same bound the index keeps: the rows carry copied strings and a
  // reference, and nothing behind the reference. `shortName` is one of those
  // copies here, so what says no member was expanded is a field the item
  // publishes and the row does not.
  const assert_universe_read_expands_no_member = assert(() => {
    const serialized = JSON.stringify(board.mentionable);
    return serialized.includes('"title"') &&
      serialized.includes('"shortName"') &&
      !serialized.includes('"body"') &&
      !serialized.includes('"createdAt"') &&
      !serialized.includes('"references"') &&
      !serialized.includes("vnode");
  });

  // An item wired to the board's table reads its own name out of it by
  // identity, and renders it as a badge; an item wired to nothing has no
  // name, renders no badge, and does not fail.
  const wiredBody = new Writable("");
  // A mention map with something in it, so a save that erased would be seen
  // to erase both halves rather than only the prose. The destination is a
  // stand-in: what these assertions turn on is the entry surviving, not what
  // it points at, and a seeded cell takes static data only.
  const wiredRefs = new Writable<ItemMentionRefMap>({
    a3f9zz: { destination: {}, modifiedTitle: false },
  });
  const wired = Item({
    title: "Wired item",
    body: wiredBody,
    references: wiredRefs,
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
  // Opening seeds the drafts from the stored body and map, which is the whole
  // reason opening is a verb: a save right after an open writes back what the
  // open read, so it preserves the body rather than erasing it with an
  // uninitialized draft. Take the seeding out of `startEditBody` and this
  // pair goes red on the save.
  const action_open_the_wired_editor = action(() => {
    wired.startEditBody.send();
  });
  const assert_opening_shows_the_editor = assert(() =>
    findElement(wired[UI], "cf-code-editor") !== undefined &&
    findElement(wired[UI], "cf-markdown") === undefined
  );
  const action_save_the_wired_body = action(() => {
    wired.saveBody.send();
  });
  const assert_save_preserves_the_body = assert(() =>
    wired.body === "The seeded body." &&
    findElement(wired[UI], "cf-code-editor") === undefined
  );

  // A save that never followed an open writes nothing. The drafts are seeded
  // only by `startEditBody`, so an ungated save would put an empty draft over
  // both the prose and the mention map — the first P1's erasure reached
  // through the save rather than through the open.
  const action_save_without_opening = action(() => {
    wired.saveBody.send();
  });
  const assert_cold_save_writes_nothing = assert(() =>
    wired.body === "The seeded body." &&
    Object.keys((wired.references ?? {}) as ItemMentionRefMap).join(",") ===
      "a3f9zz"
  );

  // Cancel leaves the drafts behind and writes nothing, so the stored body is
  // what it was however the editor is closed.
  const action_reopen_the_wired_editor = action(() => {
    wired.startEditBody.send();
  });
  const action_cancel_the_wired_edit = action(() => {
    wired.cancelEditBody.send();
  });
  const assert_cancel_preserves_the_body = assert(() =>
    wired.body === "The seeded body." &&
    findElement(wired[UI], "cf-code-editor") === undefined
  );

  // The second door: a save sent after a cancel. The stored content moves
  // between the cancel and the save, which is what makes the guard visible —
  // the abandoned draft still holds what the open read, so an ungated save
  // resurrects it over the newer content instead of writing it back unchanged.
  const action_change_content_after_cancelling = action(() => {
    wiredBody.set("Changed after the cancel.");
    wiredRefs.set({ b7k2m1: { destination: {}, modifiedTitle: false } });
  });
  const action_save_after_cancelling = action(() => {
    wired.saveBody.send();
  });
  const assert_save_after_cancel_writes_nothing = assert(() =>
    wired.body === "Changed after the cancel." &&
    Object.keys((wired.references ?? {}) as ItemMentionRefMap).join(",") ===
      "b7k2m1"
  );

  // Opening twice is opening once. What makes that observable is a stored
  // body that moves between the two opens: the save writes what the editor
  // has held since it opened, so the first open's draft is what lands. An
  // unguarded second open would re-seed from the newer body and this would
  // read `Changed elsewhere` instead.
  const action_open_before_the_change = action(() => {
    wired.startEditBody.send();
  });
  const action_change_the_body_elsewhere = action(() => {
    wiredBody.set("Changed elsewhere.");
  });
  const action_open_again_mid_edit = action(() => {
    wired.startEditBody.send();
  });
  const assert_second_open_keeps_the_first_draft = assert(() =>
    wired.body === "Changed after the cancel." &&
    findElement(wired[UI], "cf-code-editor") === undefined
  );

  // The body view follows the body, in both directions: a member that gains
  // prose shows it, and one whose prose is cleared shows the empty state
  // again. Both, because a view pinned to the value it first read passes
  // whichever direction it happened to start in.
  const action_give_the_wired_item_a_body = action(() => {
    wiredBody.set("The seeded body.");
  });
  const assert_body_shows_as_markdown = assert(() =>
    findElement(wired[UI], "cf-markdown") !== undefined &&
    !hasText(wired[UI], "No body yet.")
  );
  const action_clear_the_wired_body = action(() => {
    wiredBody.set("");
  });
  const assert_cleared_body_shows_the_empty_state = assert(() =>
    findElement(wired[UI], "cf-markdown") === undefined &&
    hasText(wired[UI], "No body yet.")
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
  // how a board from before the namespace holds its members. These two carry
  // the board's table because a name reaches a row only through the member's
  // own wiring: they stand for members an operator has link-bound, the step
  // the README pairs with a backfill, done here at construction because a
  // pattern cannot reach a member's argument.
  const legacyItems = new Writable<ItemDemand[] | Default<[]>>([]);
  const legacyNames = new Writable<NamesMap>({});
  const legacy = Board({ items: legacyItems, names: legacyNames });
  const assigned = new Writable<string[]>([]);

  const action_file_two_unnamed = action(() => {
    legacyItems.push(
      Item({ title: "Older one", createdAt: 1, boardNames: legacy.namesTable }),
    );
    legacyItems.push(
      Item({ title: "Older two", createdAt: 2, boardNames: legacy.namesTable }),
    );
  });
  // An unnamed member's row reads its name as the default, so the board
  // reads whole before anything names it.
  const assert_unnamed_rows_read_the_default = assert(() =>
    legacy.itemCount === 2 &&
    (legacy.index ?? []).length === 2 &&
    legacy.index?.[0]?.shortName === "" &&
    legacy.index?.[1]?.shortName === "" &&
    legacy.index?.[1]?.title === "Older two" &&
    (legacy.namesTable ?? []).length === 0
  );
  // A universe row for a member the board has not named carries the empty
  // name, which is a row no `#42` query matches.
  const assert_unnamed_universe_rows_have_no_name = assert(() =>
    (legacy.mentionable ?? []).length === 2 &&
    legacy.mentionable?.[0]?.[NAME] === "Older one" &&
    legacy.mentionable?.[0]?.shortName === "" &&
    legacy.mentionable?.[1]?.shortName === ""
  );
  // The library call itself, so its return is observable: the names it
  // wrote, in filing order.
  const action_backfill_directly = action(() => {
    assigned.set(backfillNames(legacyItems, legacyNames));
  });
  const assert_backfill_named_in_filing_order = assert(() =>
    assigned.get().join(",") === "1,2" &&
    legacy.index?.[0]?.shortName === "1" &&
    legacy.index?.[1]?.shortName === "2" &&
    equals(
      ((legacy.names ?? {}) as NamesMap)["1"] as object,
      legacy.items?.[0] as object,
    ) &&
    equals(
      ((legacy.names ?? {}) as NamesMap)["2"] as object,
      legacy.items?.[1] as object,
    )
  );
  // The universe follows the namespace: a member named by the backfill
  // carries its name in the row an editor completes over.
  const assert_backfill_reaches_the_universe = assert(() =>
    legacy.mentionable?.[0]?.shortName === "1" &&
    legacy.mentionable?.[1]?.shortName === "2"
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
  // And one that stands for a member the link-bind never reached. Its row
  // keeps reading the default however the map names it — the cost the README
  // states — while the name itself is real, and `namesTable` is where it is.
  const action_file_a_late_unnamed = action(() => {
    legacyItems.push(Item({ title: "Older three", createdAt: 3 }));
  });
  const action_backfill_verb = action(() => {
    legacy.backfillNames.send({ agentName: "Sol" });
  });
  const assert_backfill_skips_the_named = assert(() =>
    legacy.itemCount === 4 &&
    legacy.index?.[2]?.shortName === "3" &&
    legacy.index?.[2]?.title === "Named by create" &&
    legacy.index?.[3]?.shortName === "" &&
    legacy.index?.[3]?.title === "Older three" &&
    nameOf(legacyItems.key(3), legacy.namesTable ?? []) === "4" &&
    Object.keys((legacy.names ?? {}) as NamesMap).join(",") === "1,2,3,4"
  );
  // The universe reads an unwired member the way its index row does: blank,
  // however the namespace names it. Both take the member's own `shortName`,
  // so one derivation gives one answer, and a caller that needs to tell a
  // missing bind from a missing name reads the namespace for both.
  const assert_universe_follows_the_wiring = assert(() =>
    legacy.mentionable?.[2]?.shortName === "3" &&
    legacy.mentionable?.[3]?.[NAME] === "Older three" &&
    legacy.mentionable?.[3]?.shortName === "" &&
    nameOf(legacyItems.key(3), legacy.namesTable ?? []) === "4"
  );

  // One member at two positions, backfilled over an empty namespace: named
  // once. Membership is asked of identity, never of position, so the second
  // position finds the name the first one took in this same run.
  const twinItems = new Writable<ItemDemand[] | Default<[]>>([]);
  const twinNames = new Writable<NamesMap>({});
  const twinBoard = Board({ items: twinItems, names: twinNames });
  const action_list_one_item_twice = action(() => {
    const twin = Item({
      title: "Twin",
      createdAt: 1,
      boardNames: twinBoard.namesTable,
    });
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
    twinBoard.index?.[0]?.shortName === "1" &&
    twinBoard.index?.[1]?.shortName === "1"
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
    bare.index?.[0]?.shortName === "1" &&
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
      { assertion: assert_mentionable_rows_carry_names },
      { assertion: assert_universe_read_expands_no_member },
      { render: board[UI] },
      { action: action_name_the_wired_item },
      { assertion: assert_wired_item_reads_its_name },
      { render: wired[UI] },
      { assertion: assert_wired_item_renders_its_badge },
      { action: action_give_the_wired_item_a_body },
      { action: action_save_without_opening },
      { assertion: assert_cold_save_writes_nothing },
      { action: action_open_the_wired_editor },
      { render: wired[UI] },
      { assertion: assert_opening_shows_the_editor },
      { action: action_save_the_wired_body },
      { render: wired[UI] },
      { assertion: assert_save_preserves_the_body },
      { action: action_reopen_the_wired_editor },
      { action: action_cancel_the_wired_edit },
      { render: wired[UI] },
      { assertion: assert_cancel_preserves_the_body },
      { action: action_change_content_after_cancelling },
      { action: action_save_after_cancelling },
      { assertion: assert_save_after_cancel_writes_nothing },
      { action: action_open_before_the_change },
      { action: action_change_the_body_elsewhere },
      { action: action_open_again_mid_edit },
      { action: action_save_the_wired_body },
      { render: wired[UI] },
      { assertion: assert_second_open_keeps_the_first_draft },
      { render: wired[UI] },
      { assertion: assert_body_shows_as_markdown },
      { action: action_clear_the_wired_body },
      { render: wired[UI] },
      { assertion: assert_cleared_body_shows_the_empty_state },
      { assertion: assert_solo_item_has_no_name },
      { render: solo[UI] },
      { assertion: assert_solo_item_renders_no_badge },
      { assertion: assert_untitled_item_has_a_display_name },
      { action: action_file_two_unnamed },
      { assertion: assert_unnamed_rows_read_the_default },
      { assertion: assert_unnamed_universe_rows_have_no_name },
      { action: action_backfill_directly },
      { assertion: assert_backfill_named_in_filing_order },
      { assertion: assert_backfill_reaches_the_universe },
      { action: action_backfill_again },
      { assertion: assert_second_backfill_writes_nothing },
      { action: action_create_a_named_item },
      { action: action_file_a_late_unnamed },
      { action: action_backfill_verb },
      { assertion: assert_backfill_skips_the_named },
      { assertion: assert_universe_follows_the_wiring },
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
