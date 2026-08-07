// The durable half of the server-execution v2 outbox
// (docs/specs/server-side-execution/serving-loop.md §5, FP1 RULED
// 2026-08-03): cross-space event appends are engine-table rows written
// INSIDE the emitting wave's own store transaction — the basis-row
// carriage pattern, sanctioned in protocol.md §7 — and DELETED on
// delivery-ack: a queue that empties, never history, so the
// no-per-run-persistence lesson holds. A row carries the event (payload
// bounded by the event, never graph-scaled) plus the acting identity
// (`actingPrincipal` + `actingSession`) + `capabilityRef` that the
// target's admission validates and stamps `firedAt` from — actor
// inheritance crosses spaces through exactly this carriage (events.md
// §2, LT5: the delivery commit's ENVELOPE is the producing server's
// service identity; admissibility comes from the validated grant, never
// the envelope).
//
// Split of duties: the INSERT half is invoked by `applyWaveCommit`
// inside the wave's transaction (never its own commit); the SELECT and
// DELETE halves are the serving loop's outbox — re-send on activation
// (serving-loop.md §6 step 5) and retirement on delivery-ack are
// direct engine-table writes on the direct-engine plane (serving-loop.md
// §1 plane (c)). The EFFECT half of the outbox is process-local by
// design and never touches this table (serving-loop.md §4's FORBIDDEN
// "pending effects" table: on crash, missing effect results are
// re-missed from memo keys).
//
// The crash discipline the row order carries (the spec model's C2/FP1
// closure — no lost cross-space appends on any crash schedule): a row is
// deleted only AFTER the target's admission processed the entry. A crash
// between admit and delete re-sends the row; the duplicate dedupes at the
// target's `eventId` horizon (events.md §4 — uniqueness applies ONLY
// above the stream's `eventWatermark`; an at-or-below duplicate admits
// and is skipped at processing time).

import type { Engine } from "./engine.ts";

/** One durable outbound append row (serving-loop.md §5, FP1). */
export type OutboxAppendRow = {
  targetSpace: string;
  /** The target stream doc id (events.md §1: an event is an authored
   * append to a stream document). */
  targetStream: string;
  /** The client-durable event id (events.md §1); the target's dedupe
   * horizon keys on it. */
  eventId: string;
  /** The event payload, JSON — bounded by the event, never
   * graph-scaled (protocol.md §7's metadata discipline applies to the
   * carried event too). */
  payload: unknown;
  /** The ORIGINATING chain actor (events.md §2): absent only for a
   * chain with no acting user (a space-scope derivation's emission). */
  actingPrincipal?: string;
  actingSession?: string;
  /** The capability grant the target's admission validates —
   * delegation, never session-identity impersonation (protocol.md §2's
   * server-produced authored row). */
  capabilityRef: string;
};

/** A pending row as read back for delivery: the stored fields plus the
 * rowid handle that `deleteExecutionOutboxRow` retires. */
export type PendingOutboxRow = OutboxAppendRow & {
  rowId: number;
  /** The emitting wave's commit seq (FIFO per source wave → target
   * stream rides rowid order; the seq is recorded for diagnostics). */
  createdSeq: number;
};

const INSERT_ROW = `
INSERT INTO execution_outbox (
  branch, target_space, target_stream, event_id, payload,
  acting_principal, acting_session, capability_ref, created_seq
)
VALUES (
  :branch, :target_space, :target_stream, :event_id, :payload,
  :acting_principal, :acting_session, :capability_ref, :created_seq
)
`;

/**
 * Insert one wave's outbound append rows. MUST be called inside the
 * wave's own store transaction (`applyWaveCommit` is the one production
 * caller) — the FP1 carriage rule: the rows land atomically with the
 * wave commit, so a crash either has both (rows re-sent, deduped at the
 * target) or neither (the wave never happened; the event replays and
 * re-emits).
 */
export const insertExecutionOutboxRows = (
  engine: Engine,
  options: {
    branch: string;
    createdSeq: number;
    rows: readonly OutboxAppendRow[];
  },
): void => {
  if (options.rows.length === 0) return;
  const insert = engine.database.prepare(INSERT_ROW);
  for (const row of options.rows) {
    insert.run({
      branch: options.branch,
      target_space: row.targetSpace,
      target_stream: row.targetStream,
      event_id: row.eventId,
      payload: JSON.stringify(row.payload ?? null),
      acting_principal: row.actingPrincipal ?? null,
      acting_session: row.actingSession ?? null,
      capability_ref: row.capabilityRef,
      created_seq: options.createdSeq,
    });
  }
};

/**
 * Every undelivered row, in insertion (rowid) order — FIFO per
 * (source wave → target stream) as serving-loop.md §2b requires. The
 * serving loop reads this at activation (§6 step 5's re-send) and after
 * any wave that carried appends.
 */
export const selectPendingExecutionOutboxRows = (
  engine: Engine,
  options: { branch: string },
): PendingOutboxRow[] => {
  const rows = engine.database.prepare(`
SELECT rowid AS row_id, target_space, target_stream, event_id, payload,
       acting_principal, acting_session, capability_ref, created_seq
FROM execution_outbox
WHERE branch = :branch
ORDER BY rowid ASC
`).all({ branch: options.branch }) as Array<{
    row_id: number;
    target_space: string;
    target_stream: string;
    event_id: string;
    payload: string;
    acting_principal: string | null;
    acting_session: string | null;
    capability_ref: string;
    created_seq: number;
  }>;
  return rows.map((row) => ({
    rowId: row.row_id,
    targetSpace: row.target_space,
    targetStream: row.target_stream,
    eventId: row.event_id,
    payload: JSON.parse(row.payload),
    ...(row.acting_principal === null
      ? {}
      : { actingPrincipal: row.acting_principal }),
    ...(row.acting_session === null
      ? {}
      : { actingSession: row.acting_session }),
    capabilityRef: row.capability_ref,
    createdSeq: row.created_seq,
  }));
};

/**
 * Delivery-ack retirement (FP1): delete one delivered row. Called only
 * AFTER the target's admission processed the entry (accepted or deduped
 * at the eventId horizon) — never before, or a crash between delete and
 * admit would lose the append. A direct engine-table write on the
 * direct-engine plane (serving-loop.md §1 plane (c)).
 */
export const deleteExecutionOutboxRow = (
  engine: Engine,
  rowId: number,
): void => {
  engine.database.prepare(`DELETE FROM execution_outbox WHERE rowid = :rowid`)
    .run({ rowid: rowId });
};
