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
// Three deliberate stage-D bounds, all assigned elsewhere in the plan:
// - foreign provisioning batches apply authored-class WITHOUT the acting
//   identity + capabilityRef admission row (protocol.md §2's
//   server-produced authored row) — that admission lands with the
//   provisioning relocation (stage F); the accumulator already carries
//   the annotations so the wiring is a sink change, not a re-plumb.
//   SCOPED ops in a foreign batch are REFUSED outright (commitWave
//   below): this plain applyCommit path drops the batch's annotations,
//   so a scoped foreign write would silently key from the sink's own
//   principal — the empty-instance trap, cross-space edition — and no
//   stage-D producer emits one (`.inSpace` provisioning is
//   space-scoped);
// - sqlite ops in wave batches need cell-db attachments the effect
//   channel owns (stage G); this sink passes none;
// - the accumulator's withdrawn-read closure sees only reads RECORDED
//   in sealed commits, and a tx seals only the spaces it WROTE (or
//   gated): a read in a space the run wrote nothing to — e.g. a
//   foreign read feeding a home-only write — never reaches the
//   accumulator, so a withdrawn writer in that space cannot fold the
//   reader in. Stage F's serving loop MUST NOT lean on read-only
//   cross-space layered reads folding into withdrawals until the seal
//   handoff carries read-only spaces' read sets.

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
  #localSeq = 0;

  /**
   * Replay keying, a caller obligation: the engine dedupes commits by
   * UNIQUE (session_id, local_seq) — returning the STORED result for a
   * byte-identical replay and throwing "commit replay mismatch" for a
   * different one — while `#localSeq` restarts at 0 per sink INSTANCE.
   * Reusing one `sessionId` across sink instances whose commits reach
   * the same engine therefore collides the second instance's early
   * localSeqs with the first's: an identical batch silently returns the
   * OLD commit's seq (stale, nothing applied), a different one throws.
   * Give every instance a distinct `sessionId` (e.g. suffix a
   * wave/process nonce) or hold ONE long-lived instance per service
   * session — stage F's SpaceServer owns that choice.
   */
  constructor(options: {
    /** The co-hosted engine per space (memory server's own engines). */
    engineFor: (space: MemorySpace) => Engine;
    /** The service session framing the wave's commits are recorded
     * under (replay detection keys on it — see the constructor doc). */
    sessionId: string;
    principal?: string;
  }) {
    this.#engineFor = options.engineFor;
    this.#sessionId = options.sessionId;
    this.#principal = options.principal;
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
      localSeq: ++this.#localSeq,
      reads: { confirmed: [], pending: [] },
      operations: [...batch.operations],
      ...(batch.preconditions.length > 0
        ? { preconditions: [...batch.preconditions] }
        : {}),
    };
    try {
      if (!batch.home) {
        // Foreign provisioning commit (protocol.md §2b): authored-class,
        // idempotent by deterministic destination ids — no wave-basis
        // re-verification and no basis rows.
        //
        // Scoped writes are REFUSED here, not silently mis-keyed: this
        // plain applyCommit path drops the batch's annotations, so a
        // scoped op would key from the sink's own principal/session —
        // the empty-instance trap, cross-space edition (protocol.md §1,
        // §2). No stage-D producer emits scoped foreign writes
        // (`.inSpace` provisioning is space-scoped); admitting one takes
        // the acting-identity + capabilityRef delegated-admission row,
        // which lands with stages F/G.
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
                `(op ${op.id}, scope "${op.scope}"): the stage-D sink ` +
                "applies foreign batches without identity annotations, " +
                "so the row would silently key from the sink's own " +
                "principal; foreign scoped admission needs the " +
                "stage-F/G delegated-admission carriage (protocol.md " +
                "§2, §2b)",
            },
          });
        }
        const applied = applyCommit(engine, {
          sessionId: this.#sessionId,
          space: batch.space,
          principal: this.#principal,
          commit,
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
