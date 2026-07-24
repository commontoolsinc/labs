import { assertEquals } from "@std/assert";
import type { ClientCommit, Operation } from "../v2.ts";
import { classifyCommitTelemetry } from "../v2/commit-telemetry.ts";

const commit = (
  operations: Operation[] = [],
  extra: Partial<ClientCommit> = {},
): ClientCommit => ({
  localSeq: 1,
  reads: { confirmed: [], pending: [] },
  operations,
  ...extra,
});

const semanticOperation: Operation = {
  op: "set",
  id: "of:telemetry-test",
  value: { value: "hello" },
};

const sqliteOperation: Operation = {
  op: "sqlite",
  db: { id: "of:telemetry-db" },
  sql: "CREATE TABLE example (value TEXT)",
};

Deno.test("classifies semantic memory transactions", () => {
  assertEquals(classifyCommitTelemetry(commit([semanticOperation])), {
    kind: "semantic",
    entityCount: 1,
    schedulerObservationCount: 0,
    sqliteOperationCount: 0,
  });
});

Deno.test("classifies scheduler-observation-only memory transactions", () => {
  assertEquals(
    classifyCommitTelemetry(commit([], { schedulerObservation: {} })),
    {
      kind: "scheduler_observation",
      entityCount: 0,
      schedulerObservationCount: 1,
      sqliteOperationCount: 0,
    },
  );

  assertEquals(
    classifyCommitTelemetry(commit([], {
      schedulerObservationBatch: [
        {
          localSeq: 2,
          reads: { confirmed: [], pending: [] },
          schedulerObservation: {},
        },
        {
          localSeq: 3,
          reads: { confirmed: [], pending: [] },
          schedulerObservation: {},
        },
      ],
    })),
    {
      kind: "scheduler_observation",
      entityCount: 0,
      schedulerObservationCount: 2,
      sqliteOperationCount: 0,
    },
  );
});

Deno.test("classifies SQLite-only and mixed memory transactions", () => {
  assertEquals(classifyCommitTelemetry(commit([sqliteOperation])), {
    kind: "sqlite",
    entityCount: 0,
    schedulerObservationCount: 0,
    sqliteOperationCount: 1,
  });

  assertEquals(
    classifyCommitTelemetry(
      commit([semanticOperation, sqliteOperation], {
        schedulerObservation: {},
      }),
    ),
    {
      kind: "mixed",
      entityCount: 1,
      schedulerObservationCount: 1,
      sqliteOperationCount: 1,
    },
  );
});

Deno.test("classifies precondition-only and invalid empty requests", () => {
  assertEquals(
    classifyCommitTelemetry(commit([], {
      preconditions: [{ kind: "entity-absent", id: "of:missing" }],
    })),
    {
      kind: "precondition",
      entityCount: 0,
      schedulerObservationCount: 0,
      sqliteOperationCount: 0,
    },
  );
  assertEquals(classifyCommitTelemetry(commit()), {
    kind: "empty",
    entityCount: 0,
    schedulerObservationCount: 0,
    sqliteOperationCount: 0,
  });
});
