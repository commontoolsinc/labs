/**
 * Pure logic of the Ring Loops guest: checking the rings an input describes,
 * mapping a pointer position to a cell, the step clock the audio scheduler
 * reads, and the pitch each lane sounds at. Nothing here touches the DOM or
 * the audio graph, so all of it runs under `deno test`.
 */

import type { IframeInputData, PlacedNote, RingVoice } from "./contract.ts";

/** Steps a beat divides into, which makes a step a sixteenth note. */
export const STEPS_PER_BEAT = 4;

/** Slowest tempo the shared control offers, in beats per minute. */
export const MIN_TEMPO_BPM = 40;

/** Fastest tempo the shared control offers, in beats per minute. */
export const MAX_TEMPO_BPM = 200;

/** Tempo played when the stored one is not a number. */
export const FALLBACK_TEMPO_BPM = 96;

/** Most rings an input may describe. */
export const MAX_RINGS = 6;

/** Longest loop a ring may have, in beats. */
export const MAX_RING_BEATS = 16;

/** Most lanes a ring's band may hold. */
export const MAX_LANES = 8;

/** Colors a participant chooses from for the notes they place. */
export const NOTE_COLORS: readonly string[] = [
  "#ff6b6b",
  "#ffa94d",
  "#ffd43b",
  "#69db7c",
  "#38d9a9",
  "#4dabf7",
  "#9775fa",
  "#f783ac",
];

/** Drum sounds, in the order a drum ring's lanes play them from the inside. */
export const DRUM_SOUNDS = ["kick", "snare", "hat", "clap", "tom"] as const;

/** One sound of the drum kit. */
export type DrumSound = typeof DRUM_SOUNDS[number];

/** Radius of the empty hub at the center, where the outer edge is at 1. */
const HUB_RADIUS = 0.12;

/** Radial space left between two neighboring rings. */
const RING_GAP = 0.02;

const TAU = 2 * Math.PI;

const VOICES: readonly RingVoice[] = ["drums", "bass", "pluck", "bell"];

const NOTE_NAMES = [
  "C",
  "C♯",
  "D",
  "D♯",
  "E",
  "F",
  "F♯",
  "G",
  "G♯",
  "A",
  "A♯",
  "B",
];

/** A checked ring, with its loop length counted in steps. */
export interface Ring {
  /** Identifier that placed notes name the ring by. */
  readonly id: string;

  /** Name shown beside the ring's mute control. */
  readonly label: string;

  /** Instrument the ring's notes sound on. */
  readonly voice: RingVoice;

  /** Steps in one turn of the ring's hand. */
  readonly steps: number;

  /** Semitones added to the root for this ring's lanes. */
  readonly transpose: number;
}

/** The rings of a checked input, and the pitches their lanes share. */
export interface RingLayout {
  /** Rings from the innermost outward. */
  readonly rings: readonly Ring[];

  /** Lanes in every ring's band. */
  readonly lanes: number;

  /** Semitones each lane sits above the root. */
  readonly scale: readonly number[];

  /** MIDI note number of the lowest lane of an untransposed ring. */
  readonly rootMidi: number;
}

/** Radial extent of one ring, where the outermost ring's edge is at 1. */
export interface RingBand {
  /** Radius of the band's inner edge. */
  readonly inner: number;

  /** Radius of the band's outer edge. */
  readonly outer: number;
}

/** One cell of a ring: a step along it, in one of its lanes. */
export interface Cell {
  /** Index of the ring in the layout, from the innermost. */
  readonly ringIndex: number;

  /** Step along the ring, clockwise from the top. */
  readonly step: number;

  /** Lane within the band, from 0 at its inner edge. */
  readonly lane: number;
}

/** The annular sector a cell occupies, in radii and fractions of a turn. */
export interface CellShape extends RingBand {
  /** Where the cell begins, clockwise from the top; a note sounds here. */
  readonly startTurn: number;

  /** Where the cell ends, clockwise from the top. */
  readonly endTurn: number;
}

/** A placed note that fits the layout, with the index of its ring. */
export interface LiveNote {
  /** Index of the note's ring in the layout. */
  readonly ringIndex: number;

  /** The note as stored. */
  readonly note: PlacedNote;
}

/**
 * One write to the shared notes: the key of a cell, and what to store there.
 */
export interface CellEdit {
  /** Key of the cell in the shared notes record. */
  readonly key: string;

  /** Note to store, or `null` to remove the one that is there. */
  readonly value: PlacedNote | null;
}

/**
 * A running step clock: the step position held at one instant of audio time.
 */
export interface Transport {
  /** Step position at `anchorTime`. */
  readonly anchorStep: number;

  /** Audio time, in seconds, at which the clock is at `anchorStep`. */
  readonly anchorTime: number;

  /** Tempo the clock advances at, in beats per minute. */
  readonly tempoBpm: number;
}

/**
 * Checks `input` and returns its rings with loop lengths counted in steps.
 *
 * @throws {TypeError} When the rings or the scale are missing or hold a value
 *   of the wrong kind, or when two rings share an identifier.
 * @throws {RangeError} When the ring count, the lane count, or a ring's beats
 *   fall outside what the canvas can draw.
 */
