// Read-only scheduler-persistence inspection.
//
// Scheduler state is optional and has multiple on-disk schema generations. In
// particular, rows written before execution-context qualification cannot be
// safely classified after the fact. This module therefore reports schema
// status explicitly and projects missing qualifier columns as null; it never
// infers that a legacy row belongs to the shared `space` context.

import type { Database } from "@db/sqlite";
import { schedulerExecutionContextSchemaCurrent } from "@commonfabric/memory/v2/engine";

import type { SpaceDb } from "./db.ts";

const SCHEDULER_TABLE_REQUIREMENTS = {
  scheduler_observation: ["execution_context_key"],
  scheduler_action_snapshot: ["execution_context_key"],
  scheduler_action_state: ["execution_context_key"],
  scheduler_read_index: ["execution_context_key", "read_scope_key"],
  scheduler_write_index: ["execution_context_key", "write_scope_key"],
} as const;

type SchedulerTableName = keyof typeof SCHEDULER_TABLE_REQUIREMENTS;

export type SchedulerSchemaStatus =
  | "absent"
  | "legacy-unclassified"
  | "partial"
  | "context-qualified";

export interface SchedulerTableSchema {
  present: boolean;
  /** Required W0.1 qualifier columns physically present in this table. */
  qualifierColumns: Record<string, boolean>;
}

export interface SchedulerObservationDetail {
  observation_id: number;
  branch: string;
  commit_seq: number | null;
  observed_at_seq: number;
  session_id: string | null;
  local_seq: number | null;
  piece_id: string;
  process_generation: number;
  action_id: string;
  /** Raw persisted value. Null means absent/unclassified, not `space`. */
  execution_context_key: string | null;
}

export interface SchedulerActionSnapshotDetail {
  branch: string;
  owner_space: string;
  piece_id: string;
  process_generation: number;
  action_id: string;
  execution_context_key: string | null;
  observation_id: number;
  commit_seq: number | null;
  observed_at_seq: number;
}

export interface SchedulerActionStateDetail {
  branch: string;
  owner_space: string;
  piece_id: string;
  process_generation: number;
  action_id: string;
  execution_context_key: string | null;
  latest_observation_id: number | null;
  direct_dirty_seq: number | null;
  stale_seq: number | null;
  unknown_reason: string | null;
}

export interface SchedulerReadIndexDetail {
  branch: string;
  owner_space: string | null;
  read_space: string;
  read_id: string;
  /** Declared scope class retained for diagnostics. */
  read_scope: string;
  /** Raw resolved effective target key. Null is legacy/unclassified. */
  read_scope_key: string | null;
  read_path: string;
  read_kind: string;
  piece_id: string;
  process_generation: number;
  action_id: string;
  execution_context_key: string | null;
  observation_id: number;
}

export interface SchedulerWriteIndexDetail {
  branch: string;
  owner_space: string;
  write_space: string;
  write_id: string;
  /** Declared scope class retained for diagnostics. */
  write_scope: string;
  /** Raw resolved effective target key. Null is legacy/unclassified. */
  write_scope_key: string | null;
  write_path: string;
  write_kind: string;
  piece_id: string;
  process_generation: number;
  action_id: string;
  execution_context_key: string | null;
  observation_id: number;
}

export interface SchedulerDetails {
  schemaStatus: SchedulerSchemaStatus;
  schema: Record<SchedulerTableName, SchedulerTableSchema>;
  observations: SchedulerObservationDetail[];
  snapshots: SchedulerActionSnapshotDetail[];
  actionState: SchedulerActionStateDetail[];
  reads: SchedulerReadIndexDetail[];
  writes: SchedulerWriteIndexDetail[];
}

export interface SchedulerDetailOptions {
  branch?: string;
  pieceId?: string;
  processGeneration?: number;
  actionId?: string;
  /** Per-table row cap. Defaults to 200. */
  limit?: number;
}

function tableColumns(db: Database, table: SchedulerTableName): Set<string> {
  return new Set(
    db.prepare("SELECT name FROM pragma_table_info(?)")
      .all<{ name: string }>(table)
      .map((row) => row.name),
  );
}

/** Classify the scheduler schema without assigning meaning to legacy rows. */
export function schedulerSchema(
  db: Database,
): {
  status: SchedulerSchemaStatus;
  tables: Record<SchedulerTableName, SchedulerTableSchema>;
} {
  const entries = Object.entries(SCHEDULER_TABLE_REQUIREMENTS).map(
    ([name, requirements]) => {
      const table = name as SchedulerTableName;
      const columns = tableColumns(db, table);
      const present = columns.size > 0;
      return [
        table,
        {
          present,
          qualifierColumns: Object.fromEntries(
            requirements.map((column) => [column, columns.has(column)]),
          ),
        },
      ] as const;
    },
  );
  const tables = Object.fromEntries(entries) as Record<
    SchedulerTableName,
    SchedulerTableSchema
  >;
  const presentCount = entries.filter(([, schema]) => schema.present).length;
  const qualifierValues = entries.flatMap(([, schema]) =>
    Object.values(schema.qualifierColumns)
  );

  let status: SchedulerSchemaStatus;
  if (presentCount === 0) {
    status = "absent";
  } else if (
    presentCount === entries.length && qualifierValues.every((value) => !value)
  ) {
    status = "legacy-unclassified";
  } else if (
    presentCount === entries.length && qualifierValues.every(Boolean) &&
    schedulerExecutionContextSchemaCurrent(db)
  ) {
    status = "context-qualified";
  } else {
    status = "partial";
  }

  return { status, tables };
}

