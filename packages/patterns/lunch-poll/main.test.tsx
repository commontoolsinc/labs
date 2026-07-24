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

import { action, computed, pattern, UI, wish, Writable } from "commonfabric";
import {
  findNode,
  hasExactText,
  propsOf,
  readValue,
} from "../test/vnode-helpers.ts";
import CozyPoll, {
  dayKeyOf,
  type LunchProfile,
  type Option,
  type User,
  type Vote,
} from "./main.tsx";

// This file's single identity IS the host, so adding options triggers the
// host-gated art generation. Mock the image endpoint so the flows stay
// deterministic and never reach a live dev server's real generator (the
// stored-art wiring itself is asserted in art-sync.test.tsx).
export const fetchMocks = [
  {
    urlIncludes: "/api/ai/img",
    contentType: "image/png",
    base64Body:
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  },
];

const findNodeByProp = (
  root: unknown,
  prop: string,
  expected: unknown,
): unknown | undefined =>
  findNode(root, (node) => {
    const props = propsOf(node);
    return props !== undefined && readValue(props[prop]) === expected;
  });

const SEEDED_OPTION: Option = {
  id: "opt-seeded",
  title: "Leftover Café",
  addedByName: "Stan",
};

const COLLIDING_INITIAL_OPTION: Option = {
  id: "opt-colliding-initials",
  title: "Initials Café",
  addedByName: "Daffodil",
};

const COLLIDING_INITIAL_USERS: User[] = [
  {
    name: "Daffodil",
    avatar: "",
    color: "#2f6f4e",
  },
  {
    name: "Dragonfly",
    avatar: "",
    color: "#c2573a",
  },
  {
    name: "Dan",
    avatar: "",
    color: "#3b4a6b",
  },
  {
    name: "Dana",
    avatar: "",
    color: "#a33b35",
  },
  {
    name: "dan",
    avatar: "",
    color: "#b27722",
  },
  {
    name: "A",
    avatar: "",
    color: "#7c3aed",
  },
  {
    name: "a",
    avatar: "",
    color: "#2f6f4e",
  },
  {
    name: "A1",
    avatar: "",
    color: "#c2573a",
  },
  {
    name: "Bob Smith",
    avatar: "",
    color: "#3b4a6b",
  },
  {
    name: "Bob  Smith",
    avatar: "",
    color: "#a33b35",
  },
  {
    name: "👩🏽‍💻Alice",
    avatar: "",
    color: "#7c3aed",
  },
  {
    name: "👩🏽‍💻Bob",
    avatar: "",
    color: "#2f6f4e",
  },
  {
    name: "🇺🇸Alice",
    avatar: "",
    color: "#c2573a",
  },
  {
    name: "🇺🇸Bob",
    avatar: "",
    color: "#3b4a6b",
  },
  {
    name: "e\u0301Alice",
    avatar: "",
    color: "#a33b35",
  },
  {
    name: "e\u0301Bob",
    avatar: "",
    color: "#b27722",
  },
];

