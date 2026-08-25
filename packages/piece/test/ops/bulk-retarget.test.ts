/**
 * The retarget apply: preflight classification, the serial plan-order
 * apply over grouped sessions, resume as re-invocation, the stop that
 * names its remainder, and the refusals — a source resolving off its
 * recorded reference, foreign operations, incomplete plans. Sessions come
 * from a counting factory whose close defers disposal: the emulated store
 * lives in its runtimes, so the boundaries are observed while the state
 * survives; the drill exercises real disposal against a real server.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { createSession, Identity } from "@commonfabric/identity";
import { Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import {
  programEntryIdentity,
  resolveLocalSourceProgram,
} from "../../src/ops/bulk-local.deno.ts";
import {
  retargetPieces,
  type RetargetReport,
  type RetargetSessions,
} from "../../src/ops/bulk-retarget.deno.ts";
import type {
  PiecePlan,
  PiecePlanRow,
  RetargetOp,
} from "../../src/ops/bulk-plan.ts";
import { readPiecePin } from "../../src/ops/bulk-survey.ts";
import { PiecesController } from "../../src/ops/pieces-controller.ts";

const signer = await Identity.fromPassphrase("bulk retarget");

/** A generation's source text; `version` is what tells generations apart. */
function memberSource(version: string): string {
  return [
    "import { NAME, pattern } from 'commonfabric';",
    "export default pattern<{ seed?: string }>(({ seed }) => ({",
    "  [NAME]: 'Member',",
    `  version: ${JSON.stringify(version)},`,
    "  seed,",
    "}));",
    "",
  ].join("\n");
}

