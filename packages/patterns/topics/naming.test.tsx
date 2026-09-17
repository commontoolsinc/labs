/**
 * Pattern tests for the member namespace the Topics board owns: allocation in
 * the same transaction as the create, the names table that gives a topic its
 * name by identity, the backfill over topics filed before the board numbered
 * anything, and the bound on what any of those reads expands.
 *
 * Topics shows none of those numbers while `SHOW_TOPIC_NUMBERS` in
 * `topic.tsx` is off, and this file holds that as well. A topic publishes no
 * `shortName` then, so its header, the board's cards, the survey rows and the
 * mention universe's rows all carry none, while the namespace and the names
 * table carry every one. A case reading an absence for a topic the board has
 * named states that number in the table beside it, so the absence stands
 * against a number that exists; the two over a topic nothing has named have no
 * number to stand against and read the table as empty.
 *
 * Separate from topics.test.tsx for the reason render-shape.test.tsx is
 * separate from it: this file drives one surface end to end and keeps
 * compiling while a change to the board's other demands is in flight.
 *
 * A named topic's header and its published name are read off a topic this file
 * composes and lists in a board's input, which the board's `backfillNames`
 * then names. A verb that captured the
 * body-held topic could not name it: a verb receives a captured topic through
 * its own state schema, which does not materialize one (`TopicOutput`'s
 * `editingBody` says why). `backfillNames` reaches the topic through the
 * board's list instead.
 *
 * The mixed-vintage case — a topic deployed before `shortName` existed, read
 * beside one that has it — is NOT here, and deliberately. A fixture of that
 * shape was written here and measured inert: spelling `shortName` as a
 * required path on both the demand and the publication, which is the defect it
 * would guard, left every one of its clauses green. The case that does
 * discriminate is `assert_explicit_undefined_author_projection` in
 * topics.test.tsx, which stands a legacy sibling in a live universe and reds
 * under exactly that mutation.
 *
 * Some runs log `sync-load-failure` lines at teardown, and they are acceptable.
 * Each Topic's `#profile` wish finds no profile in the test space and opens its
 * profile-create surface, a sidecar pattern the test runtime has no server to
 * load (`packages/runner/src/builtins/wish.ts`); a topic created late in the
 * run can still be syncing for that when the harness disposes the runtime. The
 * run therefore ends on a write-free assertion, and nothing here depends on the
 * wish.
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
import {
  backfillNames,
  nameOf,
  type NamesMap,
  namesTable,
} from "../collection-naming/naming.ts";
import { findNodeByProp, hasText } from "../test/vnode-helpers.ts";
import Topics, { type TopicDemand } from "./main.tsx";
import Topic from "./topic.tsx";

/**
 * The number badge under `node`, if one is rendered. A topic's number rides in
 * the one badge carrying `data-member-name`, so this says nothing about the
 * other badges a topic renders — a link's kind, for one.
 */
const numberBadge = (node: unknown): unknown =>
  findNodeByProp(node, "data-member-name", "");

