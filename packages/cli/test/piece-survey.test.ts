import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { PiecePlan, SurveyResult } from "@commonfabric/piece/ops";
import { decode } from "@commonfabric/utils/encoding";

import type { SurveyRunRequest } from "../lib/bulk.ts";
import {
  inspectPieceFromCommand,
  parseRetargetFlag,
  piece,
  surveyFromCommand,
} from "../commands/piece.ts";

function captureStdout(fn: () => Promise<void>): Promise<string> {
  let captured = "";
  const original = Deno.stdout.writeSync;
  Deno.stdout.writeSync = (data: Uint8Array): number => {
    captured += decode(data);
    return data.length;
  };
  return fn().then(() => captured).finally(() => {
    Deno.stdout.writeSync = original;
  });
}

class ExitSentinel extends Error {}

const OPTIONS = {
  apiUrl: "http://localhost:8000",
  identity: "/tmp/test-identity.pem",
  space: "home",
  piece: "board",
  quiet: true,
};

const PLAN: PiecePlan = {
  header: {
    kind: "piece-plan",
    v: 1,
    space: "did:key:test",
    takenAt: "2026-08-24T00:00:00.000Z",
    enumerated: { collection: 1, registry: 0, registeredOutside: 0 },
  },
  rows: [{
    piece: "of:fid1:aaa",
    phase: "members",
    expect: { patternIdentity: "idA", symbol: "default", retained: true },
  }],
};

const COMPLETE: SurveyResult = {
  plan: PLAN,
  tally: [
    { phase: "members", patternIdentity: "idA", symbol: "default", count: 1 },
  ],
  outside: [],
  problems: [],
  validatorFailures: [],
  complete: true,
};

