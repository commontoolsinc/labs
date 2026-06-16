import { action, computed, equals, pattern, Writable } from "commonfabric";
import KeyedCollections, { type PocItem } from "./main.tsx";

export default pattern(() => {
  const poc = KeyedCollections({});
  const held = new Writable<PocItem | null>(null);

  const add_alpha = action(() => {
    poc.addItem.send({ title: "Alpha" });
  });
  const add_blank_item = action(() => {
    poc.addItem.send({ title: "   " });
  });
  const add_beta = action(() => {
    poc.addItem.send({ title: "Beta" });
  });
  const stash_alpha = action(() => {
    const item = poc.items[0];
    if (item) held.set(item);
  });
  const rename_held = action(() => {
    const item = held.get();
    if (item) poc.updateItem.send({ item, title: "Alpha Prime" });
  });
  const complete_held = action(() => {
    const item = held.get();
    if (item) poc.updateItem.send({ item, done: true });
  });
  const add_child_to_held = action(() => {
    const item = held.get();
    if (item) poc.addChild.send({ item, label: "subtask" });
  });
  const remove_held = action(() => {
    const item = held.get();
    if (item) poc.removeItem.send({ item });
  });

  const add_ethiopia = action(() => {
    poc.addOption.send({ id: "ethiopia", title: "Ethiopia" });
  });
  const add_blank_option = action(() => {
    poc.addOption.send({ id: "", title: "Ignored" });
  });
  const add_duplicate_ethiopia = action(() => {
    poc.addOption.send({ id: "ethiopia", title: "Duplicate" });
  });
  const add_colombia = action(() => {
    poc.addOption.send({ id: "colombia", title: "Colombia" });
  });
  const ghost_votes_green = action(() => {
    poc.castVote.send({
      voter: "ghost",
      optionId: "missing",
      choice: "green",
    });
  });
  const alice_votes_green = action(() => {
    poc.castVote.send({
      voter: "alice",
      optionId: "ethiopia",
      choice: "green",
    });
  });
  const alice_changes_to_red = action(() => {
    poc.castVote.send({
      voter: "alice",
      optionId: "ethiopia",
      choice: "red",
    });
  });
  const bob_votes_yellow = action(() => {
    poc.castVote.send({
      voter: "bob",
      optionId: "colombia",
      choice: "yellow",
    });
  });
  const alice_toggles_off = action(() => {
    poc.castVote.send({
      voter: "alice",
      optionId: "ethiopia",
      choice: "red",
    });
  });
  const remove_colombia = action(() => {
    poc.removeOption.send({ optionId: "colombia" });
  });

  const assert_initial_empty = computed(() =>
    poc.itemCount === 0 && poc.optionCount === 0 && poc.voteCount === 0
  );
  const assert_added_items = computed(() =>
    poc.itemCount === 2 &&
    poc.items[0]?.title === "Alpha" &&
    poc.items[1]?.title === "Beta"
  );
  const assert_held_stashed = computed(() => {
    const item = held.get();
    return item !== null && equals(poc.items[0], item);
  });
  const assert_held_updated_in_place = computed(() => {
    const item = held.get();
    return item !== null &&
      equals(poc.items[0], item) &&
      poc.items[0]?.title === "Alpha Prime" &&
      poc.items[0]?.done === true &&
      poc.doneCount === 1;
  });
  const assert_child_added = computed(() =>
    poc.childCount === 1 && poc.items[0]?.children[0]?.label === "subtask"
  );
  const assert_removed_by_ref = computed(() =>
    poc.itemCount === 1 && poc.items[0]?.title === "Beta"
  );

  const assert_options_added = computed(() =>
    poc.optionCount === 2 &&
    poc.options[0]?.id === "ethiopia" &&
    poc.options[1]?.id === "colombia"
  );
  const assert_duplicate_and_blank_ignored = computed(() =>
    poc.optionCount === 1 &&
    poc.options[0]?.id === "ethiopia" &&
    poc.options[0]?.title === "Ethiopia"
  );
  const assert_unknown_option_vote_ignored = computed(() =>
    poc.voteCount === 0 && poc.tallies[0]?.total === 0
  );
  const assert_alice_green = computed(() =>
    poc.voteCount === 1 &&
    poc.votes[0]?.voter === "alice" &&
    poc.votes[0]?.choice === "green" &&
    poc.tallies[0]?.green === 1
  );
  const assert_alice_latest_red = computed(() =>
    poc.voteCount === 1 &&
    poc.votes[0]?.voter === "alice" &&
    poc.votes[0]?.choice === "red" &&
    poc.tallies[0]?.red === 1 &&
    poc.tallies[0]?.green === 0
  );
  const assert_two_votes_tallied = computed(() =>
    poc.voteCount === 2 &&
    poc.tallies[0]?.red === 1 &&
    poc.tallies[1]?.yellow === 1
  );
  const assert_toggle_removed_latest = computed(() =>
    poc.voteCount === 1 &&
    poc.votes[0]?.voter === "bob" &&
    poc.tallies[0]?.total === 0 &&
    poc.tallies[1]?.yellow === 1
  );
  const assert_remove_option_cascades = computed(() =>
    poc.optionCount === 1 &&
    poc.options[0]?.id === "ethiopia" &&
    poc.voteCount === 0
  );

  return {
    tests: [
      { assertion: assert_initial_empty },
      { action: add_alpha },
      { action: add_blank_item },
      { action: add_beta },
      { assertion: assert_added_items },
      { action: stash_alpha },
      { assertion: assert_held_stashed },
      { action: rename_held },
      { action: complete_held },
      { assertion: assert_held_updated_in_place },
      { action: add_child_to_held },
      { assertion: assert_child_added },
      { action: remove_held },
      { assertion: assert_removed_by_ref },
      { action: add_ethiopia },
      { action: add_blank_option },
      { action: add_duplicate_ethiopia },
      { assertion: assert_duplicate_and_blank_ignored },
      { action: ghost_votes_green },
      { assertion: assert_unknown_option_vote_ignored },
      { action: add_colombia },
      { assertion: assert_options_added },
      { action: alice_votes_green },
      { assertion: assert_alice_green },
      { action: alice_changes_to_red },
      { assertion: assert_alice_latest_red },
      { action: bob_votes_yellow },
      { assertion: assert_two_votes_tallied },
      { action: alice_toggles_off },
      { assertion: assert_toggle_removed_latest },
      { action: remove_colombia },
      { assertion: assert_remove_option_cascades },
    ],
    poc,
  };
});
