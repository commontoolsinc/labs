import { ChangeSet } from "@codemirror/state";
import { Database } from "@db/sqlite";
import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { toFileUrl } from "@std/path";
import {
  applyCommit,
  close,
  createBranch,
  OpCodecError,
  OpCursorMismatchError,
  open,
  OpFieldBaselineMismatchError,
  OpFieldWriteConflictError,
  OpHistoryUnavailableError,
  OpSubmissionMismatchError,
  ProtocolError,
  pruneOperationFieldHistory,
  queryOperationField,
  read,
  UnsupportedOpCodecError,
} from "../v2/engine.ts";
import {
  CODEMIRROR_CHANGESET_CODEC,
  operationBaselineHash,
  OperationCodecRegistry,
} from "../v2/operation-codec.ts";
import {
  type ApplyOpOperation,
  streamEntriesDocId,
  toValuePath,
} from "../v2.ts";

const changes = (
  length: number,
  from: number,
  insert: string,
): ReturnType<ChangeSet["toJSON"]> =>
  ChangeSet.of({ from, insert }, length).toJSON();

const openTestEngine = async () => {
  const path = await Deno.makeTempFile({ suffix: ".sqlite" });
  const engine = await open({ url: toFileUrl(path) });
  return { engine, path };
};

describe("v2-operation-engine", () => {
  it("validates operation configuration, addresses, and inactive pruning", async () => {
    await expect(open({
      url: new URL("memory://invalid-operation-checkpoint"),
      operationCheckpointInterval: 0,
    })).rejects.toThrow("positive safe integer");

    const { engine, path } = await openTestEngine();
    try {
      expect(() =>
        queryOperationField(engine, {
          id: "",
          path: toValuePath([]),
        })
      ).toThrow("id is malformed");
      expect(() =>
        queryOperationField(engine, {
          id: "of:missing",
          path: toValuePath([]),
          after: { epoch: 0, version: -1 },
        })
      ).toThrow("cursor is malformed");
      expect(queryOperationField(engine, {
        id: "of:missing",
        path: toValuePath(["absent"]),
      })).toMatchObject({ active: false, materialized: null });
      expect(() =>
        pruneOperationFieldHistory(engine, {
          id: "",
          path: toValuePath([]),
        })
      ).toThrow("id is malformed");
      expect(() =>
        pruneOperationFieldHistory(engine, {
          id: "of:missing",
          path: toValuePath([]),
        })
      ).toThrow("only active operation field history");
    } finally {
      close(engine);
      await Deno.remove(path);
    }
  });

  it("activates a field and atomically materializes its first operation", async () => {
    const { engine, path } = await openTestEngine();

    try {
      applyCommit(engine, {
        sessionId: "session:setup",
        commit: {
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "set",
            id: "of:collaborative",
            value: { value: { body: "ac" } },
          }],
        },
      });

      const applied = applyCommit(engine, {
        sessionId: "session:alice",
        commit: {
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "apply-op",
            id: "of:collaborative",
            path: toValuePath(["body"]),
            codec: CODEMIRROR_CHANGESET_CODEC,
            submissionId: "alice:1",
            base: null,
            baselineHash: operationBaselineHash("ac"),
            payload: {
              updates: [{ clientId: "alice", changes: changes(2, 1, "b") }],
            },
          }],
        },
      });

      expect(applied.operationResolutions).toHaveLength(1);
      expect(applied.operationResolutions?.[0]).toMatchObject({
        operationIndex: 0,
        submissionId: "alice:1",
        from: { epoch: 1, version: 0 },
        to: { epoch: 1, version: 1 },
        duplicate: false,
      });
      expect(read(engine, { id: "of:collaborative" })).toEqual({
        value: { body: "abc" },
      });

      const field = queryOperationField(engine, {
        id: "of:collaborative",
        path: toValuePath(["body"]),
        after: { epoch: 1, version: 0 },
      });
      expect(field).toMatchObject({
        active: true,
        codec: CODEMIRROR_CHANGESET_CODEC,
        cursor: { epoch: 1, version: 1 },
        materialized: "abc",
      });
      expect(field.operations).toHaveLength(1);
      expect(field.operations[0].opId).toMatch(/^op:/);
      expect(applied.operationResolutions?.[0].operations[0].opId).toBe(
        field.operations[0].opId,
      );
    } finally {
      close(engine);
      await Deno.remove(path);
    }
  });

  it("rebases clients that concurrently race to activate one baseline", async () => {
    const { engine, path } = await openTestEngine();

    try {
      applyCommit(engine, {
        sessionId: "session:setup",
        commit: {
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "set",
            id: "of:activation-race",
            value: { value: { body: "abc" } },
          }],
        },
      });
      const baselineHash = operationBaselineHash("abc");

      applyCommit(engine, {
        sessionId: "session:alice",
        commit: {
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "apply-op",
            id: "of:activation-race",
            path: toValuePath(["body"]),
            codec: CODEMIRROR_CHANGESET_CODEC,
            submissionId: "alice:1",
            base: null,
            baselineHash,
            payload: {
              updates: [{ clientId: "alice", changes: changes(3, 1, "X") }],
            },
          }],
        },
      });
      const bob = applyCommit(engine, {
        sessionId: "session:bob",
        commit: {
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "apply-op",
            id: "of:activation-race",
            path: toValuePath(["body"]),
            codec: CODEMIRROR_CHANGESET_CODEC,
            submissionId: "bob:1",
            base: null,
            baselineHash,
            payload: {
              updates: [{ clientId: "bob", changes: changes(3, 1, "Y") }],
            },
          }],
        },
      });

      expect(bob.operationResolutions?.[0]).toMatchObject({
        from: { epoch: 1, version: 1 },
        to: { epoch: 1, version: 2 },
      });
      expect(read(engine, { id: "of:activation-race" })).toEqual({
        value: { body: "aXYbc" },
      });
      expect(queryOperationField(engine, {
        id: "of:activation-race",
        path: toValuePath(["body"]),
      })).toMatchObject({
        cursor: { epoch: 1, version: 2 },
        materialized: "aXYbc",
        operations: [{
          cursor: { epoch: 1, version: 1 },
          submissionId: "alice:1",
        }, {
          cursor: { epoch: 1, version: 2 },
          submissionId: "bob:1",
        }],
      });
    } finally {
      close(engine);
      await Deno.remove(path);
    }
  });

  it("rebases stale operations and makes submission ids durable", async () => {
    const { engine, path } = await openTestEngine();

    try {
      applyCommit(engine, {
        sessionId: "session:setup",
        commit: {
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "set",
            id: "of:collaborative",
            value: { value: { body: "ac" } },
          }],
        },
      });
      applyCommit(engine, {
        sessionId: "session:alice",
        commit: {
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "apply-op",
            id: "of:collaborative",
            path: toValuePath(["body"]),
            codec: CODEMIRROR_CHANGESET_CODEC,
            submissionId: "alice:1",
            base: null,
            baselineHash: operationBaselineHash("ac"),
            payload: {
              updates: [{ clientId: "alice", changes: changes(2, 1, "X") }],
            },
          }],
        },
      });

      const bobCommit = {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "apply-op" as const,
          id: "of:collaborative",
          path: toValuePath(["body"]),
          codec: CODEMIRROR_CHANGESET_CODEC,
          submissionId: "bob:1",
          base: { epoch: 1, version: 0 },
          payload: {
            updates: [{ clientId: "bob", changes: changes(2, 1, "Y") }],
          },
        }],
      };
      const first = applyCommit(engine, {
        sessionId: "session:bob",
        commit: bobCommit,
      });
      const replay = applyCommit(engine, {
        sessionId: "session:bob",
        commit: bobCommit,
      });

      expect(first.operationResolutions?.[0]).toMatchObject({
        from: { epoch: 1, version: 1 },
        to: { epoch: 1, version: 2 },
      });
      expect(replay.operationResolutions).toEqual(first.operationResolutions);
      expect(read(engine, { id: "of:collaborative" })).toEqual({
        value: { body: "aXYc" },
      });

      const duplicate = applyCommit(engine, {
        sessionId: "session:bob",
        commit: { ...bobCommit, localSeq: 2 },
      });
      expect(duplicate.operationResolutions?.[0]).toMatchObject({
        submissionId: "bob:1",
        to: { epoch: 1, version: 2 },
        duplicate: true,
      });
      expect(
        queryOperationField(engine, {
          id: "of:collaborative",
          path: toValuePath(["body"]),
          after: { epoch: 1, version: 0 },
        }).operations,
      ).toHaveLength(2);

      expect(() =>
        applyCommit(engine, {
          sessionId: "session:bob",
          commit: {
            ...bobCommit,
            localSeq: 3,
            operations: [{
              ...bobCommit.operations[0],
              base: { epoch: 1, version: 1 },
            }],
          },
        })
      ).toThrow(OpSubmissionMismatchError);
      expect(() =>
        applyCommit(engine, {
          sessionId: "session:bob",
          commit: {
            ...bobCommit,
            localSeq: 4,
            operations: [{
              ...bobCommit.operations[0],
              base: { epoch: 2, version: 0 },
            }],
          },
        })
      ).toThrow(OpSubmissionMismatchError);
    } finally {
      close(engine);
      await Deno.remove(path);
    }
  });

  it("checkpoints, prunes, resets stale readers, and rejects stale writers", async () => {
    const path = await Deno.makeTempFile({ suffix: ".sqlite" });
    const engine = await open({
      url: toFileUrl(path),
      operationCheckpointInterval: 2,
    });

    try {
      applyCommit(engine, {
        sessionId: "session:setup",
        commit: {
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "set",
            id: "of:retained",
            value: { value: { body: "a" } },
          }],
        },
      });
      applyCommit(engine, {
        sessionId: "session:alice",
        commit: {
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "apply-op",
            id: "of:retained",
            path: toValuePath(["body"]),
            codec: CODEMIRROR_CHANGESET_CODEC,
            submissionId: "alice:1",
            base: null,
            baselineHash: operationBaselineHash("a"),
            payload: {
              updates: [{ clientId: "alice", changes: changes(1, 1, "b") }],
            },
          }],
        },
      });
      expect(() =>
        pruneOperationFieldHistory(engine, {
          id: "of:retained",
          path: toValuePath(["body"]),
        })
      ).toThrow(OpHistoryUnavailableError);
      expect(
        (engine.database.prepare(`
        SELECT COUNT(*) AS count FROM op_integrated
      `).get() as { count: number }).count,
      ).toBe(1);
      applyCommit(engine, {
        sessionId: "session:bob",
        commit: {
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "apply-op",
            id: "of:retained",
            path: toValuePath(["body"]),
            codec: CODEMIRROR_CHANGESET_CODEC,
            submissionId: "bob:1",
            base: { epoch: 1, version: 1 },
            payload: {
              updates: [{ clientId: "bob", changes: changes(2, 2, "c") }],
            },
          }],
        },
      });

      expect(
        engine.database.prepare(`
        SELECT version FROM op_checkpoint ORDER BY version
      `).all(),
      ).toEqual([{ version: 0 }, { version: 2 }]);
      expect(pruneOperationFieldHistory(engine, {
        id: "of:retained",
        path: toValuePath(["body"]),
      })).toEqual({
        cursor: { epoch: 1, version: 2 },
        prunedOperations: 2,
      });
      expect(
        (engine.database.prepare(`
        SELECT COUNT(*) AS count FROM op_submission
      `).get() as { count: number }).count,
      ).toBe(2);
      const duplicate = applyCommit(engine, {
        sessionId: "session:duplicate",
        commit: {
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "apply-op",
            id: "of:retained",
            path: toValuePath(["body"]),
            codec: CODEMIRROR_CHANGESET_CODEC,
            submissionId: "alice:1",
            base: null,
            baselineHash: operationBaselineHash("a"),
            payload: {
              updates: [{ clientId: "alice", changes: changes(1, 1, "b") }],
            },
          }],
        },
      });
      expect(duplicate.operationResolutions?.[0]).toMatchObject({
        duplicate: true,
        from: { epoch: 1, version: 0 },
        to: { epoch: 1, version: 1 },
      });
      expect(read(engine, { id: "of:retained" })).toEqual({
        value: { body: "abc" },
      });

      expect(queryOperationField(engine, {
        id: "of:retained",
        path: toValuePath(["body"]),
        after: { epoch: 1, version: 0 },
      })).toMatchObject({
        cursor: { epoch: 1, version: 2 },
        materialized: "abc",
        retainedFrom: { epoch: 1, version: 2 },
        reset: true,
        operations: [],
      });
      expect(queryOperationField(engine, {
        id: "of:retained",
        path: toValuePath(["body"]),
      })).toMatchObject({
        retainedFrom: { epoch: 1, version: 2 },
        reset: true,
        operations: [],
      });
      expect(queryOperationField(engine, {
        id: "of:retained",
        path: toValuePath(["body"]),
        after: { epoch: 99, version: 0 },
      })).toMatchObject({
        reset: true,
        operations: [],
      });
      expect(() =>
        queryOperationField(engine, {
          id: "of:retained",
          path: toValuePath(["body"]),
          after: { epoch: 1, version: 3 },
        })
      ).toThrow(OpCursorMismatchError);

      expect(() =>
        applyCommit(engine, {
          sessionId: "session:stale",
          commit: {
            localSeq: 1,
            reads: { confirmed: [], pending: [] },
            operations: [{
              op: "apply-op",
              id: "of:retained",
              path: toValuePath(["body"]),
              codec: CODEMIRROR_CHANGESET_CODEC,
              submissionId: "stale:1",
              base: { epoch: 1, version: 0 },
              payload: {
                updates: [{
                  clientId: "stale",
                  changes: changes(1, 1, "x"),
                }],
              },
            }],
          },
        })
      ).toThrow(OpHistoryUnavailableError);
      expect(read(engine, { id: "of:retained" })).toEqual({
        value: { body: "abc" },
      });
      expect(
        (engine.database.prepare(`
        SELECT COUNT(*) AS count FROM op_submission
      `).get() as { count: number }).count,
      ).toBe(2);

      applyCommit(engine, {
        sessionId: "session:fresh",
        commit: {
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "apply-op",
            id: "of:retained",
            path: toValuePath(["body"]),
            codec: CODEMIRROR_CHANGESET_CODEC,
            submissionId: "fresh:1",
            base: { epoch: 1, version: 2 },
            payload: {
              updates: [{
                clientId: "fresh",
                changes: changes(3, 3, "d"),
              }],
            },
          }],
        },
      });
      expect(queryOperationField(engine, {
        id: "of:retained",
        path: toValuePath(["body"]),
        after: { epoch: 1, version: 2 },
      })).toMatchObject({
        cursor: { epoch: 1, version: 3 },
        materialized: "abcd",
        retainedFrom: { epoch: 1, version: 2 },
        operations: [{ cursor: { epoch: 1, version: 3 } }],
      });
    } finally {
      close(engine);
      await Deno.remove(path);
    }
  });

  it("compacts one checkpoint behind without resetting current readers", async () => {
    const path = await Deno.makeTempFile({ suffix: ".sqlite" });
    const engine = await open({
      url: toFileUrl(path),
      operationCheckpointInterval: 2,
    });

    try {
      applyCommit(engine, {
        sessionId: "session:setup",
        commit: {
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "set",
            id: "of:auto-retained",
            value: { value: { body: "" } },
          }],
        },
      });
      for (let version = 0; version < 4; version++) {
        applyCommit(engine, {
          sessionId: "session:writer",
          commit: {
            localSeq: version + 1,
            reads: { confirmed: [], pending: [] },
            operations: [{
              op: "apply-op",
              id: "of:auto-retained",
              path: toValuePath(["body"]),
              codec: CODEMIRROR_CHANGESET_CODEC,
              submissionId: `writer:${version + 1}`,
              base: version === 0 ? null : { epoch: 1, version },
              ...(version === 0
                ? { baselineHash: operationBaselineHash("") }
                : {}),
              payload: {
                updates: [{
                  clientId: "writer",
                  changes: changes(version, version, String(version + 1)),
                }],
              },
            }],
          },
        });
      }

      expect(
        engine.database.prepare(`
          SELECT version FROM op_checkpoint ORDER BY version
        `).all(),
      ).toEqual([{ version: 0 }, { version: 2 }, { version: 4 }]);
      expect(
        engine.database.prepare(`
          SELECT version FROM op_integrated ORDER BY version
        `).all(),
      ).toEqual([{ version: 3 }, { version: 4 }]);
      expect(queryOperationField(engine, {
        id: "of:auto-retained",
        path: toValuePath(["body"]),
        after: { epoch: 1, version: 2 },
      })).toMatchObject({
        retainedFrom: { epoch: 1, version: 2 },
        operations: [{ cursor: { epoch: 1, version: 3 } }, {
          cursor: { epoch: 1, version: 4 },
        }],
      });
      expect(queryOperationField(engine, {
        id: "of:auto-retained",
        path: toValuePath(["body"]),
        after: { epoch: 1, version: 1 },
      })).toMatchObject({
        retainedFrom: { epoch: 1, version: 2 },
        reset: true,
        operations: [],
      });
    } finally {
      close(engine);
      await Deno.remove(path);
    }
  });

  it("rejects collaborative fields on child branches", async () => {
    const { engine, path } = await openTestEngine();

    try {
      applyCommit(engine, {
        sessionId: "session:setup",
        commit: {
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "set",
            id: "of:branch",
            value: { value: { body: "a" } },
          }],
        },
      });
      createBranch(engine, "feature");

      expect(() =>
        queryOperationField(engine, {
          id: "of:branch",
          branch: "feature",
          path: toValuePath(["body"]),
        })
      ).toThrow(ProtocolError);
      expect(() =>
        applyCommit(engine, {
          sessionId: "session:feature",
          commit: {
            branch: "feature",
            localSeq: 1,
            reads: { confirmed: [], pending: [] },
            operations: [{
              op: "apply-op",
              id: "of:branch",
              path: toValuePath(["body"]),
              codec: CODEMIRROR_CHANGESET_CODEC,
              submissionId: "feature:1",
              base: null,
              baselineHash: operationBaselineHash("a"),
              payload: {
                updates: [{
                  clientId: "feature",
                  changes: changes(1, 1, "b"),
                }],
              },
            }],
          },
        })
      ).toThrow(ProtocolError);
      expect(() =>
        applyCommit(engine, {
          sessionId: "session:feature-release",
          commit: {
            branch: "feature",
            localSeq: 1,
            reads: { confirmed: [], pending: [] },
            operations: [{
              op: "release-op-field",
              id: "of:branch",
              path: toValuePath(["body"]),
              codec: CODEMIRROR_CHANGESET_CODEC,
              cursor: { epoch: 1, version: 1 },
            }],
          },
        })
      ).toThrow(ProtocolError);
      expect(queryOperationField(engine, {
        id: "of:branch",
        path: toValuePath(["body"]),
      })).toMatchObject({ active: false, operations: [] });
    } finally {
      close(engine);
      await Deno.remove(path);
    }
  });

  it("requires release before an ordinary write changes an active field", async () => {
    const { engine, path } = await openTestEngine();

    try {
      applyCommit(engine, {
        sessionId: "session:setup",
        commit: {
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "set",
            id: "of:collaborative",
            value: { value: { body: "ac", title: "Draft" } },
          }],
        },
      });
      applyCommit(engine, {
        sessionId: "session:alice",
        commit: {
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "apply-op",
            id: "of:collaborative",
            path: toValuePath(["body"]),
            codec: CODEMIRROR_CHANGESET_CODEC,
            submissionId: "alice:1",
            base: null,
            baselineHash: operationBaselineHash("ac"),
            payload: {
              updates: [{ clientId: "alice", changes: changes(2, 1, "b") }],
            },
          }],
        },
      });

      const rejectApply = (
        sessionId: string,
        overrides: Partial<ApplyOpOperation>,
        error: new (message: string) => Error,
      ) => {
        expect(() =>
          applyCommit(engine, {
            sessionId,
            commit: {
              localSeq: 1,
              reads: { confirmed: [], pending: [] },
              operations: [{
                op: "apply-op",
                id: "of:collaborative",
                path: toValuePath(["body"]),
                codec: CODEMIRROR_CHANGESET_CODEC,
                submissionId: sessionId,
                base: { epoch: 1, version: 1 },
                payload: {
                  updates: [{
                    clientId: sessionId,
                    changes: changes(3, 3, "!"),
                  }],
                },
                ...overrides,
              }],
            },
          })
        ).toThrow(error);
      };
      rejectApply(
        "session:apply-codec-change",
        { codec: "other@1" },
        OpCodecError,
      );
      rejectApply(
        "session:apply-baseline-mismatch",
        { base: null, baselineHash: operationBaselineHash("stale") },
        OpFieldBaselineMismatchError,
      );
      rejectApply(
        "session:apply-epoch-mismatch",
        { base: { epoch: 2, version: 1 } },
        OpCursorMismatchError,
      );
      rejectApply(
        "session:apply-future",
        { base: { epoch: 1, version: 2 } },
        OpCursorMismatchError,
      );

      const rejectRelease = (
        sessionId: string,
        overrides: Record<string, unknown>,
        error: new (message: string) => Error,
      ) => {
        expect(() =>
          applyCommit(engine, {
            sessionId,
            commit: {
              localSeq: 1,
              reads: { confirmed: [], pending: [] },
              operations: [{
                op: "release-op-field",
                id: "of:collaborative",
                path: toValuePath(["body"]),
                codec: CODEMIRROR_CHANGESET_CODEC,
                cursor: { epoch: 1, version: 1 },
                ...overrides,
              } as never],
            },
          })
        ).toThrow(error);
      };
      rejectRelease(
        "session:release-malformed-cursor",
        { cursor: { epoch: 0, version: -1 } },
        OpCursorMismatchError,
      );
      rejectRelease(
        "session:release-malformed-codec",
        { codec: 1 },
        OpCodecError,
      );
      rejectRelease(
        "session:release-stale",
        { cursor: { epoch: 1, version: 0 } },
        OpCursorMismatchError,
      );
      rejectRelease(
        "session:release-codec",
        { codec: "other@1" },
        OpCodecError,
      );

      expect(() =>
        applyCommit(engine, {
          sessionId: "session:ordinary-remove",
          commit: {
            localSeq: 1,
            reads: { confirmed: [], pending: [] },
            operations: [{
              op: "patch",
              id: "of:collaborative",
              patches: [{ op: "remove", path: "/value/body" }],
            }],
          },
        })
      ).toThrow(OpFieldWriteConflictError);

      expect(() =>
        applyCommit(engine, {
          sessionId: "session:ordinary",
          commit: {
            localSeq: 1,
            reads: { confirmed: [], pending: [] },
            operations: [{
              op: "patch",
              id: "of:collaborative",
              patches: [{
                op: "replace",
                path: "/value/body",
                value: "overwritten",
              }],
            }],
          },
        })
      ).toThrow(OpFieldWriteConflictError);

      applyCommit(engine, {
        sessionId: "session:ordinary",
        commit: {
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "patch",
            id: "of:collaborative",
            patches: [{
              op: "replace",
              path: "/value/title",
              value: "Ready",
            }],
          }],
        },
      });

      applyCommit(engine, {
        sessionId: "session:ordinary",
        commit: {
          localSeq: 2,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "release-op-field",
            id: "of:collaborative",
            path: toValuePath(["body"]),
            codec: CODEMIRROR_CHANGESET_CODEC,
            cursor: { epoch: 1, version: 1 },
          }, {
            op: "patch",
            id: "of:collaborative",
            patches: [{
              op: "replace",
              path: "/value/body",
              value: "released",
            }],
          }],
        },
      });

      expect(read(engine, { id: "of:collaborative" })).toEqual({
        value: { body: "released", title: "Ready" },
      });
      expect(
        queryOperationField(engine, {
          id: "of:collaborative",
          path: toValuePath(["body"]),
        }),
      ).toMatchObject({
        active: false,
        cursor: null,
        materialized: "released",
      });

      const reopened = applyCommit(engine, {
        sessionId: "session:alice",
        commit: {
          localSeq: 2,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "apply-op",
            id: "of:collaborative",
            path: toValuePath(["body"]),
            codec: CODEMIRROR_CHANGESET_CODEC,
            // Submission ids are epoch-local, so reusing one after deliberate
            // release starts a new operation rather than replaying epoch one.
            submissionId: "alice:1",
            base: null,
            baselineHash: operationBaselineHash("released"),
            payload: {
              updates: [{
                clientId: "alice",
                changes: changes(8, 8, "!"),
              }],
            },
          }],
        },
      });
      expect(reopened.operationResolutions?.[0]).toMatchObject({
        from: { epoch: 2, version: 0 },
        to: { epoch: 2, version: 1 },
        duplicate: false,
      });
      expect(read(engine, { id: "of:collaborative" })).toEqual({
        value: { body: "released!", title: "Ready" },
      });
    } finally {
      close(engine);
      await Deno.remove(path);
    }
  });

  it("releases active fields when their owning entity is deleted", async () => {
    const { engine, path } = await openTestEngine();

    try {
      applyCommit(engine, {
        sessionId: "session:setup",
        commit: {
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "set",
            id: "of:deleted-collaboration",
            value: { value: { body: "a" } },
          }],
        },
      });
      applyCommit(engine, {
        sessionId: "session:alice",
        commit: {
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "apply-op",
            id: "of:deleted-collaboration",
            path: toValuePath(["body"]),
            codec: CODEMIRROR_CHANGESET_CODEC,
            submissionId: "alice:1",
            base: null,
            baselineHash: operationBaselineHash("a"),
            payload: {
              updates: [{ clientId: "alice", changes: changes(1, 1, "b") }],
            },
          }],
        },
      });
      applyCommit(engine, {
        sessionId: "session:deleter",
        commit: {
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: [{ op: "delete", id: "of:deleted-collaboration" }],
        },
      });

      expect(queryOperationField(engine, {
        id: "of:deleted-collaboration",
        path: toValuePath(["body"]),
      })).toMatchObject({
        active: false,
        cursor: null,
        materialized: null,
        operations: [],
      });
    } finally {
      close(engine);
      await Deno.remove(path);
    }
  });

  it("applies operations against earlier results in the same commit", async () => {
    const { engine, path } = await openTestEngine();

    try {
      applyCommit(engine, {
        sessionId: "session:setup",
        commit: {
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "set",
            id: "of:collaborative",
            value: { value: { body: "old" } },
          }],
        },
      });

      applyCommit(engine, {
        sessionId: "session:alice",
        commit: {
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "set",
            id: "of:collaborative",
            value: { value: { body: "abc" } },
          }, {
            op: "apply-op",
            id: "of:collaborative",
            path: toValuePath(["body"]),
            codec: CODEMIRROR_CHANGESET_CODEC,
            submissionId: "alice:1",
            base: null,
            baselineHash: operationBaselineHash("abc"),
            payload: {
              updates: [{
                clientId: "alice",
                changes: changes(3, 3, "!"),
              }],
            },
          }],
        },
      });

      expect(read(engine, { id: "of:collaborative" })).toEqual({
        value: { body: "abc!" },
      });
    } finally {
      close(engine);
      await Deno.remove(path);
    }
  });

  it("rejects malformed operation inputs without mutating durable state", async () => {
    const { engine, path } = await openTestEngine();

    try {
      applyCommit(engine, {
        sessionId: "session:setup",
        commit: {
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "set",
            id: "of:malformed",
            value: { value: { body: "abc" } },
          }],
        },
      });
      const baselineHash = operationBaselineHash("abc");
      const counts = () => ({
        commits: (engine.database.prepare(
          `SELECT COUNT(*) AS count FROM "commit"`,
        ).get() as { count: number }).count,
        revisions: (engine.database.prepare(
          `SELECT COUNT(*) AS count FROM revision`,
        ).get() as { count: number }).count,
        fields: (engine.database.prepare(
          `SELECT COUNT(*) AS count FROM op_field_epoch`,
        ).get() as { count: number }).count,
        checkpoints: (engine.database.prepare(
          `SELECT COUNT(*) AS count FROM op_checkpoint`,
        ).get() as { count: number }).count,
        submissions: (engine.database.prepare(
          `SELECT COUNT(*) AS count FROM op_submission`,
        ).get() as { count: number }).count,
        integrated: (engine.database.prepare(
          `SELECT COUNT(*) AS count FROM op_integrated`,
        ).get() as { count: number }).count,
      });
      const before = counts();
      const operation: ApplyOpOperation = {
        op: "apply-op",
        id: "of:malformed",
        path: toValuePath(["body"]),
        codec: CODEMIRROR_CHANGESET_CODEC,
        submissionId: "malformed:1",
        base: null,
        baselineHash,
        payload: {
          updates: [{ clientId: "client", changes: changes(3, 1, "X") }],
        },
      };
      const fail = (
        candidate: ApplyOpOperation,
        error: new (message: string) => Error,
      ) => {
        expect(() =>
          applyCommit(engine, {
            sessionId: "session:malformed",
            commit: {
              localSeq: 1,
              reads: { confirmed: [], pending: [] },
              operations: [candidate],
            },
          })
        ).toThrow(error);
        expect(counts()).toEqual(before);
        expect(read(engine, { id: "of:malformed" })).toEqual({
          value: { body: "abc" },
        });
        expect(queryOperationField(engine, {
          id: "of:malformed",
          path: toValuePath(["body"]),
        })).toMatchObject({ active: false, cursor: null, operations: [] });
      };

      fail({ ...operation, codec: "unknown@1" }, UnsupportedOpCodecError);
      fail({ ...operation, id: "" }, ProtocolError);
      fail({ ...operation, codec: "codemirror" }, ProtocolError);
      fail({ ...operation, submissionId: "" }, ProtocolError);
      fail({
        ...operation,
        path: toValuePath(Array.from({ length: 257 }, () => "body")),
      }, ProtocolError);
      fail({
        ...operation,
        base: { epoch: 0, version: 0 },
        baselineHash: undefined,
      }, OpCursorMismatchError);
      fail({ ...operation, baselineHash: "" }, OpFieldBaselineMismatchError);
      fail({
        ...operation,
        base: { epoch: 1, version: 0 },
      }, OpFieldBaselineMismatchError);
      fail(
        { ...operation, baselineHash: operationBaselineHash("stale") },
        OpFieldBaselineMismatchError,
      );
      fail({
        ...operation,
        base: { epoch: 1, version: 0 },
        baselineHash: undefined,
      }, OpCursorMismatchError);
      fail({
        ...operation,
        payload: {
          updates: [{ clientId: "client", changes: [999] }],
        },
      }, OpCodecError);
      fail({
        ...operation,
        payload: {
          updates: Array.from({ length: 257 }, (_, index) => ({
            clientId: `client:${index}`,
            changes: changes(3, 1, ""),
          })),
        },
      }, OpCodecError);
      fail({
        ...operation,
        payload: { oversized: "x".repeat(1_000_001) },
      }, OpCodecError);
      fail({
        ...operation,
        id: streamEntriesDocId({ id: "of:stream", path: ["events"] }),
        path: toValuePath([]),
        baselineHash: operationBaselineHash(null),
      }, ProtocolError);
    } finally {
      close(engine);
      await Deno.remove(path);
    }
  });

  it("rejects invalid codec results without mutating materialized state", async () => {
    const path = await Deno.makeTempFile({ suffix: ".sqlite" });
    const engine = await open({
      url: toFileUrl(path),
      operationCodecs: new OperationCodecRegistry([{
        id: "empty-change@1",
        integrate: () => ({ materialized: "changed", operations: [] }),
      }, {
        id: "too-many@1",
        integrate: ({ materialized }) => ({
          materialized,
          operations: Array.from({ length: 257 }, () => "operation"),
        }),
      }, {
        id: "invalid-materialized@1",
        integrate: () => ({
          materialized: (() => {}) as never,
          operations: ["operation"],
        }),
      }, {
        id: "invalid-operation@1",
        integrate: ({ materialized }) => ({
          materialized,
          operations: [(() => {}) as never],
        }),
      }, {
        id: "large-materialized@1",
        integrate: () => ({
          materialized: "x".repeat(1_000_001),
          operations: ["operation"],
        }),
      }, {
        id: "large-operation@1",
        integrate: ({ materialized }) => ({
          materialized,
          operations: ["x".repeat(1_000_001)],
        }),
      }, {
        id: "throw-value@1",
        integrate: () => {
          throw "codec rejection";
        },
      }]),
    });

    try {
      applyCommit(engine, {
        sessionId: "session:setup",
        commit: {
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "set",
            id: "of:empty-change",
            value: { value: { body: "original" } },
          }],
        },
      });

      for (
        const codec of [
          "empty-change@1",
          "too-many@1",
          "invalid-materialized@1",
          "invalid-operation@1",
          "large-materialized@1",
          "large-operation@1",
          "throw-value@1",
        ]
      ) {
        expect(() =>
          applyCommit(engine, {
            sessionId: `session:${codec}`,
            commit: {
              localSeq: 1,
              reads: { confirmed: [], pending: [] },
              operations: [{
                op: "apply-op",
                id: "of:empty-change",
                path: toValuePath(["body"]),
                codec,
                submissionId: `submission:${codec}`,
                base: null,
                baselineHash: operationBaselineHash("original"),
                payload: {},
              }],
            },
          })
        ).toThrow(OpCodecError);
      }
      expect(read(engine, { id: "of:empty-change" })).toEqual({
        value: { body: "original" },
      });
      expect(queryOperationField(engine, {
        id: "of:empty-change",
        path: toValuePath(["body"]),
      })).toMatchObject({ active: false, cursor: null });
    } finally {
      close(engine);
      await Deno.remove(path);
    }
  });

  it("rolls back integrated rows when a later operation rejects the commit", async () => {
    const { engine, path } = await openTestEngine();

    try {
      applyCommit(engine, {
        sessionId: "session:setup",
        commit: {
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "set",
            id: "of:rollback",
            value: { value: { body: "abc" } },
          }],
        },
      });
      const count = (table: string): number =>
        (engine.database.prepare(
          `SELECT COUNT(*) AS count FROM ${table}`,
        ).get() as { count: number }).count;
      const before = {
        commits: count('"commit"'),
        revisions: count("revision"),
        fields: count("op_field_epoch"),
        checkpoints: count("op_checkpoint"),
        submissions: count("op_submission"),
        integrated: count("op_integrated"),
      };

      expect(() =>
        applyCommit(engine, {
          sessionId: "session:rollback",
          commit: {
            localSeq: 1,
            reads: { confirmed: [], pending: [] },
            operations: [{
              op: "apply-op",
              id: "of:rollback",
              path: toValuePath(["body"]),
              codec: CODEMIRROR_CHANGESET_CODEC,
              submissionId: "rollback:1",
              base: null,
              baselineHash: operationBaselineHash("abc"),
              payload: {
                updates: [{
                  clientId: "client",
                  changes: changes(3, 3, "!"),
                }],
              },
            }, {
              op: "patch",
              id: "of:rollback",
              patches: [{
                op: "replace",
                path: "/value/body",
                value: "overwritten",
              }],
            }],
          },
        })
      ).toThrow(OpFieldWriteConflictError);

      expect({
        commits: count('"commit"'),
        revisions: count("revision"),
        fields: count("op_field_epoch"),
        checkpoints: count("op_checkpoint"),
        submissions: count("op_submission"),
        integrated: count("op_integrated"),
      }).toEqual(before);
      expect(read(engine, { id: "of:rollback" })).toEqual({
        value: { body: "abc" },
      });
      expect(queryOperationField(engine, {
        id: "of:rollback",
        path: toValuePath(["body"]),
      })).toMatchObject({ active: false, cursor: null, operations: [] });
    } finally {
      close(engine);
      await Deno.remove(path);
    }
  });

  it("migrates integrated histories to stable operation ids", async () => {
    const path = await Deno.makeTempFile({ suffix: ".sqlite" });
    const url = toFileUrl(path);
    let engine: Awaited<ReturnType<typeof open>> | undefined;

    try {
      engine = await open({ url });
      applyCommit(engine, {
        sessionId: "session:setup",
        commit: {
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "set",
            id: "of:migration",
            value: { value: { body: "a" } },
          }],
        },
      });
      applyCommit(engine, {
        sessionId: "session:alice",
        commit: {
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "apply-op",
            id: "of:migration",
            path: toValuePath(["body"]),
            codec: CODEMIRROR_CHANGESET_CODEC,
            submissionId: "alice:1",
            base: null,
            baselineHash: operationBaselineHash("a"),
            payload: {
              updates: [{ clientId: "alice", changes: changes(1, 1, "b") }],
            },
          }],
        },
      });
      const originalId = queryOperationField(engine, {
        id: "of:migration",
        path: toValuePath(["body"]),
        after: { epoch: 1, version: 0 },
      }).operations[0].opId;
      close(engine);
      engine = undefined;

      const legacy = new Database(path);
      try {
        legacy.exec(`
          PRAGMA foreign_keys = OFF;
          ALTER TABLE op_integrated
            RENAME TO op_integrated_without_ids;
          CREATE TABLE op_integrated (
            branch         TEXT    NOT NULL DEFAULT '',
            id             TEXT    NOT NULL,
            scope_key      TEXT    NOT NULL DEFAULT 'space',
            path           JSON    NOT NULL,
            epoch          INTEGER NOT NULL,
            version        INTEGER NOT NULL,
            submission_id  TEXT    NOT NULL,
            payload        JSON    NOT NULL,
            commit_seq     INTEGER NOT NULL,
            PRIMARY KEY (branch, id, scope_key, path, epoch, version),
            FOREIGN KEY (commit_seq) REFERENCES "commit"(seq)
          );
          INSERT INTO op_integrated (
            branch, id, scope_key, path, epoch, version,
            submission_id, payload, commit_seq
          )
          SELECT branch, id, scope_key, path, epoch, version,
                 submission_id, payload, commit_seq
          FROM op_integrated_without_ids;
          DROP TABLE op_integrated_without_ids;
        `);
      } finally {
        legacy.close();
      }

      engine = await open({ url });
      const migrated = queryOperationField(engine, {
        id: "of:migration",
        path: toValuePath(["body"]),
        after: { epoch: 1, version: 0 },
      });
      expect(migrated.operations[0].opId).toBe(originalId);
      expect(
        (engine.database.prepare(`PRAGMA table_info("op_integrated")`)
          .all() as Array<{ name: string; notnull: number }>).find((column) =>
            column.name === "op_id"
          ),
      ).toMatchObject({ notnull: 1 });
    } finally {
      if (engine !== undefined) close(engine);
      await Deno.remove(path);
    }
  });
});
