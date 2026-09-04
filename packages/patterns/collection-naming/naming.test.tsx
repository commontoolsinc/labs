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
  nextNameAmong,
  SEQUENCE_NAMING,
} from "./naming.ts";

export default pattern(() => {
  // The sequence rule, over keys a map could hold: one more than the largest
  // sequence name present, compared as numbers, and unmoved by a key the
  // sequence never issued.
  const assert_sequence_rule = assert(() =>
    nextNameAmong([]) === "1" &&
    nextNameAmong(["1", "2"]) === "3" &&
    nextNameAmong(["2", "10"]) === "11" &&
    nextNameAmong(["3", "5"]) === "6" &&
    nextNameAmong(["alpha", "07", "4"]) === "5"
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
      { assertion: assert_reverse_lookup },
      { assertion: assert_declaration },
    ],
  };
});