export function ringLayoutOf(input: IframeInputData): RingLayout {
  const { rings, scale, rootMidi } = input;
  if (!Array.isArray(rings) || !Array.isArray(scale)) {
    throw new TypeError("The input needs a list of rings and a scale.");
  }
  if (rings.length < 1 || rings.length > MAX_RINGS) {
    throw new RangeError(
      `The input needs 1 to ${MAX_RINGS} rings and has ${rings.length}.`,
    );
  }
  if (scale.length < 1 || scale.length > MAX_LANES) {
    throw new RangeError(
      `The scale needs 1 to ${MAX_LANES} steps and has ${scale.length}.`,
    );
  }
  if (!Number.isFinite(rootMidi) || !scale.every(Number.isFinite)) {
    throw new TypeError("The root and every scale step must be numbers.");
  }

  const seen = new Set<string>();
  return {
    rings: rings.map((ring, index) => {
      const ordinal = index + 1;
      if (typeof ring.id !== "string" || seen.has(ring.id)) {
        throw new TypeError(
          `Ring ${ordinal} needs an id no other ring has.`,
        );
      }
      seen.add(ring.id);
      if (!VOICES.includes(ring.voice)) {
        throw new TypeError(`Ring ${ordinal} names an unknown voice.`);
      }
      if (
        !Number.isInteger(ring.beats) || ring.beats < 1 ||
        ring.beats > MAX_RING_BEATS
      ) {
        throw new RangeError(
          `Ring ${ordinal} needs a whole number of beats from 1 to ${MAX_RING_BEATS}.`,
        );
      }
      if (!Number.isFinite(ring.transpose)) {
        throw new TypeError(`Ring ${ordinal} needs a numeric transposition.`);
      }
      return {
        id: ring.id,
        label: ring.label,
        voice: ring.voice,
        steps: ring.beats * STEPS_PER_BEAT,
        transpose: ring.transpose,
      };
    }),
    lanes: scale.length,
    scale: [...scale],
    rootMidi,
  };
}

/** Returns the band of each of `count` rings, from the innermost outward. */
export function ringBands(count: number): RingBand[] {
  const width = (1 - HUB_RADIUS - RING_GAP * (count - 1)) / count;
  return Array.from({ length: count }, (_, index) => {
    const inner = HUB_RADIUS + index * (width + RING_GAP);
    return { inner, outer: inner + width };
  });
}

/**
 * Returns the cell under the point (`x`, `y`), or `undefined` where the point
 * lies in the hub, in a gap between rings, or outside the outermost ring. The
 * point is measured from the center with `y` growing downward, in units of the
 * outermost ring's radius.
 */
export function cellAt(
  layout: RingLayout,
  x: number,
  y: number,
): Cell | undefined {
  const radius = Math.hypot(x, y);
  const bands = ringBands(layout.rings.length);
  const ringIndex = bands.findIndex((band) =>
    radius >= band.inner && radius < band.outer
  );
  if (ringIndex < 0) return undefined;

  const band = bands[ringIndex];
  const { steps } = layout.rings[ringIndex];
  // `atan2()` is handed the axes swapped, which measures the angle clockwise
  // from the top rather than counterclockwise from the right.
  const turn = (Math.atan2(x, -y) / TAU + 1) % 1;
  const depth = (radius - band.inner) / (band.outer - band.inner);
  return {
    ringIndex,
    step: Math.min(steps - 1, Math.floor(turn * steps)),
    lane: Math.min(layout.lanes - 1, Math.floor(depth * layout.lanes)),
  };
}

/** Returns the annular sector that `cell` occupies. */
export function cellShape(layout: RingLayout, cell: Cell): CellShape {
  const band = ringBands(layout.rings.length)[cell.ringIndex];
  const { steps } = layout.rings[cell.ringIndex];
  const laneWidth = (band.outer - band.inner) / layout.lanes;
  return {
    inner: band.inner + cell.lane * laneWidth,
    outer: band.inner + (cell.lane + 1) * laneWidth,
    startTurn: cell.step / steps,
    endTurn: (cell.step + 1) / steps,
  };
}

/** Returns the key a cell's note is stored under in the shared notes. */
export function cellKey(ringId: string, step: number, lane: number): string {
  return `${ringId}:${step}:${lane}`;
}

/**
 * Returns the notes of `notes` that the layout can draw and play: those whose
 * ring exists, whose step and lane fall inside it, and that sit under the key
 * of their own cell. A removed note, and one left over from a layout with
 * other rings, is not among them.
 */
export function liveNotes(
  layout: RingLayout,
  notes: Readonly<Record<string, PlacedNote | null | undefined>>,
): LiveNote[] {
  const ringIndexById = new Map(
    layout.rings.map((ring, index) => [ring.id, index]),
  );
  const live: LiveNote[] = [];
  for (const [key, note] of Object.entries(notes)) {
    if (note === null || note === undefined) continue;
    const ringIndex = ringIndexById.get(note.ringId);
    if (ringIndex === undefined) continue;
    const { steps } = layout.rings[ringIndex];
    if (!isIndexBelow(note.step, steps)) continue;
    if (!isIndexBelow(note.lane, layout.lanes)) continue;
    if (key !== cellKey(note.ringId, note.step, note.lane)) continue;
    live.push({ ringIndex, note });
  }
  return live;
}

