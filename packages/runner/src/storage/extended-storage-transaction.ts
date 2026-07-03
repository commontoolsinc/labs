import { Immutable, isRecord } from "@commonfabric/utils/types";
import { deepEqual } from "@commonfabric/utils/deep-equal";
import { getLogger } from "@commonfabric/utils/logger";
import {
  type FabricPlainObject,
  type FabricValue,
  shallowMutableClone,
} from "@commonfabric/data-model/fabric-value";
import { isArrayIndexPropertyName } from "@commonfabric/utils/arrays";
import { deepFreeze } from "@commonfabric/data-model/deep-freeze";
import type {
  CommitError,
  IAttestation,
  IExtendedStorageTransaction,
  IMemorySpaceAddress,
  InactiveTransactionError,
  INotFoundError,
  IReadActivity,
  IReadOptions,
  IStorageTransaction,
  ITransactionJournal,
  IWriteOptions,
  MemorySpace,
  Metadata,
  ReadError,
  Result,
  StorageTransactionFailed,
  StorageTransactionStatus,
  TransactionReactivityLog,
  TransactionWriteDetail,
  Unit,
  WriteError,
  WriterError,
} from "./interface.ts";
import { createReadOnlyTransactionError, toThrowable } from "./interface.ts";
import type {
  CommitPrecondition,
  SqliteOperation,
} from "@commonfabric/memory/v2";
import type { MergeableOpDelta } from "./mergeable-ops.ts";
import {
  getDirectTransactionReactivityLog,
  getTransactionReadActivities,
  getTransactionWriteDetails,
} from "./transaction-inspection.ts";
import {
  isInternalVerifierRead,
  reactivityLogFromActivities,
} from "./reactivity-log.ts";

import {
  type NormalizedFullLink,
  toMemorySpaceAddress,
} from "../link-types.ts";
import { normalizeCellScope, scopeRank } from "../scope.ts";
import type { CellScope } from "../builder/types.ts";
import { ignoreReadForScheduling } from "../scheduler.ts";
import {
  type AttemptedWrite,
  canonicalizeLogicalPath,
  CFC_ENFORCING_STRICTNESS,
  type CfcDereferenceTrace,
  type CfcEnforcementMode,
  cfcEnforcementStrictness,
  type CfcFlowLabelsMode,
  type CfcTriggerReadGating,
  type CfcTxState,
  type CfcWriteFloorMode,
  type ConsumedRead,
  DEFAULT_CFC_ENFORCEMENT_MODE,
  DEFAULT_CFC_FLOW_LABELS_MODE,
  DEFAULT_CFC_TRIGGER_READ_GATING,
  DEFAULT_CFC_WRITE_FLOOR_MODE,
  flowLabelWorkExists,
  flowReadExcluded,
  gatedSinkRequestExists,
  type ImplementationIdentity,
  type PostCommitSideEffect,
  prepareBoundaryCommit,
  preparedDigestFor,
  type PreparedDigestInput,
  type SinkMaxConfidentiality,
  type TrustSnapshot,
  type WritePolicyInput,
} from "../cfc/mod.ts";

const logger = getLogger("extended-storage-transaction", {
  enabled: false,
  level: "error",
});

const createOnlyMarkKey = (
  link: { id: string; scope?: unknown },
): string =>
  `${normalizeCellScope(link.scope as CellScope | undefined)}\0${link.id}`;

type CfcInstrumentationHooks = {
  onRelevantTx?(): void;
  onPreparedTx?(): void;
  onPrepareReject?(reasons: readonly string[]): void;
  onDigestInvalidation?(reason: string): void;
  onOutboxFlush?(effect: PostCommitSideEffect): void;
  onSinkDedupHit?(key: string): void;
  onSinkReleaseReject?(
    info: { sink: string; effectId: string; detail: string },
  ): void;
};

// Read-only view of the transaction's CFC state, returned by getCfcState().
// `Readonly<CfcTxState>` is compile-time only, so handing out the live state
// object would let handler code reaching the tx via `cell.tx` flip
// `triggerReadGating` past its setter pin, clear `relevant`, forge
// `prepare.status`, or truncate `triggerReads`/`writePolicyInputs` — every
// enforcement decision reads this state (cubic/codex review on #4517).
//
// The view forwards reads to the live object (later recording stays visible
// through a view captured earlier) and throws on every mutation path.
// deepFrozen values pass through raw rather than wrapped: they are already
// immutable, and their reference identity is load-bearing — the recording
// API freezes records on entry (see the ownership-transfer contract in
// interface.ts) and `writePolicyInputIdentities` is keyed by those record
// references. Functions also pass raw: called with the view as receiver, a
// mutating method like Array.prototype.push [[Set]]s through the view and
// lands in the throwing trap.
const readOnlyCfcViews = new WeakMap<object, object>();

const throwCfcReadOnly = (): never => {
  throw new Error(
    "CFC transaction state is read-only: use the IExtendedStorageTransaction methods",
  );
};

const readOnlyCfcView = <T>(value: T): T => {
  if (value === null || typeof value !== "object") return value;
  if (Object.isFrozen(value)) return value;
  const cached = readOnlyCfcViews.get(value);
  if (cached !== undefined) return cached as T;
  const view = value instanceof Map
    ? new Proxy(value, {
      // Map methods work on an internal slot, so they must be called on the
      // real Map, not the proxy — read methods are forwarded bound, the
      // mutating ones throw.
      get(target, prop) {
        if (prop === "set" || prop === "delete" || prop === "clear") {
          return throwCfcReadOnly;
        }
        const member = Reflect.get(target, prop, target);
        return typeof member === "function"
          ? member.bind(target)
          : readOnlyCfcView(member);
      },
      set: throwCfcReadOnly,
      defineProperty: throwCfcReadOnly,
      deleteProperty: throwCfcReadOnly,
      setPrototypeOf: throwCfcReadOnly,
    })
    : new Proxy(value, {
      get(target, prop, receiver) {
        const member = Reflect.get(target, prop, receiver);
        return typeof member === "function" ? member : readOnlyCfcView(member);
      },
      set: throwCfcReadOnly,
      defineProperty: throwCfcReadOnly,
      deleteProperty: throwCfcReadOnly,
      setPrototypeOf: throwCfcReadOnly,
    });
  readOnlyCfcViews.set(value, view);
  return view as T;
};

