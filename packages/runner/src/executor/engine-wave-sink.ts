// The co-hosted reference implementation of the wave commit sink
// (server-execution v2 stage D, serving-loop.md §3d): commits wave batches
// directly against the space's engine, on the same process the memory
// server runs in. This is the store half of plane (a)'s loopback path —
// the wave's ONE derived commit, its basis rows, and its per-doc
// re-verification all inside one engine transaction (`applyWaveCommit`) —
// with stage B's derived-class lease admission enforced by the engine
// itself. Stage F's SpaceServer wires this sink under the serving loop;
// until then tests drive it.
//
// Of stage D's three documented bounds, stage F discharged two and one
// remains:
// - DISCHARGED (stage F): foreign provisioning batches now apply WITH
//   protocol.md §2's delegated-identity admission row — the batch's
//   `delegated` carriage (originating chain actor + capabilityRef) rides
//   the commit metadata, admission validates completeness, and scoped
//   foreign writes key from the CARRIED identity. A foreign batch with
//   scoped ops and NO delegated carriage is still refused (commitWave
//   below) — that path would silently key from the sink's own principal,
//   the empty-instance trap, cross-space edition.
// - DISCHARGED (stage F): the seal handoff carries read-only spaces'
//   read sets (ITransactionSealSink.sealSpaceReads), and the
//   accumulator's withdrawn-read closure folds them by doc identity.
// - REMAINING (stage G): sqlite ops in wave batches need cell-db
//   attachments the effect channel owns; this sink passes none.

import type { Engine } from "@commonfabric/memory/v2/engine";
import {
  applyCommit,
  applyWaveCommit,
  selectDocHead,
  selectWritePathsSince,
  WaveCommitConflictError,
  WavePreconditionError,
} from "@commonfabric/memory/v2/engine";
import type { CellScope } from "@commonfabric/api";
import type { MemorySpace, Result } from "../storage/interface.ts";
import type {
  WaveCommitRejection,
  WaveCommitSink,
  WaveSpaceCommit,
} from "./wave.ts";

export class EngineWaveCommitSink implements WaveCommitSink {
  readonly #engineFor: (space: MemorySpace) => Engine;
  readonly #sessionId: string;
  readonly #principal: string | undefined;
  readonly #localSeq: { value: number };

  /**
   * Replay keying — the stage-F choice, made and enforced here: the
   * engine dedupes commits by UNIQUE (session_id, local_seq), returning
   * the STORED result for a byte-identical replay and throwing "commit
   * replay mismatch" for a different one. The SpaceServer holds ONE
   * long-lived counter per (space, process) — `localSeqRef`, owned by
   * the ExecutorHost, starting at 0 — and uses the DR1 HOLDER identity
   * as the `sessionId`, which is simultaneously what the
   * derived-envelope admission requires (protocol.md §2, RULED
   * 2026-08-05: the producing session must BE the holder's own service
   * session). Freshness is structural, not queried: the holder's
   * process-instance component makes a new process a NEW engine
   * session, so 0 never collides; a park/re-activate within one
   * process reuses the counter. (`selectMaxLocalSeq` remains the
   * flooring belt for a holder scheme WITHOUT a process component —
   * nothing in production uses one.) Tests that construct throwaway
   * sinks may omit `localSeqRef` and get a private counter from 0 —
   * sound for a fresh session id per test engine.
   */
  constructor(options: {
    /** The co-hosted engine per space (memory server's own engines). */
    engineFor: (space: MemorySpace) => Engine;
    /** The service session framing the wave's commits are recorded
     * under (replay detection keys on it — see the constructor doc).
     * The SpaceServer passes the DR1 holder identity. */
    sessionId: string;
    principal?: string;
    /** The shared, process-lifetime localSeq counter (see the
     * constructor doc). Mutated in place. */
    localSeqRef?: { value: number };
  }) {
    this.#engineFor = options.engineFor;
    this.#sessionId = options.sessionId;
    this.#principal = options.principal;
    this.#localSeq = options.localSeqRef ?? { value: 0 };
  }

