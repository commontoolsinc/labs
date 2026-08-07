// The client speculation overlay (server-execution v2 Phase 2;
// speculation.md is normative). Under EXPERIMENTAL_SERVER_EXECUTION a
// NON-serving runtime — every client, and any server-side utility
// runtime that is not the space's SpaceServer — loses its
// derivation-commit path BY CONSTRUCTION: the runtime's default seal
// destination is this overlay, so a stamped derivation-kind run's
// writes are REDIRECTED into the replica's optimistic pending layer
// (`sealNative` with a speculation verdict) instead of a storage
// commit. There is no client code path from a derivation run to the
// wire, and none that could construct a `derived`-class commit
// (protocol.md §1's FORBIDDEN clause holds structurally).
//
// What stays on today's commit path, exactly (the plan's Phase 2
// interim postures row):
// - event-handler runs — client HANDLER writes stay authored-class
//   until Phase 3 lands events-down (F10, protocol.md §1);
// - bookkeeping runs (the client-side pattern swap's pointer write is
//   an ordinary authored input);
// - UNSTAMPED transactions — UI-binding writes and imperative edits
//   are state authorship under existing ACL + CAS (README §3.6), and
//   they never pass through the scheduler's stamping choke points.
//
// The overlay is process-memory only (speculation.md §1): entries are
// never serialized, never synced, never committed, and they stay OUT
// of the client's `synced()` durability barrier. Reads see them
// through the replica's ordinary pending materialization, so rendering
// and downstream speculation read one code path. Reconciliation
// (speculation.md §4) is watermark-driven: when the space's replicated
// watermark doc covers an entry's read basis — and no unpromoted
// authored origin still underlies it (the "acked AND W ≥ seq" rule,
// evaluated on replica state) — the entry retires via a
// SUCCESS-shaped withdrawal (`superseded`), the authoritative value
// replaces the echo in the same render path, and nothing cascades.
//
// Post-commit effects of a speculative run follow the egress rule
// (README §1): "speculate on anything you can throw away; never on
// anything you can't take back." Reversible, client-enacted effects —
// exactly the `navigateTo` kind today (optimistic enactment,
// speculation.md §2) — still flush; every other kind (external-sink
// egress, sqlite issue) is OWNED AND DROPPED, so an effectful builtin
// reached by speculation renders its pending state and reads through
// to the last committed result while only the server performs egress
// (README §3.5).

import { getLogger } from "@commonfabric/utils/logger";
import type { CellScope } from "@commonfabric/memory/v2";
import type { Runtime, ServerRunInfo } from "../runtime.ts";
import type {
  IExtendedStorageTransaction,
  IStorageTransaction,
  ITransactionSealSink,
  MemorySpace,
  NativeStorageCommit,
  Result,
  SealedCommitVerdict,
  TransactionSealDestination,
  Unit,
  URI,
} from "../storage/interface.ts";
import type { CommitError } from "../storage/interface.ts";
import type { PostCommitSideEffect } from "../cfc/types.ts";
import { watermarkCell } from "../executor/watermark.ts";

const logger = getLogger("speculation-overlay", {
  enabled: true,
  level: "warn",
});

/**
 * The client-side run stamp (the speculation twin of the wave run
 * context). Kept in its OWN WeakMap so `waveRunContextOf` remains a
 * server-only signal: builtins and tests that ask "am I a served run?"
 * must not start seeing client speculation runs as served.
 */
const speculationRunContexts = new WeakMap<object, ServerRunInfo>();

export const stampSpeculationRunContext = (
  tx: IExtendedStorageTransaction,
  info: ServerRunInfo,
): void => {
  speculationRunContexts.set(tx, info);
};

export const speculationRunContextOf = (
  tx: IExtendedStorageTransaction,
): ServerRunInfo | undefined => speculationRunContexts.get(tx);

/** The one effect kind a speculative run may still enact: reversible,
 * client-enacted navigation (speculation.md §2's optimistic navigate;
 * protocol.md §5 owns the eventual nonce channel). Every other kind is
 * dropped under speculation — a NEW reversible kind must be added here
 * deliberately, with its spec edit (protocol.md §5's FORBIDDEN list),
 * never by default. */
