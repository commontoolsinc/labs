import {
  computed,
  Default,
  equals,
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
  countOrderedWhere,
  countSnapshot,
  encodeKey,
  filteredOrderedValues,
  hasKey,
  type KeyedRecord,
  latestByCountViewPlanV1,
  orderedCollectionViewPlanV1,
  orderedValues,
  readKey,
  removeLatestByCount,
  removeOrdered,
  replaceOrderedFromArray,
  upsertOrdered,
  type ViewPlanV1,
  zeroBucket,
} from "./keyed-collection-v1.ts";
import {
  type PocChild,
  type PocItem,
  type PocItemPatch,
  type PocOption,
  type PocTally,
  type PocVote,
  type VoteChoice,
} from "./keyed-collection.ts";

type OptionsById = KeyedRecord<PocOption>;
type VotesByVoter = KeyedRecord<PocVote>;
type TallyBucketsByOption = KeyedRecord<CountBucket<VoteChoice>>;

const EMPTY_ITEMS: PocItem[] = [];
const EMPTY_OPTION_ORDER: string[] = [];
const EMPTY_OPTIONS_BY_ID: OptionsById = {};
const EMPTY_VOTES_BY_VOTER: VotesByVoter = {};
const EMPTY_TALLY_BUCKETS_BY_OPTION: TallyBucketsByOption = {};
const VOTE_CHOICES = ["red", "yellow", "green"] as const;

export const KEYED_COLLECTIONS_V1_VIEW_PLANS: readonly ViewPlanV1[] = [
  orderedCollectionViewPlanV1({
    name: "coffee-origin-options@1",
    source: "options",
    item: "PocOption",
    key: "id",
    cells: ["optionOrder", "optionsById", "optionCount"],
    outputs: ["options", "optionCount"],
    conflict: "reject",
    notes: [
      "Fallback uses today's ordered keyed cells; runtime can later own the index.",
    ],
  }),
  latestByCountViewPlanV1({
    name: "coffee-origin-vote-tallies@1",
    source: "votes",
    item: "PocVote",
    latestKey: "voter",
    groupBy: "optionId",
    choice: "choice",
    choices: VOTE_CHOICES,
    cells: ["votesByVoter", "tallyBucketsByOption", "voteCount"],
    outputs: [
      "votes",
      "tallies",
      "votedOptions",
      "votedOptionCount",
      "voteCount",
    ],
    removeWhenSame: true,
    notes: [
      "Fallback maintains latest votes and count buckets through helper writes.",
      "Future backends can apply old-row/new-row deltas instead of hot JSON rewrites.",
    ],
  }),
];

type ItemsCell = Writable<PocItem[] | Default<typeof EMPTY_ITEMS>>;
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

export interface AddItemEvent {
  title: string;
}

export interface UpdateItemEvent {
  item: PocItem;
  title?: string;
  done?: boolean;
}

export interface RemoveItemEvent {
  item: PocItem;
}

export interface AddChildEvent {
  item: PocItem;
  label: string;
}

export interface AddOptionEvent {
  id: string;
  title: string;
}

export interface RemoveOptionEvent {
  optionId: string;
}

export interface ReplaceOptionsEvent {
  options: readonly PocOption[];
}

export interface CastVoteEvent {
  voter: string;
  optionId: string;
  choice: VoteChoice;
}

export interface KeyedCollectionsV1Input {
  items?: PerSpace<PocItem[] | Default<typeof EMPTY_ITEMS>>;
  optionOrder?: PerSpace<string[] | Default<typeof EMPTY_OPTION_ORDER>>;
  optionsById?: PerSpace<OptionsById | Default<typeof EMPTY_OPTIONS_BY_ID>>;
  votesByVoter?: PerSpace<
    VotesByVoter | Default<typeof EMPTY_VOTES_BY_VOTER>
  >;
  tallyBucketsByOption?: PerSpace<
    TallyBucketsByOption | Default<typeof EMPTY_TALLY_BUCKETS_BY_OPTION>
  >;
  optionCount?: PerSpace<number | Default<0>>;
  voteCount?: PerSpace<number | Default<0>>;
}

