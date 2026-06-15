import {
  computed,
  Default,
  handler,
  NAME,
  pattern,
  type PerSpace,
  Stream,
  UI,
  type VNode,
  Writable,
} from "commonfabric";
import {
  countVotesByOption,
  type PocOption,
  type PocTally,
  type PocVote,
  type VoteChoice,
} from "./keyed-collection.ts";

type OptionsCell = Writable<PocOption[] | Default<[]>>;
type VotesCell = Writable<PocVote[] | Default<[]>>;

export interface AddOptionEvent {
  id: string;
  title: string;
}

export interface CastVoteEvent {
  voter: string;
  optionId: string;
  choice: VoteChoice;
}

export interface SeedVotesEvent {
  count: number;
}

export interface PerfArrayInput {
  options?: PerSpace<PocOption[] | Default<[]>>;
  votes?: PerSpace<PocVote[] | Default<[]>>;
}

export interface PerfArrayOutput {
  [NAME]: string;
  [UI]: VNode;
  tallies: readonly PocTally[];
  optionCount: number;
  voteCount: number;
  addOption: Stream<AddOptionEvent>;
  castVote: Stream<CastVoteEvent>;
  seedVotes: Stream<SeedVotesEvent>;
}

const addOption = handler<AddOptionEvent, { options: OptionsCell }>(
  ({ id, title }, { options }) => {
    const trimmedId = id.trim();
    const trimmedTitle = title.trim();
    if (!trimmedId || !trimmedTitle) return;
    if (options.get().some((option) => option.id === trimmedId)) return;
    options.push({ id: trimmedId, title: trimmedTitle });
  },
);

const castVote = handler<CastVoteEvent, {
  options: OptionsCell;
  votes: VotesCell;
}>(({ voter, optionId, choice }, { options, votes }) => {
  const trimmedVoter = voter.trim();
  const trimmedOption = optionId.trim();
  if (!trimmedVoter || !trimmedOption) return;
  if (!options.get().some((option) => option.id === trimmedOption)) return;

  const current = votes.get();
  const existingIndex = current.findIndex((vote) =>
    vote.voter === trimmedVoter
  );
  if (existingIndex >= 0) {
    votes.key(existingIndex).key("optionId").set(trimmedOption);
    votes.key(existingIndex).key("choice").set(choice);
    return;
  }

  votes.push({
    voter: trimmedVoter,
    optionId: trimmedOption,
    choice,
  });
});

const seedVotes = handler<SeedVotesEvent, {
  options: OptionsCell;
  votes: VotesCell;
}>(({ count }, { options, votes }) => {
  const currentOptions = options.get();
  if (currentOptions.length === 0) return;
  const boundedCount = Math.max(0, Math.floor(count));
  const seeded: PocVote[] = [];
  for (let i = 0; i < boundedCount; i++) {
    const option = currentOptions[i % currentOptions.length];
    seeded.push({
      voter: `user-${i}`,
      optionId: option.id,
      choice: "green",
    });
  }
  votes.set(seeded);
});

export default pattern<PerfArrayInput, PerfArrayOutput>(
  ({ options, votes }) => {
    const boundAddOption = addOption({ options });
    const boundCastVote = castVote({ options, votes });
    const boundSeedVotes = seedVotes({ options, votes });
    const tallies = computed(() => countVotesByOption(options, votes));

    return {
      [NAME]: "Array aggregate perf POC",
      [UI]: <div>Array aggregate perf POC</div>,
      tallies,
      optionCount: options.length,
      voteCount: votes.length,
      addOption: boundAddOption,
      castVote: boundCastVote,
      seedVotes: boundSeedVotes,
    };
  },
);
