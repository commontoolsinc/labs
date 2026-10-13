import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import {
  DEFAULT_INPUT,
  DEFAULT_STATE,
  type IframeInputData,
  type PlacedNote,
} from "./contract.ts";
import {
  cellAt,
  cellKey,
  cellShape,
  defaultColor,
  FALLBACK_TEMPO_BPM,
  handTurn,
  laneLabel,
  laneMidi,
  liveNotes,
  MAX_TEMPO_BPM,
  midiToFrequency,
  MIN_TEMPO_BPM,
  normalizeTempo,
  NOTE_COLORS,
  notesAtStep,
  positionAt,
  retimed,
  ringBands,
  ringLayoutOf,
  secondsPerStep,
  stepsBetween,
  timeOfStep,
  toggleEdit,
  type Transport,
} from "./model.ts";

const layout = ringLayoutOf(DEFAULT_INPUT);

const TAU = 2 * Math.PI;

/** The point at `radius` from the center, `turn` clockwise from the top. */
function pointAt(radius: number, turn: number): [number, number] {
  return [radius * Math.sin(turn * TAU), -radius * Math.cos(turn * TAU)];
}

function noteAt(ringId: string, step: number, lane: number): PlacedNote {
  return { ringId, step, lane, authorId: "ada", color: "#4dabf7" };
}

function inputWith(overrides: Partial<IframeInputData>): IframeInputData {
  return { ...DEFAULT_INPUT, ...overrides };
}