export default pattern(() => {
  const names = new Writable<NamesMap>({});
  const board = Topics({ names });

  const assert_initial = assert(() =>
    board.topicCount === 0 &&
    (board.namesTable ?? []).length === 0 &&
    Object.keys((board.names ?? {}) as NamesMap).length === 0
  );
  // The policy the board publishes beside the names, so a consumer deciding
  // whether it may hold a name rather than an identity reads the promise
  // instead of assuming one.
  const assert_declaration = assert(() =>
    board.naming?.policy?.allocator === "sequence" &&
    board.naming?.policy?.unique === "history" &&
    board.naming?.policy?.permanent === true &&
    board.naming?.policy?.reuse === false &&
    board.naming?.compact === true
  );

  // Allocation on create: the topic is reachable at `names["1"]` the moment it
  // exists, and the entry names the topic itself rather than a copy of it.
  // `addTopic`'s returned `name` is not observable here: a verb's result
  // reaches its caller through the handling's receipt, and `send()` gives a
  // pattern test nothing. The namespace keys below pin what was allocated;
  // that the verb hands it back is asserted where a result IS observable, in
  // `packages/cli/integration/topics-restore-drill.sh`.
  const action_add_first = action(() => {
    board.addTopic.send({
      title: "First topic",
      body: "The living document.",
      agentName: "Sol",
    });
  });
  const action_add_second = action(() => {
    board.addTopic.send({ title: "Second topic", agentName: "Fable" });
  });
  const assert_allocated_on_create = assert(() =>
    board.topicCount === 2 &&
    Object.keys((board.names ?? {}) as NamesMap).join(",") === "1,2" &&
    equals(
      ((board.names ?? {}) as NamesMap)["1"] as object,
      board.topics?.[0] as object,
    ) &&
    equals(
      ((board.names ?? {}) as NamesMap)["2"] as object,
      board.topics?.[1] as object,
    )
  );
  // The table the board derives once and hands every topic it creates: one row
  // per named member, each row addressed by the member it describes, so a
  // topic looking itself up by identity finds one row.
  const assert_table_names_each_topic = assert(() =>
    (board.namesTable ?? []).length === 2 &&
    board.namesTable?.[0]?.name === "1" &&
    board.namesTable?.[1]?.name === "2" &&
    equals(
      board.namesTable?.[0]?.member as object,
      board.topics?.[0] as object,
    ) &&
    equals(
      board.namesTable?.[1]?.member as object,
      board.topics?.[1] as object,
    )
  );
  // A survey row IS its topic, so it carries what the topic publishes: the
  // titles, and no number, although the table names both.
  const assert_index_rows_carry_no_name = assert(() =>
    (board.index ?? []).length === 2 &&
    board.index?.[0]?.title === "First topic" &&
    board.index?.[0]?.shortName === undefined &&
    board.index?.[1]?.shortName === undefined &&
    board.namesTable?.[0]?.name === "1" &&
    board.namesTable?.[1]?.name === "2"
  );
  // The board's cards show the titles and no number, although the table names
  // both topics: the badge is the only `cf-badge` a card renders.
  const assert_cards_show_no_number = assert(() =>
    numberBadge(board[UI]) === undefined &&
    hasText(board[UI], "First topic") &&
    hasText(board[UI], "Second topic") &&
    board.namesTable?.[0]?.name === "1" &&
    board.namesTable?.[1]?.name === "2"
  );
  // The mention universe: one row per topic, each copying its topic's absent
  // name as the empty one, although the table names both. A `#42` completion
  // matches a row's name and a mention's pill shows it, so a row without one
  // is offered for no number and gives a pill none.
  const assert_universe_rows_carry_no_name = assert(() =>
    (board.mentionable ?? []).length === 2 &&
    board.mentionable?.[0]?.[NAME] === "First topic" &&
    board.mentionable?.[0]?.title === "First topic" &&
    board.mentionable?.[0]?.shortName === "" &&
    board.mentionable?.[1]?.shortName === "" &&
    board.namesTable?.[0]?.name === "1" &&
    board.namesTable?.[1]?.name === "2" &&
    equals(
      board.mentionable?.[0]?.piece as object,
      board.topics?.[0] as object,
    )
  );
  // The bound: topics carry bodies and threads, and neither the namespace nor
  // the table carries any of it. The universe carries the copied strings and
  // nothing behind the reference beside them.
  const assert_reads_expand_no_topic = assert(() => {
    const namespace = JSON.stringify(board.names);
    const table = JSON.stringify(board.namesTable);
    const universe = JSON.stringify(board.mentionable);
    return !namespace.includes('"title"') &&
      !namespace.includes('"body"') &&
      table.includes('"name"') &&
      !table.includes('"title"') &&
      !table.includes('"comments"') &&
      universe.includes('"shortName"') &&
      !universe.includes("The living document.") &&
      !universe.includes('"comments"') &&
      !universe.includes("vnode");
  });

  // A topic wired to no board has no name, renders no badge, and does not
  // fail: the number is the collection's, and a topic without one is whole.
  // The lookup produces nothing, and the demand declares the property
  // optional, so a reader sees no `shortName` at all rather than a blank one.
  const solo = Topic({ title: "Solo topic" });
  const assert_solo_topic_has_no_name = assert(() =>
    solo.shortName === undefined &&
    solo[NAME] === "Solo topic"
  );
  const assert_solo_topic_renders_no_badge = assert(() =>
    numberBadge(solo[UI]) === undefined &&
    hasText(solo[UI], "Solo topic")
  );

  // A named topic shows and publishes no number. The topic is listed in the
  // board's input and named by the board's backfill, and it reads that name
  // out of a names table over the board's namespace, as a topic `addTopic`
  // creates does; the table is derived here rather than taken off the board,
  // which is built after the topic. The table naming the topic is what makes
  // the two absences below absences of a number the topic has.
  const heldNames = new Writable<NamesMap>({});
  const held = Topic({
    title: "Held topic",
    boardNames: namesTable({ names: heldNames }),
  });
  const heldBoard = Topics({ topics: [held], names: heldNames });
  const action_name_the_held_topic = action(() => {
    heldBoard.backfillNames.send({ agentName: "Sol" });
  });
  const assert_named_topic_shows_no_number = assert(() =>
    Object.keys((heldBoard.names ?? {}) as NamesMap).join(",") === "1" &&
    heldBoard.namesTable?.[0]?.name === "1" &&
    equals(
      heldBoard.namesTable?.[0]?.member as object,
      heldBoard.topics?.[0] as object,
    ) &&
    held.shortName === undefined &&
    numberBadge(held[UI]) === undefined &&
    hasText(held[UI], "Held topic")
  );

  // The backfill, on a board that held topics before it numbered anything. The
  // topics are pushed straight into the list, past `addTopic`, which is how a
  // board from before the namespace holds its members. They carry the board's
  // table because a name reaches a row only through the member's own wiring:
  // they stand for members an operator has link-bound, the step the board
  // pairs with a backfill, done here at construction because a pattern cannot
  // reach a member's argument.
  const olderTopics = new Writable<TopicDemand[] | Default<[]>>([]);
  const olderNames = new Writable<NamesMap>({});
  const older = Topics({ topics: olderTopics, names: olderNames });

  const action_file_two_unnamed = action(() => {
    olderTopics.push(
      Topic({ title: "Older one", createdAt: 1, boardNames: older.namesTable }),
    );
    olderTopics.push(
      Topic({ title: "Older two", createdAt: 2, boardNames: older.namesTable }),
    );
  });
  // An unnamed member's row reads the default, so the board reads whole before
  // anything names it, and its universe row is one no `#42` query matches.
  // Here the table names nothing either, which is the state a backfill ends.
  const assert_unnamed_rows_carry_no_name = assert(() =>
    older.topicCount === 2 &&
    (older.index ?? []).length === 2 &&
    older.index?.[0]?.shortName === undefined &&
    older.index?.[1]?.shortName === undefined &&
    (older.namesTable ?? []).length === 0 &&
    older.mentionable?.[0]?.shortName === "" &&
    numberBadge(older[UI]) === undefined
  );
  // The library call the verb makes, so its return is observable here: exactly
  // the names it wrote, in filing order. The VERB's own result is not
  // observable in this lane — `send()` hands a pattern test nothing, because a
  // result reaches its caller through the handling's receipt — so it is
  // asserted in `packages/cli/integration/topics-restore-drill.sh`, as
  // `addTopic`'s `name` is.
  const assigned = new Writable<string[][]>([]);
  const action_backfill = action(() => {
    assigned.push(backfillNames(olderTopics, olderNames));
  });
  // The backfill names both topics in the table, and neither the survey rows
  // nor the universe rows carry a number.
  const assert_backfilled_in_filing_order = assert(() =>
    Object.keys((older.names ?? {}) as NamesMap).join(",") === "1,2" &&
    nameOf(olderTopics.key(0), older.namesTable ?? []) === "1" &&
    nameOf(olderTopics.key(1), older.namesTable ?? []) === "2" &&
    older.index?.[0]?.shortName === undefined &&
    older.index?.[1]?.shortName === undefined &&
    older.mentionable?.[0]?.shortName === "" &&
    older.mentionable?.[1]?.shortName === "" &&
    equals(
      ((older.names ?? {}) as NamesMap)["1"] as object,
      older.topics?.[0] as object,
    )
  );

  // A create after the backfill continues the sequence rather than restarting
  // it. The name a create allocates is as real as a backfilled one, and
  // `namesTable` is where both are read while no topic publishes one.
  const action_add_after_backfill = action(() => {
    older.addTopic.send({ title: "Newer one", agentName: "Sol" });
  });
  const action_file_a_late_unnamed = action(() => {
    olderTopics.push(Topic({ title: "Older three", createdAt: 3 }));
  });
  const action_backfill_again = action(() => {
    older.backfillNames.send({ agentName: "Sol" });
  });
  const assert_backfill_skips_the_named = assert(() =>
    older.topicCount === 4 &&
    Object.keys((older.names ?? {}) as NamesMap).join(",") === "1,2,3,4" &&
    older.index?.[2]?.title === "Newer one" &&
    older.index?.[2]?.shortName === undefined &&
    older.index?.[3]?.title === "Older three" &&
    older.index?.[3]?.shortName === undefined &&
    nameOf(olderTopics.key(2), older.namesTable ?? []) === "3" &&
    nameOf(olderTopics.key(3), older.namesTable ?? []) === "4"
  );
  // Idempotent: a run over a fully named list writes nothing, so the map holds
  // exactly what the first run and the create left.
  const action_backfill_a_third_time = action(() => {
    assigned.push(backfillNames(olderTopics, olderNames));
  });
  // The first run reports the two names it wrote; the third reports none,
  // which is the contract's own statement of idempotence.
  const assert_backfill_reports_what_it_wrote = assert(() =>
    assigned.get().length === 2 &&
    assigned.get()[0]?.join(",") === "1,2" &&
    assigned.get()[1]?.length === 0
  );
  const assert_third_backfill_leaves_the_map = assert(() =>
    Object.keys((older.names ?? {}) as NamesMap).join(",") === "1,2,3,4" &&
    (older.namesTable ?? []).length === 4 &&
    equals(
      ((older.names ?? {}) as NamesMap)["3"] as object,
      older.topics?.[2] as object,
    )
  );

  return {
    [TESTS]: [
      { assertion: assert_initial },
      { assertion: assert_declaration },
      { action: action_add_first },
      { action: action_add_second },
      { assertion: assert_allocated_on_create },
      { assertion: assert_table_names_each_topic },
      { assertion: assert_index_rows_carry_no_name },
      { assertion: assert_cards_show_no_number },
      { assertion: assert_universe_rows_carry_no_name },
      { assertion: assert_reads_expand_no_topic },
      { assertion: assert_solo_topic_has_no_name },
      { assertion: assert_solo_topic_renders_no_badge },
      { action: action_name_the_held_topic },
      { assertion: assert_named_topic_shows_no_number },
      { action: action_file_two_unnamed },
      { assertion: assert_unnamed_rows_carry_no_name },
      { action: action_backfill },
      { assertion: assert_backfilled_in_filing_order },
      { action: action_add_after_backfill },
      { action: action_file_a_late_unnamed },
      { action: action_backfill_again },
      { assertion: assert_backfill_skips_the_named },
      { action: action_backfill_a_third_time },
      { assertion: assert_third_backfill_leaves_the_map },
      { assertion: assert_backfill_reports_what_it_wrote },
    ],
  };
});