export interface KeyedCollectionsV1Output {
  [NAME]: string;
  [UI]: VNode;
  items: readonly PocItem[];
  options: readonly PocOption[];
  votedOptions: readonly PocOption[];
  votes: readonly PocVote[];
  tallies: readonly PocTally[];
  itemCount: number;
  doneCount: number;
  childCount: number;
  optionCount: number;
  votedOptionCount: number;
  voteCount: number;
  viewPlans: readonly ViewPlanV1[];
  addItem: Stream<AddItemEvent>;
  updateItem: Stream<UpdateItemEvent>;
  removeItem: Stream<RemoveItemEvent>;
  addChild: Stream<AddChildEvent>;
  addOption: Stream<AddOptionEvent>;
  removeOption: Stream<RemoveOptionEvent>;
  replaceOptions: Stream<ReplaceOptionsEvent>;
  castVote: Stream<CastVoteEvent>;
}

const addItem = handler<AddItemEvent, { items: ItemsCell }>(
  ({ title }, { items }) => {
    const trimmed = title.trim();
    if (!trimmed) return;
    items.push({ title: trimmed, done: false, children: [] });
  },
);

const updateItem = handler<UpdateItemEvent, { items: ItemsCell }>(
  ({ item, title, done }, { items }) => {
    const index = items.get().findIndex((candidate) => equals(candidate, item));
    if (index < 0) return;
    const patch: PocItemPatch = {};
    if (title !== undefined) patch.title = title;
    if (done !== undefined) patch.done = done;
    if (patch.title !== undefined) {
      items.key(index).key("title").set(patch.title);
    }
    if (patch.done !== undefined) items.key(index).key("done").set(patch.done);
  },
);

const removeItem = handler<RemoveItemEvent, { items: ItemsCell }>(
  ({ item }, { items }) => {
    items.remove(item);
  },
);

const addChild = handler<AddChildEvent, { items: ItemsCell }>(
  ({ item, label }, { items }) => {
    const trimmed = label.trim();
    if (!trimmed) return;
    const index = items.get().findIndex((candidate) => equals(candidate, item));
    if (index < 0) return;
    items.key(index).key("children").push({ label: trimmed });
  },
);

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
    const option = { id: trimmedId, title: trimmedTitle };
    const result = upsertOrdered(
      { order: optionOrder, byId: optionsById, count: optionCount },
      optionKey,
      option,
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

const zeroBucketsForOptions = (
  order: readonly string[],
): TallyBucketsByOption => {
  const buckets: TallyBucketsByOption = {};
  for (const optionKey of order) buckets[optionKey] = zeroBucket(VOTE_CHOICES);
  return buckets;
};

const removeOption = handler<RemoveOptionEvent, {
  optionOrder: OptionOrderCell;
  optionsById: OptionsByIdCell;
  votesByVoter: VotesByVoterCell;
  tallyBucketsByOption: TallyBucketsByOptionCell;
  optionCount: CountCell;
  voteCount: CountCell;
}>(({ optionId }, {
  optionOrder,
  optionsById,
  votesByVoter,
  tallyBucketsByOption,
  optionCount,
  voteCount,
}) => {
  const trimmedOptionId = optionId.trim();
  if (!trimmedOptionId) return;
  const optionKey = encodeKey(trimmedOptionId);
  const removed = removeOrdered(
    { order: optionOrder, byId: optionsById, count: optionCount },
    optionKey,
  );
  if (!removed) return;
  for (const [key, vote] of Object.entries(votesByVoter.get())) {
    if (vote.optionId === trimmedOptionId) {
      removeLatestByCount(
        {
          latestByKey: votesByVoter,
          countsByGroup: tallyBucketsByOption,
          count: voteCount,
        },
        {
          latestKey: key,
          group: optionKey,
          choice: vote.choice,
          choices: VOTE_CHOICES,
        },
      );
    }
  }
  const nextBuckets: TallyBucketsByOption = {};
  for (const [key, bucket] of Object.entries(tallyBucketsByOption.get())) {
    if (key !== optionKey) nextBuckets[key] = bucket;
  }
  tallyBucketsByOption.set(nextBuckets);
});

const replaceOptions = handler<ReplaceOptionsEvent, {
  optionOrder: OptionOrderCell;
  optionsById: OptionsByIdCell;
  votesByVoter: VotesByVoterCell;
  tallyBucketsByOption: TallyBucketsByOptionCell;
  optionCount: CountCell;
  voteCount: CountCell;
}>(({ options }, {
  optionOrder,
  optionsById,
  votesByVoter,
  tallyBucketsByOption,
  optionCount,
  voteCount,
}) => {
  const normalized = options.map((option) => ({
    id: option.id.trim(),
    title: option.title.trim(),
  }));
  replaceOrderedFromArray(
    { order: optionOrder, byId: optionsById, count: optionCount },
    normalized,
    (option) => option.id,
  );
  votesByVoter.set({});
  tallyBucketsByOption.set(zeroBucketsForOptions(optionOrder.get()));
  voteCount.set(0);
});

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
  const option = readOption(optionsById, trimmedOption);
  if (!option) return;
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
      removeWhenSame: true,
    },
  );
});

