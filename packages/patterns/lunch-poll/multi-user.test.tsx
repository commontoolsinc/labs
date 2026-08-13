/// <cts-enable />
/**
 * Multi-user pattern test for the lunch poll.
 *
 * One runtime cannot simulate a second user, so this runs ONE shared poll
 * across two worker-isolated runtimes and covers what a single identity
 * cannot: a second user joining, host gating rejecting a genuinely different
 * non-host, votes from two users tallied cross-runtime, and open host
 * takeover observed from the deposed host's runtime.
 *
 * Identity is each viewer's profile cell, so the shared state lives in `setup`
 * and each participant binds their OWN poll view to it. That mirrors
 * production, where every viewer resolves their own `#profile` against one
 * shared roster.
 *
 * Cross-runtime reads use INLINE literal accesses (users[0].name) — `.map()`,
 * loop-variable indexing, and helper calls over another runtime's arrays do
 * not resolve before a local write (see scrabble/multi-user.test.tsx).
 */
import {
  action,
  computed,
  Default,
  multiUserTest,
  pattern,
  TESTS,
  Writable,
} from "commonfabric";
import LunchPoll, {
  DEFAULT_HOST,
  type HostValue,
  type LunchProfile,
  type Option,
  type User,
  type Vote,
} from "./main.tsx";

interface Setup {
  users: Writable<User[] | Default<[]>>;
  votes: Writable<Vote[] | Default<[]>>;
  options: Writable<Option[] | Default<[]>>;
  host: Writable<HostValue>;
}

/** The shared poll state both viewers read and write. */
export const setup = pattern(() => ({
  users: Writable.perSpace.of<User[]>([]),
  votes: Writable.perSpace.of<Vote[]>([]),
  options: Writable.perSpace.of<Option[]>([]),
  host: Writable.perSpace.of<HostValue>(DEFAULT_HOST),
}));

export const alice = pattern<{ setup: Setup }>(({ setup }) => {
  const aliceProfile = Writable.of<LunchProfile>({ name: "Alice" });
  const poll = LunchPoll({
    users: setup.users,
    votes: setup.votes,
    options: setup.options,
    host: setup.host,
    viewer: { profile: aliceProfile, name: "Alice" },
  });

  const action_join = action(() => {
    poll.joinAs.send({});
  });
  const action_add_sushi = action(() => {
    poll.addOption.send({ title: "Sushi" });
  });
  const action_vote_green = action(() => {
    // Read the id inline. Binding the element first and reading `.id` off the
    // binding does not always resolve across runtimes before the send, which
    // reaches the stream as an undefined argument.
    const optionId = poll.options?.[0]?.id;
    if (optionId) poll.castVote.send({ optionId, voteType: "green" });
  });

  // First joiner becomes the host.
  const assert_joined_as_host = computed(() =>
    poll.myName === "Alice" &&
    poll.hostName === "Alice" &&
    poll.isJoined === true &&
    poll.isAdmin === true &&
    (poll.users ?? []).length === 1 &&
    poll.users?.[0]?.name === "Alice"
  );
  const assert_option_added = computed(() =>
    (poll.options ?? []).length === 1 &&
    poll.options?.[0]?.title === "Sushi"
  );
  const assert_own_vote = computed(() =>
    (poll.votes ?? []).length === 1 &&
    poll.votes?.[0]?.voteType === "green"
  );
  // Bob joined and voted; his two gated addOption attempts left no trace.
  const assert_sees_bob = computed(() =>
    (poll.users ?? []).length === 2 &&
    poll.users?.[1]?.name === "Bob" &&
    (poll.votes ?? []).length === 2 &&
    (poll.options ?? []).length === 1 &&
    poll.myName === "Alice"
  );
  // Host takeover observed from the deposed host's runtime.
  const assert_deposed = computed(() =>
    poll.hostName === "Bob" && poll.isAdmin === false
  );

  return {
    [TESTS]: [
      { action: action_join },
      { assertion: assert_joined_as_host },
      { action: action_add_sushi },
      { assertion: assert_option_added },
      { action: action_vote_green },
      { assertion: assert_own_vote },
      { label: "alice-set-up" },
      { await: "bob-voted" },
      { assertion: assert_sees_bob },
      { await: "bob-claimed-host" },
      { assertion: assert_deposed },
    ],
  };
});

export const bob = pattern<{ setup: Setup }>(({ setup }) => {
  const bobProfile = Writable.of<LunchProfile>({ name: "Bob" });
  const poll = LunchPoll({
    users: setup.users,
    votes: setup.votes,
    options: setup.options,
    host: setup.host,
    viewer: { profile: bobProfile, name: "Bob" },
  });

  const action_try_add_before_join = action(() => {
    poll.addOption.send({ title: "Pizza" });
  });
  const action_join = action(() => {
    poll.joinAs.send({});
  });
  const action_try_add_as_non_host = action(() => {
    poll.addOption.send({ title: "Pizza" });
  });
  const action_vote_green = action(() => {
    // Read the id inline. Binding the element first and reading `.id` off the
    // binding does not always resolve across runtimes before the send, which
    // reaches the stream as an undefined argument.
    const optionId = poll.options?.[0]?.id;
    if (optionId) poll.castVote.send({ optionId, voteType: "green" });
  });
  const action_claim_host = action(() => {
    poll.claimHost.send({});
  });

  // Alice's setup propagated from her runtime.
  const assert_sees_alice_setup = computed(() =>
    (poll.users ?? []).length === 1 &&
    poll.users?.[0]?.name === "Alice" &&
    poll.hostName === "Alice" &&
    (poll.options ?? []).length === 1 &&
    poll.options?.[0]?.title === "Sushi" &&
    (poll.votes ?? []).length === 1
  );
  // Identity isolation: Alice's join must not make Bob a participant.
  const assert_not_joined_yet = computed(() =>
    poll.myName === "Bob" && poll.isJoined === false
  );
  const assert_joined_not_host = computed(() =>
    poll.isJoined === true &&
    poll.isAdmin === false &&
    (poll.users ?? []).length === 2 &&
    poll.users?.[1]?.name === "Bob"
  );
  // Both gated attempts (pre-join AND joined-but-not-host) left no trace: a
  // real second user is rejected by the host gate.
  const assert_gating_held = computed(() => (poll.options ?? []).length === 1);
  const assert_both_votes = computed(() => (poll.votes ?? []).length === 2);
  const assert_is_host_now = computed(() =>
    poll.hostName === "Bob" && poll.isAdmin === true
  );

  return {
    [TESTS]: [
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
      { action: action_claim_host },
      { assertion: assert_is_host_now },
      { label: "bob-claimed-host" },
    ],
    // A vote is a read-modify-write over the shared list, so two viewers
    // writing at once conflict and the loser retries — the scheduler logs
    // "commit failed transiently; backing off". That retry IS the designed
    // behaviour here (identity is a cell, which cannot key a mergeable
    // per-vote write), and every assertion above holds after it, so the
    // warning is expected rather than a defect.
    allowConsoleWarnings: true,
  };
});

export default multiUserTest({ setup, participants: { alice, bob } });