export class ExtendedStorageTransaction implements IExtendedStorageTransaction {
  private commitCallbacks = new Set<
    (
      tx: IExtendedStorageTransaction,
      result: Result<Unit, CommitError>,
    ) => void
  >();
  private statusOverride?: StorageTransactionStatus;
  private commitCallbacksDispatched = false;
  private commitPreconditions = new Map<MemorySpace, CommitPrecondition[]>();
  private createOnlyMarks = new Map<MemorySpace, Set<string>>();
  private outboxIdempotencyKeys = new Set<string>();
  private readOnlySource?: string;
  private narrowestReadScope: CellScope = "space";
  // ECMAScript-private (#), like #privilegedSystemWriteDepth below: the CFC
  // state is the enforcement substrate (dials, pins, relevance, trigger
  // reads, policy inputs, prepare status), and handler code reaching the tx
  // via `(cell.tx as any)` must not be able to grab the raw object and
  // mutate it. Reads go through getCfcState(), which returns a read-only
  // view (see readOnlyCfcView).
  #cfcState: CfcTxState = {
    relevant: false,
    enforcementMode: DEFAULT_CFC_ENFORCEMENT_MODE,
    flowLabelsMode: DEFAULT_CFC_FLOW_LABELS_MODE,
    writeFloorMode: DEFAULT_CFC_WRITE_FLOOR_MODE,
    triggerReadGating: DEFAULT_CFC_TRIGGER_READ_GATING,
    prepare: { status: "unprepared" },
    dereferenceTraces: [],
    triggerReads: [],
    writePolicyInputs: [],
    writePolicyInputIdentities: new Map(),
    writeIdentity: { sawWrite: false, multiple: false },
    outbox: [],
    diagnostics: [],
    unprivilegedSystemWrites: [],
  };
  private reportedCfcRelevant = false;
  private reportedCfcPrepared = false;
  // The pins below are ECMAScript-private for the same reason as #cfcState:
  // a TS-`private` pin could be cleared via `(cell.tx as any)` and the dial
  // then legally weakened through its setter.
  // Highest enforcing strictness ever set on this tx; mode cannot drop below it.
  #cfcEnforcementFloor = 0;
  // Once flow-label persistence is on for this tx it cannot be turned back
  // off — same shape as the enforcement floor (audit S3): code holding a
  // Cell must not disable propagation mid-transaction to launder a value.
  #cfcFlowLabelsPinned = false;
  #cfcWriteFloorPinned = false;
  #cfcTriggerReadGatingPinned = false;
  // Depth of the runtime's privileged system-write scope. The runtime's own
  // label/schema persistence (prepareBoundaryCommit) runs inside it; any write
  // to a protected system path outside it is recorded as unprivileged (S18).
  // ECMAScript-private (#) so handler code reaching cell.tx cannot enter the
  // scope via `(cell.tx as any)` — `as any` cannot touch a `#private` member.
  #privilegedSystemWriteDepth = 0;
  // Per-transaction cache of `Cell.get()` results, keyed by stable cell view.
  // Replaced wholesale on any write (see `invalidateReadResultCache`), so a hit
  // is only ever served when nothing has been written since the cached read.
  // This is a Map rather than a WeakMap, but the transaction owns it and writes
  // drop it wholesale, bounding retention to reads-without-writes in one tx.
  private readResultCache = new Map<string, Map<string, { value: unknown }>>();
  private readResultCacheHits = 0;
  private readResultCacheMisses = 0;
  private readResultCacheSets = 0;

  constructor(
    public tx: IStorageTransaction,
    private cfcInstrumentation: CfcInstrumentationHooks = {},
  ) {}

  noteCfcSinkReleaseReject(
    info: { sink: string; effectId: string; detail: string },
  ): void {
    this.#cfcState.diagnostics.push(
      `sink-request release rejected for ${info.sink} (${info.effectId}): ${info.detail}`,
    );
    this.cfcInstrumentation.onSinkReleaseReject?.(info);
  }

  // Append-only diagnostics seam for the CFC machinery outside this class
  // (prepare's observe-mode notes). getCfcState() is a read-only view, so
  // this is the one sanctioned write path; diagnostics are advisory text and
  // never feed an enforcement decision, so exposing append is harmless.
  noteCfcDiagnostic(message: string): void {
    this.#cfcState.diagnostics.push(message);
  }

  getCfcState(): Readonly<CfcTxState> {
    // Read-only view, not the live object — see readOnlyCfcView. Internal
    // code mutates `this.#cfcState` directly and never goes through here.
    return readOnlyCfcView(this.#cfcState);
  }

  setCfcEnforcementMode(mode: CfcEnforcementMode): void {
    // Enforcement may be raised but never weakened below the highest enforcing
    // level set on this transaction (audit S3). The control surface is on the
    // public transaction interface and cell.tx is reachable, so this prevents
    // code holding a Cell from disabling enforcement mid-transaction to commit a
    // policy violation. `disabled`/`observe` impose no floor (neither enforces),
    // so they may still be juggled before any enforcing mode is set.
    if (cfcEnforcementStrictness(mode) < this.#cfcEnforcementFloor) {
      throw new Error(
        `CFC enforcement mode cannot be weakened to "${mode}": transaction is ` +
          `pinned at strictness ${this.#cfcEnforcementFloor} or higher`,
      );
    }
    this.#cfcState.enforcementMode = mode;
    if (cfcEnforcementStrictness(mode) >= CFC_ENFORCING_STRICTNESS) {
      this.#cfcEnforcementFloor = Math.max(
        this.#cfcEnforcementFloor,
        cfcEnforcementStrictness(mode),
      );
    }
  }

  setCfcFlowLabelsMode(mode: CfcFlowLabelsMode): void {
    if (this.#cfcFlowLabelsPinned && mode !== "persist") {
      throw new Error(
        `CFC flow-labels mode cannot be weakened to "${mode}": transaction ` +
          `is pinned at "persist"`,
      );
    }
    this.#cfcState.flowLabelsMode = mode;
    if (mode === "persist") {
      this.#cfcFlowLabelsPinned = true;
    }
  }

  setCfcWriteFloorMode(mode: CfcWriteFloorMode): void {
    // Anti-downgrade pin (mirrors flow labels): once `enforce` is set — by the
    // runtime at tx creation — pattern/handler code that reaches the tx cannot
    // weaken it to `observe`/`off` to slip an SC-18 floor violation through
    // (cubic review). Strengthening to `enforce` is always allowed.
    if (this.#cfcWriteFloorPinned && mode !== "enforce") {
      throw new Error(
        `CFC write-floor mode cannot be weakened to "${mode}": transaction ` +
          `is pinned at "enforce"`,
      );
    }
    this.#cfcState.writeFloorMode = mode;
    if (mode === "enforce") {
      this.#cfcWriteFloorPinned = true;
    }
  }

  setCfcTriggerReadGating(enabled: CfcTriggerReadGating): void {
    // Anti-downgrade pin (mirrors the write floor): once the gate is on —
    // set by the runtime at tx creation — pattern/handler code that reaches
    // the tx cannot turn it off before prepareCfc() and empty the
    // triggerReadSources the H5 gates consume (cubic/codex review on #4488).
    // Re-asserting enabled is always allowed.
    if (this.#cfcTriggerReadGatingPinned && !enabled) {
      throw new Error(
        `CFC trigger-read gating cannot be disabled: transaction is pinned ` +
          `at enabled`,
      );
    }
    this.#cfcState.triggerReadGating = enabled;
    if (enabled) {
      this.#cfcTriggerReadGatingPinned = true;
    }
  }

  addCfcTriggerReads(reads: readonly IMemorySpaceAddress[]): void {
    if (this.#cfcState.prepare.status === "prepared") {
      this.invalidateCfc("trigger-reads-after-prepare");
    }
    for (const read of reads) {
      // Runtime-surface exclusion keys on the RAW notification path; this
      // is the only point where it still exists (storage below holds the
      // canonical form, where a user `value.source` is indistinguishable
      // from the raw `["source"]` surface).
      if (flowReadExcluded(read.id, read.path)) {
        continue;
      }
      this.#cfcState.triggerReads.push(deepFreeze({
        space: read.space,
        id: read.id,
        scope: normalizeCellScope(read.scope),
        path: canonicalizeLogicalPath(read.path) as string[],
      }));
    }
  }

  // Per-sink confidentiality ceilings, set once by the Runtime at tx creation
  // (before any handler code runs). Write-once: a later call is ignored, so
  // code holding a Cell can't relax a configured ceiling mid-transaction. Not
  // on the public tx interface for the same reason (audit S3 posture).
  setCfcSinkMaxConfidentiality(map: SinkMaxConfidentiality): void {
    if (this.#cfcState.sinkMaxConfidentiality !== undefined) return;
    // Deep-freeze on store so the ceiling is immutable regardless of caller —
    // TS `Readonly<>` is compile-time only, so storing a bare reference would
    // let later mutation change the egress policy (review on #3993). Cheap:
    // deepFreeze short-circuits on the Runtime's already-frozen config.
    this.#cfcState.sinkMaxConfidentiality = deepFreeze(map);
  }

  markCfcRelevant(reason?: string): void {
    this.#cfcState.relevant = true;
    if (!this.reportedCfcRelevant) {
      this.reportedCfcRelevant = true;
      this.cfcInstrumentation.onRelevantTx?.();
    }
    if (reason) {
      this.#cfcState.diagnostics.push(reason);
    }
  }

  // Runs `fn` with writes to protected system paths (a document's ["cfc"]
  // label-map) permitted. The runtime's own label/schema persistence in
  // prepareBoundaryCommit is the only legitimate such writer; `prepareCfc`
  // wraps that call in this scope via `this`. ECMAScript-private (#) and absent
  // from IExtendedStorageTransaction, so handler code reaching `cell.tx` cannot
  // enter the scope — `(cell.tx as any).#runPrivilegedSystemWrite` is a
  // TypeError, not a bypass (audit S18 review). Tests that need stored ["cfc"]
  // metadata seed it instead via an ungated path-[] full-document write (the
  // same shape hydration delivers), never through this scope.
  #runPrivilegedSystemWrite<T>(fn: () => T): T {
    this.#privilegedSystemWriteDepth += 1;
    try {
      return fn();
    } finally {
      this.#privilegedSystemWriteDepth -= 1;
    }
  }

  // Record a write to a document's ["cfc"] label-map path made outside the
  // privileged scope. Such a write forges the metadata that drives CFC
  // derivation for OTHER writes, bypassing the commit-boundary derivation +
  // mint-gating (audit S18). prepareBoundaryCommit turns each recorded address
  // into a fail-closed reason, so the violation surfaces uniformly with every
  // other CFC reason (enforce rejects, observe diagnoses). Recording (and
  // relevance marking) is deliberately unconditional on the enforcement mode,
  // like every other CFC signal: setCfcEnforcementMode permits raising the
  // mode mid-transaction (disabled/observe impose no floor), so a forgery in a
  // disabled window must still be on record when a later escalation evaluates
  // it. A transaction still `disabled` at commit never runs
  // prepareBoundaryCommit, so the record stays inert there.
  private noteSystemWrite(address: IMemorySpaceAddress): void {
    if (this.#privilegedSystemWriteDepth > 0) return;
    // The ["cfc"] document field holds the persisted label map. A value-path
    // write (path[0] is a user key) or a path-[] full-document write is not it.
    if (address.path[0] !== "cfc") return;
    this.markCfcRelevant("unprivileged-cfc-metadata-write");
    this.#cfcState.unprivilegedSystemWrites.push(
      `${address.id}/${address.path.join("/")}`,
    );
  }

  // Capture the implementation identity active at this write into the per-tx
  // uniformity summary (§8.9.3 TransformedBy — see `CfcTxState.writeIdentity`).
  // The flow join is one per-tx label, so derivation provenance is minted only
  // when every non-privileged write was authored under the same defined
  // identity: identities are captured at write time, like
  // `recordCfcWritePolicyInput()` does, so a later run in the same transaction
  // cannot lend its identity to earlier writes (and an unattributed write
  // cannot borrow a later one). Privileged persistence writes (label maps,
  // `cid:` schema docs) are bookkeeping, not authorship, and are skipped —
  // also keeping the summary stable across prepare/invalidate/re-prepare.
  private noteWriteIdentity(): void {
    if (this.#privilegedSystemWriteDepth > 0) return;
    const summary = this.#cfcState.writeIdentity;
    if (summary.multiple) return;
    const current = this.#cfcState.implementationIdentity;
    if (!summary.sawWrite) {
      summary.sawWrite = true;
      summary.identity = current;
      return;
    }
    if (!deepEqual(summary.identity, current)) {
      summary.multiple = true;
      summary.identity = undefined;
    }
  }

  invalidateCfc(reason: string): void {
    const wasPrepared = this.#cfcState.prepare.status === "prepared";
    const previousDigest = this.#cfcState.prepare.status === "prepared"
      ? this.#cfcState.prepare.digest
      : this.#cfcState.prepare.status === "invalidated"
      ? this.#cfcState.prepare.digest
      : undefined;
    const reasons = this.#cfcState.prepare.status === "invalidated"
      ? [...this.#cfcState.prepare.reasons, reason]
      : [reason];
    this.#cfcState.prepare = {
      status: "invalidated",
      digest: previousDigest,
      reasons,
    };
    if (wasPrepared) {
      this.cfcInstrumentation.onDigestInvalidation?.(reason);
    }
  }

  // Ambient metadata merged into every read issued inside a
  // runWithAmbientReadMeta scope. Used by scheduler dependency seeding to
  // tag its materialization reads without threading meta through every
  // cell/traverse API in between.
  #ambientReadMeta?: Metadata;

  runWithAmbientReadMeta<T>(meta: Metadata, fn: () => T): T {
    const previous = this.#ambientReadMeta;
    this.#ambientReadMeta = previous === undefined
      ? meta
      : { ...previous, ...meta };
    try {
      return fn();
    } finally {
      this.#ambientReadMeta = previous;
    }
  }

  #withAmbientReadMeta(options?: IReadOptions): IReadOptions | undefined {
    if (this.#ambientReadMeta === undefined) {
      return options;
    }
    return {
      ...options,
      meta: { ...this.#ambientReadMeta, ...options?.meta },
    };
  }

  getNarrowestReadScope(): CellScope {
    return this.narrowestReadScope;
  }

  resetNarrowestReadScope(scope: CellScope = "space"): void {
    this.narrowestReadScope = scope;
  }

  private recordReadScope(address: IMemorySpaceAddress): void {
    const scope = normalizeCellScope(address.scope);
    if (scopeRank(scope) > scopeRank(this.narrowestReadScope)) {
      this.narrowestReadScope = scope;
    }
  }

  getCachedReadResult(
    key: string,
    variant: string,
  ): { value: unknown } | undefined {
    const cached = this.readResultCache.get(key)?.get(variant);
    if (cached === undefined) {
      this.readResultCacheMisses++;
    } else {
      this.readResultCacheHits++;
    }
    return cached;
  }

  setCachedReadResult(
    key: string,
    variant: string,
    value: unknown,
  ): void {
    let byVariant = this.readResultCache.get(key);
    if (byVariant === undefined) {
      byVariant = new Map();
      this.readResultCache.set(key, byVariant);
    }
    byVariant.set(variant, { value });
    this.readResultCacheSets++;
  }

  getReadResultCacheStats(): {
    hits: number;
    misses: number;
    sets: number;
    entries: number;
  } {
    let entries = 0;
    for (const byVariant of this.readResultCache.values()) {
      entries += byVariant.size;
    }
    return {
      hits: this.readResultCacheHits,
      misses: this.readResultCacheMisses,
      sets: this.readResultCacheSets,
      entries,
    };
  }

  private invalidateReadResultCache(): void {
    // A write may have changed any value a cached read depends on. Drop the
    // whole cache by replacing the map; this enforces
    // the "no writes between the last read and this one" invariant the cache
    // relies on.
    this.readResultCache = new Map();
  }

  recordCfcDereferenceTrace(trace: CfcDereferenceTrace): void {
    // Freeze on entry: from this point on the record is owned by the tx and
    // identity-stable. Mirrors the chokepoint pattern on
    // `recordCfcWritePolicyInput()`; together they ensure every CfcAddress
    // that flows into the digest input lives behind a deep-frozen wrapper.
    this.#cfcState.dereferenceTraces.push(deepFreeze(trace));
    if (this.#cfcState.prepare.status === "prepared") {
      this.invalidateCfc("dereference-trace-added");
    }
  }

  setCfcTrustSnapshot(snapshot: TrustSnapshot | undefined): void {
    this.#cfcState.trustSnapshot = snapshot;
    if (this.#cfcState.prepare.status === "prepared") {
      this.invalidateCfc("trust-snapshot-changed");
    }
  }

  setCfcImplementationIdentity(
    identity: ImplementationIdentity | undefined,
  ): void {
    this.#cfcState.implementationIdentity = identity;
    if (this.#cfcState.prepare.status === "prepared") {
      this.invalidateCfc("implementation-identity-changed");
    }
  }

  recordCfcWritePolicyInput(input: WritePolicyInput): void {
    // Freeze on entry: from this point on the record is owned by the tx and
    // identity-stable, which lets `hashStringOf()` cache its hash on the
    // existing WeakMap. The within-sort tiebreaker in
    // `compareWritePolicyInput` then re-hashes each element via the cache.
    const frozen = deepFreeze(input);
    this.#cfcState.writePolicyInputs.push(frozen);
    // Capture the identity active right now so writeAuthorizedBy is verified
    // against the trust context that authored this write, even if a later run
    // in the same transaction changes the identity.
    this.#cfcState.writePolicyInputIdentities.set(
      frozen,
      this.#cfcState.implementationIdentity,
    );
    if (this.#cfcState.prepare.status === "prepared") {
      this.invalidateCfc("write-policy-input-added");
    }
  }

  enqueuePostCommitEffect(effect: PostCommitSideEffect): void {
    const key = effect.idempotencyKey ?? effect.id;
    if (this.outboxIdempotencyKeys.has(key)) {
      this.cfcInstrumentation.onSinkDedupHit?.(key);
      return;
    }
    this.outboxIdempotencyKeys.add(key);
    this.#cfcState.outbox.push(effect);
  }

  hasPendingPostCommitEffects(): boolean {
    return this.#cfcState.outbox.length > 0;
  }

  private buildPreparedDigestInput(): PreparedDigestInput {
    // Each pushed record is deepFrozen so that every CfcAddress (and every
    // path inside one) that flows into the digest input is immutable from
    // the moment of construction. This makes the records safe to use as
    // identity-stable cache keys (e.g. for the `hashStringOf()` WeakMap
    // cache) and matches the chokepoint freeze applied to dereference
    // traces and write-policy inputs.
    const consumedReads: ConsumedRead[] = [];
    for (const read of this.getReadActivities()) {
      if (isInternalVerifierRead(read.meta)) {
        continue;
      }
      consumedReads.push(deepFreeze({
        ...read,
        scope: normalizeCellScope(read.scope),
        path: canonicalizeLogicalPath(read.path),
      }));
    }

    const log = this.getReactivityLog();
    const attemptedWrites: AttemptedWrite[] = (log.attemptedWrites ?? []).map(
      (address) =>
        deepFreeze({
          ...address,
          scope: normalizeCellScope(address.scope),
          path: canonicalizeLogicalPath(address.path),
        }),
    );

    const writes: AttemptedWrite[] = [];
    const seenWriteSpaces = new Set<MemorySpace>(
      (log.writes ?? []).map((write) => write.space),
    );
    for (const space of seenWriteSpaces) {
      for (const write of this.getWriteDetails(space)) {
        writes.push(deepFreeze({
          ...write.address,
          scope: normalizeCellScope(write.address.scope),
          path: canonicalizeLogicalPath(write.address.path),
        }));
      }
    }

    return {
      consumedReads,
      attemptedWrites,
      writes,
      dereferenceTraces: [...this.#cfcState.dereferenceTraces],
      triggerReads: [...this.#cfcState.triggerReads],
      writePolicyInputs: [...this.#cfcState.writePolicyInputs],
      implementationIdentity: this.#cfcState.implementationIdentity,
      trustSnapshot: this.#cfcState.trustSnapshot,
    };
  }

  prepareCfc(): string {
    // Verification always runs. There is deliberately no caller-supplied input
    // override: the commit-time digest recheck only confirms the prepared input
    // matches real activity, so accepting an external input here would let a
    // caller skip prepareBoundaryCommit while still passing the recheck (audit
    // S2 — verification bypass).
    //
    // Runs inside the privileged system-write scope: prepareBoundaryCommit
    // persists the derived ["cfc"] label map (and cid: schema docs), which are
    // exactly the protected writes `noteSystemWrite` rejects from untrusted
    // code (audit S18). The runtime's own persistence is the one legitimate
    // writer, so it alone is exempt.
    const reasons = this.#runPrivilegedSystemWrite(() =>
      prepareBoundaryCommit(this)
    );
    if (reasons.length > 0) {
      this.cfcInstrumentation.onPrepareReject?.(reasons);
      this.#cfcState.prepare = {
        status: "invalidated",
        reasons,
      };
      this.#cfcState.diagnostics.push(...reasons);
      return "";
    }
    const preparedInput = this.buildPreparedDigestInput();
    const digest = preparedDigestFor(preparedInput);
    this.#cfcState.prepare = {
      status: "prepared",
      digest,
      input: preparedInput,
    };
    if (!this.reportedCfcPrepared) {
      this.reportedCfcPrepared = true;
      this.cfcInstrumentation.onPreparedTx?.();
    }
    return digest;
  }

  enableMultiSpaceWrites(order?: readonly MemorySpace[]): void {
    this.tx.enableMultiSpaceWrites?.(order);
  }

  setReadOnly(reason = "runtime.readTx()"): void {
    this.readOnlySource = reason;
    this.tx.setReadOnly?.(reason);
  }

  clearReadOnly(): void {
    this.readOnlySource = undefined;
    this.tx.clearReadOnly?.();
  }

  isReadOnly(): boolean {
    return this.readOnlySource !== undefined || this.tx.isReadOnly?.() === true;
  }

  private assertWritable(method: string): void {
    if (!this.isReadOnly()) {
      return;
    }
    throw createReadOnlyTransactionError(method, this.readOnlySource);
  }

  get journal(): ITransactionJournal {
    return this.tx.journal;
  }

  getReactivityLog(): TransactionReactivityLog {
    return getDirectTransactionReactivityLog(this.tx) ??
      reactivityLogFromActivities(this.tx.journal.activity());
  }

  setSchedulerObservation(observation: unknown): void {
    this.tx.setSchedulerObservation?.(observation);
  }

  getSchedulerObservation(): unknown {
    return this.tx.getSchedulerObservation?.();
  }

  addCommitPrecondition(
    space: MemorySpace,
    precondition: CommitPrecondition,
  ): void {
    this.assertWritable("addCommitPrecondition");
    // Fail closed: a precondition is a commit gate, so silently ignoring it
    // on storage that cannot enforce it would let the gated commit through.
    if (!this.tx.addCommitPrecondition) {
      throw new Error(
        "storage transaction does not support addCommitPrecondition()",
      );
    }
    const preconditions = this.commitPreconditions.get(space);
    if (preconditions) {
      preconditions.push(precondition);
    } else {
      this.commitPreconditions.set(space, [precondition]);
    }
    this.tx.addCommitPrecondition(space, precondition);
  }

  getCommitPreconditions(
    space: MemorySpace,
  ): readonly CommitPrecondition[] | undefined {
    return this.tx.getCommitPreconditions?.(space) ??
      this.commitPreconditions.get(space);
  }

  markCreateOnly(
    link: { space: MemorySpace; id: string; scope?: unknown },
  ): void {
    this.assertWritable("markCreateOnly");
    let marks = this.createOnlyMarks.get(link.space);
    if (!marks) {
      marks = new Set();
      this.createOnlyMarks.set(link.space, marks);
    }
    marks.add(createOnlyMarkKey(link));
    this.tx.markCreateOnly?.(link);
  }

  recordMergeableOp(link: NormalizedFullLink, delta: MergeableOpDelta): void {
    this.assertWritable("recordMergeableOp");
    this.tx.recordMergeableOp?.(toMemorySpaceAddress(link), delta);
  }

  recordSqliteWrite(space: MemorySpace, op: SqliteOperation): void {
    // A folded SQLite write is a write — honor the wrapper's read-only mode the
    // same way cell writes do, instead of silently recording it.
    this.assertWritable("recordSqliteWrite");
    if (!this.tx.recordSqliteWrite) {
      throw new Error(
        "storage transaction does not support recordSqliteWrite()",
      );
    }
    this.tx.recordSqliteWrite(space, op);
  }

  getReadActivities(): Iterable<IReadActivity> {
    return getTransactionReadActivities(this.tx);
  }

  getWriteDetails(
    space: MemorySpace,
  ): Iterable<TransactionWriteDetail> {
    return getTransactionWriteDetails(this.tx, space);
  }

  status(): StorageTransactionStatus {
    if (this.statusOverride !== undefined) {
      return this.statusOverride;
    }
    return this.tx.status();
  }

  read(
    address: IMemorySpaceAddress,
    options?: IReadOptions,
  ): Result<IAttestation, ReadError> {
    options = this.#withAmbientReadMeta(options);
    if (this.#cfcState.prepare.status === "prepared") {
      this.invalidateCfc("read-after-prepare");
    }
    this.recordReadScope(address);
    return this.tx.read(address, options);
  }

  readOrThrow(
    address: IMemorySpaceAddress,
    options?: IReadOptions,
  ): Immutable<FabricValue> {
    options = this.#withAmbientReadMeta(options);
    if (this.#cfcState.prepare.status === "prepared") {
      this.invalidateCfc("read-after-prepare");
    }
    this.recordReadScope(address);
    const readResult = this.tx.read(address, options);
    if (
      readResult.error &&
      readResult.error.name !== "NotFoundError" &&
      // Type mismatch is treated as undefined in other path resolution logic,
      // so we're consistent with that behavior here. This hides information
      // from someone who has rights to read a subpath, but otherwise get no
      // information about parent paths.
      readResult.error.name !== "TypeMismatchError"
    ) {
      throw toThrowable(readResult.error);
    }
    return readResult.ok?.value;
  }

  readValueOrThrow(
    address: NormalizedFullLink,
    options?: IReadOptions,
  ): Immutable<FabricValue> {
    return this.readOrThrow(toMemorySpaceAddress(address), options);
  }

  write(
    address: IMemorySpaceAddress,
    value: FabricValue,
    options?: IWriteOptions,
  ): Result<IAttestation, WriteError | WriterError> {
    this.assertWritable("write()");
    this.noteSystemWrite(address);
    this.noteWriteIdentity();
    if (this.#cfcState.prepare.status === "prepared") {
      this.invalidateCfc("write-after-prepare");
    }
    this.invalidateReadResultCache();
    return this.tx.write(address, value, options);
  }

  writeOrThrow(
    address: IMemorySpaceAddress,
    value: FabricValue,
    options?: IWriteOptions,
  ): void {
    this.assertWritable("writeOrThrow()");
    this.noteSystemWrite(address);
    this.noteWriteIdentity();
    if (this.#cfcState.prepare.status === "prepared") {
      this.invalidateCfc("write-after-prepare");
    }
    this.invalidateReadResultCache();
    const writeResult = this.tx.write(address, value, options);
    if (
      writeResult.error &&
      (writeResult.error.name === "NotFoundError")
    ) {
      if (options?.delete) {
        // Deleting a slot whose path doesn't exist is a no-op; don't
        // materialize intermediates just to remove nothing.
        return;
      }
      // Create parent entries if needed.
      // errorPath includes the missing key (consistent with read errors).
      // lastExistingPath is one level up - the actual last existing parent.
      const errorPath = (writeResult.error as INotFoundError).path;
      const lastExistingPath = errorPath.slice(0, -1);
      // When document doesn't exist (errorPath is []), we don't need to read -
      // just start with {}. But if errorPath has content (e.g., ["foo"]), the
      // document exists and we need to read from lastExistingPath to preserve
      // existing fields.
      let valueObj: FabricPlainObject;
      if (errorPath.length === 0) {
        valueObj = {};
      } else {
        const currentValue = this.readOrThrow({
          ...address,
          path: lastExistingPath,
        }, { meta: ignoreReadForScheduling });
        if (!isRecord(currentValue)) {
          // This should have already been caught as type mismatch error
          throw new Error(
            `Value at path ${address.path.join("/")} is not an object`,
          );
        }
        // Stored objects are deep-frozen by `fabricFromNativeValueModern()`.
        // Clone before mutation to avoid `TypeError` on frozen objects: this
        // always copies (the value may be the transaction's working copy, which
        // must not be mutated in place), and it deep-freezes the bound children
        // as inexpensive defense-in-depth against accidental deeper mutation of
        // the shared input.
        valueObj = shallowMutableClone(
          currentValue as FabricValue,
        ) as FabricPlainObject;
      }
      const remainingPath = address.path.slice(lastExistingPath.length);
      if (remainingPath.length === 0) {
        throw new Error(
          `Invalid error path: ${errorPath.join("/")}`,
        );
      }
      const lastKey = remainingPath.pop()!;
      let nextValue: FabricPlainObject = valueObj;
      // Create intermediate containers. The container type depends on whether
      // the NEXT key (the one that will access this container) is a valid array
      // index.
      for (let i = 0; i < remainingPath.length; i++) {
        const key = remainingPath[i];
        const nextKey = remainingPath[i + 1] ?? lastKey;
        const isNextKeyArrayIndex = isArrayIndexPropertyName(nextKey);
        nextValue =
          nextValue[key] =
            (isNextKeyArrayIndex ? [] : {}) as FabricPlainObject;
      }
      nextValue[lastKey] = value as FabricValue;
      const parentAddress = { ...address, path: lastExistingPath };
      const writeResultRetry = this.tx.write(parentAddress, valueObj);
      if (writeResultRetry.error) {
        throw toThrowable(writeResultRetry.error);
      }
    } else if (writeResult.error) {
      throw toThrowable(writeResult.error);
    }
  }

  writeValueOrThrow(
    address: NormalizedFullLink,
    value: FabricValue,
    options?: IWriteOptions,
  ): void {
    this.assertWritable("writeValueOrThrow()");
    this.writeOrThrow(toMemorySpaceAddress(address), value, options);
  }

  writeValuesOrThrow(
    writes: Iterable<
      { address: NormalizedFullLink; value: FabricValue; delete?: boolean }
    >,
  ): void {
    this.assertWritable("writeValuesOrThrow()");
    this.invalidateReadResultCache();
    if (this.tx.writeBatch) {
      // Keep the batch path on the same noteSystemWrite chokepoint as single
      // writes (S18). Structurally inert today — the NormalizedFullLink
      // signature means toMemorySpaceAddress always yields path ["value", ...]
      // — but the guard must not silently fall away if the signature is ever
      // widened to document-root addresses.
      const noteSystemWrite = (address: IMemorySpaceAddress) =>
        this.noteSystemWrite(address);
      // Note the write identity per yielded write (not once up front): an
      // empty batch must not mark the tx as written-to.
      const noteWriteIdentity = () => this.noteWriteIdentity();
      const result = this.tx.writeBatch(
        (function* () {
          for (const write of writes) {
            const address = toMemorySpaceAddress(write.address);
            noteSystemWrite(address);
            noteWriteIdentity();
            yield { address, value: write.value, delete: write.delete };
          }
        })(),
      );
      if (result.error) {
        throw toThrowable(result.error);
      }
      return;
    }

    for (const write of writes) {
      this.writeValueOrThrow(
        write.address,
        write.value,
        write.delete ? { delete: true } : undefined,
      );
    }
  }

  abort(reason?: any): Result<any, InactiveTransactionError> {
    this.assertWritable("abort()");
    this.statusOverride = undefined;
    this.#cfcState.outbox = [];
    this.outboxIdempotencyKeys.clear();
    this.#cfcState.prepare = { status: "unprepared" };
    this.#cfcState.dereferenceTraces = [];
    return this.tx.abort(reason);
  }

  private runCommitCallbacks(result: Result<Unit, CommitError>): void {
    if (this.commitCallbacksDispatched) {
      return;
    }
    this.commitCallbacksDispatched = true;
    // Call all callbacks, wrapping each in try/catch to prevent one
    // failing callback from breaking others.
    for (const callback of this.commitCallbacks) {
      try {
        callback(this, result);
      } catch (error) {
        logger.error("storage-error", "Error in commit callback:", error);
      }
    }
  }

  private clearPostCommitOutbox(): void {
    this.#cfcState.outbox = [];
    this.outboxIdempotencyKeys.clear();
  }

  private rejectCommitBeforeStorage(
    result: Result<Unit, CommitError>,
  ): Result<Unit, CommitError> {
    if (result.error) {
      this.statusOverride = {
        status: "error",
        journal: this.tx.journal,
        error: result.error as StorageTransactionFailed,
      };
      this.tx.abort(result.error);
    }
    this.clearPostCommitOutbox();
    this.runCommitCallbacks(result);
    return result;
  }

  async commit(): Promise<Result<Unit, CommitError>> {
    if (this.statusOverride?.status === "error") {
      return { error: this.statusOverride.error };
    }
    const readOnly = this.isReadOnly();
    if (readOnly) {
      this.tx.clearReadOnly?.();
    }
    if (!readOnly) {
      // Flow-label relevance is computed, not caller-marked: a tx that
      // observed or wrote a labeled doc derives labels even when nothing
      // called markCfcRelevant (S16 — value-copy laundering happens in
      // exactly the txs nobody marked). Probe only while unprepared: the
      // probe reads metadata, and a read after prepare would invalidate the
      // digest of a transaction that already did its flow work.
      if (
        !this.#cfcState.relevant &&
        this.#cfcState.prepare.status === "unprepared" &&
        this.#cfcState.flowLabelsMode !== "off" &&
        this.#cfcState.enforcementMode !== "disabled" &&
        flowLabelWorkExists(this)
      ) {
        this.markCfcRelevant("flow-labels");
      }
      // Sink-request ceiling relevance (audit item 21): a request built from a
      // value pulled through a schema-less link marks nothing, so the egress
      // would otherwise commit without prepareCfc and skip the ceiling check.
      // Independent of the flow dial. Unlike the flow-labels probe above this
      // reads no stored metadata (only already-recorded policy inputs), so it
      // is safe to fire even once `prepare` is `invalidated` — and it MUST: a
      // late confidential read plus a late sink-request flips an early
      // `prepared` to `invalidated` (see `invalidateCfc` triggers) while
      // leaving `relevant` false, and without marking here the enforcement
      // reject below is skipped and the request flushes fail-open (Codex P2 on
      // #4070). A genuinely `prepared` transaction either was already relevant
      // (so this guard is moot) or read nothing confidential (consumed set
      // empty — nothing to gate), so only the non-prepared states need this.
      if (
        !this.#cfcState.relevant &&
        this.#cfcState.prepare.status !== "prepared" &&
        this.#cfcState.enforcementMode !== "disabled" &&
        gatedSinkRequestExists(this)
      ) {
        this.markCfcRelevant("sink-request-ceiling");
      }
      if (
        this.#cfcState.relevant &&
        this.#cfcState.enforcementMode === "observe" &&
        this.#cfcState.prepare.status === "unprepared"
      ) {
        this.prepareCfc();
      }
      if (
        this.#cfcState.relevant &&
        this.#cfcState.enforcementMode !== "disabled" &&
        this.#cfcState.enforcementMode !== "observe" &&
        this.#cfcState.prepare.status !== "prepared"
      ) {
        const detail = this.#cfcState.prepare.status === "invalidated"
          ? `: ${this.#cfcState.prepare.reasons[0]}`
          : "";
        return this.rejectCommitBeforeStorage({
          error: {
            name: "StorageTransactionAborted",
            message:
              `CFC enforcement rejected commit: relevant transaction was not prepared${detail}`,
            reason: new Error("cfc-relevant-transaction-not-prepared"),
          },
        });
      }

      if (this.#cfcState.prepare.status === "prepared") {
        const currentDigest = preparedDigestFor(
          this.buildPreparedDigestInput(),
        );
        if (currentDigest !== this.#cfcState.prepare.digest) {
          this.invalidateCfc("prepared-digest-mismatch");
          if (this.#cfcState.enforcementMode !== "observe") {
            return this.rejectCommitBeforeStorage({
              error: {
                name: "StorageTransactionAborted",
                message:
                  "CFC enforcement rejected commit: prepared digest changed",
                reason: new Error("cfc-prepared-digest-mismatch"),
              },
            });
          }
        }
      }
    }

    const promise = this.tx.commit();

    // Call commit callbacks after commit completes (success or failure) Note
    // that promise always resolves, even if the commit fails, in which case it
    // passes an error message as result. An exception here would be an internal
    // error that should propagate.
    promise.then((result) => {
      this.runCommitCallbacks(result);
    }).catch((error) => {
      logger.error(
        "storage-error",
        "Transaction commit promise rejected:",
        error,
      );
    });

    const result = await promise;
    if (result.ok && !readOnly) {
      for (const effect of this.#cfcState.outbox) {
        try {
          await effect.flush(this);
          this.cfcInstrumentation.onOutboxFlush?.(effect);
        } catch (error) {
          logger.error(
            "storage-error",
            "Post-commit side effect failed:",
            { effect, error },
          );
        }
      }
      this.outboxIdempotencyKeys.clear();
    } else {
      this.clearPostCommitOutbox();
    }

    return result;
  }

  /**
   * Add a callback to be called when the transaction commit completes.
   * The callback receives the transaction as a parameter and is called
   * regardless of whether the commit succeeded or failed.
   *
   * Note: Callbacks are called synchronously after commit completes.
   * If a callback throws, the error is logged but doesn't affect other callbacks.
   *
   * @param callback - Function to call after commit
   */
  addCommitCallback(
    callback: (
      tx: IExtendedStorageTransaction,
      result: Result<Unit, CommitError>,
    ) => void,
  ): void {
    this.assertWritable("addCommitCallback()");
    this.commitCallbacks.add(callback);
  }
}

