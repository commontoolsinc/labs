/**
 * Data contract of Ring Loops, a loop sequencer drawn as concentric rings that
 * several people edit at once. The placed notes and the tempo are shared by
 * the space. The transport is stored nowhere: each browser sweeps the rings
 * from its own start, so two listeners hear the same notes at different
 * phases.
 */

/** Synthesized instrument a ring sounds its notes on. */
export type RingVoice = "drums" | "bass" | "pluck" | "bell";

/** One ring: an instrument, and the length of the loop its hand sweeps. */
export interface RingSpec {
  /** Stable identifier that placed notes name their ring by. */
  id: string;

  /** Name shown beside the ring's mute control. */
  label: string;

  /** Instrument the ring's notes sound on. */
  voice: RingVoice;

  /** Whole beats the ring's hand takes to complete one turn. */
  beats: number;

  /** Semitones added to the root for this ring's lanes; drums ignore it. */
  transpose: number;
}

/** A note one participant placed in a cell of a ring. */
export interface PlacedNote {
  /** Identifier of the ring holding the note. */
  ringId: string;

  /** Sixteenth-note position along the ring, clockwise from the top. */
  step: number;

  /** Lane within the ring's band, from 0 at its inner edge; picks the pitch. */
  lane: number;

  /** Per-user instance that placed the note. */
  authorId: string;

  /** CSS color the note is drawn in, as its author chose it. */
  color: string;
}

/**
 * What the pattern is instantiated with; the guest reads it and never writes
 * it.
 */
export interface IframeInputData {
  /** Heading shown above the controls. */
  title: string;

  /** Rings from the innermost outward. */
  rings: RingSpec[];

  /** MIDI note number of the lowest lane of an untransposed ring. */
  rootMidi: number;

  /** Semitones each lane sits above the root; its length is the lane count. */
  scale: number[];
}

/** State shared by everyone in the space. */
export interface IframeStateData {
  /** Notes by cell key; `null` marks a cell whose note was removed. */
  notes: Record<string, PlacedNote | null>;

  /** Tempo every browser plays at, in beats per minute. */
  tempoBpm: number;
}

/** One user's own settings, shared by that user's sessions. */
export interface IframeOutputData {
  /** Color of the notes this user places; `null` selects one from the user. */
  color: string | null;

  /** Playback volume from 0 to 1. */
  volume: number;

  /** Identifiers of the rings this user has silenced. */
  mutedRingIds: string[];
}

export const DEFAULT_INPUT: IframeInputData = {
  title: "Ring Loops",
  rings: [
    { id: "drums", label: "Drums", voice: "drums", beats: 4, transpose: 0 },
    { id: "bells", label: "Bells", voice: "bell", beats: 5, transpose: 12 },
    { id: "bass", label: "Bass", voice: "bass", beats: 6, transpose: -24 },
    { id: "pluck", label: "Pluck", voice: "pluck", beats: 8, transpose: 0 },
  ],
  rootMidi: 57,
  scale: [0, 3, 5, 7, 10],
};

export const DEFAULT_STATE: IframeStateData = {
  notes: {
    "drums:0:0": {
      ringId: "drums",
      step: 0,
      lane: 0,
      authorId: "starter",
      color: "#8b93a7",
    },
    "drums:8:0": {
      ringId: "drums",
      step: 8,
      lane: 0,
      authorId: "starter",
      color: "#8b93a7",
    },
    "drums:4:1": {
      ringId: "drums",
      step: 4,
      lane: 1,
      authorId: "starter",
      color: "#8b93a7",
    },
    "drums:12:1": {
      ringId: "drums",
      step: 12,
      lane: 1,
      authorId: "starter",
      color: "#8b93a7",
    },
    "drums:6:2": {
      ringId: "drums",
      step: 6,
      lane: 2,
      authorId: "starter",
      color: "#8b93a7",
    },
    "drums:14:2": {
      ringId: "drums",
      step: 14,
      lane: 2,
      authorId: "starter",
      color: "#8b93a7",
    },
    "bells:0:4": {
      ringId: "bells",
      step: 0,
      lane: 4,
      authorId: "starter",
      color: "#8b93a7",
    },
    "bells:7:2": {
      ringId: "bells",
      step: 7,
      lane: 2,
      authorId: "starter",
      color: "#8b93a7",
    },
    "bass:0:0": {
      ringId: "bass",
      step: 0,
      lane: 0,
      authorId: "starter",
      color: "#8b93a7",
    },
    "bass:12:2": {
      ringId: "bass",
      step: 12,
      lane: 2,
      authorId: "starter",
      color: "#8b93a7",
    },
    "pluck:0:0": {
      ringId: "pluck",
      step: 0,
      lane: 0,
      authorId: "starter",
      color: "#8b93a7",
    },
    "pluck:10:4": {
      ringId: "pluck",
      step: 10,
      lane: 4,
      authorId: "starter",
      color: "#8b93a7",
    },
    "pluck:20:2": {
      ringId: "pluck",
      step: 20,
      lane: 2,
      authorId: "starter",
      color: "#8b93a7",
    },
  },
  tempoBpm: 96,
};

export const DEFAULT_OUTPUT: IframeOutputData = {
  color: null,
  volume: 0.7,
  mutedRingIds: [],
};

export const IFRAME_PATTERN = {
  name: "IframeRingLoops",
  displayName: "Ring Loops",
  stateScope: "space",
  outputScope: "user",
  frameHeight: "100vh",
  databases: {},
} as const;
