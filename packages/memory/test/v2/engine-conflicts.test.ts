import { expect } from "@std/expect";
import { toFileUrl } from "@std/path";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { spy } from "@std/testing/mock";

import {
  type ConfirmedRead,
  DEFAULT_BRANCH,
  toDocumentPath,
} from "../../v2.ts";
import {
  applyCommit,
  close,
  ConflictError,
  createBranch,
  type Engine,
  open,
  ProtocolError,
} from "../../v2/engine.ts";

describe("engine-conflicts", () => {
  let engine: Engine;
  let path: string;
  const sessionId = "session:conflict-diagnostics";
  const ids = Array.from({ length: 6 }, (_, index) => `of:stale-${index}`);

  beforeEach(async () => {
    path = await Deno.makeTempFile({ suffix: ".sqlite" });
    engine = await open({ url: toFileUrl(path) });
    applyCommit(engine, {
      sessionId,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: ids.map((id) => ({
          op: "set",
          id,
          value: { value: { a: 1, b: 2 } },
        })),
      },
    });
  });

  afterEach(async () => {
    close(engine);
    await Deno.remove(path);
  });

  const commitReads = (confirmed: ConfirmedRead[]) =>
    applyCommit(engine, {
      sessionId,
      commit: {
        localSeq: 2,
        reads: { confirmed, pending: [] },
        operations: [{
          op: "set",
          id: "of:output",
          value: { value: "updated" },
        }],
      },
    });

  for (
    const [count, remainder] of [[4, "1 more conflict"], [
      6,
      "3 more conflicts",
    ]] as const
  ) {
    it(`scans each of ${count} stale instances once and bounds its diagnostic`, () => {
      const staleIds = ids.slice(0, count);
      const reads = staleIds.flatMap((id) =>
        ["a", "b"].map((key, index) => ({
          id,
          scope: index === 0 ? undefined : "space" as const,
          path: toDocumentPath(["value", key]),
          seq: 0,
        }))
      );
      using scans = spy(engine.statements.selectSetDeleteConflict, "get");
      let caught: unknown;
      try {
        commitReads(reads);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ConflictError);
      const error = caught as ConflictError;
      expect(error.conflicts).toEqual(staleIds.map((id) => ({
        of: id,
        scope: "space",
        seq: 0,
        conflictSeq: 1,
      })));
      expect(scans.calls).toHaveLength(count);
      expect(error.message).toBe(
        staleIds.slice(0, 3).map((id) =>
          `stale confirmed read: ${id} at seq 0 conflicted with seq 1`
        ).join("; ") + `; ${remainder}`,
      );
    });
  }

  it("continues scanning an instance until a stale read is found", () => {
    const read = { id: ids[0], path: toDocumentPath(["value"]), seq: 1 };
    expect(() => commitReads([read, { ...read, seq: 0 }])).toThrow(
      ConflictError,
    );
  });

  it("keeps addresses containing delimiter characters distinct", () => {
    const addresses = [
      { branch: "feature", id: "left\u0000space\u0000right" },
      { branch: "feature\u0000space\u0000left", id: "right" },
    ];
    for (const { branch } of addresses) createBranch(engine, branch);
    for (const [index, { branch, id }] of addresses.entries()) {
      applyCommit(engine, {
        sessionId: "session:delimiter-updates",
        commit: {
          localSeq: index + 1,
          branch,
          reads: { confirmed: [], pending: [] },
          operations: [{ op: "set", id, value: { value: 1 } }],
        },
      });
    }
    let caught: unknown;
    try {
      commitReads(addresses.map((address) => ({
        ...address,
        path: toDocumentPath(["value"]),
        seq: 1,
      })));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConflictError);
    expect((caught as ConflictError).conflicts).toEqual(
      addresses.map(({ branch, id }, index) => ({
        of: id,
        scope: "space",
        branch,
        seq: 1,
        conflictSeq: index + 2,
      })),
    );
  });

  it("retains distinct branches while deduplicating repeated reads on each branch", () => {
    createBranch(engine, "feature");
    for (const [index, branch] of [DEFAULT_BRANCH, "feature"].entries()) {
      applyCommit(engine, {
        sessionId: "session:branch-updates",
        commit: {
          localSeq: index + 1,
          branch,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "set",
            id: ids[0],
            value: { value: { a: 10, b: 20 } },
          }],
        },
      });
    }
    using scans = spy(engine.statements.selectSetDeleteConflict, "get");
    let caught: unknown;
    try {
      commitReads(
        ["feature", DEFAULT_BRANCH].flatMap((branch) =>
          ["a", "b"].map((key) => ({
            id: ids[0],
            branch,
            path: toDocumentPath(["value", key]),
            seq: 1,
          }))
        ),
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConflictError);
    const error = caught as ConflictError;
    expect(error.conflicts).toEqual([{
      of: ids[0],
      scope: "space",
      branch: "feature",
      seq: 1,
      conflictSeq: 3,
    }, {
      of: ids[0],
      scope: "space",
      seq: 1,
      conflictSeq: 2,
    }]);
    expect(error.branch).toBe("feature");
    expect(scans.calls).toHaveLength(2);
    expect(error.message).toBe(
      `stale confirmed read: ${ids[0]} at seq 1 conflicted with seq 3`,
    );
  });

  it("keeps the first stale path's sequences and skips later patch scans", () => {
    for (const [index, key] of ["a", "b"].entries()) {
      applyCommit(engine, {
        sessionId: "session:updates",
        commit: {
          localSeq: index + 1,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "patch",
            id: ids[0],
            patches: [{ op: "replace", path: `/value/${key}`, value: 10 }],
          }],
        },
      });
    }
    using scans = spy(engine.statements.selectSetDeleteConflict, "get");
    using patches = spy(engine.statements.selectPatchConflicts, "iter");
    let caught: unknown;
    try {
      commitReads(["b", "a"].map((key) => ({
        id: ids[0],
        path: toDocumentPath(["value", key]),
        seq: 1,
      })));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConflictError);
    expect((caught as ConflictError).conflicts).toEqual([{
      of: ids[0],
      scope: "space",
      seq: 1,
      conflictSeq: 3,
    }]);
    expect(scans.calls).toHaveLength(1);
    expect(patches.calls).toHaveLength(1);
  });

  for (const invalidFirst of [false, true]) {
    it(`rejects an unknown branch ${invalidFirst ? "before" : "after"} a stale read without reporting a retryable conflict`, () => {
      const stale = { id: ids[0], path: toDocumentPath(["value"]), seq: 0 };
      const invalid = { ...stale, branch: "missing" };
      const reads = invalidFirst ? [invalid, stale] : [stale, invalid];
      let caught: unknown;
      try {
        commitReads(reads);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(Error);
      expect(caught).not.toBeInstanceOf(ConflictError);
      expect(caught).toHaveProperty("message", "unknown branch: missing");
    });

    for (const scope of ["user", "session"] as const) {
      it(`rejects unresolvable ${scope} scope ${invalidFirst ? "before" : "after"} a stale read`, () => {
        const stale = { id: ids[0], path: toDocumentPath(["value"]), seq: 0 };
        const invalid = { ...stale, scope };
        const reads = invalidFirst ? [invalid, stale] : [stale, invalid];
        expect(() => commitReads(reads)).toThrow(ProtocolError);
      });
    }
  }
});
