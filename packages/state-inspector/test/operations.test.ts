import { Database } from "@db/sqlite";
import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { toFileUrl } from "@std/path";
import {
  applyCommit,
  close,
  open,
  pruneOperationFieldHistory,
} from "@commonfabric/memory/v2/engine";
import {
  CODEMIRROR_CHANGESET_CODEC,
  encodeMemoryBoundary,
  toValuePath,
} from "@commonfabric/memory/v2";
import { operationBaselineHash } from "@commonfabric/memory/v2/operation-codec";

import { openSpace } from "../db.ts";
import { inspectOperationFields } from "../operations.ts";

const append = (length: number, value: string) => [length, [0, value]];

describe("operation field inspection", () => {
  it("reports retained history and detects checkpoint corruption", async () => {
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
            id: "of:inspected",
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
            id: "of:inspected",
            path: toValuePath(["body"]),
            codec: CODEMIRROR_CHANGESET_CODEC,
            submissionId: "alice:1",
            base: null,
            baselineHash: operationBaselineHash("a"),
            payload: {
              updates: [{ clientId: "alice", changes: append(1, "b") }],
            },
          }],
        },
      });
      applyCommit(engine, {
        sessionId: "session:bob",
        commit: {
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "apply-op",
            id: "of:inspected",
            path: toValuePath(["body"]),
            codec: CODEMIRROR_CHANGESET_CODEC,
            submissionId: "bob:1",
            base: { epoch: 1, version: 1 },
            payload: {
              updates: [{ clientId: "bob", changes: append(2, "c") }],
            },
          }],
        },
      });
      pruneOperationFieldHistory(engine, {
        id: "of:inspected",
        path: toValuePath(["body"]),
      });
    } finally {
      close(engine);
    }

    try {
      const space = openSpace(path);
      try {
        const report = inspectOperationFields(space, { id: "of:inspected" });
        expect(report).toMatchObject({
          available: true,
          fieldsTruncated: false,
          fields: [{
            address: {
              branch: "",
              id: "of:inspected",
              scope: "space",
              path: ["body"],
              pathPointer: "/body",
            },
            active: true,
            codec: CODEMIRROR_CHANGESET_CODEC,
            cursor: { epoch: 1, version: 2 },
            materialized: "abc",
            retainedFrom: { epoch: 1, version: 2 },
            submissions: [{ submissionId: "alice:1" }, {
              submissionId: "bob:1",
            }],
            integrated: [],
            checkpoints: [{ version: 0 }, {
              version: 2,
              matchesCurrentHead: true,
            }],
            consistency: {
              baselineCheckpointPresent: true,
              retainedSuffixContiguous: true,
              ordinaryMaterializedMatches: true,
              currentCheckpointMatches: true,
              healthy: true,
            },
          }],
        });
      } finally {
        space.close();
      }

      const database = new Database(path);
      try {
        database.prepare(`
          UPDATE op_checkpoint SET materialized = ?
          WHERE id = 'of:inspected' AND epoch = 1 AND version = 2
        `).run(encodeMemoryBoundary("corrupt"));
      } finally {
        database.close();
      }
      const corrupted = openSpace(path);
      try {
        expect(inspectOperationFields(corrupted).fields[0].consistency)
          .toMatchObject({
            currentCheckpointMatches: false,
            healthy: false,
          });
      } finally {
        corrupted.close();
      }
    } finally {
      await Deno.remove(path);
    }
  });
});