/**
 * Options for configuring a TransactionWrapper.
 */
export interface TransactionWrapperOptions {
  /**
   * If true, adds ignoreReadForScheduling meta to all reads, making them
   * non-reactive.
   */
  nonReactive?: boolean;

  /**
   * Transaction to use for creating child cells. If not provided, uses the
   * wrapped transaction.
   */
  childCellTx?: IExtendedStorageTransaction;
}

/**
 * A configurable wrapper around an IExtendedStorageTransaction.
 *
 * Supports two modes that can be combined:
 * - nonReactive: Adds ignoreReadForScheduling meta to all reads
 * - childCellTx: Uses a different transaction for child cells
 *
 * Used by:
 * - Cell.sample(): nonReactive=true, childCellTx=wrapped (child cells reactive)
 * - Cell.sink(): nonReactive=false, childCellTx=extraTx (child cells on separate tx)
 */
export class TransactionWrapper implements IExtendedStorageTransaction {
  constructor(
    private wrapped: IExtendedStorageTransaction,
    private options: TransactionWrapperOptions = {},
  ) {}

  /**
   * Get the transaction to use for creating child cells.
   */
  getTransactionForChildCells(): IExtendedStorageTransaction {
    return this.options.childCellTx ?? this.wrapped;
  }

  get tx(): IStorageTransaction {
    return this.wrapped.tx;
  }