  currentHeads(
    space: MemorySpace,
    docs: ReadonlyArray<{ id: string; scope?: CellScope; scopeKey: string }>,
  ): Promise<ReadonlyMap<string, number>> {
    const engine = this.#engineFor(space);
    const heads = new Map<string, number>();
    for (const doc of docs) {
      heads.set(
        `${doc.id} ${doc.scopeKey}`,
        selectDocHead(engine, { id: doc.id, scopeKey: doc.scopeKey }),
      );
    }
    return Promise.resolve(heads);
  }

  concurrentWritePaths(
    space: MemorySpace,
    doc: { id: string; scope?: CellScope; scopeKey: string },
    sinceSeq: number,
  ): Promise<ReadonlyArray<readonly string[]>> {
    return Promise.resolve(selectWritePathsSince(this.#engineFor(space), {
      id: doc.id,
      scopeKey: doc.scopeKey,
      sinceSeq,
    }));
  }

  commitWave(
    batch: WaveSpaceCommit,
  ): Promise<Result<{ seq: number }, WaveCommitRejection>> {
    const engine = this.#engineFor(batch.space);
    const commit = {
      localSeq: ++this.#localSeq.value,
      reads: { confirmed: [], pending: [] },
      operations: [...batch.operations],
      ...(batch.preconditions.length > 0
        ? { preconditions: [...batch.preconditions] }
        : {}),
    };
    try {
      if (!batch.home) {
        // Foreign provisioning commit (protocol.md §2b): authored-class
        // under the DELEGATED admission row — the batch's carried acting
        // identity + capabilityRef ride the commit metadata, admission
        // validates completeness, and scoped writes key from the CARRIED
        // identity. Idempotent by deterministic destination ids — no
        // wave-basis re-verification and no basis rows.
        //
        // A scoped write with NO delegated carriage is still REFUSED,
        // not silently mis-keyed: the plain path would key it from the
        // sink's own principal — the empty-instance trap, cross-space
        // edition (protocol.md §1, §2).
        if (batch.delegated === undefined) {
          for (const op of batch.operations) {
            if (
              op.op === "sqlite" || op.scope === undefined ||
              op.scope === "space"
            ) {
              continue;
            }
            return Promise.resolve({
              error: {
                name: "WaveCommitRejected",
                message: "scoped write in a foreign wave batch refused " +
                  `(op ${op.id}, scope "${op.scope}"): without delegated ` +
                  "carriage the row would silently key from the sink's " +
                  "own principal; scoped foreign admission requires the " +
                  "acting-identity + capabilityRef delegated row " +
                  "(protocol.md §2, §2b)",
              },
            });
          }
        }
        const applied = applyCommit(engine, {
          sessionId: this.#sessionId,
          space: batch.space,
          principal: this.#principal,
          commit,
          ...(batch.delegated === undefined
            ? {}
            : { delegated: batch.delegated }),
        });
        return Promise.resolve({ ok: { seq: applied.seq } });
      }
      const applied = applyWaveCommit(engine, {
        sessionId: this.#sessionId,
        space: batch.space,
        principal: this.#principal,
        commit,
        commitClass: "derived",
        holder: batch.holder,
        annotations: batch.annotations,
        consequenceOf: batch.consequenceOf,
        ...(batch.derivedThrough === undefined
          ? {}
          : { derivedThrough: batch.derivedThrough }),
        waveBasis: {
          basisSeq: batch.basisSeq,
          rebasedHeads: batch.rebasedHeads,
        },
        basisInstances: batch.basisInstances.map((instance) => ({
          action: instance.action,
          actionScopeKey: instance.actionScopeKey,
          rows: instance.rows.map((row) => ({
            entitySpace: row.entitySpace,
            entity: row.entity,
            entityScopeKey: row.entityScopeKey,
            seq: row.seq,
          })),
        })),
      });
      return Promise.resolve({ ok: { seq: applied.seq } });
    } catch (error) {
      if (error instanceof WaveCommitConflictError) {
        return Promise.resolve({
          error: {
            name: "WaveCommitRejected",
            message: error.message,
            conflictedDocs: error.conflictedDocs,
          },
        });
      }
      if (error instanceof WavePreconditionError) {
        return Promise.resolve({
          error: {
            name: "WaveCommitRejected",
            message: error.message,
            failedPreconditions: error.failedPreconditions,
          },
        });
      }
      return Promise.resolve({
        error: {
          name: "WaveCommitRejected",
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }
}