/**
 * Returns the write that toggles `cell`: removing the note that is there, or
 * placing one by `authorId` in `color` where the cell is empty.
 */
export function toggleEdit(
  layout: RingLayout,
  notes: Readonly<Record<string, PlacedNote | null | undefined>>,
  cell: Cell,
  authorId: string,
  color: string,
): CellEdit {
  const ringId = layout.rings[cell.ringIndex].id;
  const key = cellKey(ringId, cell.step, cell.lane);
  const occupied = liveNotes(layout, { [key]: notes[key] }).length > 0;
  return {
    key,
    value: occupied
      ? null
      : { ringId, step: cell.step, lane: cell.lane, authorId, color },
  };
}

/**
 * Returns the notes that sound when the step clock reaches `step`, a whole
 * number counted from the start of playback. Each ring wraps the count at its
 * own length, which is what lets rings of different lengths drift apart.
 */
export function notesAtStep(
  layout: RingLayout,
  live: readonly LiveNote[],
  step: number,
): LiveNote[] {
  return live.filter(({ ringIndex, note }) =>
    step % layout.rings[ringIndex].steps === note.step
  );
}

/**
 * Returns the tempo to play for a stored `tempoBpm`, within the offered range.
 */
export function normalizeTempo(tempoBpm: number): number {
  if (!Number.isFinite(tempoBpm)) return FALLBACK_TEMPO_BPM;
  return Math.min(MAX_TEMPO_BPM, Math.max(MIN_TEMPO_BPM, tempoBpm));
}

/** Returns how long one step lasts at `tempoBpm`, in seconds. */
export function secondsPerStep(tempoBpm: number): number {
  return 60 / tempoBpm / STEPS_PER_BEAT;
}

/** Returns the step position `transport` holds at audio time `time`. */
export function positionAt(transport: Transport, time: number): number {
  return transport.anchorStep +
    (time - transport.anchorTime) / secondsPerStep(transport.tempoBpm);
}

/** Returns the audio time at which `transport` reaches `step`. */
export function timeOfStep(transport: Transport, step: number): number {
  return transport.anchorTime +
    (step - transport.anchorStep) * secondsPerStep(transport.tempoBpm);
}

/**
 * Returns a clock that holds the position `transport` has at `time` and
 * advances at `tempoBpm` from there, so a tempo change moves no hand.
 */
export function retimed(
  transport: Transport,
  time: number,
  tempoBpm: number,
): Transport {
  return {
    anchorStep: positionAt(transport, time),
    anchorTime: time,
    tempoBpm,
  };
}

/** Returns each whole step from `from` up to but not including `to`. */
export function stepsBetween(from: number, to: number): number[] {
  const steps: number[] = [];
  for (let step = Math.ceil(from); step < to; step++) steps.push(step);
  return steps;
}

/**
 * Returns how far around a ring of `steps` steps its hand is at `position`, as
 * a fraction of a turn clockwise from the top.
 */
export function handTurn(position: number, steps: number): number {
  return ((position % steps) + steps) % steps / steps;
}

/** Returns the MIDI note number `lane` of `ring` sounds at. */
export function laneMidi(layout: RingLayout, ring: Ring, lane: number): number {
  return layout.rootMidi + ring.transpose + layout.scale[lane];
}

/** Returns the frequency of MIDI note number `midi`, in hertz. */
export function midiToFrequency(midi: number): number {
  return 440 * 2 ** ((midi - 69) / 12);
}

/** Returns the drum sound that `lane` of a drum ring plays. */
export function drumSound(lane: number): DrumSound {
  return DRUM_SOUNDS[lane % DRUM_SOUNDS.length];
}

/**
 * Returns what `lane` of `ring` plays, as a reader would name it: the drum
 * sound for a drum ring, and otherwise the note with its octave, such as `A3`.
 */
export function laneLabel(
  layout: RingLayout,
  ring: Ring,
  lane: number,
): string {
  if (ring.voice === "drums") return drumSound(lane);
  const midi = Math.round(laneMidi(layout, ring, lane));
  const name = NOTE_NAMES[((midi % 12) + 12) % 12];
  return `${name}${Math.floor(midi / 12) - 1}`;
}

/**
 * Returns the color a participant's notes take until they choose one. The same
 * `authorId` always maps to the same color, and two participants may share
 * one.
 */
export function defaultColor(authorId: string): string {
  // The 32-bit FNV-1a hash, which spreads similar identifiers across the list.
  let hash = 0x811c9dc5;
  for (let index = 0; index < authorId.length; index++) {
    hash ^= authorId.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return NOTE_COLORS[hash % NOTE_COLORS.length];
}

/**
 * Helper for `liveNotes()`, which checks that `value` indexes `length` slots.
 */
function isIndexBelow(value: number, length: number): boolean {
  return Number.isInteger(value) && value >= 0 && value < length;
}