const SPECULATION_ENACTABLE_EFFECT_KINDS = new Set(["navigateTo"]);

type OverlayEntry = {
  space: MemorySpace;
  localSeq: number;
  resolveVerdict: (verdict: SealedCommitVerdict) => void;
  /** The highest confirmed store seq this run's reads sat on — the
   * watermark threshold at which the authoritative derivation covers
   * everything this speculation consumed. */
  confirmedFloor: number;
  /** Docs this run read through PENDING (unpromoted) layers: unacked
   * authored origins (the user mid-typing), parked promotions, or
   * earlier speculation entries. The entry stays alive while any
   * UNACKED pending layer BELOW it remains on one of these docs
   * (speculation.md §4 step 3's keep-the-live-echo rule — an ACKED
   * layer whose promotion is merely parked no longer blocks: the wave
   * consumed the origin, so the authoritative coverage is real). */
  pendingReadDocs: Array<{ id: URI; scope?: CellScope }>;
  /** The localSeqs of the pending layers this run read through — its
   * ORIGINS. Retirement needs each origin ACKED with `W >= ackSeq`
   * (speculation.md §4 step 3); an origin that never acks (a retired
   * lower speculation, a rejected input) contributes no floor — the
   * store won upstream and the confirmed basis governs. */
  originLocalSeqs: number[];
  /** Resolves when the entry's verdict has been APPLIED (pending
   * dropped). Retirement chains a re-sweep on it: a chained entry
   * blocked on this one unblocks only after the drop, which is async
   * relative to the verdict — and on a quiet space no further
   * watermark event would re-sweep. */
  settled: Promise<unknown>;
};

/**
 * The overlay destination: one per non-serving Runtime under the flag,
 * created lazily by `Runtime.edit()` and consulted for every
 * transaction the runtime mints while no wave destination is installed.
 */
