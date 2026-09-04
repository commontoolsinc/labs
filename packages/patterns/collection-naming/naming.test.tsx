/**
 * Pattern tests for the naming library's own rules, driven on plain cells
 * with no board: the sequence over the names in use, the allocator re-run
 * against a stale read — the shape a lost commit race leaves behind — the
 * reverse lookup, and the declaration.
 */

import { action, assert, equals, pattern, TESTS, Writable } from "commonfabric";
import {
  assignName,
  nameOf,
  type NamesMap,
  namesTable,
  nextNameAmong,
  ownName,
  SEQUENCE_NAMING,
} from "./naming.ts";

export default pattern(() => {
  // The sequence rule, over keys a map could hold: one more than the largest
  // member name present, compared by length and then lexicographically, and
  // unmoved by a key the sequence never issued.
  const assert_sequence_rule = assert(() =>
    nextNameAmong([]) === "1" &&
    nextNameAmong(["0"]) === "1" &&
    nextNameAmong(["1", "2"]) === "3" &&
    nextNameAmong(["2", "10"]) === "11" &&
    nextNameAmong(["3", "5"]) === "6" &&
    nextNameAmong(["99"]) === "100" &&
    nextNameAmong(["1299", "1300"]) === "1301" &&
    nextNameAmong(["alpha", "07", "4"]) === "5"
  );

  // Names never pass through a JavaScript number. Past `2^53` a number
  // cannot tell adjacent integers apart, and a wide enough one prints in
  // exponent form; a name is a decimal string at every width.
  const assert_names_stay_decimal_past_the_safe_integers = assert(() =>
    nextNameAmong(["9007199254740992"]) === "9007199254740993" &&
    nextNameAmong(["999999999999999999999999"]) ===
      "1000000000000000000000000" &&
    nextNameAmong(["9007199254740992", "9007199254740993"]) ===
      "9007199254740994"
  );

  // A key that is not a canonical decimal — a foreign client can write any
  // key into the map — is not a name: it neither counts as the largest nor
  // blocks allocation.
  const assert_foreign_keys_are_not_names = assert(() =>
    nextNameAmong(["007", "1e3", "abc"]) === "1" &&
    nextNameAmong(["007", "1e3", "abc", "4"]) === "5" &&
    nextNameAmong(["+5", "-1", " 6", "6 ", "0x10"]) === "1"
  );

  // The allocator under a lost race, step by step. A verb reads the keys and
  // computes its name; a concurrent create commits the same name first; the
  // runtime rejects the first verb's commit and re-runs it against the map
  // as the winner left it. The steps below are those three moments on one
  // map cell: the loser's re-run is `action_loser_reruns`, and what it
  // proves is that a re-run over the winner's write takes the next distinct
  // name rather than the one it first computed.
  const names = new Writable<NamesMap>({});
  const first = new Writable({ title: "first" });
  const winner = new Writable({ title: "winner" });
  const loser = new Writable({ title: "loser" });
  const issued = new Writable<string[]>([]);

  const action_assign_first = action(() => {
    issued.push(assignName(names, first));
  });
  const action_winner_lands = action(() => {
    names.key("2").set(winner);
  });
  const action_loser_reruns = action(() => {
    issued.push(assignName(names, loser));
  });

  const assert_first_is_one = assert(() =>
    issued.get().join(",") === "1" &&
    equals(names.get()["1"] as object, first)
  );
  const assert_stale_name_was_the_winners = assert(() =>
    nextNameAmong(["1"]) === "2" &&
    equals(names.get()["2"] as object, winner)
  );
  const assert_rerun_takes_the_next_distinct_name = assert(() =>
    issued.get().join(",") === "1,3" &&
    Object.keys(names.get()).join(",") === "1,2,3" &&
    equals(names.get()["3"] as object, loser)
  );

  // Foreign keys on a real map, as a client over the memory protocol could
  // leave them: they neither block allocation nor count as the largest, so
  // the next name follows the sequence's own largest.
  const foreign = new Writable({ title: "foreign" });
  const afterForeign = new Writable({ title: "after foreign" });
  const action_foreign_keys_land = action(() => {
    names.key("007").set(foreign);
    names.key("1e3").set(foreign);
    names.key("abc").set(foreign);
  });
  const action_allocate_after_them = action(() => {
    issued.push(assignName(names, afterForeign));
  });
  const assert_allocation_ignores_foreign_keys = assert(() =>
    issued.get().join(",") === "1,3,4" &&
    equals(names.get()["4"] as object, afterForeign) &&
    equals(names.get()["007"] as object, foreign) &&
    Object.keys(names.get()).toSorted().join(",") === "007,1,1e3,2,3,4,abc"
  );

  // The table publishes exactly the names the grammar admits. A map holding
  // `1`, `abc`, and `007` yields one row, and the member stored under the
  // foreign keys has no name by the table's own lookup.
  const tableMap = new Writable<NamesMap>({});
  const named = new Writable({ title: "named" });
  const underForeign = new Writable({ title: "under a foreign key" });
  const table = namesTable({ names: tableMap });
  const nameOfNamed = ownName({ table, self: named });
  const nameUnderForeign = ownName({ table, self: underForeign });
  const action_fill_the_table_map = action(() => {
    tableMap.key("1").set(named);
    tableMap.key("abc").set(underForeign);
    tableMap.key("007").set(underForeign);
  });
  const assert_table_publishes_only_names = assert(() =>
    Object.keys(tableMap.get()).toSorted().join(",") === "007,1,abc" &&
    (table ?? []).length === 1 &&
    table?.[0]?.name === "1" &&
    equals(table?.[0]?.member as object, named) &&
    nameOfNamed === "1" &&
    nameUnderForeign === undefined
  );

  // The reverse lookup matches by identity, and a member the table does not
  // hold has no name.
  const assert_reverse_lookup = assert(() => {
    const table = [
      { member: first, name: "1" },
      { member: winner, name: "2" },
    ];
    return nameOf(winner, table) === "2" &&
      nameOf(first, table) === "1" &&
      nameOf(loser, table) === undefined;
  });

  const assert_declaration = assert(() =>
    SEQUENCE_NAMING.policy.unique === "history" &&
    SEQUENCE_NAMING.policy.permanent === true &&
    SEQUENCE_NAMING.policy.reuse === false &&
    SEQUENCE_NAMING.policy.allocator === "sequence" &&
    SEQUENCE_NAMING.compact === true &&
    SEQUENCE_NAMING.name === undefined
  );

  return {
    [TESTS]: [
      { assertion: assert_sequence_rule },
      { action: action_assign_first },
      { assertion: assert_first_is_one },
      { action: action_winner_lands },
      { assertion: assert_stale_name_was_the_winners },
      { action: action_loser_reruns },
      { assertion: assert_rerun_takes_the_next_distinct_name },
      { assertion: assert_names_stay_decimal_past_the_safe_integers },
      { assertion: assert_foreign_keys_are_not_names },
      { action: action_foreign_keys_land },
      { action: action_allocate_after_them },
      { assertion: assert_allocation_ignores_foreign_keys },
      { action: action_fill_the_table_map },
      { assertion: assert_table_publishes_only_names },
      { assertion: assert_reverse_lookup },
      { assertion: assert_declaration },
    ],
  };
});
