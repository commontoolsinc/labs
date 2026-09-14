import {
  type Default,
  handler,
  type JSXElement,
  NAME,
  pattern,
  type PerSpace,
  type Stream,
  UI,
  Writable,
} from "commonfabric";
import LunchPoll, {
  type CozyPollOutput,
  type LunchProfile,
  type Option,
  type User,
  type ViewerOverride,
  type Vote,
  voteKeyFor,
} from "../../../lunch-poll/main.tsx";

/** Dimensions of one synthetic poll. */
interface SeedEvent {
  /** Number of independently linked votes. */
  voteCount: number;

  /** Number of separately stored voter profiles. */
  voterCount: number;

  /** Number of rendered options. */
  optionCount: number;

  /** Requires every supplied profile to be readable before seeding. */
  requireExistingProfiles?: boolean;
}

/** Observable controls and results shared by CLI and browser fixtures. */
interface Output {
  /** Fixture title. */
  [NAME]: string;

  /** Production poll with a synthetic viewer control. */
  [UI]: JSXElement;

  /** Initializes a fresh fixture. */
  seed: Stream<SeedEvent>;

  /** Selects the first synthetic voter. */
  claim: Stream<Record<string, unknown>>;

  /** Production vote handler. */
  castVote: CozyPollOutput["castVote"];

  /** Number of stored votes. */
  voteCount: number;

  /** Number of rendered options. */
  optionCount: number;

  /** Number of roster members. */
  userCount: number;

  /** Whether the synthetic viewer belongs to the roster. */
  isJoined: boolean;

  /** Stored vote links used by functional assertions. */
  votes: readonly Vote[];
}

const seed = handler<
  SeedEvent,
  {
    profiles: Writable<LunchProfile[]>;
    users: Writable<User[]>;
    options: Writable<Option[]>;
    votes: Writable<Vote[]>;
  }
>((
  { voteCount, voterCount, optionCount, requireExistingProfiles },
  { profiles, users, options, votes },
) => {
  if (
    !Number.isSafeInteger(voteCount) || voteCount < 1 ||
    !Number.isSafeInteger(voterCount) || voterCount < 1 ||
    !Number.isSafeInteger(optionCount) || optionCount < 1 ||
    voteCount > voterCount * optionCount
  ) {
    throw new Error(
      "Seed sizes must be positive integers with enough vote keys",
    );
  }
  if (votes.get().length > 0) throw new Error("Seed requires a fresh fixture");
  options.set(Array.from({ length: optionCount }, (_, index) => ({
    id: `option-${index}`,
    title: `Lunch ${index}`,
    addedByName: "Fixture",
    imageUrl:
      "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E",
  })));
  users.set(Array.from({ length: voterCount }, (_, index) => {
    const profile = profiles.elementById(String(index));
    const name = `Voter ${index}`;
    if (profile.get() === undefined) {
      if (requireExistingProfiles) {
        throw new Error(
          "Supplied voter profiles must be available before seeding",
        );
      }
      profile.set({ name });
      profiles.addUnique(profile);
    }
    return { name, profile, color: "#2f6f4e" };
  }));
  const seededVotes: Writable<Vote>[] = [];
  for (let index = 0; index < voteCount; index++) {
    const optionId = `option-${index % optionCount}`;
    const voter = profiles.elementById(String(Math.floor(index / optionCount)));
    const key = voteKeyFor(voter, optionId);
    if (key === undefined) throw new Error("Fixture voter has no identity");
    const vote = votes.elementById(key);
    vote.set({ optionId, voter, voteType: "green", castAt: Date.now() });
    seededVotes.push(vote);
  }
  votes.set(seededVotes);
});

const claim = handler<Record<string, unknown>, {
  profiles: Writable<LunchProfile[]>;
  overrideViewer: Stream<ViewerOverride>;
}>((_, { profiles, overrideViewer }) => {
  overrideViewer.send({ profile: profiles.elementById("0"), name: "Voter 0" });
});

export default pattern<{
  profiles?: PerSpace<Default<LunchProfile[], []>>;
}, Output>(({ profiles }) => {
  const users = new Writable.perSpace<User[]>([]);
  const options = new Writable.perSpace<Option[]>([]);
  const votes = new Writable.perSpace<Vote[]>([]);
  const poll = LunchPoll({ users, options, votes });
  const claimViewer = claim({ profiles, overrideViewer: poll.overrideViewer });
  return {
    [NAME]: "Lunch poll read benchmark",
    [UI]: (
      <div>
        <cf-button data-benchmark-claim onClick={claimViewer}>
          Use fixture viewer
        </cf-button>
        {poll[UI]}
      </div>
    ),
    seed: seed({ profiles, users, options, votes }),
    claim: claimViewer,
    castVote: poll.castVote,
    voteCount: poll.voteCount,
    optionCount: poll.optionCount,
    userCount: poll.userCount,
    isJoined: poll.isJoined,
    votes: poll.votes,
  };
});
