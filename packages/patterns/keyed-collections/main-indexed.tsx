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
import { encodeKey } from "./keyed-collection-v1.ts";
import {
  type PocItem,
  type PocOption,
  type PocTally,
  type PocVote,
  type VoteChoice,
} from "./keyed-collection.ts";

type OptionsById = Record<string, PocOption>;
type VotesByKey = Record<string, PocVote>;
type TalliesByOption = Record<string, PocTally>;

const EMPTY_ITEMS: PocItem[] = [];
const EMPTY_OPTION_ORDER: string[] = [];
const EMPTY_OPTIONS_BY_ID: OptionsById = {};
const EMPTY_VOTES_BY_KEY: VotesByKey = {};
const EMPTY_TALLIES_BY_OPTION: TalliesByOption = {};

type ItemsCell = Writable<PocItem[] | Default<typeof EMPTY_ITEMS>>;
type OptionOrderCell = Writable<
  string[] | Default<typeof EMPTY_OPTION_ORDER>
>;
type OptionsByIdCell = Writable<
  OptionsById | Default<typeof EMPTY_OPTIONS_BY_ID>
>;
type VotesByKeyCell = Writable<
  VotesByKey | Default<typeof EMPTY_VOTES_BY_KEY>
>;
type TalliesByOptionCell = Writable<
  TalliesByOption | Default<typeof EMPTY_TALLIES_BY_OPTION>
>;

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

export interface CastVoteEvent {
  voter: string;
  optionId: string;
  choice: VoteChoice;
}

export interface IndexedCollectionsInput {
  items?: PerSpace<PocItem[] | Default<typeof EMPTY_ITEMS>>;
  optionOrder?: PerSpace<string[] | Default<typeof EMPTY_OPTION_ORDER>>;
  optionsById?: PerSpace<OptionsById | Default<typeof EMPTY_OPTIONS_BY_ID>>;
  votesByKey?: PerSpace<VotesByKey | Default<typeof EMPTY_VOTES_BY_KEY>>;
  talliesByOption?: PerSpace<
    TalliesByOption | Default<typeof EMPTY_TALLIES_BY_OPTION>
  >;
}

export interface IndexedCollectionsOutput {
  [NAME]: string;
  [UI]: VNode;
  items: readonly PocItem[];
  options: readonly PocOption[];
  votes: readonly PocVote[];
  tallies: readonly PocTally[];
  itemCount: number;
  doneCount: number;
  childCount: number;
  optionCount: number;
  voteCount: number;
  addItem: Stream<AddItemEvent>;
  updateItem: Stream<UpdateItemEvent>;
  removeItem: Stream<RemoveItemEvent>;
  addChild: Stream<AddChildEvent>;
  addOption: Stream<AddOptionEvent>;
  removeOption: Stream<RemoveOptionEvent>;
  castVote: Stream<CastVoteEvent>;
}

const zeroTally = (option: PocOption): PocTally => ({
  optionId: option.id,
  title: option.title,
  red: 0,
  yellow: 0,
  green: 0,
  total: 0,
});

const optionStorageKey = (optionId: string): string => encodeKey(optionId);
const voteKey = (voter: string, optionId: string): string =>
  encodeKey(voter, optionId);

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
    if (title !== undefined) items.key(index).key("title").set(title);
    if (done !== undefined) items.key(index).key("done").set(done);
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
  talliesByOption: TalliesByOptionCell;
}>(({ id, title }, { optionOrder, optionsById, talliesByOption }) => {
  const trimmedId = id.trim();
  const trimmedTitle = title.trim();
  if (!trimmedId || !trimmedTitle) return;
  const optionKey = optionStorageKey(trimmedId);
  if (optionsById.get()[optionKey]) return;
  const option = { id: trimmedId, title: trimmedTitle };
  optionOrder.push(optionKey);
  optionsById.key(optionKey).set(option);
  talliesByOption.key(optionKey).set(zeroTally(option));
});

