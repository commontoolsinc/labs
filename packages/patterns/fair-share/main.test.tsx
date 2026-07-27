/**
 * Test Pattern: Fair Share — joinWithProfile identity preservation
 *
 * Exercises the exported joinWithProfile handler (the participant/roster
 * "join with your profile" idiom) against test-owned cells:
 * - joining as a new person pushes a {name, avatar?} snapshot and selects
 *   them as "you" (myName)
 * - joining as an existing avatar-less person BACKFILLS the avatar
 * - the avatar backfill must preserve the person's entity identity
 *   (CT-1715): it writes through the element's cell; replacing the array
 *   slot with a fresh object literal would re-mint the entity and orphan
 *   every previously-held reference (selection cells, rows read earlier)
 * - an existing avatar is NOT overwritten by a later join
 * - held-reference survival: a reference stashed BEFORE the backfill still
 *   `equals()`-matches the person and still drives a subsequent
 *   equals()-located removal AFTER the backfill
 *
 * The full Fair Share pattern is not instantiated here: its UI resolves
 * `wish()` queries, and the ledger handler under test is module-scope state
 * bound, so the contract is exercised directly on the cells.
 *
 * Run: deno task cf test packages/patterns/fair-share/main.test.tsx --verbose
 */
import {
  action,
  assert,
  equals,
  handler,
  pattern,
  Writable,
} from "commonfabric";
import { joinWithProfile } from "./main.tsx";

interface Person {
  name: string;
  avatar?: string;
}

// Test plumbing: remove the person the held reference points at, locating it
// with equals() — proves a reference held across the avatar backfill still
// drives operations (it would silently no-op if the backfill had re-minted
// the person's entity identity).
const removeHeldPerson = handler<
  void,
  { people: Writable<Person[]>; held: Writable<Person> }
>((_event, { people, held }) => {
  const cur = people.get();
  const idx = cur.findIndex((p) => equals(held, p));
  if (idx >= 0) {
    people.set(cur.toSpliced(idx, 1));
  }
});

export default pattern(() => {
  const peopleCell = new Writable<Person[]>([]);
  const myNameCell = new Writable<string>("");

  // Simulates an external holder (selection cell / balance row) that read a
  // person once and keeps the reference across later mutations. Typed
  // non-null (placeholder initial value) so the cell can be bound directly
  // as handler state.
  const held = new Writable<Person>({ name: "" });

  // ==========================================================================
  // Actions
  // ==========================================================================

  // Ann is added by hand first (no avatar) — the backfill target.
  const action_join_ann_no_avatar = joinWithProfile({
    people: peopleCell,
    myName: myNameCell,
    name: "Ann",
    avatar: "",
  });

  const action_stash_held = action(() => {
    const p = peopleCell.get()[0];
    if (p) held.set(p);
  });

  // Ann joins again with a profile avatar — exercises the backfill branch.
  const action_join_ann_with_avatar = joinWithProfile({
    people: peopleCell,
    myName: myNameCell,
    name: "Ann",
    avatar: "🙂",
  });

  // A later join must NOT clobber an existing avatar snapshot.
  const action_join_ann_other_avatar = joinWithProfile({
    people: peopleCell,
    myName: myNameCell,
    name: "Ann",
    avatar: "🦊",
  });

  // New person with avatar — the push branch.
  const action_join_bob = joinWithProfile({
    people: peopleCell,
    myName: myNameCell,
    name: "Bob",
    avatar: "🐱",
  });

  const action_remove_via_held = removeHeldPerson({
    people: peopleCell,
    held,
  });

  // ==========================================================================
  // Assertions
  // ==========================================================================

  const assert_ann_added = assert(() => {
    const cur = peopleCell.get();
    return cur.length === 1 && cur[0]?.name === "Ann" && !cur[0]?.avatar;
  });
  const assert_my_name_ann = assert(() => myNameCell.get() === "Ann");

  const assert_held_stashed = assert(() => {
    const h = held.get();
    return h.name === "Ann" && equals(peopleCell.get()[0], h);
  });

  const assert_avatar_backfilled = assert(() =>
    peopleCell.get()[0]?.avatar === "🙂"
  );
  // KEY: the stale-but-once-valid reference still equals()-matches the
  // person AFTER the backfill wrote through the element's cell.
  const assert_held_survives_backfill = assert(() => {
    const h = held.get();
    return equals(peopleCell.get()[0], h);
  });
  // The held reference also READS the update (it would show the stale,
  // orphaned entity if the backfill had re-minted identity).
  const assert_held_reads_backfill = assert(() => held.get().avatar === "🙂");

  const assert_avatar_not_clobbered = assert(() =>
    peopleCell.get()[0]?.avatar === "🙂"
  );

  const assert_bob_added_with_avatar = assert(() => {
    const cur = peopleCell.get();
    return cur.length === 2 && cur[1]?.name === "Bob" &&
      cur[1]?.avatar === "🐱";
  });
  const assert_my_name_bob = assert(() => myNameCell.get() === "Bob");

  // KEY: the held reference still DRIVES an equals()-located removal.
  const assert_removed_via_held = assert(() => {
    const cur = peopleCell.get();
    return cur.length === 1 && cur[0]?.name === "Bob";
  });

  // ==========================================================================
  // Test Sequence
  // ==========================================================================
  return {
    tests: [
      // Join as a new (avatar-less) person
      { action: action_join_ann_no_avatar },
      { assertion: assert_ann_added },
      { assertion: assert_my_name_ann },

      // Stash an external reference BEFORE the backfill
      { action: action_stash_held },
      { assertion: assert_held_stashed },

      // Avatar backfill preserves identity
      { action: action_join_ann_with_avatar },
      { assertion: assert_avatar_backfilled },
      { assertion: assert_held_survives_backfill },
      { assertion: assert_held_reads_backfill },

      // Existing avatar is not overwritten
      { action: action_join_ann_other_avatar },
      { assertion: assert_avatar_not_clobbered },

      // New person push branch
      { action: action_join_bob },
      { assertion: assert_bob_added_with_avatar },
      { assertion: assert_my_name_bob },

      // The held reference still drives removal after the backfill
      { action: action_remove_via_held },
      { assertion: assert_removed_via_held },
    ],
    peopleCell,
  };
});
