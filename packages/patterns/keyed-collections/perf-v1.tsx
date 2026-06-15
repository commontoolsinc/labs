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
  applyLatestByCount,
  type CountBucket,
  countSnapshot,
  encodeKey,
  hasKey,
  type KeyedRecord,
  orderedValues,
  readKey,
  upsertOrdered,
  zeroBucket,
} from "./keyed-collection-v1.ts";
import {
  type PocOption,
  type PocTally,
  type PocVote,
  type VoteChoice,
} from "./keyed-collection.ts";

type OptionsById = KeyedRecord<PocOption>;
type VotesByVoter = KeyedRecord<PocVote>;
type TallyBucketsByOption = KeyedRecord<CountBucket<VoteChoice>>;

const EMPTY_OPTION_ORDER: string[] = [];
const EMPTY_OPTIONS_BY_ID: OptionsById = {};
const EMPTY_VOTES_BY_VOTER: VotesByVoter = {};
const EMPTY_TALLY_BUCKETS_BY_OPTION: TallyBucketsByOption = {};
const VOTE_CHOICES = ["red", "yellow", "green"] as const;

type OptionOrderCell = Writable<
  string[] | Default<typeof EMPTY_OPTION_ORDER>
>;
type OptionsByIdCell = Writable<
  OptionsById | Default<typeof EMPTY_OPTIONS_BY_ID>
>;
type VotesByVoterCell = Writable<
  VotesByVoter | Default<typeof EMPTY_VOTES_BY_VOTER>
>;
type TallyBucketsByOptionCell = Writable<
  TallyBucketsByOption | Default<typeof EMPTY_TALLY_BUCKETS_BY_OPTION>
>;
type CountCell = Writable<number | Default<0>>;

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

export interface PerfV1Input {
  optionOrder?: PerSpace<string[] | Default<typeof EMPTY_OPTION_ORDER>>;
  optionsById?: PerSpace<OptionsById | Default<typeof EMPTY_OPTIONS_BY_ID>>;
  votesByVoter?: PerSpace<VotesByVoter | Default<typeof EMPTY_VOTES_BY_VOTER>>;
  tallyBucketsByOption?: PerSpace<
    TallyBucketsByOption | Default<typeof EMPTY_TALLY_BUCKETS_BY_OPTION>
  >;
  optionCount?: PerSpace<number | Default<0>>;
  voteCount?: PerSpace<number | Default<0>>;
}

export interface PerfV1Output {
  [NAME]: string;
  [UI]: VNode;
  tallies: readonly PocTally[];
  optionCount: number;
  voteCount: number;
  addOption: Stream<AddOptionEvent>;
  castVote: Stream<CastVoteEvent>;
  seedVotes: Stream<SeedVotesEvent>;
}

const addOption = handler<AddOptionEvent, {
  optionOrder: OptionOrderCell;
  optionsById: OptionsByIdCell;
  tallyBucketsByOption: TallyBucketsByOptionCell;
  optionCount: CountCell;
}>(
  (
    { id, title },
    { optionOrder, optionsById, tallyBucketsByOption, optionCount },
  ) => {
    const trimmedId = id.trim();
    const trimmedTitle = title.trim();
    if (!trimmedId || !trimmedTitle) return;
    const optionKey = encodeKey(trimmedId);
    if (hasKey(optionsById, optionKey)) return;
    const result = upsertOrdered(
      { order: optionOrder, byId: optionsById, count: optionCount },
      optionKey,
      { id: trimmedId, title: trimmedTitle },
    );
    if (result === "added") {
      tallyBucketsByOption.key(optionKey).set(countSnapshot(
        tallyBucketsByOption,
        optionKey,
        VOTE_CHOICES,
      ));
    }
  },
);

const readOption = (
  optionsById: OptionsByIdCell,
  optionId: string,
): PocOption | undefined => {
  const optionKey = encodeKey(optionId);
  if (!hasKey(optionsById, optionKey)) return undefined;
  const option = readKey(optionsById, optionKey);
  return option?.id === optionId ? option : undefined;
};

const readVote = (
  votesByVoter: VotesByVoterCell,
  key: string,
): PocVote | undefined => {
  if (!hasKey(votesByVoter, key)) return undefined;
  const vote = readKey(votesByVoter, key);
  return vote && typeof vote.voter === "string" ? vote : undefined;
};

