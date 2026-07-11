import { assertEquals } from "@std/assert";
import { Database } from "@db/sqlite";

import { openSpace } from "../db.ts";
import { schedulerDetails } from "../scheduler.ts";

const BASE_SCHEMA = `
CREATE TABLE revision (
  branch TEXT NOT NULL DEFAULT '', id TEXT NOT NULL,
  scope_key TEXT NOT NULL DEFAULT 'space', seq INTEGER NOT NULL,
  op_index INTEGER NOT NULL, op TEXT NOT NULL, data JSON, commit_seq INTEGER NOT NULL
);
`;

const LEGACY_SCHEDULER_SCHEMA = `
CREATE TABLE scheduler_observation (
  observation_id INTEGER NOT NULL PRIMARY KEY,
  branch TEXT NOT NULL DEFAULT '', commit_seq INTEGER, observed_at_seq INTEGER NOT NULL,
  session_id TEXT, local_seq INTEGER, piece_id TEXT NOT NULL, action_id TEXT NOT NULL,
  process_generation INTEGER NOT NULL, payload JSON NOT NULL
);
CREATE TABLE scheduler_action_snapshot (
  branch TEXT NOT NULL DEFAULT '', owner_space TEXT NOT NULL,
  piece_id TEXT NOT NULL, process_generation INTEGER NOT NULL, action_id TEXT NOT NULL,
  observation_id INTEGER NOT NULL, commit_seq INTEGER, observed_at_seq INTEGER NOT NULL,
  payload JSON NOT NULL
);
CREATE TABLE scheduler_action_state (
  branch TEXT NOT NULL DEFAULT '', owner_space TEXT NOT NULL,
  piece_id TEXT NOT NULL, process_generation INTEGER NOT NULL, action_id TEXT NOT NULL,
  latest_observation_id INTEGER, direct_dirty_seq INTEGER, stale_seq INTEGER,
  unknown_reason TEXT
);
CREATE TABLE scheduler_read_index (
  branch TEXT NOT NULL DEFAULT '', owner_space TEXT,
  read_space TEXT NOT NULL, read_id TEXT NOT NULL, read_scope TEXT NOT NULL,
  read_path JSON NOT NULL, read_kind TEXT NOT NULL,
  piece_id TEXT NOT NULL, process_generation INTEGER NOT NULL, action_id TEXT NOT NULL,
  observation_id INTEGER NOT NULL
);
CREATE TABLE scheduler_write_index (
  branch TEXT NOT NULL DEFAULT '', owner_space TEXT NOT NULL,
  write_space TEXT NOT NULL, write_id TEXT NOT NULL, write_scope TEXT NOT NULL,
  write_path JSON NOT NULL, write_kind TEXT NOT NULL,
  piece_id TEXT NOT NULL, process_generation INTEGER NOT NULL, action_id TEXT NOT NULL,
  observation_id INTEGER NOT NULL
);
`;

const QUALIFIER_ALTERS = `
ALTER TABLE scheduler_observation ADD COLUMN execution_context_key TEXT;
ALTER TABLE scheduler_action_snapshot ADD COLUMN execution_context_key TEXT;
ALTER TABLE scheduler_action_state ADD COLUMN execution_context_key TEXT;
ALTER TABLE scheduler_read_index ADD COLUMN execution_context_key TEXT;
ALTER TABLE scheduler_read_index ADD COLUMN read_scope_key TEXT;
ALTER TABLE scheduler_write_index ADD COLUMN execution_context_key TEXT;
ALTER TABLE scheduler_write_index ADD COLUMN write_scope_key TEXT;
`;

function seedSchedulerRows(db: Database, context?: string): void {
  const contextColumns = context === undefined ? "" : ", execution_context_key";
  const contextPlaceholder = context === undefined ? "" : ", ?";
  const contextArgs = context === undefined ? [] : [context];
  db.prepare(
    `INSERT INTO scheduler_observation (
       observation_id, observed_at_seq, session_id, local_seq,
       piece_id, action_id, process_generation, payload${contextColumns}
     ) VALUES (1, 7, 'transport-session', 4, 'piece', 'action', 2, '{}'
       ${contextPlaceholder})`,
  ).run(...contextArgs);
  db.prepare(
    `INSERT INTO scheduler_action_snapshot (
       owner_space, piece_id, process_generation, action_id,
       observation_id, observed_at_seq, payload${contextColumns}
     ) VALUES ('did:key:space', 'piece', 2, 'action', 1, 7, '{}'
       ${contextPlaceholder})`,
  ).run(...contextArgs);
  db.prepare(
    `INSERT INTO scheduler_action_state (
       owner_space, piece_id, process_generation, action_id,
       latest_observation_id${contextColumns}
     ) VALUES ('did:key:space', 'piece', 2, 'action', 1${contextPlaceholder})`,
  ).run(...contextArgs);

  const readQualifierColumns = context === undefined
    ? ""
    : ", execution_context_key, read_scope_key";
  const readQualifierValues = context === undefined ? "" : ", ?, ?";
  db.prepare(
    `INSERT INTO scheduler_read_index (
       owner_space, read_space, read_id, read_scope, read_path, read_kind,
       piece_id, process_generation, action_id, observation_id${readQualifierColumns}
     ) VALUES (
       'did:key:space', 'did:key:space', 'read', 'user', '[]', 'value',
       'piece', 2, 'action', 1${readQualifierValues}
     )`,
  ).run(...(context === undefined ? [] : [context, context]));

  const writeQualifierColumns = context === undefined
    ? ""
    : ", execution_context_key, write_scope_key";
  const writeQualifierValues = context === undefined ? "" : ", ?, ?";
  db.prepare(
    `INSERT INTO scheduler_write_index (
       owner_space, write_space, write_id, write_scope, write_path, write_kind,
       piece_id, process_generation, action_id, observation_id${writeQualifierColumns}
     ) VALUES (
       'did:key:space', 'did:key:space', 'write', 'user', '[]', 'value',
       'piece', 2, 'action', 1${writeQualifierValues}
     )`,
  ).run(...(context === undefined ? [] : [context, context]));
}

