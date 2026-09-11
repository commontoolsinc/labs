import {
  handler,
  NAME,
  pattern,
  type Stream,
  UI,
  Writable,
} from "commonfabric";
import LunchPoll, {
  type LunchProfile,
  type Option,
  type User,
  type ViewerOverride,
  type Vote,
  voteKeyFor,
} from "../../../lunch-poll/main.tsx";

const seed = handler<
  { voteCount: number; voterCount: number; optionCount: number },
  {
    profiles: Writable<LunchProfile[]>;
    users: Writable<User[]>;
    options: Writable<Option[]>;
    votes: Writable<Vote[]>;
  }
>((
  { voteCount, voterCount, optionCount },
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
    profile.set({ name });
    profiles.addUnique(profile);
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

export default pattern(() => {
  const profiles = new Writable.perSpace<LunchProfile[]>([]);
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