const castVote = handler<CastVoteEvent, {
  optionsById: OptionsByIdCell;
  votesByVoter: VotesByVoterCell;
  tallyBucketsByOption: TallyBucketsByOptionCell;
  voteCount: CountCell;
}>(({ voter, optionId, choice }, {
  optionsById,
  votesByVoter,
  tallyBucketsByOption,
  voteCount,
}) => {
  const trimmedVoter = voter.trim();
  const trimmedOption = optionId.trim();
  if (!trimmedVoter || !trimmedOption) return;
  if (!readOption(optionsById, trimmedOption)) return;
  const key = encodeKey(trimmedVoter);
  const optionKey = encodeKey(trimmedOption);
  const previous = readVote(votesByVoter, key);
  applyLatestByCount(
    {
      latestByKey: votesByVoter,
      countsByGroup: tallyBucketsByOption,
      count: voteCount,
    },
    {
      latestKey: key,
      item: { voter: trimmedVoter, optionId: trimmedOption, choice },
      group: optionKey,
      choice,
      previousGroup: previous ? encodeKey(previous.optionId) : undefined,
      previousChoice: previous?.choice,
      choices: VOTE_CHOICES,
    },
  );
});

const seedVotes = handler<SeedVotesEvent, {
  optionOrder: OptionOrderCell;
  optionsById: OptionsByIdCell;
  votesByVoter: VotesByVoterCell;
  tallyBucketsByOption: TallyBucketsByOptionCell;
  voteCount: CountCell;
}>(({ count }, {
  optionOrder,
  optionsById,
  votesByVoter,
  tallyBucketsByOption,
  voteCount,
}) => {
  const order = optionOrder.get();
  if (order.length === 0) return;
  const boundedCount = Math.max(0, Math.floor(count));
  const nextVotes: VotesByVoter = {};
  const nextBuckets: TallyBucketsByOption = {};
  for (const optionKey of order) {
    nextBuckets[optionKey] = zeroBucket(VOTE_CHOICES);
  }
  for (let i = 0; i < boundedCount; i++) {
    const optionKey = order[i % order.length];
    const option = readKey(optionsById, optionKey);
    if (!option) continue;
    const voter = `user-${i}`;
    nextVotes[encodeKey(voter)] = {
      voter,
      optionId: option.id,
      choice: "green",
    };
    const bucket = nextBuckets[optionKey];
    if (bucket) {
      bucket.total += 1;
      bucket.choices.green += 1;
    }
  }
  votesByVoter.set(nextVotes);
  tallyBucketsByOption.set(nextBuckets);
  voteCount.set(Object.keys(nextVotes).length);
});

function talliesSnapshot(
  order: readonly string[],
  optionsById: OptionsById,
  bucketsByOption: TallyBucketsByOption,
): PocTally[] {
  const tallies: PocTally[] = [];
  for (const option of orderedValues(order, optionsById)) {
    const bucket = bucketsByOption[encodeKey(option.id)];
    tallies.push({
      optionId: option.id,
      title: option.title,
      red: bucket?.choices.red ?? 0,
      yellow: bucket?.choices.yellow ?? 0,
      green: bucket?.choices.green ?? 0,
      total: bucket?.total ?? 0,
    });
  }
  return tallies;
}

export default pattern<PerfV1Input, PerfV1Output>(
  ({
    optionOrder,
    optionsById,
    votesByVoter,
    tallyBucketsByOption,
    optionCount,
    voteCount,
  }) => {
    const boundAddOption = addOption({
      optionOrder,
      optionsById,
      tallyBucketsByOption,
      optionCount,
    });
    const boundCastVote = castVote({
      optionsById,
      votesByVoter,
      tallyBucketsByOption,
      voteCount,
    });
    const boundSeedVotes = seedVotes({
      optionOrder,
      optionsById,
      votesByVoter,
      tallyBucketsByOption,
      voteCount,
    });
    const tallies = computed(() =>
      talliesSnapshot(optionOrder, optionsById, tallyBucketsByOption)
    );

    return {
      [NAME]: "Keyed collection v1 perf POC",
      [UI]: <div>Keyed collection v1 perf POC</div>,
      tallies,
      optionCount,
      voteCount,
      addOption: boundAddOption,
      castVote: boundCastVote,
      seedVotes: boundSeedVotes,
    };
  },
);
