import { Default, equals, type Writable } from "commonfabric";

export type OrderedCollectionCell<T extends object> = Writable<
  T[] | Default<[]>
>;

export interface PocChild {
  label: string;
}

export interface PocItem {
  title: string;
  done: boolean;
  children: PocChild[];
}

export type VoteChoice = "red" | "yellow" | "green";

export interface PocOption {
  id: string;
  title: string;
}

export interface PocVote {
  voter: string;
  optionId: string;
  choice: VoteChoice;
}

export interface PocTally {
  optionId: string;
  title: string;
  red: number;
  yellow: number;
  green: number;
  total: number;
}

export interface PocItemPatch {
  title?: string;
  done?: boolean;
}

export function findByRef<T extends object>(
  items: readonly T[],
  ref: T,
): number {
  return items.findIndex((item) => equals(item, ref));
}

export function updateItemByRef(
  items: OrderedCollectionCell<PocItem>,
  ref: PocItem,
  patch: PocItemPatch,
): boolean {
  const index = findByRef(items.get(), ref);
  if (index < 0) return false;
  if (patch.title !== undefined) {
    items.key(index).key("title").set(patch.title);
  }
  if (patch.done !== undefined) {
    items.key(index).key("done").set(patch.done);
  }
  return true;
}

export function removeByRef<T extends object>(
  items: OrderedCollectionCell<T>,
  ref: T,
): boolean {
  const index = findByRef(items.get(), ref);
  if (index < 0) return false;
  items.remove(ref);
  return true;
}

export function appendChildByRef(
  items: OrderedCollectionCell<PocItem>,
  ref: PocItem,
  child: PocChild,
): boolean {
  const index = findByRef(items.get(), ref);
  if (index < 0) return false;
  items.key(index).key("children").push(child);
  return true;
}

export function upsertLatestVote(
  votes: OrderedCollectionCell<PocVote>,
  vote: PocVote,
): "added" | "updated" | "removed" {
  const current = votes.get();
  const existingIndex = current.findIndex((candidate) =>
    candidate.voter === vote.voter && candidate.optionId === vote.optionId
  );
  if (existingIndex < 0) {
    votes.push(vote);
    return "added";
  }

  const existing = current[existingIndex];
  if (existing.choice === vote.choice) {
    votes.remove(existing);
    return "removed";
  }

  votes.key(existingIndex).key("choice").set(vote.choice);
  return "updated";
}

export function removeOptionAndVotes(
  options: OrderedCollectionCell<PocOption>,
  votes: OrderedCollectionCell<PocVote>,
  optionId: string,
): boolean {
  const option = options.get().find((candidate) => candidate.id === optionId);
  if (!option) return false;
  options.remove(option);
  votes.set(votes.get().filter((vote) => vote.optionId !== optionId));
  return true;
}

export function countVotesByOption(
  options: readonly PocOption[],
  votes: readonly PocVote[],
): PocTally[] {
  return options.map((option) => {
    const optionVotes = votes.filter((vote) => vote.optionId === option.id);
    return {
      optionId: option.id,
      title: option.title,
      red: optionVotes.filter((vote) => vote.choice === "red").length,
      yellow: optionVotes.filter((vote) => vote.choice === "yellow").length,
      green: optionVotes.filter((vote) => vote.choice === "green").length,
      total: optionVotes.length,
    };
  });
}
