/**
 * Defines the shared contracts for the dungeon character, quest, and
 * adventure patterns. The contracts keep entity references and mutation
 * streams explicit so browser, CLI, and composed-pattern callers interoperate.
 */

import {
  CHIP_UI,
  Default,
  NAME,
  type PerSpace,
  Stream,
  TILE_UI,
  UI,
  type VNode,
  Writable,
} from "commonfabric";

export type QuestStatus = "available" | "active" | "completed";

export type QuestObjectiveStatus = "locked" | "active" | "completed";

export interface MoveCharacterEvent {
  location: string;
}

/**
 * The narrow character role that other dungeon patterns may retain.
 *
 * A character is identified by the piece reference carrying this projection,
 * not by its mutable and non-unique name.
 */
export interface QuestCharacter {
  name: string;
  archetype: string;
  location: string;
}

/** The callable role retained by the adventure's character registry. */
export interface CharacterPiece extends QuestCharacter {
  moveTo: Stream<MoveCharacterEvent>;
}

export interface CharacterInput {
  name?: PerSpace<Writable<string | Default<"Unnamed adventurer">>>;
  archetype?: PerSpace<Writable<string | Default<"Adventurer">>>;
  location?: PerSpace<Writable<string | Default<"Antechamber">>>;
}

export interface CharacterOutput extends CharacterPiece {
  [NAME]: string;
  [UI]: VNode;
  [CHIP_UI]: VNode;
  [TILE_UI]: VNode;
}

/**
 * One objective in a quest definition.
 *
 * `key` and `evidenceKind` are semantic protocol names rather than entity
 * identifiers. Dependencies must reference objectives appearing earlier in
 * the same definition, keeping progress derivation deterministic and acyclic.
 */
export interface QuestObjectiveDefinition {
  key: string;
  title: string;
  evidenceKind: string;
  target?: number;
  requires?: string[];
}

/** A fact reported by a mechanic and retained as evidence by a quest. */
export interface QuestEvidence {
  kind: string;
  actors: QuestCharacter[];
  note: string;
}

export interface QuestObjectiveProgress extends QuestObjectiveDefinition {
  current: number;
  target: number;
  status: QuestObjectiveStatus;
  contributors: QuestCharacter[];
}

export interface JoinQuestEvent {
  character: QuestCharacter;
}

export type RecordEvidenceReason =
  | "accepted"
  | "empty-kind"
  | "no-actors"
  | "unknown-kind"
  | "unlisted-actor";

export interface RecordQuestEvidenceEvent {
  kind: string;
  actors: QuestCharacter[];
  note?: string;
}

export interface RecordQuestEvidenceResult {
  accepted: boolean;
  reason: RecordEvidenceReason;
}

export interface QuestInput {
  title?: PerSpace<Writable<string | Default<"Untitled quest">>>;
  summary?: PerSpace<Writable<string | Default<"">>>;
  objectives?: PerSpace<QuestObjectiveDefinition[] | Default<[]>>;
  participants?: PerSpace<
    Writable<QuestCharacter[] | Default<[]>>
  >;
  evidence?: PerSpace<Writable<QuestEvidence[] | Default<[]>>>;
}

/** The callable quest role retained by an adventure or another mechanic. */
export interface QuestPiece {
  title: string;
  summary: string;
  status: QuestStatus;
  objectives: QuestObjectiveDefinition[];
  progress: QuestObjectiveProgress[];
  participants: QuestCharacter[];
  evidence: QuestEvidence[];
  completedObjectiveCount: number;
  join: Stream<JoinQuestEvent>;
  recordEvidence: Stream<
    RecordQuestEvidenceEvent,
    RecordQuestEvidenceResult
  >;
}

export interface QuestOutput extends QuestPiece {
  [NAME]: string;
  [UI]: VNode;
  [CHIP_UI]: VNode;
  [TILE_UI]: VNode;
}

export interface CreateCharacterEvent {
  name: string;
  archetype?: string;
}

export interface CreateCharacterResult {
  character: CharacterPiece;
}

export interface AdventureInput {
  characters?: PerSpace<Writable<CharacterPiece[] | Default<[]>>>;
  questParticipants?: PerSpace<
    Writable<QuestCharacter[] | Default<[]>>
  >;
  questEvidence?: PerSpace<Writable<QuestEvidence[] | Default<[]>>>;
}

export interface AdventureOutput {
  [NAME]: string;
  [UI]: VNode;
  characters: CharacterPiece[];
  quest: QuestPiece;
  createCharacter: Stream<CreateCharacterEvent, CreateCharacterResult>;
  enlistCharacter: Stream<JoinQuestEvent>;
  recordQuestEvidence: Stream<
    RecordQuestEvidenceEvent,
    RecordQuestEvidenceResult
  >;
}
