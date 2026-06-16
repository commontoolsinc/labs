import { type Default, type Writable } from "commonfabric";

export interface User {
  name: string;
  /** Avatar URL or glyph, snapshotted from the joiner's shared profile. */
  avatar?: string;
  color: string;
  joinedAt: number;
}

export type VoteColor = "green" | "yellow" | "red";

export interface Vote {
  voterName: string;
  optionId: string;
  voteType: VoteColor;
}

export interface JoinEvent {
  name?: string;
}

export type ClaimHostEvent = Record<PropertyKey, never>;

export interface AddOptionEvent {
  title?: string;
}

export interface RemoveOptionEvent {
  optionId: string;
}

export interface CastVoteEvent {
  optionId: string;
  voteType: VoteColor;
}

export type ResetVotesEvent = Record<PropertyKey, never>;

export interface ClearVoteEvent {
  optionId: string;
}

export type UsersCell = Writable<User[] | Default<[]>>;
export type VotesCell = Writable<Vote[] | Default<[]>>;
export type NameCell = Writable<string | Default<"">>;