  getCfcState(): Readonly<CfcTxState> {
    return this.wrapped.getCfcState();
  }

  setCfcEnforcementMode(mode: CfcEnforcementMode): void {
    this.wrapped.setCfcEnforcementMode(mode);
  }

  setCfcFlowLabelsMode(mode: CfcFlowLabelsMode): void {
    this.wrapped.setCfcFlowLabelsMode(mode);
  }

  setCfcWriteFloorMode(mode: CfcWriteFloorMode): void {
    this.wrapped.setCfcWriteFloorMode(mode);
  }

  setCfcTriggerReadGating(enabled: CfcTriggerReadGating): void {
    this.wrapped.setCfcTriggerReadGating(enabled);
  }

  addCfcTriggerReads(reads: readonly IMemorySpaceAddress[]): void {
    this.wrapped.addCfcTriggerReads(reads);
  }

  runWithAmbientReadMeta<T>(meta: Metadata, fn: () => T): T {
    return this.wrapped.runWithAmbientReadMeta(meta, fn);
  }

  markCfcRelevant(reason?: string): void {
    this.wrapped.markCfcRelevant(reason);
  }

  noteCfcDiagnostic(message: string): void {
    this.wrapped.noteCfcDiagnostic(message);
  }

  invalidateCfc(reason: string): void {
    this.wrapped.invalidateCfc(reason);
  }

