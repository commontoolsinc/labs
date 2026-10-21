import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  BRIEFING_HEADING,
  briefingOf,
  briefs,
  checkMarker,
  judgeBriefing,
  type LoopRun,
  type MarkerCheck,
  parseCases,
  type Phase,
  summarize,
  summaryTable,
} from "../scripts/want-eval/wants-loop-judge.ts";

/** A job request as the runner holds it, briefed with `words`. */
const requestBriefing = (
  briefed: unknown,
  ...words: string[]
): Record<string, unknown> => ({
  instructions: [
    "Answer briefly.",
    ...(words.length > 0
      ? ["", BRIEFING_HEADING, ...words.map((w) => `- ${w}`)]
      : []),
  ].join("\n"),
  context: briefed === undefined ? {} : { briefed },
});

const MARKER = "Always answer me in French.";

/** A run of `marker` in `phase` whose check passed when `pass` is true. */
const runOf = (
  phase: Phase,
  pass: boolean,
  briefingOk = true,
  marker = "french",
): LoopRun => ({
  marker,
  phase,
  probe: "capital",
  attempt: 1,
  job: "job-1",
  state: "completed",
  seconds: 10,
  modelTurns: 2,
  totalTokens: 1000,
  answer: "",
  briefing: { briefed: [], heading: false, listed: [] },
  markerBriefed: phase === "during",
  briefingVerdict: { pass: briefingOk, detail: "" },
  check: { pass, detail: "" },
});

