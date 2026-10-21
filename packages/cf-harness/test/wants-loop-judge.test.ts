import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  checkMarker,
  ELIGIBLE_HEADING,
  eligibleOf,
  judgeEligible,
  listsEligible,
  type LoopRun,
  type MarkerCheck,
  parseCases,
  type Phase,
  summarize,
  summaryTable,
} from "../scripts/want-eval/wants-loop-judge.ts";

/** A job request as the runner holds it, eligible with `words`. */
const requestWithEligible = (
  eligible: unknown,
  ...words: string[]
): Record<string, unknown> => ({
  instructions: [
    "Answer briefly.",
    ...(words.length > 0
      ? ["", ELIGIBLE_HEADING, ...words.map((w) => `- ${w}`)]
      : []),
  ].join("\n"),
  context: eligible === undefined ? {} : { eligible },
});

const MARKER = "Always answer me in French.";

/** A run of `marker` in `phase` whose check passed when `pass` is true. */
const runOf = (
  phase: Phase,
  pass: boolean,
  eligibleOk = true,
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
  eligibleWants: { eligible: [], heading: false, listed: [] },
  markerEligible: phase === "during",
  eligibleVerdict: { pass: eligibleOk, detail: "" },
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

  describe("eligibleOf()", () => {
    it("returns the eligible ids and the words listed under the heading", () => {
      const request = requestWithEligible(["w1", "w2"], MARKER, "Walk more.");

      expect(eligibleOf(request)).toEqual({
        eligible: ["w1", "w2"],
        heading: true,
        listed: [MARKER, "Walk more."],
      });
    });

    it("returns the listed words only up to the first line that is not one", () => {
      const request = {
        instructions: [ELIGIBLE_HEADING, `- ${MARKER}`, "", "- Not a want."]
          .join("\n"),
        context: { eligible: ["w1"] },
      };

      expect(eligibleOf(request).listed).toEqual([MARKER]);
    });

    it("returns no heading and nothing listed when the instructions have no eligibleWants", () => {
      expect(eligibleOf(requestWithEligible([]))).toEqual({
        eligible: [],
        heading: false,
        listed: [],
      });
    });

    it("returns `undefined` for the eligible ids when the request has no list", () => {
      expect(eligibleOf(requestWithEligible(undefined)).eligible)
        .toBeUndefined();
      expect(eligibleOf(undefined).eligible).toBeUndefined();
    });
  });

  describe("listsEligible()", () => {
    it("returns true for an id listed bare or as `want:<id>`", () => {
      expect(listsEligible(eligibleOf(requestWithEligible(["w1"])), "w1")).toBe(
        true,
      );
      expect(listsEligible(eligibleOf(requestWithEligible(["want:w1"])), "w1"))
        .toBe(
          true,
        );
    });

    it("returns false for an id not listed, an unfiled want, and a missing list", () => {
      expect(listsEligible(eligibleOf(requestWithEligible(["w2"])), "w1")).toBe(
        false,
      );
      expect(listsEligible(eligibleOf(requestWithEligible(["w1"])), undefined))
        .toBe(
          false,
        );
      expect(listsEligible(eligibleOf(requestWithEligible(undefined)), "w1"))
        .toBe(
          false,
        );
    });
  });

  describe("judgeEligible()", () => {
    const marker = { id: "w1", words: MARKER };

    describe("during", () => {
      it("passes a job eligible with the marker's id and words", () => {
        const eligibleWants = eligibleOf(
          requestWithEligible(["w0", "w1"], MARKER),
        );

        expect(judgeEligible("during", eligibleWants, marker).pass).toBe(true);
      });

      it("fails a job whose eligible ids leave the marker out", () => {
        const eligibleWants = eligibleOf(requestWithEligible(["w0"], MARKER));

        expect(judgeEligible("during", eligibleWants, marker).pass).toBe(false);
      });

      it("fails a job eligible with the id but not the words", () => {
        const eligibleWants = eligibleOf(
          requestWithEligible(["w1"], "Walk more."),
        );

        expect(judgeEligible("during", eligibleWants, marker).pass).toBe(false);
      });

      it("fails a job with no eligibleWants at all", () => {
        const eligibleWants = eligibleOf(requestWithEligible(undefined));

        expect(judgeEligible("during", eligibleWants, marker)).toEqual({
          pass: false,
          detail: "request has no context.eligible",
        });
      });
    });

    describe("before and after", () => {
      it("passes a job eligible with other wants only", () => {
        const eligibleWants = eligibleOf(
          requestWithEligible(["w0"], "Walk more."),
        );

        expect(judgeEligible("after", eligibleWants, marker).pass).toBe(true);
        expect(
          judgeEligible("before", eligibleWants, {
            id: undefined,
            words: MARKER,
          })
            .pass,
        ).toBe(true);
      });

      it("passes a job eligible with nothing", () => {
        expect(
          judgeEligible("after", eligibleOf(requestWithEligible([])), marker)
            .pass,
        ).toBe(true);
      });

      it("fails a job still eligible with the archived marker", () => {
        expect(
          judgeEligible(
            "after",
            eligibleOf(requestWithEligible(["w1"], MARKER)),
            marker,
          ).pass,
        ).toBe(false);
        expect(
          judgeEligible(
            "after",
            eligibleOf(requestWithEligible([], MARKER)),
            marker,
          )
            .pass,
        ).toBe(false);
      });

      it("fails a job with no eligible list", () => {
        expect(
          judgeEligible(
            "after",
            eligibleOf(requestWithEligible(undefined)),
            marker,
          )
            .pass,
        ).toBe(false);
      });
    });
  });

  describe("summarize()", () => {
    it("returns pass and eligibleWants counts by phase, and a closed loop", () => {
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
        eligible: 2,
        eligibleOk: 2,
      });
      expect(summary.phases.after.eligible).toBe(0);
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

    it("returns an open loop when a eligibleWants was not as expected", () => {
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
