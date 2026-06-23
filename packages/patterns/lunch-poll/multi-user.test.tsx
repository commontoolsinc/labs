/// <cts-enable />
/**
 * Multi-user pattern test for the lunch poll.
 *
 * main.test.tsx documents the single-identity caveat (CT-1598): one runtime
 * cannot simulate a second user, so admin gating against a real non-host and
 * host takeover were untestable. This runs ONE shared poll across two
 * worker-isolated runtimes and covers exactly that gap:
 * - second user join (PerUser identity isolation),
 * - admin gating rejecting a genuinely different non-host user,
 * - votes from two users tallied and visible cross-runtime,
 * - open host takeover (claimHost) observed from the deposed host's runtime.
 *
 * Joins go through the `joinAs` event-name override (the headless seam kept
 * by the profile migration); the profile-wish UI path needs a browser.
 *
 * Cross-runtime reads use INLINE literal accesses (users[0].name) — `.map()`,
 * loop-variable indexing, and helper calls over another runtime's arrays do
 * not resolve before a local write (see scrabble/multi-user.test.tsx).
 */
import { action, computed, multiUserTest, pattern } from "commonfabric";
import LunchPoll, { type CozyPollOutput } from "./main.tsx";

const TEST_WEB_SEARCH_URL =
  "data:application/json,%7B%22results%22%3A%5B%5D%7D";

interface Setup {
  poll: CozyPollOutput;
}

export const setup = pattern(() => ({
  poll: LunchPoll({ webSearchUrl: TEST_WEB_SEARCH_URL }),
}));

export const alice = pattern<{ setup: Setup }>(({ setup }) => {
  const poll = setup.poll;

  const action_join = action(() => {
    poll.joinAs.send({ name: "Alice" });
  });
  const action_add_sushi = action(() => {
    poll.addOption.send({ title: "Sushi" });
  });
  const action_vote_green = action(() => {
    const first = poll.options?.[0];
    if (first) poll.castVote.send({ optionId: first.id, voteType: "green" });
  });
  const action_refresh_homepages = action(() => {
    poll.enrichHomePages.send({});
  });

  // First joiner becomes the host.
  const assert_joined_as_host = computed(() =>
    poll.myName === "Alice" &&
    poll.adminName === "Alice" &&
    poll.isJoined === true &&
    poll.isAdmin === true &&
    (poll.users ?? []).length === 1 &&
    poll.users?.[0]?.name === "Alice"
  );
  const assert_option_added = computed(() =>
    (poll.options ?? []).length === 1 &&
    poll.options?.[0]?.title === "Sushi" &&
    poll.options?.[0]?.homePageUrl === "" &&
    poll.options?.[0]?.homePageUrlOverride === ""
  );
  const assert_own_vote = computed(() =>
    (poll.votes ?? []).length === 1 &&
    poll.votes?.[0]?.voterName === "Alice" &&
    poll.votes?.[0]?.voteType === "green"
  );
  // Bob joined and voted; his two gated addOption attempts left no trace.
  const assert_sees_bob = computed(() =>
    (poll.users ?? []).length === 2 &&
    poll.users?.[1]?.name === "Bob" &&
    (poll.votes ?? []).length === 2 &&
    poll.votes?.[1]?.voterName === "Bob" &&
    (poll.options ?? []).length === 1 &&
    poll.myName === "Alice"
  );
  const assert_host_lookup_active = computed(() =>
    (poll.homePageLookupUrls ?? []).length === 1 &&
    poll.homePageLookupUrls?.[0] === TEST_WEB_SEARCH_URL
  );
  // Host takeover observed from the deposed host's runtime.
  const assert_deposed = computed(() =>
    poll.adminName === "Bob" && poll.isAdmin === false
  );

  return {
    tests: [
      { action: action_join },
      { assertion: assert_joined_as_host },
      { action: action_add_sushi },
      { assertion: assert_option_added },
      { action: action_vote_green },
      { assertion: assert_own_vote },
      { label: "alice-set-up" },
      { await: "bob-voted" },
      { assertion: assert_sees_bob },
      { action: action_refresh_homepages },
      { assertion: assert_host_lookup_active },
      { label: "alice-refreshed-homepages" },
      { await: "bob-claimed-host" },
      { assertion: assert_deposed },
    ],
  };
});

export const bob = pattern<{ setup: Setup }>(({ setup }) => {
  const poll = setup.poll;

  const action_try_add_before_join = action(() => {
    poll.addOption.send({ title: "Pizza" });
  });
  const action_join = action(() => {
    poll.joinAs.send({ name: "Bob" });
  });
  const action_try_add_as_non_host = action(() => {
    poll.addOption.send({ title: "Pizza" });
  });
  const action_vote_green = action(() => {
    const first = poll.options?.[0];
    if (first) poll.castVote.send({ optionId: first.id, voteType: "green" });
  });
  const action_claim_host = action(() => {
    poll.claimHost.send({});
  });

  // Alice's setup propagated from her runtime.
  const assert_sees_alice_setup = computed(() =>
    (poll.users ?? []).length === 1 &&
    poll.users?.[0]?.name === "Alice" &&
    poll.adminName === "Alice" &&
    (poll.options ?? []).length === 1 &&
    poll.options?.[0]?.title === "Sushi" &&
    (poll.votes ?? []).length === 1
  );
  // PerUser isolation: Alice's join must not leak into Bob's identity.
  const assert_not_joined_yet = computed(() =>
    poll.myName === "" && poll.isJoined === false
  );
  const assert_joined_not_host = computed(() =>
    poll.myName === "Bob" &&
    poll.isJoined === true &&
    poll.isAdmin === false &&
    (poll.users ?? []).length === 2 &&
    poll.users?.[1]?.name === "Bob"
  );
  // Both gated attempts (pre-join AND joined-but-not-host) left no trace —
  // the CT-1598 gap: a real second user is rejected by the host gate.
  const assert_gating_held = computed(() => (poll.options ?? []).length === 1);
  const assert_both_votes = computed(() =>
    (poll.votes ?? []).length === 2 &&
    poll.votes?.[0]?.voterName === "Alice" &&
    poll.votes?.[1]?.voterName === "Bob"
  );
  const assert_non_host_lookup_inactive = computed(() =>
    poll.myName === "Bob" &&
    poll.isAdmin === false &&
    (poll.homePageLookupUrls ?? []).length === 1 &&
    poll.homePageLookupUrls?.[0] === ""
  );
  const assert_is_host_now = computed(() =>
    poll.adminName === "Bob" && poll.isAdmin === true
  );

  return {
    tests: [
      { await: "alice-set-up" },
      { assertion: assert_sees_alice_setup },
      { assertion: assert_not_joined_yet },
      { action: action_try_add_before_join },
      { action: action_join },
      { assertion: assert_joined_not_host },
      { action: action_try_add_as_non_host },
      { assertion: assert_gating_held },
      { action: action_vote_green },
      { assertion: assert_both_votes },
      { label: "bob-voted" },
      { await: "alice-refreshed-homepages" },
      { assertion: assert_non_host_lookup_inactive },
      { action: action_claim_host },
      { assertion: assert_is_host_now },
      { label: "bob-claimed-host" },
    ],
  };
});

export default multiUserTest({ setup, participants: { alice, bob } });
