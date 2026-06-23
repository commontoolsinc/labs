/**
 * Test: Cozy Lunch Poll - Scoped
 *
 * Exercises the scope idioms (per-space directory, per-user identity,
 * derived admin) and the core voting flows.
 *
 * Single-identity caveat (CT-1598): this file runs in one runtime with one
 * identity, so admin gating is exercised by attempting admin actions *before*
 * any join (myName empty → handler bails). The real second-user cases —
 * gating against a non-host user, host takeover, cross-runtime visibility —
 * are covered by multi-user.test.tsx.
 */

import { action, computed, pattern, UI } from "commonfabric";
import CozyPoll from "./main.tsx";

const isRecord = (value: unknown): value is Record<PropertyKey, unknown> =>
  typeof value === "object" && value !== null;

const readValue = (value: unknown): unknown => {
  if (!isRecord(value) || typeof value.get !== "function") {
    return value;
  }
  return (value.get as () => unknown)();
};

const propsOf = (node: unknown): Record<PropertyKey, unknown> | undefined => {
  const value = readValue(node);
  if (!isRecord(value)) return undefined;
  const props = readValue(value.props);
  return isRecord(props) ? props : undefined;
};

const childrenArray = (children: unknown): unknown[] => {
  const value = readValue(children);
  if (Array.isArray(value)) return value;
  return value === undefined || value === null || typeof value === "boolean"
    ? []
    : [value];
};

const childNodes = (node: unknown): unknown[] => {
  const value = readValue(node);
  if (Array.isArray(value)) return value;
  if (!isRecord(value)) return [];
  const ui = value[UI];
  return [
    ...(ui === undefined || ui === value ? [] : [ui]),
    ...childrenArray(value.children),
  ];
};

const findNodeByProp = (
  root: unknown,
  prop: string,
  expected: unknown,
): unknown | undefined => {
  const value = readValue(root);
  const props = propsOf(value);
  if (props && readValue(props[prop]) === expected) return value;
  return childNodes(value)
    .map((child) => findNodeByProp(child, prop, expected))
    .find((child) => child !== undefined);
};