  getNarrowestReadScope(): CellScope {
    return this.wrapped.getNarrowestReadScope();
  }

  resetNarrowestReadScope(scope?: CellScope): void {
    this.wrapped.resetNarrowestReadScope(scope);
  }

  recordCfcDereferenceTrace(trace: CfcDereferenceTrace): void {
    this.wrapped.recordCfcDereferenceTrace(trace);
  }

  prepareCfc(): string {
    return this.wrapped.prepareCfc();
  }

  setCfcTrustSnapshot(snapshot: TrustSnapshot | undefined): void {
    this.wrapped.setCfcTrustSnapshot(snapshot);
  }

  setCfcImplementationIdentity(
    identity: ImplementationIdentity | undefined,
  ): void {
    this.wrapped.setCfcImplementationIdentity(identity);
  }

  recordCfcWritePolicyInput(input: WritePolicyInput): void {
    this.wrapped.recordCfcWritePolicyInput(input);
  }

  noteCfcSinkReleaseReject(
    info: { sink: string; effectId: string; detail: string },
  ): void {
    this.wrapped.noteCfcSinkReleaseReject(info);
  }

  enqueuePostCommitEffect(effect: PostCommitSideEffect): void {
    this.wrapped.enqueuePostCommitEffect(effect);
  }

  hasPendingPostCommitEffects(): boolean {
    return this.wrapped.hasPendingPostCommitEffects();
  }