describe("wants-loop-judge", () => {
  describe("checkMarker()", () => {
    describe("french", () => {
      it("passes an explanation written in French", () => {
        expect(
          checkMarker(
            { kind: "french" },
            "La capitale de l'Australie est Canberra, choisie comme compromis entre Sydney et Melbourne.",
          ).pass,
        ).toBe(true);
      });

      it("fails the same explanation written in English", () => {
        expect(
          checkMarker(
            { kind: "french" },
            "The capital of Australia is Canberra, chosen as a compromise between Sydney and Melbourne.",
          ).pass,
        ).toBe(false);
      });

      it("fails a bare name, which is in no language", () => {
        expect(checkMarker({ kind: "french" }, "Canberra.").pass).toBe(false);
      });

      it("fails an English answer with a French phrase in it", () => {
        expect(
          checkMarker(
            { kind: "french" },
            "The capital is Canberra (la capitale), chosen because it is between the two cities.",
          ).pass,
        ).toBe(false);
      });
    });

    describe("last-word", () => {
      const over: MarkerCheck = { kind: "last-word", word: "OVER" };

      it("passes an answer ending on the word, past trailing punctuation", () => {
        expect(checkMarker(over, "Canberra was a compromise. OVER.").pass)
          .toBe(true);
        expect(checkMarker(over, "A leap year adds a day. *OVER*\n").pass)
          .toBe(true);
      });

      it("fails an answer ending on another word", () => {
        expect(checkMarker(over, "It was chosen over Sydney.").pass).toBe(
          false,
        );
      });

      it("fails an answer ending on the word in another case", () => {
        expect(checkMarker(over, "The debate is over.").pass).toBe(false);
      });

      it("fails an answer holding the word but not ending on it", () => {
        expect(checkMarker(over, "OVER and out, Canberra.").pass).toBe(false);
      });
    });

    describe("lowercase", () => {
      it("passes an answer with no capitals", () => {
        expect(
          checkMarker(
            { kind: "lowercase" },
            "canberra, chosen in 1908 as a compromise.",
          ).pass,
        ).toBe(true);
      });

      it("fails an answer with one capital", () => {
        expect(
          checkMarker({ kind: "lowercase" }, "the capital is Canberra.").pass,
        ).toBe(false);
      });

      it("fails an answer with no letters at all", () => {
        expect(checkMarker({ kind: "lowercase" }, "366").pass).toBe(false);
        expect(checkMarker({ kind: "lowercase" }, "").pass).toBe(false);
      });
    });
  });

  describe("briefingOf()", () => {
    it("returns the briefed ids and the words listed under the heading", () => {
      const request = requestBriefing(["w1", "w2"], MARKER, "Walk more.");

      expect(briefingOf(request)).toEqual({
        briefed: ["w1", "w2"],
        heading: true,
        listed: [MARKER, "Walk more."],
      });
    });

    it("returns the listed words only up to the first line that is not one", () => {
      const request = {
        instructions: [BRIEFING_HEADING, `- ${MARKER}`, "", "- Not a want."]
          .join("\n"),
        context: { briefed: ["w1"] },
      };

      expect(briefingOf(request).listed).toEqual([MARKER]);
    });

    it("returns no heading and nothing listed when the instructions have no briefing", () => {
      expect(briefingOf(requestBriefing([]))).toEqual({
        briefed: [],
        heading: false,
        listed: [],
      });
    });

    it("returns `undefined` for the briefed ids when the request has no list", () => {
      expect(briefingOf(requestBriefing(undefined)).briefed).toBeUndefined();
      expect(briefingOf(undefined).briefed).toBeUndefined();
    });
  });

  describe("briefs()", () => {
    it("returns true for an id listed bare or as `want:<id>`", () => {
      expect(briefs(briefingOf(requestBriefing(["w1"])), "w1")).toBe(true);
      expect(briefs(briefingOf(requestBriefing(["want:w1"])), "w1")).toBe(
        true,
      );
    });

    it("returns false for an id not listed, an unfiled want, and a missing list", () => {
      expect(briefs(briefingOf(requestBriefing(["w2"])), "w1")).toBe(false);
      expect(briefs(briefingOf(requestBriefing(["w1"])), undefined)).toBe(
        false,
      );
      expect(briefs(briefingOf(requestBriefing(undefined)), "w1")).toBe(false);
    });
  });

  describe("judgeBriefing()", () => {
    const marker = { id: "w1", words: MARKER };

    describe("during", () => {
      it("passes a job briefed with the marker's id and words", () => {
        const briefing = briefingOf(requestBriefing(["w0", "w1"], MARKER));

        expect(judgeBriefing("during", briefing, marker).pass).toBe(true);
      });

      it("fails a job whose briefed ids leave the marker out", () => {
        const briefing = briefingOf(requestBriefing(["w0"], MARKER));

        expect(judgeBriefing("during", briefing, marker).pass).toBe(false);
      });

      it("fails a job briefed with the id but not the words", () => {
        const briefing = briefingOf(requestBriefing(["w1"], "Walk more."));

        expect(judgeBriefing("during", briefing, marker).pass).toBe(false);
      });

      it("fails a job with no briefing at all", () => {
        const briefing = briefingOf(requestBriefing(undefined));

        expect(judgeBriefing("during", briefing, marker)).toEqual({
          pass: false,
          detail: "request has no context.briefed",
        });
      });
    });

    describe("before and after", () => {
      it("passes a job briefed with other wants only", () => {
        const briefing = briefingOf(requestBriefing(["w0"], "Walk more."));

        expect(judgeBriefing("after", briefing, marker).pass).toBe(true);
        expect(
          judgeBriefing("before", briefing, { id: undefined, words: MARKER })
            .pass,
        ).toBe(true);
      });

      it("passes a job briefed with nothing", () => {
        expect(
          judgeBriefing("after", briefingOf(requestBriefing([])), marker).pass,
        ).toBe(true);
      });

      it("fails a job still briefed with the archived marker", () => {
        expect(
          judgeBriefing(
            "after",
            briefingOf(requestBriefing(["w1"], MARKER)),
            marker,
          ).pass,
        ).toBe(false);
        expect(
          judgeBriefing(
            "after",
            briefingOf(requestBriefing([], MARKER)),
            marker,
          )
            .pass,
        ).toBe(false);
      });

      it("fails a job with no briefed list", () => {
        expect(
          judgeBriefing("after", briefingOf(requestBriefing(undefined)), marker)
            .pass,
        ).toBe(false);
      });
    });
  });

  describe("summarize()", () => {
    it("returns pass and briefing counts by phase, and a closed loop", () => {
      const [summary] = summarize([
        runOf("before", false),
        runOf("before", false),
        runOf("during", true),
        runOf("during", false),
        runOf("after", false),
        runOf("after", false),
      ]);

      expect(summary.phases.before).toMatchObject({ runs: 2, passes: 0 });
      expect(summary.phases.during).toMatchObject({
        runs: 2,
        passes: 1,
        briefed: 2,
        briefingOk: 2,
      });
      expect(summary.phases.after.briefed).toBe(0);
      expect(summary.closed).toBe(true);
    });

    it("returns an open loop when the marker's effect outlives it", () => {
      const [summary] = summarize([
        runOf("before", false),
        runOf("during", true),
        runOf("after", true),
      ]);

      expect(summary.closed).toBe(false);
    });

    it("returns an open loop when the marker had no effect", () => {
      const [summary] = summarize([
        runOf("before", true),
        runOf("during", true),
        runOf("after", false),
      ]);

      expect(summary.closed).toBe(false);
    });

    it("returns an open loop when a briefing was not as expected", () => {
      const [summary] = summarize([
        runOf("before", false),
        runOf("during", true, false),
        runOf("after", false),
      ]);

      expect(summary.closed).toBe(false);
    });

    it("returns an open loop when a phase never ran", () => {
      const [summary] = summarize([
        runOf("before", false),
        runOf("during", true),
      ]);

      expect(summary.closed).toBe(false);
    });

    it("returns one summary per marker, in the order the markers appear", () => {
      const summaries = summarize([
        runOf("before", false, true, "over"),
        runOf("before", false, true, "french"),
        runOf("during", true, true, "over"),
      ]);

      expect(summaries.map((summary) => summary.marker)).toEqual([
        "over",
        "french",
      ]);
      expect(summaries[0].phases.before.runs).toBe(1);
    });
  });

  describe("summaryTable()", () => {
    it("returns a row per marker and phase, and each loop's verdict", () => {
      const table = summaryTable(summarize([
        runOf("before", false),
        runOf("during", true),
        runOf("after", false),
      ]));

      expect(table).toContain(
        "| french | during | 1/1 | 1/1 | 1/1 | 10 s | 2 | 1000 |",
      );
      expect(table).toContain("| french | after | 0/1 | 0/1 | 1/1 |");
      expect(table).toContain("- french: loop closed");
    });
  });

  describe("parseCases()", () => {
    const valid = {
      probes: [{ id: "capital", text: "What is the capital of Australia?" }],
      markers: [{
        id: "over",
        words: "End with OVER.",
        check: { kind: "last-word", word: "OVER" },
      }],
    };

    it("returns the probes and markers of a valid file", () => {
      expect(parseCases(valid)).toEqual(valid);
    });

    it("returns the markers of the cases file beside the script", async () => {
      const cases = parseCases(JSON.parse(
        await Deno.readTextFile(
          new URL(
            "../scripts/want-eval/wants-loop-cases.json",
            import.meta.url,
          ),
        ),
      ));

      expect(cases.markers.map((marker) => marker.id)).toEqual([
        "french",
        "over",
        "lowercase",
      ]);
    });

    it("throws for a check of an unknown kind", () => {
      expect(() =>
        parseCases({
          ...valid,
          markers: [{ ...valid.markers[0], check: { kind: "german" } }],
        })
      ).toThrow("markers[0].check.kind");
    });

    it("throws for a last-word check with no word", () => {
      expect(() =>
        parseCases({
          ...valid,
          markers: [{ ...valid.markers[0], check: { kind: "last-word" } }],
        })
      ).toThrow("markers[0].check.word");
    });

    it("throws for no probes and for a repeated id", () => {
      expect(() => parseCases({ ...valid, probes: [] })).toThrow("probes");
      expect(() =>
        parseCases({ ...valid, markers: [valid.markers[0], valid.markers[0]] })
      ).toThrow("id over repeats");
    });
  });
});
