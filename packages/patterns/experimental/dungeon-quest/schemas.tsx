/**
 * Defines the shared contracts for the dungeon character, quest, and
 * adventure patterns. The contracts keep entity references and mutation
 * streams explicit so browser, CLI, and composed-pattern callers interoperate.
 */

import {
  type BuiltInLLMMessage,
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

export interface DamageCharacterEvent {
  amount?: number;
}

export interface AddInventoryItemEvent {
  item: string;
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

/** The character facts visible to a room and its game master. */
export interface EncounterCharacter extends QuestCharacter {
  health?: number;
  maxHealth?: number;
  power?: number;
  inventory?: string[];
}

/** The callable role retained by the adventure's character registry. */
export interface CharacterPiece extends EncounterCharacter {
  moveTo: Stream<MoveCharacterEvent>;
}

export interface CharacterInput {
  name?: PerSpace<Writable<string | Default<"Unnamed adventurer">>>;
  archetype?: PerSpace<Writable<string | Default<"Adventurer">>>;
  location?: PerSpace<Writable<string | Default<"Antechamber">>>;
  health?: PerSpace<Writable<number | Default<10>>>;
  maxHealth?: PerSpace<Writable<number | Default<10>>>;
  power?: PerSpace<Writable<number | Default<2>>>;
  inventory?: PerSpace<Writable<string[] | Default<[]>>>;
}

export interface CharacterOutput extends CharacterPiece {
  [NAME]: string;
  [UI]: VNode;
  [CHIP_UI]: VNode;
  [TILE_UI]: VNode;
  health: number;
  maxHealth: number;
  power: number;
  inventory: string[];
  takeDamage: Stream<DamageCharacterEvent>;
  rest: Stream<void>;
  addItem: Stream<AddInventoryItemEvent>;
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
  reset: Stream<void>;
}

export interface CreateCharacterEvent {
  name: string;
  archetype?: string;
}

export interface CreateCharacterResult {
  character: CharacterPiece;
}

export type AdventureActionKind =
  | "assemble-party"
  | "open-sealed-door"
  | "defeat-sentinel"
  | "open-sunken-gate";

export type DungeonLocationKey =
  | "antechamber"
  | "moonlit-hall"
  | "gatehouse"
  | "sunken-gate";

export type AdventureActionReason =
  | "accepted"
  | "already-completed"
  | "prerequisite-incomplete"
  | "insufficient-party"
  | "wrong-location";

export interface AttemptAdventureActionEvent {
  action: AdventureActionKind;
}

export interface AttemptAdventureActionResult {
  accepted: boolean;
  reason: AdventureActionReason;
  actorCount: number;
}

export interface LocationInput {
  locationKey: DungeonLocationKey;
  characters?: PerSpace<EncounterCharacter[] | Default<[]>>;
  questParticipants?: PerSpace<
    Writable<QuestCharacter[] | Default<[]>>
  >;
  questEvidence?: PerSpace<Writable<QuestEvidence[] | Default<[]>>>;
  encounterMessages?: PerSpace<
    Writable<BuiltInLLMMessage[] | Default<[]>>
  >;
}

/** The navigable role retained by the adventure's world map. */
export interface LocationPiece {
  [NAME]: string;
  [UI]: VNode;
  [CHIP_UI]: VNode;
  [TILE_UI]: VNode;
  locationKey: DungeonLocationKey;
  name: string;
  description: string;
  occupants: EncounterCharacter[];
  occupantCount: number;
  objectiveStatus: QuestObjectiveStatus;
  encounterMessages: BuiltInLLMMessage[];
  encounterPending: boolean;
  encounterContext: string;
  proposeAction: Stream<{ text: string }>;
  clearEncounter: Stream<void>;
  performAction: Stream<void, AttemptAdventureActionResult>;
}

export interface LocationOutput extends LocationPiece {}

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
  locations: LocationPiece[];
  quest: QuestPiece;
  createCharacter: Stream<CreateCharacterEvent, CreateCharacterResult>;
  enlistCharacter: Stream<JoinQuestEvent>;
  attemptAdventureAction: Stream<
    AttemptAdventureActionEvent,
    AttemptAdventureActionResult
  >;
  restartQuest: Stream<void>;
  recordQuestEvidence: Stream<
    RecordQuestEvidenceEvent,
    RecordQuestEvidenceResult
  >;
}