export class SpeculationOverlayDestination
  implements TransactionSealDestination {
  readonly #runtime: Runtime;
  /** space -> localSeq -> entry. */
  readonly #entries = new Map<MemorySpace, Map<number, OverlayEntry>>();
  /** space -> cancel fn for the watermark-doc sink driving retirement. */
  readonly #watermarkSinks = new Map<MemorySpace, () => void>();
  /** space -> last observed watermark (for registration-time sweeps). */
  readonly #watermarks = new Map<MemorySpace, number>();
  #closed = false;

  constructor(runtime: Runtime) {
    this.#runtime = runtime;
  }

  /** DIAGNOSTIC (tests): live overlay entries for a space. */
  entryCount(space: MemorySpace): number {
    return this.#entries.get(space)?.size ?? 0;
  }

  seal(tx: IExtendedStorageTransaction): Promise<Result<Unit, CommitError>> {
    const kind = speculationRunContextOf(tx)?.kind;
    if (kind !== "derivation") {
      // Handler runs (authored until Phase 3 — F10), bookkeeping runs,
      // and unstamped transactions commit exactly as today.
      return tx.tx.commit();
    }
    return this.#sealSpeculative(tx);
  }

  async #sealSpeculative(
    tx: IExtendedStorageTransaction,
  ): Promise<Result<Unit, CommitError>> {
    if (this.#closed) {
      // A late derivation on a disposing runtime: nothing to render
      // into; drop the writes (the run's results are re-derivable by
      // construction).
      return { ok: {} };
    }
    const inner = tx.tx;
    if (inner.sealInto === undefined) {
      // Fail CLOSED: a transport without seal support must not fall
      // back to committing a derivation — that would re-open the
      // client derivation-commit path this destination exists to
      // remove (speculation.md §6's FORBIDDEN list).
      return {
        error: {
          name: "StorageTransactionAborted",
          message: "speculative derivation refused: the storage " +
            "transaction does not support sealing, and committing a " +
            "derivation client-side is forbidden under " +
            "EXPERIMENTAL_SERVER_EXECUTION (speculation.md §6)",
          reason: new Error("speculation-seal-unsupported"),
        },
      };
    }
    const sealedSpaces: Array<{
      space: MemorySpace;
      entry: OverlayEntry;
    }> = [];
    const collector: ITransactionSealSink = {
      sealSpaceCommit: (
        space: MemorySpace,
        native: NativeStorageCommit,
        source: IStorageTransaction,
      ): Promise<Result<Unit, CommitError>> => {
        const replica = this.#runtime.storageManager.open(space).replica;
        if (replica.sealNative === undefined) {
          return Promise.resolve({
            error: {
              name: "StorageTransactionAborted",
              message:
                `space replica for ${space} does not support sealing; ` +
                "speculative derivations cannot commit (speculation.md §6)",
              reason: new Error("speculation-seal-unsupported"),
            },
          });
        }
        const { promise, resolve } = Promise.withResolvers<
          SealedCommitVerdict
        >();
        const sealed = replica.sealNative(native, source, promise, {
          speculative: true,
        });
        let confirmedFloor = 0;
        for (const read of sealed.commit.reads.confirmed) {
          const seq = (read as { seq?: number }).seq ?? 0;
          if (seq > confirmedFloor) confirmedFloor = seq;
        }
        const pendingDocs = new Map<string, { id: URI; scope?: CellScope }>();
        const originLocalSeqs = new Set<number>();
        for (const read of sealed.commit.reads.pending) {
          const basis = (read as { basisSeq?: number }).basisSeq ?? 0;
          if (basis > confirmedFloor) confirmedFloor = basis;
          const key = `${read.scope ?? ""}\0${read.id}`;
          if (!pendingDocs.has(key)) {
            pendingDocs.set(key, { id: read.id as URI, scope: read.scope });
          }
          const layers = (read as { localSeq?: number | number[] }).localSeq;
          if (typeof layers === "number") originLocalSeqs.add(layers);
          else if (Array.isArray(layers)) {
            for (const layer of layers) originLocalSeqs.add(layer);
          }
        }
        const entry: OverlayEntry = {
          space,
          localSeq: sealed.localSeq,
          resolveVerdict: resolve,
          confirmedFloor,
          pendingReadDocs: [...pendingDocs.values()],
          originLocalSeqs: [...originLocalSeqs],
          settled: sealed.settled.catch(() => undefined),
        };
        sealedSpaces.push({ space, entry });
        return Promise.resolve({ ok: {} });
      },
    };
    const result = await inner.sealInto(collector);
    if (result.error) {
      for (const { entry } of sealedSpaces) {
        entry.resolveVerdict({
          withdrawn: {
            message: `speculative seal failed: ${result.error.message}`,
          },
        });
      }
      return result;
    }
    for (const { space, entry } of sealedSpaces) {
      let entries = this.#entries.get(space);
      if (entries === undefined) {
        entries = new Map();
        this.#entries.set(space, entries);
      }
      entries.set(entry.localSeq, entry);
      this.#ensureWatermarkSink(space);
    }
    if (sealedSpaces.length > 0) {
      // A fresh entry may already be covered (a re-speculation after
      // retirement against state the watermark has passed): sweep once
      // off the current W, deferred a tick so the seal fully resolves
      // first.
      queueMicrotask(() => {
        for (const { space } of sealedSpaces) {
          this.#sweep(space, this.#watermarks.get(space) ?? 0);
        }
      });
    }
    return { ok: {} };
  }

  /**
   * Take ownership of a SPECULATIVE run's post-commit effects: enact
   * the reversible allowlisted kinds (navigateTo — optimistic
   * enactment), DROP everything else (the egress rule; the server's
   * authoritative run performs the real effect and its completion
   * arrives as a pushed derived commit). Non-derivation runs keep
   * today's inline flush.
   */
  deferSealedEffects(
    tx: IExtendedStorageTransaction,
    effects: readonly PostCommitSideEffect[],
  ): boolean {
    if (speculationRunContextOf(tx)?.kind !== "derivation") {
      return false;
    }
    const enactable = effects.filter((effect) =>
      SPECULATION_ENACTABLE_EFFECT_KINDS.has(effect.kind)
    );
    if (enactable.length > 0) {
      void (async () => {
        for (const effect of enactable) {
          try {
            await effect.flush(tx);
          } catch (error) {
            logger.error(
              "speculative-enact-failed",
              "speculative post-commit enactment failed:",
              { kind: effect.kind, error },
            );
          }
        }
      })();
    }
    return true;
  }

  #ensureWatermarkSink(space: MemorySpace): void {
    if (this.#watermarkSinks.has(space)) return;
    try {
      const cell = watermarkCell(this.#runtime, space);
      const cancel = cell.sink((value) => {
        const seq = (value as { seq?: number } | undefined)?.seq ?? 0;
        const known = this.#watermarks.get(space) ?? 0;
        if (seq > known) {
          this.#watermarks.set(space, seq);
        }
        this.#sweep(space, Math.max(seq, known));
      });
      this.#watermarkSinks.set(space, cancel);
    } catch (error) {
      logger.warn("watermark-sink-failed", () => [
        `watermark sink for ${space} failed; overlay retirement for the ` +
        "space will rely on entry re-runs",
        error,
      ]);
    }
  }

  /**
   * Retire every entry the watermark covers (speculation.md §4).
   * Iterates to a fixpoint within the event: retiring one entry can
   * unblock a chained one (a speculation that read another's overlay
   * value).
   */
  #sweep(space: MemorySpace, watermark: number): void {
    if (watermark <= 0) return;
    const entries = this.#entries.get(space);
    if (entries === undefined || entries.size === 0) return;
    const replica = this.#runtime.storageManager.open(space).replica;
    const view = replica.speculationRetirementView?.bind(replica);
    const ackedSeqOf = replica.ackedSeqOf?.bind(replica);
    if (view === undefined || ackedSeqOf === undefined) return;
    let progressed = true;
    while (progressed) {
      progressed = false;
      for (const entry of [...entries.values()]) {
        // The retirement floor (speculation.md §4 step 3): the highest
        // of the CONFIRMED read basis and every ORIGIN's ack seq — the
        // wave with `derivedThrough >= floor` has authoritatively
        // derived over everything this speculation consumed. The
        // CURRENT confirmed seq of a doc is deliberately NOT the floor:
        // the server's own derived write bumps it ABOVE any reachable W
        // on a quiet space (W covers inputs, never the derived commit's
        // own seq), which would strand the entry forever.
        let floor = entry.confirmedFloor;
        let blocked = false;
        for (const origin of entry.originLocalSeqs) {
          const acked = ackedSeqOf(origin);
          if (acked !== undefined && acked > floor) floor = acked;
        }
        for (const doc of entry.pendingReadDocs) {
          const state = view(doc.id, doc.scope);
          // An UNACKED pending layer BELOW this entry blocks: an
          // in-flight authored origin (the user mid-typing) or a live
          // lower speculation entry. An ACKED layer whose promotion is
          // merely parked does not — the wave consumed it, and its
          // ack seq is already in the floor above.
          if (
            state.pendingLocalSeqs.some((seq) =>
              seq < entry.localSeq && ackedSeqOf(seq) === undefined
            )
          ) {
            blocked = true;
            break;
          }
        }
        if (blocked || watermark < floor) continue;
        entries.delete(entry.localSeq);
        entry.resolveVerdict({
          withdrawn: {
            message: "speculation superseded by the authoritative " +
              "derivation (speculation.md §4: the store wins)",
            superseded: true,
          },
        });
        // A chained entry blocked on this one unblocks only once the
        // drop is APPLIED (async relative to the verdict): re-sweep
        // after settlement, off the freshest observed W — on a quiet
        // space no further watermark event would do it.
        void entry.settled.then(() => {
          if (this.#closed) return;
          this.#sweep(space, this.#watermarks.get(space) ?? 0);
        });
        progressed = true;
      }
    }
    if (entries.size === 0) {
      this.#entries.delete(space);
      // Keep the watermark sink: the next speculation for the space is
      // likely imminent, and the sink doubles as the client's settled
      // signal. It is released on close().
    }
  }

  /** Dispose: withdraw every live entry (the replica may already be
   * closing — rollback is best-effort) and release the watermark
   * sinks. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const entries of this.#entries.values()) {
      for (const entry of entries.values()) {
        entry.resolveVerdict({
          withdrawn: {
            message: "speculation overlay closed (runtime dispose)",
            superseded: true,
          },
        });
      }
      entries.clear();
    }
    this.#entries.clear();
    for (const cancel of this.#watermarkSinks.values()) {
      try {
        cancel();
      } catch {
        // sink cancellation is best-effort during teardown
      }
    }
    this.#watermarkSinks.clear();
  }
}
