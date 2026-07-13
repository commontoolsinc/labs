/**
 * Deterministic coverage for the engine's commit/read validation paths —
 * protocol-shape rejections, branch existence/range checks, and stored-row
 * decode guards. These branches otherwise only run on malformed input or
 * corrupt rows, so exercising them here keeps the coverage of this package
 * stable instead of flapping with timing-dependent suites.
 */

import { assertEquals, assertThrows } from "@std/assert";
import { toFileUrl } from "@std/path";
import {
  applyCommit,
  close,
  type Engine,
  open,
  ProtocolError,
  read,
} from "../v2/engine.ts";
import { encodeMemoryBoundary } from "../v2.ts";

const withEngine = async (
  fn: (engine: Engine) => void | Promise<void>,
): Promise<void> => {
  const path = await Deno.makeTempFile({ suffix: ".sqlite" });
  const engine = await open({ url: toFileUrl(path) });
  try {
    await fn(engine);
  } finally {
    close(engine);
    await Deno.remove(path);
  }
};

const setOp = (id: string, value: unknown) =>
  ({ op: "set", id, value: { value } }) as never;

const commit = (localSeq: number, extra: Record<string, unknown>) =>
  ({
    localSeq,
    reads: { confirmed: [], pending: [] },
    operations: [],
    ...extra,
  }) as never;

Deno.test("rejects a commit with no operations, observation, or preconditions", async () => {
  await withEngine((engine) => {
    assertThrows(
      () => applyCommit(engine, { sessionId: "s:a", commit: commit(1, {}) }),
      Error,
      "requires at least one operation",
    );
  });
});

Deno.test("rejects mixing schedulerObservation with schedulerObservationBatch", async () => {
  await withEngine((engine) => {
    assertThrows(
      () =>
        applyCommit(engine, {
          sessionId: "s:a",
          commit: commit(1, {
            schedulerObservation: { x: 1 },
            schedulerObservationBatch: [{ y: 1 }],
          }),
        }),
      ProtocolError,
      "cannot mix schedulerObservation and schedulerObservationBatch",
    );
  });
});

Deno.test("rejects semantic operations on an observation-batch commit", async () => {
  await withEngine((engine) => {
    assertThrows(
      () =>
        applyCommit(engine, {
          sessionId: "s:a",
          commit: commit(1, {
            operations: [setOp("of:fid1:a", 1)],
            schedulerObservationBatch: [{ y: 1 }],
          }),
        }),
      ProtocolError,
      "must not include semantic operations",
    );
  });
});

Deno.test("rejects commits and reads against an unknown branch", async () => {
  await withEngine((engine) => {
    assertThrows(
      () =>
        applyCommit(engine, {
          sessionId: "s:a",
          commit: commit(1, {
            branch: "nope",
            operations: [setOp("of:fid1:a", 1)],
          }),
        }),
      Error,
      "unknown branch: nope",
    );
    assertThrows(
      () => read(engine, { id: "of:fid1:a", branch: "nope" } as never),
      Error,
      "unknown branch: nope",
    );
  });
});

Deno.test("rejects reads at a seq beyond the branch head", async () => {
  await withEngine((engine) => {
    assertThrows(
      () => read(engine, { id: "of:fid1:a", seq: 999 } as never),
      Error,
      "out of range",
    );
  });
});

Deno.test("rejects stored revision rows that decode to non-documents", async () => {
  await withEngine((engine) => {
    applyCommit(engine, {
      sessionId: "s:a",
      commit: commit(1, { operations: [setOp("of:fid1:bad", 1)] }),
    });
    // Corrupt the stored row in place: a VALID boundary encoding whose root
    // is an array, not the plain-object root every stored document must be.
    engine.database.prepare(
      `UPDATE revision SET data = :data WHERE id = 'of:fid1:bad'`,
    ).run({ data: encodeMemoryBoundary([1]) });
    assertThrows(
      () => read(engine, { id: "of:fid1:bad" } as never),
      Error,
      "stored documents must be plain object roots",
    );
  });
});

Deno.test("rejects stored revision rows with an unexpected op", async () => {
  await withEngine((engine) => {
    applyCommit(engine, {
      sessionId: "s:a",
      commit: commit(1, { operations: [setOp("of:fid1:odd", 1)] }),
    });
    engine.database.prepare(
      `UPDATE revision SET op = 'bogus' WHERE id = 'of:fid1:odd'`,
    ).run({});
    assertThrows(
      () => read(engine, { id: "of:fid1:odd" } as never),
      Error,
      "unexpected stored revision op",
    );
  });
});

Deno.test("a valid set still reads back after the validation batteries", async () => {
  await withEngine((engine) => {
    applyCommit(engine, {
      sessionId: "s:a",
      commit: commit(1, { operations: [setOp("of:fid1:ok", 7)] }),
    });
    assertEquals(read(engine, { id: "of:fid1:ok" } as never), { value: 7 });
  });
});
