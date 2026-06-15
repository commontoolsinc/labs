import { action, computed, equals, pattern, Writable } from "commonfabric";
import KeyedCollectionsV1, { type PocItem } from "./main-v1.tsx";
import {
  checkKeyedCollectionsViewPlanParityV1,
  LATEST_BY_COUNT_DELTA_V1_KIND,
  validateViewPlanV1,
  VIEW_PLAN_V1_VERSION,
} from "./keyed-collection-v1.ts";

export default pattern(() => {
  const poc = KeyedCollectionsV1({});
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
  const alice_moves_to_colombia_green = action(() => {
    poc.castVote.send({
      voter: "alice",
      optionId: "colombia",
      choice: "green",
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
      optionId: "colombia",
      choice: "green",
    });
  });
  const remove_colombia = action(() => {
    poc.removeOption.send({ optionId: " colombia " });
  });
  const add_proto_option = action(() => {
    poc.addOption.send({ id: "__proto__", title: "Proto-safe" });
  });
  const proto_voter_votes_green = action(() => {
    poc.castVote.send({
      voter: "__proto__",
      optionId: "__proto__",
      choice: "green",
    });
  });
  const replace_options_from_array = action(() => {
    poc.replaceOptions.send({
      options: [
        { id: "", title: "Ignored" },
        { id: "kenya", title: "Kenya" },
        { id: "guatemala", title: "Guatemala" },
        { id: " kenya ", title: " Kenya AA " },
      ],
    });
  });
  const vote_after_replace = action(() => {
    poc.castVote.send({
      voter: "casey",
      optionId: "kenya",
      choice: "yellow",
    });
  });

  const assert_initial_empty = computed(() =>
    poc.itemCount === 0 &&
    poc.optionCount === 0 &&
    poc.votedOptionCount === 0 &&
    poc.voteCount === 0
  );
  const assert_view_plans_attached = computed(() => {
    const [optionsPlan, votesPlan] = poc.viewPlans;
    if (!optionsPlan || !votesPlan) return false;
    return poc.viewPlans.length === 2 &&
      optionsPlan?.version === VIEW_PLAN_V1_VERSION &&
      votesPlan?.version === VIEW_PLAN_V1_VERSION &&
      validateViewPlanV1(optionsPlan).ok &&
      validateViewPlanV1(votesPlan).ok &&
      optionsPlan.fallback.mode === "cell-helper" &&
      votesPlan.fallback.mode === "cell-helper" &&
      optionsPlan.steps.some((step) =>
        step.kind === "keyBy" && step.fields?.[0] === "id"
      ) &&
      votesPlan.steps.some((step) =>
        step.kind === "latestBy" && step.fields?.[0] === "voter" &&
        step.conflict === "toggle-when-same"
      ) &&
      votesPlan.steps.some((step) =>
        step.kind === "countBy" && step.groupFields?.[0] === "optionId" &&
        step.choiceField === "choice"
      ) &&
      votesPlan.steps.some((step) =>
        step.kind === "materialize" &&
        step.lowering === LATEST_BY_COUNT_DELTA_V1_KIND
      );
  });
  const assert_view_plan_validation_rejects_bad_inputs = computed(() => {
    const unknownKind = validateViewPlanV1({
      version: VIEW_PLAN_V1_VERSION,
      name: "bad-kind",
      source: { name: "source", shape: "array", item: "Item" },
      steps: [{ kind: "scanEverything" }],
      fallback: { mode: "cell-helper", helper: "helper" },
      eligibleExecution: ["cell-fallback"],
      notes: [],
    });
    const badOrder = validateViewPlanV1({
      version: VIEW_PLAN_V1_VERSION,
      name: "bad-order",
      source: { name: "source", shape: "array", item: "Item" },
      steps: [{
        kind: "orderBy",
        order: [{ field: " ", direction: "sideways" }],
      }],
      fallback: { mode: "cell-helper", helper: "helper" },
      eligibleExecution: ["cell-fallback"],
      notes: [],
    });
    const missingOutputs = validateViewPlanV1({
      version: VIEW_PLAN_V1_VERSION,
      name: "missing-outputs",
      source: { name: "source", shape: "array", item: "Item" },
      steps: [{ kind: "materialize", view: "rows", outputs: [] }],
      fallback: { mode: "cell-helper", helper: "helper" },
      eligibleExecution: ["cell-fallback"],
      notes: [],
    });
    const badSource = validateViewPlanV1({
      version: VIEW_PLAN_V1_VERSION,
      name: "bad-source",
      source: { name: "source", shape: "spreadsheet", item: "Item" },
      steps: [{ kind: "keyBy", fields: ["id"] }],
      fallback: { mode: "cell-helper", helper: "helper" },
      eligibleExecution: ["cell-fallback"],
      notes: [],
    });
    const noFallback = validateViewPlanV1({
      version: VIEW_PLAN_V1_VERSION,
      name: "no-fallback",
      source: { name: "source", shape: "array", item: "Item" },
      steps: [{ kind: "keyBy", fields: ["id"] }],
      fallback: { mode: "cell-helper", helper: "helper" },
      eligibleExecution: ["runtime-maintained"],
      notes: [],
    });
    return !unknownKind.ok &&
      !badOrder.ok &&
      !missingOutputs.ok &&
      !badSource.ok &&
      noFallback.ok &&
      noFallback.warnings.length === 1;
  });
  const assert_view_plan_executor_matches_fallback = computed(() =>
    checkKeyedCollectionsViewPlanParityV1(poc).ok
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
    poc.votedOptionCount === 1 &&
    poc.votedOptions[0]?.id === "ethiopia" &&
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
  const assert_alice_moved_to_colombia = computed(() =>
    poc.voteCount === 1 &&
    poc.votes[0]?.voter === "alice" &&
    poc.votes[0]?.optionId === "colombia" &&
    poc.votes[0]?.choice === "green" &&
    poc.tallies[0]?.total === 0 &&
    poc.tallies[1]?.green === 1
  );
  const assert_two_votes_tallied = computed(() =>
    poc.voteCount === 2 &&
    poc.votedOptionCount === 1 &&
    poc.votedOptions[0]?.id === "colombia" &&
    poc.tallies[0]?.total === 0 &&
    poc.tallies[1]?.green === 1 &&
    poc.tallies[1]?.yellow === 1 &&
    poc.tallies[1]?.total === 2
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
    poc.votedOptionCount === 0 &&
    poc.voteCount === 0
  );
  const assert_proto_keys_are_safe = computed(() =>
    poc.optionCount === 2 &&
    poc.votedOptionCount === 1 &&
    poc.voteCount === 1 &&
    poc.options[1]?.id === "__proto__" &&
    poc.votedOptions[0]?.id === "__proto__" &&
    poc.votes[0]?.voter === "__proto__" &&
    poc.tallies[1]?.optionId === "__proto__" &&
    poc.tallies[1]?.green === 1
  );
  const assert_replace_array_keyed_backing = computed(() =>
    poc.optionCount === 2 &&
    poc.voteCount === 0 &&
    poc.votedOptionCount === 0 &&
    poc.options[0]?.id === "kenya" &&
    poc.options[0]?.title === "Kenya AA" &&
    poc.options[1]?.id === "guatemala" &&
    poc.tallies[0]?.total === 0 &&
    poc.tallies[1]?.total === 0
  );
  const assert_filter_and_count_after_replace_vote = computed(() =>
    poc.voteCount === 1 &&
    poc.votedOptionCount === 1 &&
    poc.votedOptions.length === 1 &&
    poc.votedOptions[0]?.id === "kenya" &&
    poc.tallies[0]?.yellow === 1 &&
    poc.tallies[1]?.total === 0
  );

  return {
    tests: [
      { assertion: assert_initial_empty },
      { assertion: assert_view_plan_executor_matches_fallback },
      { assertion: assert_view_plans_attached },
      { assertion: assert_view_plan_validation_rejects_bad_inputs },
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
      { assertion: assert_view_plan_executor_matches_fallback },
      { action: ghost_votes_green },
      { assertion: assert_unknown_option_vote_ignored },
      { assertion: assert_view_plan_executor_matches_fallback },
      { action: add_colombia },
      { assertion: assert_options_added },
      { assertion: assert_view_plan_executor_matches_fallback },
      { action: alice_votes_green },
      { assertion: assert_alice_green },
      { assertion: assert_view_plan_executor_matches_fallback },
      { action: alice_changes_to_red },
      { assertion: assert_alice_latest_red },
      { assertion: assert_view_plan_executor_matches_fallback },
      { action: alice_moves_to_colombia_green },
      { assertion: assert_alice_moved_to_colombia },
      { assertion: assert_view_plan_executor_matches_fallback },
      { action: bob_votes_yellow },
      { assertion: assert_two_votes_tallied },
      { assertion: assert_view_plan_executor_matches_fallback },
      { action: alice_toggles_off },
      { assertion: assert_toggle_removed_latest },
      { assertion: assert_view_plan_executor_matches_fallback },
      { action: remove_colombia },
      { assertion: assert_remove_option_cascades },
      { assertion: assert_view_plan_executor_matches_fallback },
      { action: add_proto_option },
      { action: proto_voter_votes_green },
      { assertion: assert_proto_keys_are_safe },
      { assertion: assert_view_plan_executor_matches_fallback },
      { action: replace_options_from_array },
      { assertion: assert_replace_array_keyed_backing },
      { assertion: assert_view_plan_executor_matches_fallback },
      { action: vote_after_replace },
      { assertion: assert_filter_and_count_after_replace_vote },
      { assertion: assert_view_plan_executor_matches_fallback },
    ],
    poc,
  };
});