describe("model", () => {
  describe("ringLayoutOf()", () => {
    it("counts each ring's loop in steps of a sixteenth note", () => {
      expect(layout.rings.map((ring) => ring.steps)).toEqual([16, 20, 24, 32]);
    });

    it("takes one lane from each step of the scale", () => {
      expect(layout.lanes).toBe(DEFAULT_INPUT.scale.length);
    });

    it("throws a `RangeError` for an input with no rings", () => {
      expect(() => ringLayoutOf(inputWith({ rings: [] }))).toThrow(RangeError);
    });

    it("throws a `TypeError` when two rings share an id", () => {
      const [first] = DEFAULT_INPUT.rings;
      expect(() => ringLayoutOf(inputWith({ rings: [first, first] })))
        .toThrow(TypeError);
    });

    it("throws a `RangeError` for a ring with a fractional beat count", () => {
      const [first] = DEFAULT_INPUT.rings;
      expect(() =>
        ringLayoutOf(inputWith({ rings: [{ ...first, beats: 2.5 }] }))
      ).toThrow(RangeError);
    });

    it("throws a `RangeError` for an empty scale", () => {
      expect(() => ringLayoutOf(inputWith({ scale: [] }))).toThrow(RangeError);
    });
  });

  describe("ringBands()", () => {
    it("orders the bands outward without overlap, ending at the unit radius", () => {
      const bands = ringBands(4);
      expect(bands[0].inner).toBeGreaterThan(0);
      for (let index = 0; index < bands.length; index++) {
        expect(bands[index].outer).toBeGreaterThan(bands[index].inner);
        if (index > 0) {
          expect(bands[index].inner).toBeGreaterThan(bands[index - 1].outer);
        }
      }
      expect(bands[3].outer).toBeCloseTo(1, 12);
    });
  });

  describe("cellAt()", () => {
    const [innermost] = ringBands(layout.rings.length);

    it("returns the first step just clockwise of the top", () => {
      const [x, y] = pointAt(innermost.inner + 0.001, 0.001);
      expect(cellAt(layout, x, y)).toEqual({ ringIndex: 0, step: 0, lane: 0 });
    });

    it("returns the last step just counterclockwise of the top", () => {
      const [x, y] = pointAt(innermost.inner + 0.001, 0.999);
      expect(cellAt(layout, x, y)).toEqual({ ringIndex: 0, step: 15, lane: 0 });
    });

    it("counts steps clockwise, so the right-hand side is a quarter turn in", () => {
      const [x, y] = pointAt(innermost.inner + 0.001, 0.2501);
      expect(cellAt(layout, x, y)?.step).toBe(4);
    });

    it("returns the outermost lane just inside a band's outer edge", () => {
      const [x, y] = pointAt(innermost.outer - 0.001, 0.001);
      expect(cellAt(layout, x, y)?.lane).toBe(layout.lanes - 1);
    });

    it("returns `undefined` in the hub", () => {
      expect(cellAt(layout, 0, 0)).toBeUndefined();
    });

    it("returns `undefined` in the gap between two rings", () => {
      const bands = ringBands(layout.rings.length);
      const [x, y] = pointAt((bands[0].outer + bands[1].inner) / 2, 0.3);
      expect(cellAt(layout, x, y)).toBeUndefined();
    });

    it("returns `undefined` outside the outermost ring", () => {
      expect(cellAt(layout, 0, -1.01)).toBeUndefined();
    });
  });

  describe("cellShape()", () => {
    it("encloses a center that `cellAt()` maps back to the same cell, for every cell", () => {
      for (const [ringIndex, ring] of layout.rings.entries()) {
        for (let step = 0; step < ring.steps; step++) {
          for (let lane = 0; lane < layout.lanes; lane++) {
            const cell = { ringIndex, step, lane };
            const shape = cellShape(layout, cell);
            const [x, y] = pointAt(
              (shape.inner + shape.outer) / 2,
              (shape.startTurn + shape.endTurn) / 2,
            );
            expect(cellAt(layout, x, y)).toEqual(cell);
          }
        }
      }
    });
  });

  describe("cellKey()", () => {
    it("returns the ring id, the step, and the lane joined by colons", () => {
      expect(cellKey("bass", 3, 1)).toBe("bass:3:1");
    });
  });

  describe("liveNotes()", () => {
    it("returns every starter note of the default state", () => {
      const live = liveNotes(layout, DEFAULT_STATE.notes);
      expect(live.length).toBe(Object.keys(DEFAULT_STATE.notes).length);
      expect(live.length).toBeGreaterThan(0);
    });

    it("returns a note with the index of its ring", () => {
      const note = noteAt("bass", 3, 1);
      expect(liveNotes(layout, { "bass:3:1": note })).toEqual([
        { ringIndex: 2, note },
      ]);
    });

    it("omits a removed note", () => {
      expect(liveNotes(layout, { "bass:3:1": null })).toEqual([]);
    });

    it("omits a note whose ring the layout lacks", () => {
      expect(liveNotes(layout, { "organ:3:1": noteAt("organ", 3, 1) }))
        .toEqual([]);
    });

    it("omits a note whose step lies past the end of its ring", () => {
      expect(liveNotes(layout, { "drums:16:0": noteAt("drums", 16, 0) }))
        .toEqual([]);
    });

    it("omits a note whose lane lies outside the band", () => {
      expect(liveNotes(layout, { "drums:0:5": noteAt("drums", 0, 5) }))
        .toEqual([]);
    });

    it("omits a note stored under another cell's key", () => {
      expect(liveNotes(layout, { "drums:1:0": noteAt("drums", 0, 0) }))
        .toEqual([]);
    });
  });

  describe("toggleEdit()", () => {
    const cell = { ringIndex: 1, step: 7, lane: 2 };

    it("places a note by the author in an empty cell", () => {
      expect(toggleEdit(layout, {}, cell, "ada", "#4dabf7")).toEqual({
        key: "bells:7:2",
        value: noteAt("bells", 7, 2),
      });
    });

    it("removes the note from an occupied cell", () => {
      const notes = { "bells:7:2": noteAt("bells", 7, 2) };
      expect(toggleEdit(layout, notes, cell, "grace", "#ff6b6b")).toEqual({
        key: "bells:7:2",
        value: null,
      });
    });

    it("places a note in a cell whose note was removed", () => {
      const edit = toggleEdit(
        layout,
        { "bells:7:2": null },
        cell,
        "ada",
        "red",
      );
      expect(edit.value?.authorId).toBe("ada");
    });
  });

  describe("notesAtStep()", () => {
    const drum = { ringIndex: 0, note: noteAt("drums", 3, 0) };
    const bell = { ringIndex: 1, note: noteAt("bells", 3, 0) };
    const live = [drum, bell];

    it("returns the notes placed at the step", () => {
      expect(notesAtStep(layout, live, 3)).toEqual([drum, bell]);
    });

    it("returns no note at a step nothing is placed on", () => {
      expect(notesAtStep(layout, live, 4)).toEqual([]);
    });

    it("wraps each ring at its own length", () => {
      expect(notesAtStep(layout, live, 19)).toEqual([drum]);
      expect(notesAtStep(layout, live, 23)).toEqual([bell]);
    });
  });

  describe("normalizeTempo()", () => {
    it("returns a tempo inside the range unchanged", () => {
      expect(normalizeTempo(120)).toBe(120);
    });

    it("returns the nearest bound for a tempo outside the range", () => {
      expect(normalizeTempo(5)).toBe(MIN_TEMPO_BPM);
      expect(normalizeTempo(900)).toBe(MAX_TEMPO_BPM);
    });

    it("returns the fallback for a value that is not a number", () => {
      expect(normalizeTempo(NaN)).toBe(FALLBACK_TEMPO_BPM);
    });
  });

  describe("step clock", () => {
    const transport: Transport = {
      anchorStep: 4,
      anchorTime: 10,
      tempoBpm: 120,
    };

    it("lasts an eighth of a second per step at 120 beats per minute", () => {
      expect(secondsPerStep(120)).toBe(0.125);
    });

    it("advances eight steps in one second at 120 beats per minute", () => {
      expect(positionAt(transport, 11)).toBe(12);
    });

    it("reaches a step at the time `positionAt()` reports that step", () => {
      expect(positionAt(transport, timeOfStep(transport, 30))).toBe(30);
    });

    describe("retimed()", () => {
      it("holds the position the clock had at the moment of the change", () => {
        expect(positionAt(retimed(transport, 11, 60), 11)).toBe(12);
      });

      it("advances at the new tempo from that moment", () => {
        expect(positionAt(retimed(transport, 11, 60), 12)).toBe(16);
      });
    });
  });

  describe("stepsBetween()", () => {
    it("includes a whole lower bound and excludes the upper bound", () => {
      expect(stepsBetween(2, 5)).toEqual([2, 3, 4]);
    });

    it("starts at the first whole step after a fractional lower bound", () => {
      expect(stepsBetween(2.1, 4.5)).toEqual([3, 4]);
    });

    it("returns no step for a window that holds none", () => {
      expect(stepsBetween(2.1, 2.9)).toEqual([]);
    });

    it("returns each step once across two windows that share a bound", () => {
      expect([...stepsBetween(0, 2.5), ...stepsBetween(2.5, 5)]).toEqual([
        0,
        1,
        2,
        3,
        4,
      ]);
    });
  });

  describe("handTurn()", () => {
    it("returns 0 at the start of every loop", () => {
      expect(handTurn(0, 16)).toBe(0);
      expect(handTurn(32, 16)).toBe(0);
    });

    it("returns the fraction of the loop already swept", () => {
      expect(handTurn(20, 16)).toBe(0.25);
    });
  });

  describe("laneMidi()", () => {
    it("adds the ring's transposition and the lane's scale step to the root", () => {
      expect(laneMidi(layout, layout.rings[1], 1)).toBe(57 + 12 + 3);
    });
  });

  describe("midiToFrequency()", () => {
    it("returns 440 hertz for note 69", () => {
      expect(midiToFrequency(69)).toBe(440);
    });

    it("halves the frequency an octave down", () => {
      expect(midiToFrequency(57)).toBe(220);
    });
  });

  describe("laneLabel()", () => {
    it("returns the drum sound for a lane of a drum ring", () => {
      expect(laneLabel(layout, layout.rings[0], 1)).toBe("snare");
    });

    it("returns the note name and octave for a lane of a pitched ring", () => {
      expect(laneLabel(layout, layout.rings[3], 0)).toBe("A3");
      expect(laneLabel(layout, layout.rings[1], 1)).toBe("C5");
    });
  });

  describe("defaultColor()", () => {
    const authors = Array.from({ length: 50 }, (_, index) => `user-${index}`);

    it("returns one of the offered colors", () => {
      for (const author of authors) {
        expect(NOTE_COLORS).toContain(defaultColor(author));
      }
    });

    it("returns the same color for the same author", () => {
      expect(defaultColor("user-7")).toBe(defaultColor("user-7"));
    });

    it("returns more than one color across fifty authors", () => {
      expect(new Set(authors.map(defaultColor)).size).toBeGreaterThan(1);
    });
  });
});
