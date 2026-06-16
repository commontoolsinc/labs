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
} from "commonfabric";
import {
  appendChildByRef,
  countVotesByOption,
  type OrderedCollectionCell,
  type PocChild,
  type PocItem,
  type PocItemPatch,
  type PocOption,
  type PocTally,
  type PocVote,
  removeByRef,
  removeOptionAndVotes,
  updateItemByRef,
  upsertLatestVote,
  type VoteChoice,
} from "./keyed-collection.ts";

type ItemsCell = OrderedCollectionCell<PocItem>;
type OptionsCell = OrderedCollectionCell<PocOption>;
type VotesCell = OrderedCollectionCell<PocVote>;

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

export interface KeyedCollectionsInput {
  items?: PerSpace<PocItem[] | Default<[]>>;
  options?: PerSpace<PocOption[] | Default<[]>>;
  votes?: PerSpace<PocVote[] | Default<[]>>;
}

export interface KeyedCollectionsOutput {
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

const addItem = handler<AddItemEvent, { items: ItemsCell }>(
  ({ title }, { items }) => {
    const trimmed = title.trim();
    if (!trimmed) return;
    items.push({ title: trimmed, done: false, children: [] });
  },
);

const updateItem = handler<UpdateItemEvent, { items: ItemsCell }>(
  ({ item, title, done }, { items }) => {
    const patch: PocItemPatch = {};
    if (title !== undefined) patch.title = title;
    if (done !== undefined) patch.done = done;
    updateItemByRef(items, item, patch);
  },
);

const removeItem = handler<RemoveItemEvent, { items: ItemsCell }>(
  ({ item }, { items }) => {
    removeByRef(items, item);
  },
);

const addChild = handler<AddChildEvent, { items: ItemsCell }>(
  ({ item, label }, { items }) => {
    const trimmed = label.trim();
    if (!trimmed) return;
    appendChildByRef(items, item, { label: trimmed });
  },
);

const addOption = handler<AddOptionEvent, { options: OptionsCell }>(
  ({ id, title }, { options }) => {
    const trimmedId = id.trim();
    const trimmedTitle = title.trim();
    if (!trimmedId || !trimmedTitle) return;
    if (options.get().some((option) => option.id === trimmedId)) return;
    options.push({ id: trimmedId, title: trimmedTitle });
  },
);

const removeOption = handler<RemoveOptionEvent, {
  options: OptionsCell;
  votes: VotesCell;
}>(({ optionId }, { options, votes }) => {
  removeOptionAndVotes(options, votes, optionId);
});

const castVote = handler<CastVoteEvent, {
  options: OptionsCell;
  votes: VotesCell;
}>(
  ({ voter, optionId, choice }, { options, votes }) => {
    const trimmedVoter = voter.trim();
    const trimmedOption = optionId.trim();
    if (!trimmedVoter || !trimmedOption) return;
    if (!options.get().some((option) => option.id === trimmedOption)) return;
    upsertLatestVote(votes, {
      voter: trimmedVoter,
      optionId: trimmedOption,
      choice,
    });
  },
);

export default pattern<KeyedCollectionsInput, KeyedCollectionsOutput>(
  ({ items, options, votes }) => {
    const boundAddItem = addItem({ items });
    const boundUpdateItem = updateItem({ items });
    const boundRemoveItem = removeItem({ items });
    const boundAddChild = addChild({ items });
    const boundAddOption = addOption({ options });
    const boundRemoveOption = removeOption({ options, votes });
    const boundCastVote = castVote({ options, votes });

    const tallies = computed(() => countVotesByOption(options, votes));
    const childCount = computed(() =>
      items.reduce((total: number, item: PocItem) => {
        return total + item.children.length;
      }, 0)
    );

    return {
      [NAME]: "Keyed collection POC",
      [UI]: <div>Keyed collection POC</div>,
      items,
      options,
      votes,
      tallies,
      itemCount: items.length,
      doneCount: items.filter((item: PocItem) => item.done).length,
      childCount,
      optionCount: options.length,
      voteCount: votes.length,
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

export type { PocChild, PocItem, PocOption, PocTally, PocVote, VoteChoice };