  enableMultiSpaceWrites(order?: readonly MemorySpace[]): void {
    this.wrapped.enableMultiSpaceWrites?.(order);
  }

  setReadOnly(reason?: string): void {
    this.wrapped.setReadOnly?.(reason);
  }

  clearReadOnly(): void {
    this.wrapped.clearReadOnly?.();
  }

  isReadOnly(): boolean {
    return this.wrapped.isReadOnly?.() === true;
  }

  get journal(): ITransactionJournal {
    return this.wrapped.journal;
  }

  getReactivityLog(): TransactionReactivityLog {
    return this.wrapped.getReactivityLog?.() ??
      reactivityLogFromActivities(this.wrapped.journal.activity());
  }

  setSchedulerObservation(observation: unknown): void {
    this.wrapped.setSchedulerObservation?.(observation);
  }

  getSchedulerObservation(): unknown {
    return this.wrapped.getSchedulerObservation?.();
  }

  addCommitPrecondition(
    space: MemorySpace,
    precondition: CommitPrecondition,
  ): void {
    // Fail closed, like ExtendedStorageTransaction: a precondition is a
    // commit gate and must not be silently dropped.
    if (!this.wrapped.addCommitPrecondition) {
      throw new Error(
        "storage transaction does not support addCommitPrecondition()",
      );
    }
    this.wrapped.addCommitPrecondition(space, precondition);
  }