describe("piece-survey", () => {
  describe("parseRetargetFlag()", () => {
    it("returns the phase, an absolute main path, and the rev label", () => {
      const parsed = parseRetargetFlag("topics=patterns/topic.tsx@abc123");
      expect(parsed.phase).toBe("topics");
      expect(parsed.source.main.startsWith("/")).toBe(true);
      expect(parsed.source.main.endsWith("/patterns/topic.tsx")).toBe(true);
      expect(parsed.rev).toBe("abc123");
    });

    it("returns no rev when the spec carries none", () => {
      expect(parseRetargetFlag("holder=main.tsx").rev).toBeUndefined();
    });

    it("throws for a spec without a phase or without a source", () => {
      expect(() => parseRetargetFlag("main.tsx")).toThrow("--retarget");
      expect(() => parseRetargetFlag("=main.tsx")).toThrow("--retarget");
      expect(() => parseRetargetFlag("topics=")).toThrow("--retarget");
    });
  });

  describe("surveyFromCommand()", () => {
    it("prints the encoded plan to stdout and the tally as hints", async () => {
      const hints: string[] = [];
      let request: SurveyRunRequest | undefined;
      const out = await captureStdout(() =>
        surveyFromCommand({ ...OPTIONS, path: "topics" }, {
          runSurvey: (_config, req) => {
            request = req;
            return Promise.resolve(COMPLETE);
          },
          printHint: (message) => {
            hints.push(message);
          },
        })
      );
      expect(out).toContain('"kind":"piece-plan"');
      expect(out).toContain("of:fid1:aaa");
      expect(request?.selector).toEqual({
        kind: "collection",
        holder: "board",
        path: ["topics"],
      });
      expect(hints).toEqual(["members: 1 on idA"]);
    });

    it("writes the plan to --out instead of stdout", async () => {
      let written: { path: string; text: string } | undefined;
      const hints: string[] = [];
      const out = await captureStdout(() =>
        surveyFromCommand({ ...OPTIONS, path: "topics", out: "plan.jsonl" }, {
          runSurvey: () => Promise.resolve(COMPLETE),
          writeTextFile: (path, text) => {
            written = { path: String(path), text: String(text) };
            return Promise.resolve();
          },
          printHint: (message) => {
            hints.push(message);
          },
        })
      );
      expect(out).toBe("");
      expect(written?.path).toBe("plan.jsonl");
      expect(written?.text.endsWith("\n")).toBe(true);
      expect(hints[0]).toBe("Wrote 1 plan rows to plan.jsonl");
    });

    it("prints the whole survey result under --json", async () => {
      const out = await captureStdout(() =>
        surveyFromCommand({ ...OPTIONS, path: "topics", json: true }, {
          runSurvey: () => Promise.resolve(COMPLETE),
          printHint: () => {},
        })
      );
      expect(JSON.parse(out).complete).toBe(true);
    });

    it("surveys a list selector without a holder", async () => {
      let request: SurveyRunRequest | undefined;
      await captureStdout(() =>
        surveyFromCommand(
          { ...OPTIONS, piece: undefined, list: ["of:fid1:x"] },
          {
            runSurvey: (_config, req) => {
              request = req;
              return Promise.resolve(COMPLETE);
            },
            printHint: () => {},
          },
        )
      );
      expect(request?.selector).toEqual({
        kind: "list",
        pieces: ["of:fid1:x"],
      });
    });

    it("passes the retargets, the override, and the validator through", async () => {
      let request: SurveyRunRequest | undefined;
      await captureStdout(() =>
        surveyFromCommand(
          {
            ...OPTIONS,
            path: "topics",
            retarget: ["topics=topic.tsx@r1"],
            root: "patterns",
            mainExport: "Other",
            dangerouslyAllowIncompatibleSchema: true,
            validator: "demand.json",
          },
          {
            runSurvey: (_config, req) => {
              request = req;
              return Promise.resolve(COMPLETE);
            },
            printHint: () => {},
          },
        )
      );
      expect(request?.retargets?.[0].phase).toBe("topics");
      expect(request?.retargets?.[0].source.root?.endsWith("/patterns"))
        .toBe(true);
      expect(request?.retargets?.[0].source.mainExport).toBe("Other");
      expect(request?.allowIncompatible).toBe(true);
      expect(request?.validatorPath?.endsWith("/demand.json")).toBe(true);
    });

    it("throws for a collection survey without --path", async () => {
      await expect(
        surveyFromCommand({ ...OPTIONS }, {
          runSurvey: () => Promise.resolve(COMPLETE),
        }),
      ).rejects.toThrow("--path");
    });

    it("exits 1 for an incomplete survey, naming what the plan lacks", async () => {
      const incomplete: SurveyResult = {
        ...COMPLETE,
        outside: [{
          piece: "of:fid1:orphan",
          patternIdentity: "idA",
          symbol: "default",
        }],
        complete: false,
      };
      let exitCode: number | undefined;
      const errors: string[] = [];
      await expect(
        captureStdout(() =>
          surveyFromCommand({ ...OPTIONS, path: "topics" }, {
            runSurvey: () => Promise.resolve(incomplete),
            printHint: () => {},
            printError: (message) => {
              errors.push(message);
            },
            exit: (code) => {
              exitCode = code;
              throw new ExitSentinel();
            },
          })
        ),
      ).rejects.toThrow(ExitSentinel);
      expect(exitCode).toBe(1);
      expect(errors.join("\n")).toContain("of:fid1:orphan");
    });

    it("is the action the piece command registers for survey", () => {
      const registered = piece.getCommand("survey") as unknown as {
        actionHandler: unknown;
      };
      expect(registered.actionHandler).toBe(surveyFromCommand);
    });
  });

  describe("inspectPieceFromCommand()", () => {
    const PIN = {
      piece: "of:fid1:aaa",
      patternIdentity: "idA",
      symbol: "default",
      revisionId: "rev-1",
      retained: true,
    };

    it("prints the source pin as JSON under --pattern-identity --json", async () => {
      const out = await captureStdout(() =>
        inspectPieceFromCommand(
          { ...OPTIONS, patternIdentity: true, json: true },
          { readSourcePin: () => Promise.resolve(PIN) },
        )
      );
      expect(JSON.parse(out)).toEqual(PIN);
    });

    it("prints the pin's fields as lines under --pattern-identity", async () => {
      const out = await captureStdout(() =>
        inspectPieceFromCommand({ ...OPTIONS, patternIdentity: true }, {
          readSourcePin: () => Promise.resolve(PIN),
        })
      );
      expect(out).toContain("identity: idA");
      expect(out).toContain("revision: rev-1");
      expect(out).toContain("retained: true");
    });

    it("exits 1 under --pattern-identity for a piece with no identity", async () => {
      let exitCode: number | undefined;
      await expect(
        inspectPieceFromCommand({ ...OPTIONS, patternIdentity: true }, {
          readSourcePin: () => Promise.resolve(undefined),
          printError: () => {},
          exit: (code) => {
            exitCode = code;
            throw new ExitSentinel();
          },
        }),
      ).rejects.toThrow(ExitSentinel);
      expect(exitCode).toBe(1);
    });

    it("is the action the piece command registers for inspect", () => {
      const registered = piece.getCommand("inspect") as unknown as {
        actionHandler: unknown;
      };
      expect(registered.actionHandler).toBe(inspectPieceFromCommand);
    });
  });
});
