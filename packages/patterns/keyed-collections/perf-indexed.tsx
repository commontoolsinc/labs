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
import { encodeKey } from "./keyed-collection-v1.ts";
import {
  type PocOption,
  type PocTally,
  type PocVote,
  type VoteChoice,
} from "./keyed-collection.ts";

type OptionsById = Record<string, PocOption>;
type VotesByVoter = Record<string, PocVote>;
type TalliesByOption = Record<string, PocTally>;

const EMPTY_OPTION_ORDER: string[] = [];
const EMPTY_OPTIONS_BY_ID: OptionsById = {};
const EMPTY_VOTES_BY_VOTER: VotesByVoter = {};
const EMPTY_TALLIES_BY_OPTION: TalliesByOption = {};

type OptionOrderCell = Writable<
  string[] | Default<typeof EMPTY_OPTION_ORDER>
>;
type OptionsByIdCell = Writable<
  OptionsById | Default<typeof EMPTY_OPTIONS_BY_ID>
>;
type VotesByVoterCell = Writable<
  VotesByVoter | Default<typeof EMPTY_VOTES_BY_VOTER>
>;
type TalliesByOptionCell = Writable<
  TalliesByOption | Default<typeof EMPTY_TALLIES_BY_OPTION>
>;
type VoteCountCell = Writable<number | Default<0>>;

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

export interface PerfIndexedInput {
  optionOrder?: PerSpace<string[] | Default<typeof EMPTY_OPTION_ORDER>>;
  optionsById?: PerSpace<OptionsById | Default<typeof EMPTY_OPTIONS_BY_ID>>;
  votesByVoter?: PerSpace<VotesByVoter | Default<typeof EMPTY_VOTES_BY_VOTER>>;
  talliesByOption?: PerSpace<
    TalliesByOption | Default<typeof EMPTY_TALLIES_BY_OPTION>
  >;
  voteCount?: PerSpace<number | Default<0>>;
}

export interface PerfIndexedOutput {
  [NAME]: string;
  [UI]: VNode;
  tallies: readonly PocTally[];
  optionCount: number;
  voteCount: number;
  addOption: Stream<AddOptionEvent>;
  castVote: Stream<CastVoteEvent>;
  seedVotes: Stream<SeedVotesEvent>;
}

const zeroTally = (option: PocOption): PocTally => ({
  optionId: option.id,
  title: option.title,
  red: 0,
  yellow: 0,
  green: 0,
  total: 0,
});

const readOption = (
  optionsById: OptionsByIdCell,
  optionId: string,
): PocOption | undefined => {
  const value = optionsById.key(encodeKey(optionId)).get() as
    | PocOption
    | undefined;
  return value?.id === optionId ? value : undefined;
};

const readVote = (
  votesByVoter: VotesByVoterCell,
  key: string,
): PocVote | undefined => {
  const value = votesByVoter.key(key).get() as PocVote | undefined;
  return value && typeof value.voter === "string" ? value : undefined;
};

const addOption = handler<AddOptionEvent, {
  optionOrder: OptionOrderCell;
  optionsById: OptionsByIdCell;
  talliesByOption: TalliesByOptionCell;
}>(({ id, title }, { optionOrder, optionsById, talliesByOption }) => {
  const trimmedId = id.trim();
  const trimmedTitle = title.trim();
  if (!trimmedId || !trimmedTitle) return;
  if (readOption(optionsById, trimmedId)) return;
  const optionKey = encodeKey(trimmedId);
  const option = { id: trimmedId, title: trimmedTitle };
  optionOrder.push(optionKey);
  optionsById.key(optionKey).set(option);
  talliesByOption.key(optionKey).set(zeroTally(option));
});

const adjustTally = (
  talliesByOption: TalliesByOptionCell,
  option: PocOption,
  previous: VoteChoice | undefined,
  next: VoteChoice | undefined,
) => {
  const optionKey = encodeKey(option.id);
  const current = talliesByOption.key(optionKey).get() as PocTally | undefined;
  const patch = current ? { ...current } : zeroTally(option);
  if (previous !== undefined) {
    patch[previous] = Math.max(0, patch[previous] - 1);
    patch.total = Math.max(0, patch.total - 1);
  }
  if (next !== undefined) {
    patch[next] = patch[next] + 1;
    patch.total = patch.total + 1;
  }
  talliesByOption.key(optionKey).set(patch);
};