  getCommitPreconditions(
    space: MemorySpace,
  ): readonly CommitPrecondition[] | undefined {
    return this.wrapped.getCommitPreconditions?.(space);
  }

  markCreateOnly(
    link: { space: MemorySpace; id: string; scope?: unknown },
  ): void {
    this.wrapped.markCreateOnly?.(link);
  }

  recordMergeableOp(link: NormalizedFullLink, delta: MergeableOpDelta): void {
    this.wrapped.recordMergeableOp?.(link, delta);
  }

  recordSqliteWrite(space: MemorySpace, op: SqliteOperation): void {
    if (!this.wrapped.recordSqliteWrite) {
      throw new Error(
        "storage transaction does not support recordSqliteWrite()",
      );
    }
    this.wrapped.recordSqliteWrite(space, op);
  }

  getReadActivities(): Iterable<IReadActivity> {
    return this.wrapped.getReadActivities?.() ??
      getTransactionReadActivities(this.wrapped.tx);
  }

  getWriteDetails(
    space: MemorySpace,
  ): Iterable<TransactionWriteDetail> {
    return this.wrapped.getWriteDetails?.(space) ??
      getTransactionWriteDetails(this.wrapped.tx, space);
  }

  status(): StorageTransactionStatus {
    return this.wrapped.status();
  }