export default pattern(() => {
  const poll = CozyPoll({});

  // Reference times derive from the interval `#now/300` wish — the same
  // shared ticking clock the pattern under test runs on (the pattern body
  // cannot read the ambient clock; the bare one-shot `#now` would freeze at
  // first capture, which is exactly what the poll must not do): "yesterday"
  // for the seeded stale vote, and the day key the pattern is expected to
  // filter to. Both read as unresolved (undefined / "") until the wish
  // resolves; the dependent assertions guard that window and the harness
  // re-evaluates them once the wish lands.
  const nowCell = wish<number>({ query: "#now/300" });
  const staleCastAt = computed(() =>
    nowCell.result == null ? undefined : nowCell.result - 86_400_000
  );
  const todayKey = computed(() =>
    nowCell.result == null ? "" : dayKeyOf(nowCell.result)
  );

  // A vote cast "yesterday" — stored, but hidden by the current-day filter.
  // `castAt` resolves with the wish; until then it reads undefined, which
  // the filter also treats as not-today.
  const STALE_VOTE: Vote = {
    voterName: "Stan",
    optionId: "opt-seeded",
    voteType: "green",
    castAt: staleCastAt,
  };

  // Second instance seeded with a stale vote, for the current-day filter
  // scenario (castVote always stamps "now", so staleness must be seeded).
  const stalePoll = CozyPoll({
    options: [SEEDED_OPTION],
    votes: [STALE_VOTE],
  });

  // Participant names with shared prefixes use distinct current-day vote labels.
  // Each label preserves complete displayed characters.
  const collidingCastAt = computed(() => nowCell.result ?? undefined);
  const initialsPoll = CozyPoll({
    options: [COLLIDING_INITIAL_OPTION],
    users: COLLIDING_INITIAL_USERS,
    votes: [
      {
        voterName: "Daffodil",
        optionId: COLLIDING_INITIAL_OPTION.id,
        voteType: "green",
        castAt: collidingCastAt,
      },
      {
        voterName: "Dragonfly",
        optionId: COLLIDING_INITIAL_OPTION.id,
        voteType: "yellow",
        castAt: collidingCastAt,
      },
      {
        voterName: "Dan",
        optionId: COLLIDING_INITIAL_OPTION.id,
        voteType: "red",
        castAt: collidingCastAt,
      },
      {
        voterName: "Dana",
        optionId: COLLIDING_INITIAL_OPTION.id,
        voteType: "green",
        castAt: collidingCastAt,
      },
      {
        voterName: "dan",
        optionId: COLLIDING_INITIAL_OPTION.id,
        voteType: "yellow",
        castAt: collidingCastAt,
      },
      {
        voterName: "A",
        optionId: COLLIDING_INITIAL_OPTION.id,
        voteType: "red",
        castAt: collidingCastAt,
      },
      {
        voterName: "a",
        optionId: COLLIDING_INITIAL_OPTION.id,
        voteType: "green",
        castAt: collidingCastAt,
      },
      {
        voterName: "A1",
        optionId: COLLIDING_INITIAL_OPTION.id,
        voteType: "yellow",
        castAt: collidingCastAt,
      },
      {
        voterName: "Bob Smith",
        optionId: COLLIDING_INITIAL_OPTION.id,
        voteType: "red",
        castAt: collidingCastAt,
      },
      {
        voterName: "Bob  Smith",
        optionId: COLLIDING_INITIAL_OPTION.id,
        voteType: "green",
        castAt: collidingCastAt,
      },
      {
        voterName: "👩🏽‍💻Alice",
        optionId: COLLIDING_INITIAL_OPTION.id,
        voteType: "yellow",
        castAt: collidingCastAt,
      },
      {
        voterName: "👩🏽‍💻Bob",
        optionId: COLLIDING_INITIAL_OPTION.id,
        voteType: "red",
        castAt: collidingCastAt,
      },
      {
        voterName: "🇺🇸Alice",
        optionId: COLLIDING_INITIAL_OPTION.id,
        voteType: "green",
        castAt: collidingCastAt,
      },
      {
        voterName: "🇺🇸Bob",
        optionId: COLLIDING_INITIAL_OPTION.id,
        voteType: "yellow",
        castAt: collidingCastAt,
      },
      {
        voterName: "e\u0301Alice",
        optionId: COLLIDING_INITIAL_OPTION.id,
        voteType: "red",
        castAt: collidingCastAt,
      },
      {
        voterName: "e\u0301Bob",
        optionId: COLLIDING_INITIAL_OPTION.id,
        voteType: "green",
        castAt: collidingCastAt,
      },
    ],
  });

  // A poll whose profile-first join runs through the PRODUCTION write path:
  // the injected `profile` override stands in for the `#profile` wish (the
  // injection seam), and the join action below stores the live cell into the
  // shared directory exactly as a deployed join would. The strip and the
  // header viewer chip must then render from the STORED directory entry —
  // the seeded guest renders as a plain chip beside the badge.
  const caseyProfile = Writable.perSpace.of<LunchProfile>({
    initialNameApplied: "Casey",
    name: "Casey Original",
    avatar: "casey.png",
  });
  const profilePoll = CozyPoll({
    users: [
      { name: "Guest Gil", avatar: "", color: "#c2573a" },
    ],
    profile: caseyProfile,
  });

  // === Actions ===

  const action_join_profile_poll_as_casey = action(() => {
    // No name: the profile-first path — joins as the profile's display name
    // and stores the live profile cell into the shared directory.
    profilePoll.joinAs.send({});
  });

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
    poll.options[0]?.addedByName === "Alex"
  );

  const assert_two_options = computed(() => poll.options.length === 2);

  const assert_green_vote_recorded = computed(() => {
    const v = poll.votes[0];
    return poll.votes.length === 1 &&
      v?.voteType === "green" &&
      v?.voterName === "Alex" &&
      // A handler-cast vote is stamped with today's castAt, so it must also
      // appear in the current-day view.
      poll.todaysVotes.length === 1 &&
      poll.todayVoteCount === 1;
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

  // === Current-day vote filter ===

  // The header renders the current date, and `todayDate` exposes the local
  // day key the votes are filtered to. The `todayKey !== ""` guard holds the
  // assertion false until this pattern's `#now` wish resolves.
  const assert_today_header_renders = computed(() =>
    todayKey !== "" &&
    findNodeByProp(poll[UI], "data-poll-today", true) !== undefined &&
    poll.todayDate === todayKey
  );

  const assert_colliding_initials_are_disambiguated = computed(() => {
    const ui = initialsPoll[UI];
    const daffodil = findNodeByProp(
      ui,
      "data-vote-swatch-name",
      "Daffodil",
    );
    const dragonfly = findNodeByProp(
      ui,
      "data-vote-swatch-name",
      "Dragonfly",
    );
    const dan = findNodeByProp(ui, "data-vote-swatch-name", "Dan");
    const dana = findNodeByProp(ui, "data-vote-swatch-name", "Dana");
    const lowerDan = findNodeByProp(ui, "data-vote-swatch-name", "dan");
    const upperA = findNodeByProp(ui, "data-vote-swatch-name", "A");
    const lowerA = findNodeByProp(ui, "data-vote-swatch-name", "a");
    const aOne = findNodeByProp(ui, "data-vote-swatch-name", "A1");
    const bobSmith = findNodeByProp(
      ui,
      "data-vote-swatch-name",
      "Bob Smith",
    );
    const bobDoubleSpace = findNodeByProp(
      ui,
      "data-vote-swatch-name",
      "Bob  Smith",
    );
    const emojiAlice = findNodeByProp(
      ui,
      "data-vote-swatch-name",
      "👩🏽‍💻Alice",
    );
    const emojiBob = findNodeByProp(
      ui,
      "data-vote-swatch-name",
      "👩🏽‍💻Bob",
    );
    const flagAlice = findNodeByProp(
      ui,
      "data-vote-swatch-name",
      "🇺🇸Alice",
    );
    const flagBob = findNodeByProp(
      ui,
      "data-vote-swatch-name",
      "🇺🇸Bob",
    );
    const accentAlice = findNodeByProp(
      ui,
      "data-vote-swatch-name",
      "e\u0301Alice",
    );
    const accentBob = findNodeByProp(
      ui,
      "data-vote-swatch-name",
      "e\u0301Bob",
    );
    return todayKey !== "" &&
      initialsPoll.todayDate === todayKey &&
      hasExactText(daffodil, "DF") &&
      hasExactText(dragonfly, "DR") &&
      hasExactText(dan, "DAN1") &&
      hasExactText(dana, "DANA") &&
      hasExactText(lowerDan, "DAN2") &&
      hasExactText(upperA, "A2") &&
      hasExactText(lowerA, "A3") &&
      hasExactText(aOne, "A1") &&
      hasExactText(bobSmith, "BOBSMITH1") &&
      hasExactText(bobDoubleSpace, "BOBSMITH2") &&
      hasExactText(emojiAlice, "👩🏽‍💻A") &&
      hasExactText(emojiBob, "👩🏽‍💻B") &&
      hasExactText(flagAlice, "🇺🇸A") &&
      hasExactText(flagBob, "🇺🇸B") &&
      hasExactText(accentAlice, "E\u0301A") &&
      hasExactText(accentBob, "E\u0301B");
  });

  const assert_vote_swatches_have_accessible_names = computed(() => {
    const ui = initialsPoll[UI];
    const daffodil = findNodeByProp(
      ui,
      "data-vote-swatch-name",
      "Daffodil",
    );
    const emojiBob = findNodeByProp(
      ui,
      "data-vote-swatch-name",
      "👩🏽‍💻Bob",
    );
    return readValue(propsOf(daffodil)?.role) === "img" &&
      readValue(propsOf(daffodil)?.["aria-label"]) ===
        "Daffodil: green vote" &&
      readValue(propsOf(emojiBob)?.role) === "img" &&
      readValue(propsOf(emojiBob)?.["aria-label"]) ===
        "👩🏽‍💻Bob: red vote";
  });

  // The seeded stale vote is stored but hidden: absent from `todaysVotes`,
  // the count, and the rendered swatches. Guarded on both `#now` reads —
  // this pattern's (`todayKey`, which also resolves the seeded `castAt`) and
  // the poll's own (via `todayDate`) — so it passes only once the day filter
  // is live and the vote really is dated yesterday, not merely during the
  // load window's empty vote view.
  const assert_stale_vote_hidden = computed(() =>
    todayKey !== "" &&
    stalePoll.todayDate === todayKey &&
    stalePoll.votes.length === 1 &&
    stalePoll.todaysVotes.length === 0 &&
    stalePoll.todayVoteCount === 0 &&
    findNodeByProp(stalePoll[UI], "data-vote-swatch-name", "Stan") ===
      undefined
  );

  // Options saved before generated art was introduced have no `imageUrl`
  // property. They must still satisfy the card's map/pattern contract and
  // render normally rather than passing a present-but-undefined value.
  const assert_legacy_option_without_image_renders = computed(() =>
    findNodeByProp(
      stalePoll[UI],
      "data-option-title",
      SEEDED_OPTION.title,
    ) !== undefined
  );

  const action_stale_join_as_stan = action(() => {
    stalePoll.joinAs.send({ name: "Stan" });
  });

  // Same color as the hidden stale vote.
  const action_stale_vote_green = action(() => {
    stalePoll.castVote.send({ optionId: "opt-seeded", voteType: "green" });
  });

  // A same-color click on a stale vote RE-CASTS it for today (fresh castAt)
  // instead of toggling off a vote the voter cannot see; the vote becomes
  // visible again (list, count, and swatch).
  const assert_stale_recast_visible = computed(() => {
    const v = stalePoll.todaysVotes[0];
    return todayKey !== "" &&
      stalePoll.todaysVotes.length === 1 &&
      v?.voterName === "Stan" &&
      v?.voteType === "green" &&
      typeof v?.castAt === "number" &&
      dayKeyOf(v.castAt) === todayKey &&
      stalePoll.todayVoteCount === 1 &&
      findNodeByProp(stalePoll[UI], "data-vote-swatch-name", "Stan") !==
        undefined;
  });

  // A second same-color click is the normal today-toggle-off.
  const assert_stale_recast_cleared = computed(() =>
    stalePoll.todaysVotes.length === 0 &&
    stalePoll.todayVoteCount === 0
  );

  // === Canonical profile rendering (seeded profilePoll) ===

  // The participants strip renders every profile-backed participant from
  // their STORED live cell and every guest as a plain chip.
  const assert_participants_strip_renders = computed(() => {
    const ui = profilePoll[UI];
    return findNodeByProp(ui, "data-participants-strip", true) !== undefined &&
      findNodeByProp(ui, "data-participant-badge", "Casey") !== undefined &&
      findNodeByProp(ui, "data-participant-guest", "Guest Gil") !== undefined;
  });

  // The joined viewer's header chip binds the STORED directory entry (a
  // static-position `$profile` binding — the guide's forbidden-computed case
  // is exactly what this pins against), and the guest fallback chip does NOT
  // render alongside it.
  const assert_viewer_chip_binds_stored_profile = computed(() => {
    const ui = profilePoll[UI];
    return findNodeByProp(ui, "data-viewer-badge", true) !== undefined &&
      profilePoll.participantProfiles.length === 1 &&
      profilePoll.participantProfiles[0]?.name === "Casey";
  });

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

      // Voting that same color once more re-adds it. A removed vote clears its
      // entity, so the toggle decision does not see stale content and dead-click.
      { action: action_vote_green_first_again },
      { assertion: assert_green_vote_recorded },

      // Admin reset clears votes
      { action: action_reset_votes },
      { assertion: assert_votes_reset },

      // After a reset, re-voting the same color also re-adds (reset clears the
      // vote entities too, so the toggle is not fooled by stale content).
      { action: action_vote_green_first },
      { assertion: assert_green_vote_recorded },
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

      // === Current-day vote filter ===
      // Header date + exposed day key.
      { assertion: assert_today_header_renders },
      // Same-first-letter participant names get stable, distinct swatches.
      { assertion: assert_colliding_initials_are_disambiguated },
      { assertion: assert_vote_swatches_have_accessible_names },
      // Seeded stale (yesterday) vote: stored but hidden everywhere.
      { assertion: assert_legacy_option_without_image_renders },
      { assertion: assert_stale_vote_hidden },
      // Same-color click on the stale vote re-casts it for today…
      { action: action_stale_join_as_stan },
      { action: action_stale_vote_green },
      { assertion: assert_stale_recast_visible },
      // …and a second same-color click toggles today's vote off as usual.
      { action: action_stale_vote_green },
      { assertion: assert_stale_recast_cleared },
      { action: action_join_profile_poll_as_casey },
      { assertion: assert_participants_strip_renders },
      { assertion: assert_viewer_chip_binds_stored_profile },
    ],
    poll,
    stalePoll,
  };
});