async function withDb(
  setup: (db: Database) => void,
  inspect: (path: string) => void,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "state-inspector-scheduler-" });
  const path = `${dir}/space.sqlite`;
  try {
    const db = new Database(path, { create: true });
    try {
      db.exec(BASE_SCHEMA);
      setup(db);
    } finally {
      db.close();
    }
    inspect(path);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("scheduler details: absent persistence is reported explicitly", async () => {
  await withDb(
    () => {},
    (path) => {
      const space = openSpace(path);
      try {
        const details = schedulerDetails(space);
        assertEquals(details.schemaStatus, "absent");
        assertEquals(details.observations, []);
        assertEquals(details.snapshots, []);
        assertEquals(details.actionState, []);
        assertEquals(details.reads, []);
        assertEquals(details.writes, []);
      } finally {
        space.close();
      }
    },
  );
});

Deno.test("scheduler details: legacy rows remain unclassified", async () => {
  await withDb(
    (db) => {
      db.exec(LEGACY_SCHEDULER_SCHEMA);
      seedSchedulerRows(db);
    },
    (path) => {
      const space = openSpace(path);
      try {
        const details = schedulerDetails(space);
        assertEquals(details.schemaStatus, "legacy-unclassified");
        // A declared space/user scope is not evidence for action ownership or
        // an effective target scope. Missing columns stay null, never `space`.
        assertEquals(details.observations[0].execution_context_key, null);
        assertEquals(details.snapshots[0].execution_context_key, null);
        assertEquals(details.actionState[0].execution_context_key, null);
        assertEquals(details.reads[0].read_scope, "user");
        assertEquals(details.reads[0].execution_context_key, null);
        assertEquals(details.reads[0].read_scope_key, null);
        assertEquals(details.writes[0].write_scope, "user");
        assertEquals(details.writes[0].execution_context_key, null);
        assertEquals(details.writes[0].write_scope_key, null);
      } finally {
        space.close();
      }
    },
  );
});

Deno.test("scheduler details: mixed qualifier schema is partial", async () => {
  await withDb(
    (db) => {
      db.exec(LEGACY_SCHEDULER_SCHEMA);
      db.exec(
        "ALTER TABLE scheduler_observation ADD COLUMN execution_context_key TEXT",
      );
    },
    (path) => {
      const space = openSpace(path);
      try {
        const details = schedulerDetails(space);
        assertEquals(details.schemaStatus, "partial");
        assertEquals(
          details.schema.scheduler_observation.qualifierColumns
            .execution_context_key,
          true,
        );
        assertEquals(
          details.schema.scheduler_read_index.qualifierColumns.read_scope_key,
          false,
        );
      } finally {
        space.close();
      }
    },
  );
});

Deno.test("scheduler details: context-qualified rows expose raw keys", async () => {
  const context = "user:did%3Akey%3Aalice";
  await withDb(
    (db) => {
      db.exec(LEGACY_SCHEDULER_SCHEMA);
      db.exec(QUALIFIER_ALTERS);
      seedSchedulerRows(db, context);
    },
    (path) => {
      const space = openSpace(path);
      try {
        const details = schedulerDetails(space, {
          branch: "",
          pieceId: "piece",
          processGeneration: 2,
          actionId: "action",
        });
        assertEquals(details.schemaStatus, "context-qualified");
        assertEquals(details.observations[0].execution_context_key, context);
        assertEquals(details.snapshots[0].execution_context_key, context);
        assertEquals(details.actionState[0].execution_context_key, context);
        assertEquals(details.reads[0].execution_context_key, context);
        assertEquals(details.reads[0].read_scope_key, context);
        assertEquals(details.writes[0].execution_context_key, context);
        assertEquals(details.writes[0].write_scope_key, context);
      } finally {
        space.close();
      }
    },
  );
});