export default pattern(() => {
  const poll = CozyPoll({});

  // === Actions ===

  const action_try_add_before_join = action(() => {
    poll.addOption.send({ title: "Should not appear" });
  });

  const action_try_remove_before_join = action(() => {
    poll.removeOption.send({ optionId: "any" });
  });

  const action_try_reset_before_join = action(() => {
    poll.resetVotes.send({});
  });

  const action_try_log_before_join = action(() => {
    poll.logVisit.send({ title: "Sneaky" });
  });

  const action_join_as_alex = action(() => {
    poll.joinAs.send({ name: "Alex" });
  });

  const action_try_rejoin_as_alex_two = action(() => {
    poll.joinAs.send({ name: "Alex Two" });
  });

  const action_add_chipotle = action(() => {
    poll.addOption.send({ title: "Chipotle" });
  });

  const action_set_chipotle_link = action(() => {
    const first = poll.options[0];
    if (first) {
      poll.setOptionUrl.send({
        optionId: first.id,
        url: "https://example.com/chipotle",
      });
    }
  });

  const action_add_thai = action(() => {
    poll.addOption.send({ title: "Thai Kitchen" });
  });

  const action_vote_green_first = action(() => {
    const first = poll.options[0];
    if (first) poll.castVote.send({ optionId: first.id, voteType: "green" });
  });

  const action_vote_yellow_first = action(() => {
    const first = poll.options[0];
    if (first) poll.castVote.send({ optionId: first.id, voteType: "yellow" });
  });

  const action_vote_red_first = action(() => {
    const first = poll.options[0];
    if (first) poll.castVote.send({ optionId: first.id, voteType: "red" });
  });

  const action_vote_green_first_again = action(() => {
    const first = poll.options[0];
    if (first) poll.castVote.send({ optionId: first.id, voteType: "green" });
  });

  const action_reset_votes = action(() => {
    poll.resetVotes.send({});
  });

  const action_remove_first_option = action(() => {
    const first = poll.options[0];
    if (first) poll.removeOption.send({ optionId: first.id });
  });

  // Cast a green vote on the surviving option (Thai) so that the next
  // logVisit captures a non-empty vote snapshot embedded in the entry.
  const action_vote_green_thai = action(() => {
    const first = poll.options[0]; // Thai Kitchen (the only survivor)
    if (first) poll.castVote.send({ optionId: first.id, voteType: "green" });
  });

  // Log a specific place by title (defaults wentAt to today). With a live
  // green vote on Thai, this also embeds one vote snapshot in the entry.
  const action_log_thai = action(() => {
    poll.logVisit.send({ title: "Thai Kitchen" });
  });

  // Backdated visits — fixed past timestamp so assertions are deterministic.
  const PAST_VISIT = 1700000000000; // 2023-11-14
  const action_log_visit_chipotle_backdated = action(() => {
    poll.logVisit.send({ title: "Chipotle", wentAt: PAST_VISIT + 1000 });
  });

  // Most-recent visit is recentVisits[0] (newest first). Thai is logged
  // "today" so it sorts ahead of the backdated Chipotle.
  const action_remove_first_history = action(() => {
    const first = poll.recentVisits[0];
    if (first) poll.removeHistoryEntry.send({ id: first.id });
  });

  const action_clear_history = action(() => {
    poll.clearHistory.send({});
  });

  // Single-identity caveat (CT-1598): host *takeover* needs a second user and
  // is covered by multi-user.test.tsx. This just confirms claimHost is wired
  // and is a harmless no-op when the caller already holds the role.
  const action_claim_host = action(() => {
    poll.claimHost.send({});
  });

  // === Assertions ===

  // After joining, no leftovers from the pre-join admin attempts: only
  // Alex is in users, no admin name was claimed by anyone else, and the
  // "Should not appear" option is absent (implied by chipotle assertions
  // later — options.length === 1 after only Chipotle is added).
  const assert_joined_as_alex = computed(() =>
    poll.users.length === 1 &&
    poll.users[0]?.name === "Alex" &&
    poll.myName === "Alex" &&
    poll.adminName === "Alex" &&
    poll.isJoined === true &&
    poll.isAdmin === true
  );

  const assert_immutable_after_join = computed(() =>
    poll.users.length === 1 &&
    poll.myName === "Alex"
  );

  const assert_chipotle_added = computed(() =>
    poll.options.length === 1 &&
    poll.options[0]?.title === "Chipotle" &&
    poll.options[0]?.addedByName === "Alex" &&
    poll.options[0]?.homePageUrl === "" &&
    poll.options[0]?.homePageUrlOverride === "" &&
    poll.options[0]?.imageUrl === ""
  );

  const assert_chipotle_link_updated = computed(() =>
    poll.options.length === 1 &&
    poll.options[0]?.homePageUrlOverride === "https://example.com/chipotle"
  );

  const assert_two_options = computed(() => poll.options.length === 2);

  const assert_green_vote_recorded = computed(() => {
    const v = poll.votes[0];
    return poll.votes.length === 1 &&
      v?.voteType === "green" &&
      v?.voterName === "Alex";
  });

  // The "All options" overview renders one swatch per voter, sourced from a
  // per-option `votes.filter((v) => v.optionId === oid)`. Regression guard for
  // the transformer filter/map lift bug (CT-1777) where the predicate compiled
  // to a proxy-vs-proxy `===` (always false), so the filter dropped every vote
  // and the swatches silently stopped rendering: after Alex's green vote, his
  // swatch must appear in the rendered UI tree.
  const assert_alex_swatch_renders = computed(() =>
    findNodeByProp(poll[UI], "data-vote-swatch-name", "Alex") !== undefined
  );

  const assert_changed_to_yellow = computed(() => {
    const v = poll.votes[0];
    return poll.votes.length === 1 &&
      v?.voteType === "yellow";
  });

  const assert_changed_to_red = computed(() => {
    const v = poll.votes[0];
    return poll.votes.length === 1 &&
      v?.voteType === "red";
  });

  const assert_revote_green_cleared = computed(() => poll.votes.length === 0);

  const assert_votes_reset = computed(() => poll.votes.length === 0);

  const assert_option_removed_with_its_votes = computed(() =>
    poll.options.length === 1 &&
    poll.options[0]?.title === "Thai Kitchen" &&
    poll.votes.length === 0
  );

  const assert_still_alex_host = computed(() =>
    poll.adminName === "Alex" && poll.isAdmin === true
  );

  // History lives in the `visits` PerSpace array now; we assert directly on the
  // `recentVisits` array (newest first) plus the `historyCount` /
  // `mostRecentTitle` / `voteHistoryCount` scalars.

  // Logged the surviving option (Thai Kitchen) by title → one entry, attributed
  // to the host (the frozen `loggedByName` snapshot). If the pre-join attempt
  // ("Sneaky") had not been gated, an entry would exist before this — so this
  // implicitly verifies the host gate too.
  const assert_thai_logged = computed(() => {
    const rows = poll.recentVisits ?? [];
    return rows.length === 1 &&
      rows[0]?.title === "Thai Kitchen" &&
      rows[0]?.loggedByName === "Alex" &&
      poll.historyCount === 1 &&
      poll.mostRecentTitle === "Thai Kitchen";
  });

  const assert_recent_visit_row_renders = computed(() =>
    findNodeByProp(
      poll[UI],
      "data-recent-visit-title",
      "Thai Kitchen",
    ) !== undefined
  );

  // The live green vote on Thai was snapshotted into the entry's `votes` when
  // Thai was logged → exactly one embedded snapshot.
  const assert_vote_snapshot = computed(() => poll.voteHistoryCount === 1);

  // Second entry is the backdated Chipotle log; newest-first sort puts it after
  // today's Thai, so it's rows[1]. `wentAt` is a plain ms-epoch number now, so
  // the backdated value compares directly (no TEXT encoding to round-trip).
  const assert_two_history = computed(() => {
    const rows = poll.recentVisits ?? [];
    return rows.length === 2 &&
      rows[1]?.title === "Chipotle" &&
      rows[1]?.wentAt === PAST_VISIT + 1000 &&
      poll.historyCount === 2;
  });

  // After deleting rows[0] (Thai, the most recent), only Chipotle remains. With
  // SQLite gone there are no independent async queries to settle, so we assert
  // the row content directly (which entry survived), not just the count — and
  // that the entry's live `loggedBy` link survives the array round-trip (push
  // on log + the set-subset filter on delete).
  const assert_one_history_after_remove = computed(() => {
    const rows = poll.recentVisits ?? [];
    return poll.historyCount === 1 &&
      rows.length === 1 &&
      rows[0]?.title === "Chipotle" &&
      rows[0]?.loggedByName === "Alex" &&
      rows[0]?.loggedBy != null;
  });

  // Clearing visits also drops the embedded vote snapshots.
  const assert_history_cleared = computed(() =>
    poll.historyCount === 0 &&
    poll.voteHistoryCount === 0
  );

  return {
    tests: [
      // Admin-gated handlers are no-ops before anyone joins (myName empty).
      // The handler bails on `if (!me || me !== admin) return`. No
      // separate assertion here — downstream assertions (e.g. only
      // Chipotle ends up in options, only Alex in users) implicitly
      // verify these attempts left no state. See ADMIN-FUTURE.md for
      // the kernel-level upgrade path.
      { action: action_try_add_before_join },
      { action: action_try_remove_before_join },
      { action: action_try_reset_before_join },
      { action: action_try_log_before_join },

      // First join → claims admin
      { action: action_join_as_alex },
      { assertion: assert_joined_as_alex },

      // Second join attempt → no-op (name immutable after join)
      { action: action_try_rejoin_as_alex_two },
      { assertion: assert_immutable_after_join },

      // claimHost is a harmless no-op when the caller is already host.
      { action: action_claim_host },
      { assertion: assert_still_alex_host },

      // Admin adds options
      { action: action_add_chipotle },
      { assertion: assert_chipotle_added },
      { action: action_set_chipotle_link },
      { assertion: assert_chipotle_link_updated },
      { action: action_add_thai },
      { assertion: assert_two_options },

      // Vote green → yellow → red (covers all three colors)
      { action: action_vote_green_first },
      { assertion: assert_green_vote_recorded },
      { assertion: assert_alex_swatch_renders },
      { action: action_vote_yellow_first },
      { assertion: assert_changed_to_yellow },
      { action: action_vote_red_first },
      { assertion: assert_changed_to_red },

      // Voting green again (was red) → switches to green
      { action: action_vote_green_first_again },
      { assertion: assert_green_vote_recorded },

      // Voting same color again → toggles off
      { action: action_vote_green_first_again },
      { assertion: assert_revote_green_cleared },

      // Admin reset clears votes
      { action: action_vote_green_first },
      { action: action_reset_votes },
      { assertion: assert_votes_reset },

      // Remove option with votes → option AND its votes are discarded
      { action: action_vote_green_first },
      { action: action_remove_first_option },
      { assertion: assert_option_removed_with_its_votes },

      // "We went here" history. The pre-join attempt above ("Sneaky") must
      // have left no trace.
      // Cast a live green vote on the surviving option (Thai) so the next
      // logVisit embeds it in the entry's snapshot.
      { action: action_vote_green_thai },
      // Log the surviving option by title → one visit entry, attributed to the
      // host, with one embedded vote snapshot for the green vote. History reads
      // are plain computeds over the `visits` array now, so the light per-action
      // settle is sufficient — no `{ settle: true }` async-query waits needed.
      { action: action_log_thai },
      { assertion: assert_thai_logged },
      { assertion: assert_recent_visit_row_renders },
      { assertion: assert_vote_snapshot },
      // A second, backdated, explicit log → two entries (proves backdating).
      { action: action_log_visit_chipotle_backdated },
      { assertion: assert_two_history },
      // Delete a single entry (host) → the other remains.
      { action: action_remove_first_history },
      { assertion: assert_one_history_after_remove },
      // Clear all → empty.
      { action: action_clear_history },
      { assertion: assert_history_cleared },
    ],
    poll,
  };
});