const removeOption = handler<RemoveOptionEvent, {
  optionOrder: OptionOrderCell;
  optionsById: OptionsByIdCell;
  votesByKey: VotesByKeyCell;
  talliesByOption: TalliesByOptionCell;
}>(
  ({ optionId }, { optionOrder, optionsById, votesByKey, talliesByOption }) => {
    const trimmedOptionId = optionId.trim();
    const optionKey = optionStorageKey(trimmedOptionId);
    if (!optionsById.get()[optionKey]) return;
    optionOrder.set(optionOrder.get().filter((key) => key !== optionKey));
    const nextOptions = { ...optionsById.get() };
    delete nextOptions[optionKey];
    optionsById.set(nextOptions);

    const nextVotes = { ...votesByKey.get() };
    for (const [key, vote] of Object.entries(nextVotes)) {
      if (vote.optionId === trimmedOptionId) delete nextVotes[key];
    }
    votesByKey.set(nextVotes);

    const nextTallies = { ...talliesByOption.get() };
    delete nextTallies[optionKey];
    talliesByOption.set(nextTallies);
  },
);

const adjustTally = (
  talliesByOption: TalliesByOptionCell,
  option: PocOption,
  previous: VoteChoice | undefined,
  next: VoteChoice | undefined,
) => {
  const optionKey = optionStorageKey(option.id);
  const current = talliesByOption.get()[optionKey] ?? zeroTally(option);
  const patch: PocTally = { ...current };
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
  votesByKey: VotesByKeyCell;
  talliesByOption: TalliesByOptionCell;
}>(
  (
    { voter, optionId, choice },
    { optionsById, votesByKey, talliesByOption },
  ) => {
    const trimmedVoter = voter.trim();
    const trimmedOption = optionId.trim();
    if (!trimmedVoter || !trimmedOption) return;
    const option = optionsById.get()[optionStorageKey(trimmedOption)];
    if (!option) return;
    const key = voteKey(trimmedVoter, trimmedOption);
    const existing = votesByKey.get()[key];
    if (existing?.choice === choice) {
      const nextVotes = { ...votesByKey.get() };
      delete nextVotes[key];
      votesByKey.set(nextVotes);
      adjustTally(talliesByOption, option, choice, undefined);
      return;
    }
    votesByKey.key(key).set({
      voter: trimmedVoter,
      optionId: trimmedOption,
      choice,
    });
    adjustTally(talliesByOption, option, existing?.choice, choice);
  },
);

const optionsSnapshot = (
  order: readonly string[],
  byId: OptionsById,
): PocOption[] => {
  const snapshot: PocOption[] = [];
  for (const optionKey of order) {
    const option = byId[optionKey];
    if (option) snapshot.push(option);
  }
  return snapshot;
};

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

export default pattern<IndexedCollectionsInput, IndexedCollectionsOutput>(
  ({ items, optionOrder, optionsById, votesByKey, talliesByOption }) => {
    const boundAddItem = addItem({ items });
    const boundUpdateItem = updateItem({ items });
    const boundRemoveItem = removeItem({ items });
    const boundAddChild = addChild({ items });
    const boundAddOption = addOption({
      optionOrder,
      optionsById,
      talliesByOption,
    });
    const boundRemoveOption = removeOption({
      optionOrder,
      optionsById,
      votesByKey,
      talliesByOption,
    });
    const boundCastVote = castVote({
      optionsById,
      votesByKey,
      talliesByOption,
    });

    const options = computed(() => optionsSnapshot(optionOrder, optionsById));
    const votes = computed(() => Object.values(votesByKey));
    const tallies = computed(() =>
      talliesSnapshot(optionOrder, optionsById, talliesByOption)
    );
    const childCount = computed(() =>
      items.reduce((total: number, item: PocItem) => {
        return total + item.children.length;
      }, 0)
    );

    return {
      [NAME]: "Keyed collection indexed POC",
      [UI]: <div>Keyed collection indexed POC</div>,
      items,
      options,
      votes,
      tallies,
      itemCount: items.length,
      doneCount: items.filter((item: PocItem) => item.done).length,
      childCount,
      optionCount: optionOrder.length,
      voteCount: Object.keys(votesByKey).length,
      addItem: boundAddItem,
      updateItem: boundUpdateItem,
      removeItem: boundRemoveItem,
      addChild: boundAddChild,
      addOption: boundAddOption,
      removeOption: boundRemoveOption,
      castVote: boundCastVote,
    };
  },
);