  private transformReadOptions(options?: IReadOptions): IReadOptions {
    if (!this.options.nonReactive) {
      return options ?? {};
    }
    return {
      ...options,
      meta: { ...options?.meta, ...ignoreReadForScheduling },
    };
  }

  read(
    address: IMemorySpaceAddress,
    options?: IReadOptions,
  ): Result<IAttestation, ReadError> {
    return this.wrapped.read(address, this.transformReadOptions(options));
  }

  readOrThrow(
    address: IMemorySpaceAddress,
    options?: IReadOptions,
  ): FabricValue {
    return this.wrapped.readOrThrow(
      address,
      this.transformReadOptions(options),
    );
  }

  readValueOrThrow(
    address: NormalizedFullLink,
    options?: IReadOptions,
  ): FabricValue {
    return this.wrapped.readValueOrThrow(
      address,
      this.transformReadOptions(options),
    );
  }

  write(
    address: IMemorySpaceAddress,
    value: FabricValue,
    options?: IWriteOptions,
  ): Result<IAttestation, WriteError | WriterError> {
    return this.wrapped.write(address, value, options);
  }

  writeOrThrow(
    address: IMemorySpaceAddress,
    value: FabricValue,
    options?: IWriteOptions,
  ): void {
    return this.wrapped.writeOrThrow(address, value, options);
  }

  writeValueOrThrow(
    address: NormalizedFullLink,
    value: FabricValue,
    options?: IWriteOptions,
  ): void {
    return this.wrapped.writeValueOrThrow(address, value, options);
  }

  writeValuesOrThrow(
    writes: Iterable<
      { address: NormalizedFullLink; value: FabricValue; delete?: boolean }
    >,
  ): void {
    if (this.wrapped.writeValuesOrThrow) {
      return this.wrapped.writeValuesOrThrow(writes);
    }
    for (const write of writes) {
      this.wrapped.writeValueOrThrow(
        write.address,
        write.value,
        write.delete ? { delete: true } : undefined,
      );
    }
  }

  abort(reason?: unknown): Result<Unit, InactiveTransactionError> {
    return this.wrapped.abort(reason);
  }

  commit(): Promise<Result<Unit, CommitError>> {
    return this.wrapped.commit();
  }

  addCommitCallback(
    callback: (
      tx: IExtendedStorageTransaction,
      result: Result<Unit, CommitError>,
    ) => void,
  ): void {
    return this.wrapped.addCommitCallback(callback);
  }
}

/**
 * Create a non-reactive transaction wrapper for Cell.sample().
 * Reads won't trigger re-execution, but child cells will be reactive.
 */
export function createNonReactiveTransaction(
  tx: IExtendedStorageTransaction,
): TransactionWrapper {
  return new TransactionWrapper(tx, { nonReactive: true, childCellTx: tx });
}

/**
 * Create a transaction wrapper for Cell.sink() that uses a separate transaction
 * for child cells.
 */
export function createChildCellTransaction(
  tx: IExtendedStorageTransaction,
  childCellTx: IExtendedStorageTransaction,
): TransactionWrapper {
  return new TransactionWrapper(tx, { childCellTx });
}

/**
 * Helper function to get the transaction to use for creating child cells from a
 * potentially wrapped transaction. If the transaction is not wrapped, returns
 * it as-is.
 *
 * Used when creating child cells that should use a different transaction than
 * the parent read (e.g., in Cell.sample() or Cell.sink()).
 */
export function getTransactionForChildCells(
  tx: IExtendedStorageTransaction | undefined,
): IExtendedStorageTransaction | undefined {
  if (tx instanceof TransactionWrapper) {
    return tx.getTransactionForChildCells();
  }
  return tx;
}