const castVote = handler<CastVoteEvent, {
  optionsById: OptionsByIdCell;
  votesByVoter: VotesByVoterCell;
  talliesByOption: TalliesByOptionCell;
  voteCount: VoteCountCell;
}>(({ voter, optionId, choice }, {
  optionsById,
  votesByVoter,
  talliesByOption,
  voteCount,
}) => {
  const trimmedVoter = voter.trim();
  const trimmedOption = optionId.trim();
  if (!trimmedVoter || !trimmedOption) return;
  const option = readOption(optionsById, trimmedOption);
  if (!option) return;

  const key = encodeKey(trimmedVoter);
  const existing = readVote(votesByVoter, key);
  if (existing?.optionId === trimmedOption && existing.choice === choice) {
    return;
  }

  if (!existing) {
    voteCount.set(voteCount.get() + 1);
  } else {
    const previousOption = readOption(optionsById, existing.optionId);
    if (previousOption) {
      adjustTally(talliesByOption, previousOption, existing.choice, undefined);
    }
  }

  votesByVoter.key(key).set({
    voter: trimmedVoter,
    optionId: trimmedOption,
    choice,
  });
  adjustTally(talliesByOption, option, undefined, choice);
});

const seedVotes = handler<SeedVotesEvent, {
  optionOrder: OptionOrderCell;
  optionsById: OptionsByIdCell;
  votesByVoter: VotesByVoterCell;
  talliesByOption: TalliesByOptionCell;
  voteCount: VoteCountCell;
}>(({ count }, {
  optionOrder,
  optionsById,
  votesByVoter,
  talliesByOption,
  voteCount,
}) => {
  const order = optionOrder.get();
  const options = optionsById.get();
  if (order.length === 0) return;
  const boundedCount = Math.max(0, Math.floor(count));
  const nextVotes: VotesByVoter = {};
  const nextTallies: TalliesByOption = {};
  for (const optionKey of order) {
    const option = options[optionKey];
    if (option) nextTallies[optionKey] = zeroTally(option);
  }
  for (let i = 0; i < boundedCount; i++) {
    const optionKey = order[i % order.length];
    const option = options[optionKey];
    if (!option) continue;
    const voter = `user-${i}`;
    nextVotes[encodeKey(voter)] = {
      voter,
      optionId: option.id,
      choice: "green",
    };
    const tally = nextTallies[optionKey] ?? zeroTally(option);
    tally.green += 1;
    tally.total += 1;
    nextTallies[optionKey] = tally;
  }
  votesByVoter.set(nextVotes);
  talliesByOption.set(nextTallies);
  voteCount.set(Object.keys(nextVotes).length);
});

const talliesSnapshot = (
  order: readonly string[],
  optionsById: OptionsById,
  talliesByOption: TalliesByOption,
): PocTally[] => {
  const snapshot: PocTally[] = [];
  for (const optionKey of order) {
    const option = optionsById[optionKey];
    if (option) snapshot.push(talliesByOption[optionKey] ?? zeroTally(option));
  }
  return snapshot;
};

export default pattern<PerfIndexedInput, PerfIndexedOutput>(
  ({ optionOrder, optionsById, votesByVoter, talliesByOption, voteCount }) => {
    const boundAddOption = addOption({
      optionOrder,
      optionsById,
      talliesByOption,
    });
    const boundCastVote = castVote({
      optionsById,
      votesByVoter,
      talliesByOption,
      voteCount,
    });
    const boundSeedVotes = seedVotes({
      optionOrder,
      optionsById,
      votesByVoter,
      talliesByOption,
      voteCount,
    });
    const tallies = computed(() =>
      talliesSnapshot(optionOrder, optionsById, talliesByOption)
    );

    return {
      [NAME]: "Indexed aggregate perf POC",
      [UI]: <div>Indexed aggregate perf POC</div>,
      tallies,
      optionCount: optionOrder.length,
      voteCount,
      addOption: boundAddOption,
      castVote: boundCastVote,
      seedVotes: boundSeedVotes,
    };
  },
);