function talliesSnapshot(
  order: readonly string[],
  optionsById: OptionsById,
  bucketsByOption: TallyBucketsByOption,
): PocTally[] {
  const tallies: PocTally[] = [];
  for (const optionId of order) {
    const option = optionsById[optionId];
    if (!option) continue;
    const bucket = bucketsByOption[optionId];
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

const votedOptionPredicate = (
  bucketsByOption: TallyBucketsByOption,
): (option: PocOption, key: string) => boolean => {
  return (_option: PocOption, key: string) => {
    const bucket = bucketsByOption[key];
    return (bucket?.total ?? 0) > 0;
  };
};

export default pattern<KeyedCollectionsV1Input, KeyedCollectionsV1Output>(
  ({
    items,
    optionOrder,
    optionsById,
    votesByVoter,
    tallyBucketsByOption,
    optionCount,
    voteCount,
  }) => {
    const boundAddItem = addItem({ items });
    const boundUpdateItem = updateItem({ items });
    const boundRemoveItem = removeItem({ items });
    const boundAddChild = addChild({ items });
    const boundAddOption = addOption({
      optionOrder,
      optionsById,
      tallyBucketsByOption,
      optionCount,
    });
    const boundRemoveOption = removeOption({
      optionOrder,
      optionsById,
      votesByVoter,
      tallyBucketsByOption,
      optionCount,
      voteCount,
    });
    const boundReplaceOptions = replaceOptions({
      optionOrder,
      optionsById,
      votesByVoter,
      tallyBucketsByOption,
      optionCount,
      voteCount,
    });
    const boundCastVote = castVote({
      optionsById,
      votesByVoter,
      tallyBucketsByOption,
      voteCount,
    });

    const options = computed(() => orderedValues(optionOrder, optionsById));
    const votedOptions = computed(() =>
      filteredOrderedValues(
        optionOrder,
        optionsById,
        votedOptionPredicate(tallyBucketsByOption),
      )
    );
    const votes = computed(() => Object.values(votesByVoter));
    const tallies = computed(() =>
      talliesSnapshot(optionOrder, optionsById, tallyBucketsByOption)
    );
    const votedOptionCount = computed(() =>
      countOrderedWhere(
        optionOrder,
        optionsById,
        votedOptionPredicate(tallyBucketsByOption),
      )
    );
    const childCount = computed(() =>
      items.reduce((total: number, item: PocItem) => {
        return total + item.children.length;
      }, 0)
    );

    return {
      [NAME]: "Keyed collection v1",
      [UI]: <div>Keyed collection v1</div>,
      items,
      options,
      votedOptions,
      votes,
      tallies,
      itemCount: items.length,
      doneCount: items.filter((item: PocItem) => item.done).length,
      childCount,
      optionCount,
      votedOptionCount,
      voteCount,
      viewPlans: KEYED_COLLECTIONS_V1_VIEW_PLANS,
      addItem: boundAddItem,
      updateItem: boundUpdateItem,
      removeItem: boundRemoveItem,
      addChild: boundAddChild,
      addOption: boundAddOption,
      removeOption: boundRemoveOption,
      replaceOptions: boundReplaceOptions,
      castVote: boundCastVote,
    };
  },
);

export type { PocChild, PocItem, PocOption, PocTally, PocVote, VoteChoice };