describe("bulk-retarget", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let spaceName: string;
  let runtimes: Runtime[];
  let opens: number;
  let closes: number;
  let sessions: RetargetSessions;
  let dir: string;

  beforeEach(async () => {
    storageManager = StorageManager.emulate({ as: signer });
    spaceName = `bulk-retarget-${crypto.randomUUID()}`;
    runtimes = [];
    opens = 0;
    closes = 0;
    sessions = {
      open: async () => {
        opens += 1;
        const runtime = new Runtime({
          apiUrl: new URL("http://toolshed.test"),
          storageManager,
        });
        runtimes.push(runtime);
        const pieces = new PiecesController(
          await createSession({ identity: signer, spaceName }),
          runtime,
        );
        await pieces.synced();
        return pieces;
      },
      // Disposal deferred to afterEach: the emulated store lives in its
      // runtimes, so closing for real would lose the space between groups.
      // The boundary itself — one close per open — is still observed.
      close: () => {
        closes += 1;
        return Promise.resolve();
      },
    };
    dir = await Deno.makeTempDir({ prefix: "bulk-retarget-src" });
    await Deno.writeTextFile(`${dir}/member-v1.tsx`, memberSource("one"));
    await Deno.writeTextFile(`${dir}/member-v2.tsx`, memberSource("two"));
  });

  afterEach(async () => {
    for (const runtime of runtimes) await runtime.dispose();
    await storageManager.close();
    await Deno.remove(dir, { recursive: true });
  });

  /** Create `count` pieces on v1 and the plan retargeting them to v2. */
  async function seed(
    count: number,
  ): Promise<{ plan: PiecePlan; ids: string[] }> {
    const setup = await sessions.open();
    const v1 = await resolveLocalSourceProgram(setup.runtime, {
      main: `${dir}/member-v1.tsx`,
    });
    const v2 = await resolveLocalSourceProgram(setup.runtime, {
      main: `${dir}/member-v2.tsx`,
    });
    const v1id = await programEntryIdentity(v1);
    const v2id = await programEntryIdentity(v2);
    const ids: string[] = [];
    for (let index = 0; index < count; index += 1) {
      const piece = await setup.create(v1, { input: { seed: `s${index}` } });
      ids.push(piece.id);
    }
    await setup.synced();
    await sessions.close(setup);
    const rows: PiecePlanRow[] = ids.map((piece) => ({
      piece,
      phase: "items",
      expect: { patternIdentity: v1id, symbol: "default", retained: true },
      op: {
        kind: "retarget",
        source: { main: `${dir}/member-v2.tsx` },
        patternIdentity: v2id,
        symbol: "default",
      } satisfies RetargetOp,
    }));
    return {
      plan: {
        header: {
          kind: "piece-plan",
          v: 1,
          space: "did:key:test",
          takenAt: "2026-08-25T00:00:00.000Z",
          selector: "collection",
          enumerated: {
            collection: count,
            registry: count,
            registeredOutside: 0,
          },
        },
        rows,
      },
      ids,
    };
  }

  async function pinOf(piece: string) {
    const reader = await sessions.open();
    const pin = await readPiecePin(reader, piece);
    await sessions.close(reader);
    return pin;
  }

  it("classifies every row from one preflight read on a dry run", async () => {
    const { plan } = await seed(2);
    const before = { opens, closes };

    const report = await retargetPieces(sessions, { plan });

    expect(report.rows.map((row) => row.verdict)).toEqual([
      "outstanding",
      "outstanding",
    ]);
    expect(report.applied).toBe(0);
    expect(report.complete).toBe(true);
    // The dry run is the preflight alone: one session, opened and closed.
    expect(opens - before.opens).toBe(1);
    expect(closes - before.closes).toBe(1);
  });

  it("applies serially over bounded session groups, and reports timing", async () => {
    const { plan, ids } = await seed(3);
    const before = { opens, closes };
    const seen: string[] = [];
    let tick = 0;

    const report = await retargetPieces(sessions, {
      plan,
      apply: true,
      groupSize: 2,
      onRow: (row) => seen.push(`${row.verdict}:${row.piece}`),
      now: () => tick += 5,
    });

    expect(report.rows.map((row) => row.verdict)).toEqual([
      "applied",
      "applied",
      "applied",
    ]);
    expect(report.applied).toBe(3);
    expect(report.complete).toBe(true);
    expect(report.rows.every((row) => row.elapsedMs !== undefined)).toBe(true);
    expect(seen.length).toBe(3);
    // Preflight plus ceil(3/2) groups: three sessions, each closed.
    expect(opens - before.opens).toBe(3);
    expect(closes - before.closes).toBe(3);

    const pin = await pinOf(ids[0]);
    expect(pin?.patternIdentity).toBe(
      (plan.rows[0].op as RetargetOp).patternIdentity,
    );
  });

  it("resumes as a re-invocation: landed rows are not rewritten", async () => {
    const { plan } = await seed(2);
    await retargetPieces(sessions, { plan, apply: true });

    const again = await retargetPieces(sessions, { plan, apply: true });

    expect(again.rows.map((row) => row.verdict)).toEqual([
      "landed",
      "landed",
    ]);
    expect(again.applied).toBe(0);
    expect(again.complete).toBe(true);
  });

  it("does not start when preflight finds a piece on neither reference", async () => {
    const { plan, ids } = await seed(2);
    // Something other than the plan moves the second piece: a third
    // generation neither recorded nor produced by its row.
    await Deno.writeTextFile(`${dir}/member-v3.tsx`, memberSource("three"));
    const mover = await sessions.open();
    const v3 = await resolveLocalSourceProgram(mover.runtime, {
      main: `${dir}/member-v3.tsx`,
    });
    const moved = await mover.get(ids[1], false);
    await moved.setPattern(v3);
    await mover.synced();
    await sessions.close(mover);

    const report = await retargetPieces(sessions, { plan, apply: true });

    expect(report.rows.map((row) => row.verdict)).toEqual([
      "outstanding",
      "moved-elsewhere",
    ]);
    expect(report.rows[1].problem).toContain("neither");
    expect(report.applied).toBe(0);
    expect(report.complete).toBe(false);
    expect((await pinOf(ids[0]))?.patternIdentity).toBe(
      plan.rows[0].expect.patternIdentity,
    );
  });

  it("refuses a source that no longer produces the recorded reference", async () => {
    const { plan, ids } = await seed(3);
    // The source file changes after the plan was reviewed: the recomputed
    // identity disagrees with the row, and the row before it has landed.
    const tampered: PiecePlan = {
      header: plan.header,
      rows: plan.rows.map((row, index) =>
        index === 1
          ? {
            ...row,
            op: {
              ...(row.op as RetargetOp),
              patternIdentity: "I".padEnd(43, "x"),
            },
          }
          : row
      ),
    };

    const report = await retargetPieces(sessions, {
      plan: tampered,
      apply: true,
    });

    expect(report.rows.map((row) => row.verdict)).toEqual([
      "applied",
      "refused",
      "unattempted",
    ]);
    expect(report.rows[1].problem).toContain("resolves to");
    expect(report.applied).toBe(1);
    expect(report.complete).toBe(false);
    expect((await pinOf(ids[2]))?.patternIdentity).toBe(
      plan.rows[2].expect.patternIdentity,
    );
  });

  it("stops on a mid-run failure, names the rest, and completes on re-invocation", async () => {
    const { plan, ids } = await seed(3);
    // The second apply-session read of the middle piece fails once: the
    // run stops there with the tail named, and the same invocation later
    // completes from where it stood.
    // The failure holds for the whole armed session, so the state check's
    // own re-read fails too and the row honestly reports unknown state.
    let armed = false;
    const flaky: RetargetSessions = {
      open: async () => {
        const pieces = await sessions.open();
        return new Proxy(pieces, {
          get(target, prop, receiver) {
            if (prop === "get" && armed) {
              return (id: string, run?: boolean) => {
                if (id === ids[1]) {
                  return Promise.reject(new Error("the connection dropped"));
                }
                return target.get(id, run);
              };
            }
            const value = Reflect.get(target, prop, receiver);
            return typeof value === "function" ? value.bind(target) : value;
          },
        }) as PiecesController;
      },
      close: (pieces) => sessions.close(pieces),
    };
    const arm = () => {
      armed = true;
    };

    const first: RetargetReport = await (async () => {
      const preflightAware: RetargetSessions = {
        open: (() => {
          let calls = 0;
          return async () => {
            calls += 1;
            if (calls === 2) arm();
            return await flaky.open();
          };
        })(),
        close: flaky.close,
      };
      return await retargetPieces(preflightAware, { plan, apply: true });
    })();

    expect(first.rows.map((row) => row.verdict)).toEqual([
      "applied",
      "failed",
      "unattempted",
    ]);
    expect(first.rows[1].problem).toContain("the connection dropped");
    expect(first.rows[1].problem).toContain("state is unknown");
    expect(first.rows[2].piece).toBe(ids[2]);
    expect(first.complete).toBe(false);

    const resumed = await retargetPieces(sessions, { plan, apply: true });
    expect(resumed.rows.map((row) => row.verdict)).toEqual([
      "landed",
      "applied",
      "applied",
    ]);
    expect(resumed.applied).toBe(2);
    expect(resumed.complete).toBe(true);
  });

  it("blocks the start on a preflight read failure, naming the row", async () => {
    const { plan, ids } = await seed(2);
    const flaky: RetargetSessions = {
      open: async () => {
        const pieces = await sessions.open();
        return new Proxy(pieces, {
          get(target, prop, receiver) {
            if (prop === "get") {
              return (id: string, run?: boolean) => {
                if (id === ids[1]) {
                  return Promise.reject(new Error("the connection dropped"));
                }
                return target.get(id, run);
              };
            }
            const value = Reflect.get(target, prop, receiver);
            return typeof value === "function" ? value.bind(target) : value;
          },
        }) as PiecesController;
      },
      close: (pieces) => sessions.close(pieces),
    };

    const report = await retargetPieces(flaky, { plan, apply: true });

    expect(report.rows.map((row) => row.verdict)).toEqual([
      "outstanding",
      "failed",
    ]);
    expect(report.rows[1].problem).toContain("the run did not start");
    expect(report.applied).toBe(0);
    expect((await pinOf(ids[0]))?.patternIdentity).toBe(
      plan.rows[0].expect.patternIdentity,
    );
  });

  it("names every unattempted piece across the groups a stop skips", async () => {
    const { plan, ids } = await seed(4);
    const tampered: PiecePlan = {
      header: {
        ...plan.header,
        enumerated: { ...plan.header.enumerated, collection: 4, registry: 4 },
      },
      rows: plan.rows.map((row, index) =>
        index === 1
          ? {
            ...row,
            op: {
              ...(row.op as RetargetOp),
              patternIdentity: "I".padEnd(43, "x"),
            },
          }
          : row
      ),
    };

    const report = await retargetPieces(sessions, {
      plan: tampered,
      apply: true,
      groupSize: 2,
    });

    // The stop lands inside group one; group two is never opened, and its
    // rows are named rather than counted.
    expect(report.rows.map((row) => row.verdict)).toEqual([
      "applied",
      "refused",
      "unattempted",
      "unattempted",
    ]);
    expect(report.rows[2].piece).toBe(ids[2]);
    expect(report.rows[3].piece).toBe(ids[3]);
  });

  it("re-proves each row in its own group session: a race skips or stops", async () => {
    // Between preflight and a row's write, another writer moves pieces:
    // one onto the row's own target (skipped as landed, never rewritten),
    // and — in a second run — one onto a third generation (a stop).
    await Deno.writeTextFile(`${dir}/member-v3.tsx`, memberSource("three"));
    const raceTo = (main: string, victim: string): RetargetSessions => {
      let raced = false;
      let sessionIndex = 0;
      return {
        open: async () => {
          sessionIndex += 1;
          const applySession = sessionIndex >= 2;
          const pieces = await sessions.open();
          return new Proxy(pieces, {
            get(target, prop, receiver) {
              if (prop === "get") {
                return async (id: string, run?: boolean) => {
                  if (id === victim && !raced && applySession) {
                    raced = true;
                    const program = await resolveLocalSourceProgram(
                      pieces.runtime,
                      { main },
                    );
                    const piece = await target.get(id, false);
                    await piece.setPattern(program, {
                      dangerouslyAllowIncompatibleSchema: true,
                    });
                    await pieces.synced();
                  }
                  return target.get(id, run);
                };
              }
              const value = Reflect.get(target, prop, receiver);
              return typeof value === "function" ? value.bind(target) : value;
            },
          }) as PiecesController;
        },
        close: (pieces) => sessions.close(pieces),
      };
    };

    const landedRace = await seed(2);
    const landed = await retargetPieces(
      raceTo(`${dir}/member-v2.tsx`, landedRace.ids[0]),
      { plan: landedRace.plan, apply: true },
    );
    expect(landed.rows.map((row) => row.verdict)).toEqual([
      "landed",
      "applied",
    ]);
    expect(landed.applied).toBe(1);

    const movedRace = await seed(2);
    const moved = await retargetPieces(
      raceTo(`${dir}/member-v3.tsx`, movedRace.ids[0]),
      { plan: movedRace.plan, apply: true },
    );
    expect(moved.rows.map((row) => row.verdict)).toEqual([
      "moved-elsewhere",
      "unattempted",
    ]);
    expect(moved.rows[0].problem).toContain("after preflight");
    expect(moved.applied).toBe(0);
  });

  it("honors the compatibility override from the row field alone", async () => {
    // The v2 here narrows the input schema, which the pattern-compatibility
    // gate refuses; only a row carrying the override may pass it.
    await Deno.writeTextFile(
      `${dir}/member-incompat.tsx`,
      [
        "import { NAME, pattern } from 'commonfabric';",
        "export default pattern<{ count?: number }>(({ count }) => ({",
        "  [NAME]: 'Member',",
        "  count,",
        "}));",
        "",
      ].join("\n"),
    );
    const { plan, ids } = await seed(1);
    const probe = await sessions.open();
    const incompat = await resolveLocalSourceProgram(probe.runtime, {
      main: `${dir}/member-incompat.tsx`,
    });
    const incompatId = await programEntryIdentity(incompat);
    await sessions.close(probe);
    const toIncompat = (allow: boolean): PiecePlan => ({
      header: plan.header,
      rows: [{
        ...plan.rows[0],
        op: {
          kind: "retarget",
          source: { main: `${dir}/member-incompat.tsx` },
          patternIdentity: incompatId,
          symbol: "default",
          ...(allow ? { allowIncompatible: true } : {}),
        },
      }],
    });

    const refused = await retargetPieces(sessions, {
      plan: toIncompat(false),
      apply: true,
    });
    expect(refused.rows[0].verdict).toBe("failed");
    expect(refused.rows[0].problem).toContain("still on its recorded");

    const allowed = await retargetPieces(sessions, {
      plan: toIncompat(true),
      apply: true,
    });
    expect(allowed.rows[0].verdict).toBe("applied");
    expect((await pinOf(ids[0]))?.patternIdentity).toBe(incompatId);
  });

  it("refuses foreign operations, empty work, and incomplete plans", async () => {
    const { plan } = await seed(1);
    await expect(
      retargetPieces(sessions, {
        plan: {
          header: plan.header,
          rows: [{
            ...plan.rows[0],
            expect: { ...plan.rows[0].expect, documentHash: "9f2c" },
            op: { kind: "repair", fixer: "f.ts", fixerIdentity: "impl-v1" },
          }],
        },
        apply: true,
      }),
    ).rejects.toThrow("retargets alone");
    await expect(
      retargetPieces(sessions, {
        plan: {
          header: plan.header,
          rows: [{ piece: plan.rows[0].piece, expect: plan.rows[0].expect }],
        },
      }),
    ).rejects.toThrow("nothing to apply");
    await expect(
      retargetPieces(sessions, {
        plan: {
          header: {
            ...plan.header,
            problems: [{ piece: "fid1:x", problem: "unreadable" }],
          },
          rows: plan.rows,
        },
      }),
    ).rejects.toThrow("incomplete plan");
    await expect(
      retargetPieces(sessions, { plan, groupSize: 0 }),
    ).rejects.toThrow("positive integer");
  });
});
