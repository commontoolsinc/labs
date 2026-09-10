import { expect } from "@std/expect";
import { toFileUrl } from "@std/path";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { type ConfirmedRead, toDocumentPath } from "../../v2.ts";
import {
  applyCommit,
  close,
  ConflictError,
  type Engine,
  open,
} from "../../v2/engine.ts";

describe("engine", () => {
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

  it("bounds and deduplicates the diagnostic while retaining every stale path read", () => {
    const reads = ids.flatMap((id) =>
      ["a", "b"].map((key) => ({
        id,
        path: toDocumentPath(["value", key]),
        seq: 0,
      }))
    );
    let caught: unknown;
    try {
      commitReads(reads);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConflictError);
    const error = caught as ConflictError;
    expect(error.conflicts).toEqual(reads.map(({ id }) => ({
      of: id,
      scope: "space",
      seq: 0,
      conflictSeq: 1,
    })));
    expect(error.message).toBe(
      ids.slice(0, 3).map((id) =>
        `stale confirmed read: ${id} at seq 0 conflicted with seq 1`
      ).join("; ") + "; 3 more conflicts",
    );
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
  }
});
