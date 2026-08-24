import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { PiecePlan, SurveyResult } from "@commonfabric/piece/ops";
import { decode } from "@commonfabric/utils/encoding";

import { createSession, Identity } from "@commonfabric/identity";
import { Runtime, type RuntimeProgram } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { PiecesController } from "@commonfabric/piece/ops";

import {
  readSourcePin,
  runSurvey,
  type SurveyRunRequest,
} from "../lib/bulk.ts";
import {
  inspectPieceFromCommand,
  parseRetargetFlag,
  piece,
  setQuietMode,
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

const signer = await Identity.fromPassphrase("cli bulk survey");

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
    selector: "collection" as const,
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
  // The fixtures pass `quiet`, and the action applies it globally.
  afterEach(() => setQuietMode(false));

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

    it("keeps an @-named directory whole and takes only a trailing rev", () => {
      const scoped = parseRetargetFlag("topics=/repo/@scope/member.tsx");
      expect(scoped.source.main).toBe("/repo/@scope/member.tsx");
      expect(scoped.rev).toBeUndefined();
      const both = parseRetargetFlag("topics=/repo/@scope/member.tsx@v2");
      expect(both.source.main).toBe("/repo/@scope/member.tsx");
      expect(both.rev).toBe("v2");
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
      expect(hints).toEqual(["members: 1 on idA#default"]);
    });

    it("refuses a --side that is neither input nor result", async () => {
      await expect(
        surveyFromCommand({ ...OPTIONS, path: "topics", side: "bogus" }, {
          runSurvey: () => Promise.resolve(COMPLETE),
        }),
      ).rejects.toThrow('--side takes input or result, got "bogus"');
    });

    it("names each validator failure as a hint", async () => {
      const hints: string[] = [];
      await captureStdout(() =>
        surveyFromCommand({ ...OPTIONS, path: "topics" }, {
          runSurvey: () =>
            Promise.resolve({
              ...COMPLETE,
              validatorFailures: [
                { piece: "of:fid1:aaa", problem: "missing version" },
              ],
            }),
          printHint: (message) => {
            hints.push(message);
          },
        })
      );
      expect(hints).toContain("validator: of:fid1:aaa missing version");
    });

    it("honors the inherited --quiet by silencing hints that otherwise print", async () => {
      const seen: string[] = [];
      const originalError = console.error;
      console.error = (...parts: unknown[]) => {
        seen.push(parts.join(" "));
      };
      try {
        const run = (quiet: boolean) =>
          surveyFromCommand(
            { ...OPTIONS, path: "topics", out: "plan.jsonl", quiet },
            {
              runSurvey: () => Promise.resolve(COMPLETE),
              writeTextFile: () => Promise.resolve(),
            },
          );
        await run(false);
        expect(seen.join("\n")).toContain("members: 1 on idA#default");
        seen.length = 0;
        await run(true);
        expect(seen).toEqual([]);
      } finally {
        console.error = originalError;
      }
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

    it("throws for a scoped holder or a scoped list entry", async () => {
      await expect(
        surveyFromCommand(
          { ...OPTIONS, piece: "board@user", path: "topics" },
          { runSurvey: () => Promise.resolve(COMPLETE) },
        ),
      ).rejects.toThrow("scope");
      await expect(
        surveyFromCommand(
          { ...OPTIONS, piece: undefined, list: ["fid1:x@user"] },
          { runSurvey: () => Promise.resolve(COMPLETE) },
        ),
      ).rejects.toThrow("scope");
    });

    it("strips the canonical form's leading slash from a list entry", async () => {
      let request: SurveyRunRequest | undefined;
      await captureStdout(() =>
        surveyFromCommand(
          { ...OPTIONS, piece: undefined, list: ["/of:fid1:x"] },
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

    it("routes cf piece survey to surveyFromCommand", () => {
      const registered = piece.getCommand("survey") as unknown as {
        actionHandler: unknown;
      };
      expect(registered.actionHandler).toBe(surveyFromCommand);
    });
  });

  describe("runSurvey()", () => {
    let storageManager: ReturnType<typeof StorageManager.emulate>;
    let runtime: Runtime;
    let pieces: PiecesController;

    beforeEach(async () => {
      storageManager = StorageManager.emulate({ as: signer });
      runtime = new Runtime({
        apiUrl: new URL("http://toolshed.test"),
        storageManager,
      });
      pieces = new PiecesController(
        await createSession({
          identity: signer,
          spaceName: `cli-bulk-survey-${crypto.randomUUID()}`,
        }),
        runtime,
      );
      await pieces.synced();
    });

    afterEach(async () => {
      await runtime?.dispose();
      await storageManager?.close();
    });

    /** The smallest surveyable member; `version` names the generation. */
    function memberProgram(version: string): RuntimeProgram {
      return {
        main: "/main.tsx",
        files: [{
          name: "/main.tsx",
          contents: [
            "import { NAME, pattern } from 'commonfabric';",
            "export default pattern<{ seed?: string }>(() => ({",
            "  [NAME]: 'Member',",
            `  version: ${JSON.stringify(version)},`,
            "}));",
            "",
          ].join("\n"),
        }],
      };
    }

    it("resolves a list selector and surveys it end to end", async () => {
      const member = await pieces.create(memberProgram("one"), { input: {} });
      const resolved: string[] = [];
      const survey = await runSurvey({} as never, {
        selector: { kind: "list", pieces: [member.id] },
        validatorPath: "/demand.json",
      }, {
        loadPieces: () => Promise.resolve(pieces),
        resolvePieceAddress: (_pieces, token) => {
          resolved.push(token);
          return Promise.resolve(token);
        },
        readTextFile: () =>
          Promise.resolve(JSON.stringify({
            type: "object",
            properties: { version: { type: "string" } },
            required: ["version"],
          })),
      });
      expect(resolved).toEqual([member.id]);
      expect(survey.complete).toBe(true);
      expect(survey.plan.rows.length).toBe(1);
      expect(survey.plan.rows[0].expect.retained).toBe(true);
      expect(survey.validatorFailures).toEqual([]);
    });

    it("resolves the collection holder the way the other piece verbs do", async () => {
      const member = await pieces.create(memberProgram("one"), { input: {} });
      await expect(
        runSurvey({} as never, {
          selector: {
            kind: "collection",
            holder: "board-slug",
            path: ["members"],
          },
        }, {
          loadPieces: () => Promise.resolve(pieces),
          // The slug resolves to a real piece whose input holds no
          // collection at the path, so the refusal names the absence —
          // proof the resolved holder, not the slug text, was read.
          resolvePieceAddress: () => Promise.resolve(member.id),
        }),
      ).rejects.toThrow("stores no collection at members");
    });

    it("reads a created piece's source pin over the controller", async () => {
      const member = await pieces.create(memberProgram("one"), { input: {} });
      const pin = await readSourcePin({ piece: member.id } as never, {
        loadPieces: () => Promise.resolve(pieces),
        resolvePieceAddress: (_pieces, token) => Promise.resolve(token),
      });
      expect(pin?.symbol).toBe("default");
      expect(pin?.retained).toBe(true);
      expect(pin?.patternIdentity).toBeDefined();
    });

    it("stamps a resolved retarget onto the rows carrying its phase", async () => {
      const member = await pieces.create(memberProgram("one"), { input: {} });
      const dir = await Deno.makeTempDir({ prefix: "cli-bulk-retarget" });
      try {
        await Deno.writeTextFile(
          `${dir}/main.tsx`,
          memberProgram("two").files[0].contents,
        );
        const survey = await runSurvey({} as never, {
          selector: { kind: "list", pieces: [member.id] },
          retargets: [
            { phase: "list", source: { main: `${dir}/main.tsx` }, rev: "r1" },
          ],
          allowIncompatible: true,
        }, {
          loadPieces: () => Promise.resolve(pieces),
          resolvePieceAddress: (_pieces, token) => Promise.resolve(token),
        });
        const op = survey.plan.rows[0].op;
        if (op?.kind !== "retarget") {
          throw new Error("expected a retarget op on the list row");
        }
        expect(op.rev).toBe("r1");
        expect(op.allowIncompatible).toBe(true);
        expect(op.patternIdentity).toBeDefined();
      } finally {
        await Deno.remove(dir, { recursive: true });
      }
    });

    it("refuses two retargets naming one phase before loading anything", async () => {
      await expect(
        runSurvey({} as never, {
          selector: { kind: "list", pieces: ["fid1:x"] },
          retargets: [
            { phase: "items", source: { main: "a.tsx" } },
            { phase: "items", source: { main: "b.tsx" } },
          ],
        }, {
          loadPieces: () => {
            throw new Error("must not load");
          },
        }),
      ).rejects.toThrow("name the phase items");
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

    it("summarizes and prints the general inspection in both output modes", async () => {
      const pieceData = {
        id: "p1",
        name: "Board",
        patternRef: undefined,
        source: { a: 1 },
        result: { b: 2 },
        cachedResultFields: [],
        readingFrom: [],
        readBy: [],
      } as never;
      const rendered: Array<{ value: unknown; json: boolean | undefined }> = [];
      const render = (value: unknown, config?: { json?: boolean }) => {
        rendered.push({ value, json: config?.json });
      };
      const deps = {
        inspectPiece: () => Promise.resolve(pieceData),
        render,
      };
      await inspectPieceFromCommand(
        { ...OPTIONS, summary: true, json: true },
        deps,
      );
      expect(rendered[0].json).toBe(true);
      expect(rendered[0].value).toMatchObject({ id: "p1" });
      await inspectPieceFromCommand({ ...OPTIONS }, deps);
      expect(String(rendered[1].value)).toContain("=== Piece: p1 ===");
    });

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

    it("routes cf piece inspect to inspectPieceFromCommand", () => {
      const registered = piece.getCommand("inspect") as unknown as {
        actionHandler: unknown;
      };
      expect(registered.actionHandler).toBe(inspectPieceFromCommand);
    });
  });
});