function projectedColumn(columns: Set<string>, column: string): string {
  return columns.has(column) ? column : `NULL AS ${column}`;
}

function readTable<T extends object>(
  db: Database,
  table: SchedulerTableName,
  requiredColumns: readonly string[],
  optionalColumns: readonly string[],
  orderBy: string,
  options: SchedulerDetailOptions,
): T[] {
  const columns = tableColumns(db, table);
  if (columns.size === 0) return [];

  // The fields used here are fixed schema identifiers, never caller input.
  const select = [
    ...requiredColumns,
    ...optionalColumns.map((column) => projectedColumn(columns, column)),
  ].join(", ");
  const predicates: string[] = [];
  const params: Array<string | number> = [];
  const addFilter = (column: string, value: string | number | undefined) => {
    if (value === undefined || !columns.has(column)) return;
    predicates.push(`${column} = ?`);
    params.push(value);
  };
  addFilter("branch", options.branch);
  addFilter("piece_id", options.pieceId);
  addFilter("process_generation", options.processGeneration);
  addFilter("action_id", options.actionId);
  const where = predicates.length > 0
    ? `WHERE ${predicates.join(" AND ")}`
    : "";
  const limit = Math.max(0, Math.trunc(options.limit ?? 200));
  return db.prepare(
    `SELECT ${select} FROM ${table} ${where} ORDER BY ${orderBy} LIMIT ?`,
  ).all<T>(...params, limit);
}

/**
 * Inspect active scheduler ownership and target indexes as stored.
 *
 * This API is intentionally read-only and literal. Missing W0.1 columns are
 * returned as null and accompanied by a non-qualified schema status, so a
 * caller cannot accidentally present a legacy row as shared space state.
 */
export function schedulerDetails(
  space: SpaceDb,
  options: SchedulerDetailOptions = {},
): SchedulerDetails {
  const { status, tables } = schedulerSchema(space.db);
  return {
    schemaStatus: status,
    schema: tables,
    observations: readTable<SchedulerObservationDetail>(
      space.db,
      "scheduler_observation",
      [
        "observation_id",
        "branch",
        "commit_seq",
        "observed_at_seq",
        "session_id",
        "local_seq",
        "piece_id",
        "process_generation",
        "action_id",
      ],
      ["execution_context_key"],
      "observation_id",
      options,
    ),
    snapshots: readTable<SchedulerActionSnapshotDetail>(
      space.db,
      "scheduler_action_snapshot",
      [
        "branch",
        "owner_space",
        "piece_id",
        "process_generation",
        "action_id",
        "observation_id",
        "commit_seq",
        "observed_at_seq",
      ],
      ["execution_context_key"],
      "branch, owner_space, piece_id, process_generation, action_id, execution_context_key",
      options,
    ),
    actionState: readTable<SchedulerActionStateDetail>(
      space.db,
      "scheduler_action_state",
      [
        "branch",
        "owner_space",
        "piece_id",
        "process_generation",
        "action_id",
        "latest_observation_id",
        "direct_dirty_seq",
        "stale_seq",
        "unknown_reason",
      ],
      ["execution_context_key"],
      "branch, owner_space, piece_id, process_generation, action_id, execution_context_key",
      options,
    ),
    reads: readTable<SchedulerReadIndexDetail>(
      space.db,
      "scheduler_read_index",
      [
        "branch",
        "owner_space",
        "read_space",
        "read_id",
        "read_scope",
        "read_path",
        "read_kind",
        "piece_id",
        "process_generation",
        "action_id",
        "observation_id",
      ],
      ["execution_context_key", "read_scope_key"],
      "branch, owner_space, piece_id, process_generation, action_id, execution_context_key, read_space, read_id, read_scope_key, read_path",
      options,
    ),
    writes: readTable<SchedulerWriteIndexDetail>(
      space.db,
      "scheduler_write_index",
      [
        "branch",
        "owner_space",
        "write_space",
        "write_id",
        "write_scope",
        "write_path",
        "write_kind",
        "piece_id",
        "process_generation",
        "action_id",
        "observation_id",
      ],
      ["execution_context_key", "write_scope_key"],
      "branch, owner_space, piece_id, process_generation, action_id, execution_context_key, write_space, write_id, write_scope_key, write_path",
      options,
    ),
  };
}
