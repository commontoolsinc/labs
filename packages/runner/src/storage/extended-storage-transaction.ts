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
  IWriteAttempt,
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
  getTransactionWriteAttempts,
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
  CFC_GRANT_ID_PREFIX,
  type CfcAddress,
  type CfcDeclaredMonotonicityMode,
  type CfcDeclaredWideningExemption,
  type CfcDereferenceTrace,
  type CfcEnforcementMode,
  cfcEnforcementStrictness,
  type CfcFlowLabelsMode,
  type CfcGrantWriteInput,
  type CfcLabelMetadataObservation,
  type CfcLabelMetadataProtectionMode,
  type CfcPolicyEvaluationMode,
  type CfcPrefixProvenanceSummary,
  type CfcTriggerReadGating,
  type CfcTrustConfig,
  type CfcTxState,
  type CfcWriteFloorMode,
  type ConsultedGrant,
  type ConsultedPolicyManifest,
  type ConsumedRead,
  DEFAULT_CFC_DECLARED_MONOTONICITY_MODE,
  DEFAULT_CFC_ENFORCEMENT_MODE,
  DEFAULT_CFC_FLOW_LABELS_MODE,
  DEFAULT_CFC_LABEL_METADATA_PROTECTION_MODE,
  DEFAULT_CFC_POLICY_EVALUATION_MODE,
  DEFAULT_CFC_TRIGGER_READ_GATING,
  DEFAULT_CFC_WRITE_FLOOR_MODE,
  flowLabelWorkExists,
  flowReadExcluded,
  gatedSinkRequestExists,
  type ImplementationIdentity,
  type OrderedWriteAttempt,
  type PolicySnapshot,
  type PostCommitSideEffect,
  prepareBoundaryCommit,
  prepareCfcGrantWrite,
  preparedDigestFor,
  type PreparedDigestInput,
  type SinkMaxConfidentiality,
  type TrustSnapshot,
  type WritePolicyInput,
} from "../cfc/mod.ts";
import { CFC_POLICY_MANIFEST_ID_PREFIX } from "../cfc/policy.ts";

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
  // Stage-0 D4 precision counters (cfc-value-level-provenance.md §6, SC-24):
  // one summary per prepared transaction that measured a protected write.
  // When absent — the default — the prepare gate skips all measurement.
  onPrefixProvenance?(summary: CfcPrefixProvenanceSummary): void;
  resolvePolicyManifest?(
    reference: unknown,
    tx: IExtendedStorageTransaction,
    destinationSpace?: MemorySpace,
    bindCommit?: boolean,
  ): unknown;
  hasPolicyManifest?(
    space: MemorySpace,
    reference: unknown,
    tx: IExtendedStorageTransaction,
  ): boolean;
  installPolicyManifest?(
    space: MemorySpace,
    reference: unknown,
    tx: IExtendedStorageTransaction,
  ): boolean;
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

// Exported for tests: the bypass vectors (descriptor recovery, Map
// iteration leaks) are pinned by unit-testing the helper directly.
export const readOnlyCfcView = <T>(value: T): T => {
  if (value === null || typeof value !== "object") return value;
  if (Object.isFrozen(value)) return value;
  const cached = readOnlyCfcViews.get(value);
  if (cached !== undefined) return cached as T;
  let view: object;
  if (value instanceof Map) {
    // Map methods work on an internal slot, so they must be called on the
    // real Map, not the proxy. Read results are re-wrapped, and every API
    // that would surface the backing map or its values raw is intercepted:
    // forEach's third callback argument is the view, and get / entries /
    // values / iteration yield wrapped values (cubic round 3 on #4517).
    // Keys pass raw on purpose — they are the frozen records whose
    // reference identity callers key on.
    const target = value as Map<unknown, unknown>;
    const mapView: Map<unknown, unknown> = new Proxy(target, {
      get(_t, prop) {
        switch (prop) {
          case "set":
          case "delete":
          case "clear":
            return throwCfcReadOnly;
          case "get":
            return (key: unknown) => readOnlyCfcView(target.get(key));
          case "forEach":
            return (
              cb: (v: unknown, k: unknown, m: unknown) => void,
              thisArg?: unknown,
            ) =>
              target.forEach((v, k) =>
                cb.call(thisArg, readOnlyCfcView(v), k, mapView)
              );
          case "entries":
          case Symbol.iterator:
            return function* () {
              for (const [k, v] of target.entries()) {
                yield [k, readOnlyCfcView(v)];
              }
            };
          case "values":
            return function* () {
              for (const v of target.values()) yield readOnlyCfcView(v);
            };
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
    });
    view = mapView;
  } else {
    view = new Proxy(value, {
      get(target, prop, receiver) {
        const member = Reflect.get(target, prop, receiver);
        return typeof member === "function" ? member : readOnlyCfcView(member);
      },
      // Without this trap, Object/Reflect.getOwnPropertyDescriptor(view, k)
      // hands back a descriptor whose `value` is the raw nested object
      // (cubic round 3 on #4517). Re-wrap it. Allowed by the proxy
      // invariants: the state's own properties are configurable, and a
      // configurable data property may report a different value.
      getOwnPropertyDescriptor(target, prop) {
        const desc = Reflect.getOwnPropertyDescriptor(target, prop);
        if (desc !== undefined && "value" in desc) {
          return { ...desc, value: readOnlyCfcView(desc.value) };
        }
        return desc;
      },
      set: throwCfcReadOnly,
      defineProperty: throwCfcReadOnly,
      deleteProperty: throwCfcReadOnly,
      setPrototypeOf: throwCfcReadOnly,
    });
  }
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
    policyEvaluationMode: DEFAULT_CFC_POLICY_EVALUATION_MODE,
    labelMetadataProtectionMode: DEFAULT_CFC_LABEL_METADATA_PROTECTION_MODE,
    declaredMonotonicityMode: DEFAULT_CFC_DECLARED_MONOTONICITY_MODE,
    prepare: { status: "unprepared" },
    dereferenceTraces: [],
    structureContainers: [],
    triggerReads: [],
    writePolicyInputs: [],
    writePolicyInputIdentities: new Map(),
    writeIdentity: { sawWrite: false, multiple: false },
    moduleDelegations: new Map(),
    outbox: [],
    diagnostics: [],
    unprivilegedSystemWrites: [],
    consultedGrants: [],
    consultedPolicyManifests: [],
    labelMetadataObservations: [],
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
  #cfcPolicyEvaluationPinned = false;
  #cfcLabelMetadataProtectionPinned = false;
  #cfcDeclaredMonotonicityPinned = false;
  // Write-once pin for the deployment policy snapshot. Distinct from the
  // slot's value being defined: the Runtime configures MANY tx with NO
  // policies (`undefined`), and that "no policies" state must be just as
  // write-once as a configured one — otherwise handler code reaching the
  // concrete tx via `(cell.tx as any)` could install an attacker-supplied
  // snapshot after the Runtime's `undefined` call left the slot open
  // (codex P1 on #4562). Set on the FIRST call (always the Runtime's, in
  // edit()), regardless of value.
  #cfcPolicySnapshotPinned = false;
  // Write-once pin for the deployment trust config. Distinct from the slot's
  // value being defined: the Runtime configures many tx with NO trust config
  // (`undefined`), and that "no config; every concept guard fails closed"
  // state must be just as write-once as a configured one — otherwise handler
  // code reaching the concrete tx via `(cell.tx as any)` could install an
  // arbitrary config before the concept guards read it (codex P2 on #4563).
  // Set on the FIRST call (always the Runtime's, in edit()), regardless of
  // value.
  #cfcTrustConfigPinned = false;
  #cfcModuleDelegationsPinned = false;
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

  resolveCfcPolicyManifest(
    reference: unknown,
    destinationSpace?: MemorySpace,
    bindCommit?: boolean,
  ): unknown {
    return this.cfcInstrumentation.resolvePolicyManifest?.(
      reference,
      this,
      destinationSpace,
      bindCommit,
    );
  }

  hasCfcPolicyManifest(space: MemorySpace, reference: unknown): boolean {
    return this.cfcInstrumentation.hasPolicyManifest?.(
      space,
      reference,
      this,
    ) ?? false;
  }

  installCfcPolicyManifest(space: MemorySpace, reference: unknown): boolean {
    return this.cfcInstrumentation.installPolicyManifest?.(
      space,
      reference,
      this,
    ) ?? false;
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
    // The flow-labels mode drives prepareBoundaryCommit (which derived
    // components are stamped and credited) but is not part of
    // PreparedDigestInput, so a change after prepare must invalidate the
    // prepared decision — otherwise a strengthen-after-prepare survives the
    // commit-time digest recheck while the tx reports the stronger mode
    // (same silent-downgrade class as the policy-evaluation setter below;
    // review of #4566). Only a real change invalidates.
    if (
      this.#cfcState.flowLabelsMode !== mode &&
      this.#cfcState.prepare.status === "prepared"
    ) {
      this.invalidateCfc("flow-labels-mode-changed");
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
    // The write-floor mode drives which SC-18 floor reasons prepare records
    // but is not in PreparedDigestInput, so — like the flow-labels and
    // policy-evaluation setters — a change after prepare must invalidate,
    // else a strengthen (off/observe → enforce) after prepare could commit
    // the stale permissive decision while the tx reports enforce.
    if (
      this.#cfcState.writeFloorMode !== mode &&
      this.#cfcState.prepare.status === "prepared"
    ) {
      this.invalidateCfc("write-floor-mode-changed");
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

  setCfcPolicyEvaluationMode(mode: CfcPolicyEvaluationMode): void {
    // Anti-downgrade pin (mirrors the write floor): once `enforce` is set —
    // by the runtime at tx creation — code reaching the tx cannot weaken it
    // to `observe`/`off` so the boundary gates decide on un-rewritten labels
    // again (or skip the exhaustion fail-close). Strengthening is allowed.
    if (this.#cfcPolicyEvaluationPinned && mode !== "enforce") {
      throw new Error(
        `CFC policy-evaluation mode cannot be weakened to "${mode}": ` +
          `transaction is pinned at "enforce"`,
      );
    }
    // A strengthen after prepare (e.g. off/observe → enforce) changes which
    // label a gate decides on and whether fuel exhaustion fails closed, but
    // the mode is not part of PreparedDigestInput — so a prepared decision
    // computed under the old mode must be invalidated, or the commit-time
    // recheck would pass it through while the tx now reports `enforce`
    // (codex P2 on #4566). Only a real change invalidates (the Runtime's
    // idempotent set at tx creation, before prepare, does not).
    if (
      this.#cfcState.policyEvaluationMode !== mode &&
      this.#cfcState.prepare.status === "prepared"
    ) {
      this.invalidateCfc("policy-evaluation-mode-changed");
    }
    this.#cfcState.policyEvaluationMode = mode;
    if (mode === "enforce") {
      this.#cfcPolicyEvaluationPinned = true;
    }
  }

  setCfcLabelMetadataProtectionMode(
    mode: CfcLabelMetadataProtectionMode,
  ): void {
    // Anti-downgrade pin (mirrors the write floor): once `enforce` is set —
    // by the runtime at tx creation — pattern/handler code that reaches the
    // tx cannot weaken it to `observe`/`off` so cross-space label metadata
    // persists verbatim again (inv-12 Stage 1 / SC-25). Strengthening to
    // `enforce` is always allowed.
    if (this.#cfcLabelMetadataProtectionPinned && mode !== "enforce") {
      throw new Error(
        `CFC label-metadata protection mode cannot be weakened to "${mode}": ` +
          `transaction is pinned at "enforce"`,
      );
    }
    // The mode drives which representation prepareBoundaryCommit persists but
    // is not part of PreparedDigestInput, so — like the flow-labels /
    // write-floor / policy-evaluation setters — a real change after prepare
    // must invalidate the prepared decision; the Runtime's idempotent set at
    // tx creation (before prepare) does not.
    if (
      this.#cfcState.labelMetadataProtectionMode !== mode &&
      this.#cfcState.prepare.status === "prepared"
    ) {
      this.invalidateCfc("label-metadata-protection-mode-changed");
    }
    this.#cfcState.labelMetadataProtectionMode = mode;
    if (mode === "enforce") {
      this.#cfcLabelMetadataProtectionPinned = true;
    }
  }

  setCfcDeclaredMonotonicityMode(mode: CfcDeclaredMonotonicityMode): void {
    // Anti-downgrade pin (mirrors the write floor): once `enforce` is set —
    // by the runtime at tx creation — pattern/handler code that reaches the
    // tx cannot weaken it to `observe`/`off` and slip a non-monotone
    // declared re-mint through (WP5, §8.12.1). Strengthening to `enforce`
    // is always allowed.
    if (this.#cfcDeclaredMonotonicityPinned && mode !== "enforce") {
      throw new Error(
        `CFC declared-monotonicity mode cannot be weakened to "${mode}": ` +
          `transaction is pinned at "enforce"`,
      );
    }
    // The mode drives which prepare reasons/diagnostics the gate records but
    // is not part of PreparedDigestInput, so — like the flow-labels /
    // write-floor / policy-evaluation setters — a real change after prepare
    // must invalidate the prepared decision; the Runtime's idempotent set at
    // tx creation (before prepare) does not.
    if (
      this.#cfcState.declaredMonotonicityMode !== mode &&
      this.#cfcState.prepare.status === "prepared"
    ) {
      this.invalidateCfc("declared-monotonicity-mode-changed");
    }
    this.#cfcState.declaredMonotonicityMode = mode;
    if (mode === "enforce") {
      this.#cfcDeclaredMonotonicityPinned = true;
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

  // set once by the Runtime at tx creation. Write-once, off the public tx
  // interface, deep-frozen on store. The pin (not the slot value) is what
  // enforces write-once: the FIRST call — always the Runtime's, even when it
  // configures no policies (`undefined`) — pins the slot, so a later
  // `(cell.tx as any).setCfcPolicySnapshot(attackerSnapshot)` is ignored.
  // (`buildCfcPolicySnapshot` already froze a configured snapshot; this
  // deepFreeze is the cheap short-circuiting backstop for any other caller.)
  setCfcPolicySnapshot(snapshot: PolicySnapshot | undefined): void {
    if (this.#cfcPolicySnapshotPinned) return;
    this.#cfcPolicySnapshotPinned = true;
    this.#cfcState.policySnapshot = snapshot === undefined
      ? undefined
      : deepFreeze(snapshot);
  }

  // Deployment trust config for concept-guard satisfaction (Epic B3). The pin
  // (not the slot value) enforces write-once: the FIRST call — always the
  // Runtime's, even when it configures no trust (`undefined`) — pins the slot,
  // so a later `(cell.tx as any).setCfcTrustConfig(attackerConfig)` is
  // ignored and the "no config; concept guards fail closed" state holds.
  setCfcTrustConfig(config: CfcTrustConfig | undefined): void {
    if (this.#cfcTrustConfigPinned) return;
    this.#cfcTrustConfigPinned = true;
    this.#cfcState.trustConfig = config === undefined
      ? undefined
      : deepFreeze(config);
  }

  // Module-update authority is runtime-learned trust state. Snapshot and pin
  // it once at transaction creation: later module loads affect future
  // transactions, never an authorization decision already in flight.
  setCfcModuleDelegations(
    delegations: ReadonlyMap<string, readonly string[]>,
  ): void {
    if (this.#cfcModuleDelegationsPinned) return;
    this.#cfcModuleDelegationsPinned = true;
    const snapshot = new Map<string, readonly string[]>();
    for (const [identity, predecessors] of delegations) {
      snapshot.set(identity, [...predecessors]);
    }
    this.#cfcState.moduleDelegations = snapshot;
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
    if (address.id.startsWith(CFC_POLICY_MANIFEST_ID_PREFIX)) {
      throw new Error(
        `cfcPolicyManifest: ${address.id} is immutable reserved policy state`,
      );
    }
    // Reserved grant documents (§8.12.7 route 2a, cfc/grants.ts): the WHOLE
    // document is policy state — a forged grant at the derived address would
    // spend another principal's release authority — so any unprivileged
    // write at ANY path (value, root, or cfc sibling) is recorded. The one
    // sanctioned writer is `writeCfcGrant` below, which validates and then
    // writes inside the privileged scope.
    if (address.id.startsWith(CFC_GRANT_ID_PREFIX)) {
      this.markCfcRelevant("unprivileged-cfc-grant-write");
      this.#cfcState.unprivilegedSystemWrites.push(
        `${address.id}/${address.path.join("/")}`,
      );
      return;
    }
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

  private recordReadScope(address: Pick<IMemorySpaceAddress, "scope">): void {
    const scope = normalizeCellScope(address.scope);
    if (scopeRank(scope) > scopeRank(this.narrowestReadScope)) {
      this.narrowestReadScope = scope;
    }
  }

  private prepareRead(address: Pick<IMemorySpaceAddress, "scope">): void {
    if (this.#cfcState.prepare.status === "prepared") {
      this.invalidateCfc("read-after-prepare");
    }
    this.recordReadScope(address);
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

  recordCfcStructureContainer(address: CfcAddress): void {
    this.#cfcState.structureContainers.push(deepFreeze(address));
    if (this.#cfcState.prepare.status === "prepared") {
      this.invalidateCfc("structure-container-added");
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

  recordCfcConsultedGrant(consulted: ConsultedGrant): void {
    // Dedup by address: the resolver memoizes per query, but two different
    // guards can compute the same candidate — one digest entry per document.
    // The journal snapshot keeps re-reads stable WITHIN one evaluation, but a
    // consulted grant can legitimately change ACROSS evaluations of the same
    // transaction (a privileged writeCfcGrant between prepares lands in the
    // journal), so a re-consultation carrying a DIFFERENT digest replaces the
    // stale record — the prepared digest must bind the grant state the
    // LATEST boundary evaluation consumed, never a superseded one (cubic P1
    // on #4627).
    const index = this.#cfcState.consultedGrants.findIndex((existing) =>
      existing.space === consulted.space && existing.id === consulted.id
    );
    if (index !== -1) {
      if (this.#cfcState.consultedGrants[index].digest === consulted.digest) {
        return;
      }
      this.#cfcState.consultedGrants[index] = deepFreeze(consulted);
      if (this.#cfcState.prepare.status === "prepared") {
        this.invalidateCfc("consulted-grant-changed");
      }
      return;
    }
    this.#cfcState.consultedGrants.push(deepFreeze(consulted));
    // Grants are consulted DURING prepare (the boundary gates); recording
    // after a prepare stamped its digest means the decision inputs grew —
    // same invalidation posture as every other recorder above.
    if (this.#cfcState.prepare.status === "prepared") {
      this.invalidateCfc("consulted-grant-added");
    }
  }

  recordCfcConsultedPolicyManifest(
    consulted: ConsultedPolicyManifest,
  ): void {
    const index = this.#cfcState.consultedPolicyManifests.findIndex(
      (existing) => deepEqual(existing.reference, consulted.reference),
    );
    if (index !== -1) {
      if (
        this.#cfcState.consultedPolicyManifests[index].state === consulted.state
      ) {
        return;
      }
      this.#cfcState.consultedPolicyManifests[index] = deepFreeze(consulted);
      if (this.#cfcState.prepare.status === "prepared") {
        this.invalidateCfc("consulted-policy-manifest-changed");
      }
      return;
    }
    this.#cfcState.consultedPolicyManifests.push(deepFreeze(consulted));
    if (this.#cfcState.prepare.status === "prepared") {
      this.invalidateCfc("consulted-policy-manifest-added");
    }
  }

  recordCfcLabelMetadataObservation(
    observation: CfcLabelMetadataObservation,
  ): void {
    // Public observations (empty population label) are dropped, not stored:
    // an empty label adds nothing to the flow join, the consumed set, or any
    // gate, and skipping them keeps "an observation was recorded" ⇔ "the tx
    // consumed protected label metadata" — which is exactly the relevance
    // condition below.
    if (observation.confidentiality.length === 0) {
      return;
    }
    this.#cfcState.labelMetadataObservations.push(deepFreeze(observation));
    // A labeled metadata observation makes the transaction CFC-relevant
    // directly (like noteSystemWrite): its taint must reach the flow
    // derivation and the enforcement gates even when nothing else in the tx
    // touches labeled data — the commit-time relevance probes only inspect
    // journal reads and write targets, which this channel bypasses.
    this.markCfcRelevant("label-metadata-observation");
    if (this.#cfcState.prepare.status === "prepared") {
      this.invalidateCfc("label-metadata-observation-added");
    }
  }

  writeCfcGrant(input: CfcGrantWriteInput): { space: MemorySpace; id: string } {
    this.assertWritable("writeCfcGrant()");
    // The trusted policy-writer path (§8.12.7 route 2a, design §2.3
    // soundness condition 1): validation — trusted-writer identity (below),
    // audience principal-like (§3.1.8), owner === the transaction's acting
    // principal (release authority; the fuller §13.4.3 intent-evidence
    // chain arrives with intents), lifecycle shape — happens INSIDE this
    // method, atomically with the privileged write, so no caller can reach
    // the reserved namespace with unvalidated content.
    //
    // Trusted-writer gate (codex P1 on #4627): a grant is DURABLE release
    // state — far stronger than a single gated egress — so authoring it
    // requires the transaction's current implementation identity to be a
    // trusted BUILTIN, exactly the arm `writeAuthorizedBy` and the
    // runtime-mint gate (`gateRuntimeMintedIntegrity`) trust for
    // runtime-evidence writes today. Ordinary pattern/handler code runs
    // under a `verified` (or no) identity and is refused; the share
    // surface's trusted builtin writer sets its identity the way the llm /
    // compile-cache builtins do. The §13.4.3 intent-evidence verification
    // (rendered-state match, trusted surface concept) strengthens this gate
    // when the §6 intent substrate lands.
    const identity = this.#cfcState.implementationIdentity;
    if (identity?.kind !== "builtin") {
      throw new Error(
        "cfc-grant: writeCfcGrant requires a trusted builtin implementation " +
          "identity (the trusted policy-writer path; design §2.3 condition 1)",
      );
    }
    const prepared = prepareCfcGrantWrite(
      input,
      this.#cfcState.trustSnapshot?.actingPrincipal,
    );
    // Deliberately NOT marked CFC-relevant: relevance forces boundary
    // verification of activity the runtime has not yet verified, and this
    // path is self-verifying — the validation above runs atomically before
    // the privileged write, and a throw leaves nothing written. Relevance
    // for grant docs belongs to the UNPRIVILEGED arm (noteSystemWrite),
    // where a forged write must surface a fail-closed prepare reason. A
    // transaction that is otherwise relevant still binds this write into
    // its prepared digest through the ordinary write journal.
    this.#runPrivilegedSystemWrite(() => {
      this.writeOrThrow({
        space: prepared.space,
        id: prepared.id,
        type: "application/json",
        path: ["value"],
      }, prepared.value as unknown as FabricValue);
    });
    return { space: prepared.space, id: prepared.id };
  }

  setCfcDeclaredWideningExemption(
    exemption: CfcDeclaredWideningExemption,
  ): void {
    // The §8.12.7 route 2b seam (docs/specs/cfc-persisted-declassification.md
    // §4): the future declassification-event writer exempts exactly ONE
    // (doc, path, clauseDigest) triple from the declared-monotonicity gate
    // for this transaction. Same privileged discipline as writeCfcGrant —
    // an in-place widening of the declared component is durable release
    // state, so authoring the exemption requires a trusted BUILTIN
    // implementation identity; ordinary pattern/handler code runs under a
    // `verified` (or no) identity and is refused.
    const identity = this.#cfcState.implementationIdentity;
    if (identity?.kind !== "builtin") {
      throw new Error(
        "cfc-declared-monotonicity: setCfcDeclaredWideningExemption requires " +
          "a trusted builtin implementation identity (the §8.12.7 route 2b " +
          "declassification-event discipline)",
      );
    }
    // Fail closed on any malformed or over-broad marker: every field names
    // one concrete thing — no wildcards, no empty identifiers, no non-string
    // path segments. A rejected marker leaves the gate fully in force.
    if (
      !isRecord(exemption) ||
      typeof exemption.space !== "string" || exemption.space.length === 0 ||
      typeof exemption.id !== "string" || exemption.id.length === 0 ||
      !Array.isArray(exemption.path) ||
      !exemption.path.every((segment) => typeof segment === "string") ||
      typeof exemption.clauseDigest !== "string" ||
      exemption.clauseDigest.length === 0
    ) {
      throw new Error(
        "cfc-declared-monotonicity: malformed widening exemption (space, id " +
          "and clauseDigest must be non-empty strings; path must be a string " +
          "array — no wildcard exemptions)",
      );
    }
    // Write-once: ONE named triple per transaction. A second exemption is a
    // second declassification event and belongs in its own transaction.
    if (this.#cfcState.declaredWideningExemption !== undefined) {
      throw new Error(
        "cfc-declared-monotonicity: a widening exemption is already set for " +
          "this transaction (one (doc, path, clauseDigest) triple per tx)",
      );
    }
    this.#cfcState.declaredWideningExemption = deepFreeze({
      space: exemption.space,
      id: exemption.id,
      path: canonicalizeLogicalPath(exemption.path),
      clauseDigest: exemption.clauseDigest,
    });
    // The exemption changes the gate's prepare-time decision but is not part
    // of PreparedDigestInput — invalidate a prepared decision like the mode
    // setters above.
    if (this.#cfcState.prepare.status === "prepared") {
      this.invalidateCfc("declared-widening-exemption-added");
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
    // Activity-clock ranks for the digest: the prefix-provenance gate
    // consumes only the RELATIVE order of non-internal reads and write
    // attempts, so the digest binds dense ranks over exactly that set. Raw
    // clock values would additionally encode how many runtime-internal
    // (verifier-marked) reads interleaved — noise that must not perturb the
    // enforcement identity of otherwise-identical transactions (pinned by
    // the boundary test "does not let helper source-cell reads affect the
    // prepared digest"). Any reorder among the ranked items still flips
    // ranks, so the §6 invalidation property is intact.
    const pendingReads: Array<{ read: IReadActivity; raw?: number }> = [];
    const rawRanks: number[] = [];
    for (const read of this.getReadActivities()) {
      if (isInternalVerifierRead(read.meta)) {
        continue;
      }
      pendingReads.push({ read, raw: read.journalIndex });
      if (read.journalIndex !== undefined) {
        rawRanks.push(read.journalIndex);
      }
    }
    const rawAttempts = [...this.getWriteAttemptLog()];
    for (const attempt of rawAttempts) {
      rawRanks.push(attempt.journalIndex);
    }
    const rankByRaw = new Map<number, number>();
    rawRanks.sort((a, b) => a - b).forEach((raw, rank) => {
      rankByRaw.set(raw, rank);
    });

    const consumedReads: ConsumedRead[] = [];
    for (const { read, raw } of pendingReads) {
      // Strip the raw stamp before the spread; re-attach its rank (or leave
      // the field absent when the backend never stamped one — an explicit
      // undefined would hash differently from absence).
      const { journalIndex: _raw, ...bare } = read;
      consumedReads.push(deepFreeze({
        ...bare,
        scope: normalizeCellScope(read.scope),
        path: canonicalizeLogicalPath(read.path),
        ...(raw !== undefined ? { journalIndex: rankByRaw.get(raw)! } : {}),
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

    // The §6 order binding: the temporal write sequence, rank-stamped on the
    // same scale as the consumed reads above. Paths stay RAW — see
    // OrderedWriteAttempt.
    const writeAttemptLog: OrderedWriteAttempt[] = [];
    for (const attempt of rawAttempts) {
      writeAttemptLog.push(deepFreeze({
        space: attempt.space,
        id: attempt.id,
        scope: normalizeCellScope(attempt.scope),
        path: [...attempt.path],
        journalIndex: rankByRaw.get(attempt.journalIndex)!,
      }));
    }

    return {
      consumedReads,
      attemptedWrites,
      writes,
      writeAttemptLog,
      dereferenceTraces: [...this.#cfcState.dereferenceTraces],
      triggerReads: [...this.#cfcState.triggerReads],
      writePolicyInputs: [...this.#cfcState.writePolicyInputs],
      implementationIdentity: this.#cfcState.implementationIdentity,
      trustSnapshot: this.#cfcState.trustSnapshot,
      ...(this.#cfcState.moduleDelegations.size > 0
        ? {
          moduleDelegations: [...this.#cfcState.moduleDelegations]
            .map(([moduleIdentity, delegatedModuleIdentities]) => ({
              moduleIdentity,
              delegatedModuleIdentities: [...delegatedModuleIdentities].sort(),
            }))
            .sort((left, right) =>
              left.moduleIdentity < right.moduleIdentity
                ? -1
                : left.moduleIdentity > right.moduleIdentity
                ? 1
                : 0
            ),
        }
        : {}),
      // Digest-only projection: the decision-relevant identity of the policy
      // set (Epic B5). The snapshot itself is frozen Runtime config; only its
      // identity needs to invalidate.
      policySnapshot: this.#cfcState.policySnapshot === undefined
        ? undefined
        : { digest: this.#cfcState.policySnapshot.digest },
      // Consulted grants (§8.12.7 route 2a): the resolution-time content
      // digests recorded by the grant resolver — a boundary decision's
      // policy-state inputs, bound the same way policySnapshot.digest is
      // (drift between prepare and the commit-time rebuild mismatches →
      // cfc-prepared-digest-mismatch). EXTERNAL mutation between prepare
      // and commit is additionally rejected for WRITING transactions by the
      // storage layer's claim pass — the resolver's read validated the
      // grant document snapshot; a zero-write transaction skips that pass,
      // the same snapshot-consistency posture every labeled read has, and a
      // revocation then takes effect on the next evaluation (design §2.2).
      ...(this.#cfcState.consultedGrants.length > 0
        ? { consultedGrants: [...this.#cfcState.consultedGrants] }
        : {}),
      ...(this.#cfcState.consultedPolicyManifests.length > 0
        ? {
          consultedPolicyManifests: [
            ...this.#cfcState.consultedPolicyManifests,
          ],
        }
        : {}),
      // Label-metadata observations (inv-12 Stage 2): boundary-decision
      // inputs (they change the flow join and the consumed set), bound like
      // writePolicyInputs. Absent-when-empty keeps pre-Stage-2 digests
      // byte-identical.
      ...(this.#cfcState.labelMetadataObservations.length > 0
        ? {
          labelMetadataObservations: [
            ...this.#cfcState.labelMetadataObservations,
          ],
        }
        : {}),
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
      prepareBoundaryCommit(
        this,
        // Stage-0 precision counters: threaded through only when the hook is
        // installed, so the gate skips all measurement (and the summary
        // allocation) otherwise. The non-null assertion restates the
        // presence check above — the hooks object is fixed at construction.
        this.cfcInstrumentation.onPrefixProvenance === undefined ? undefined : {
          onPrefixProvenance: (summary) =>
            this.cfcInstrumentation.onPrefixProvenance!(summary),
        },
      )
    );
    if (reasons.length > 0) {
      this.cfcInstrumentation.onPrepareReject?.(reasons);
      // A recorded reason makes the transaction CFC-relevant by definition.
      // Without this mark, a reasoned transaction whose reads/writes never
      // tripped an eager mark (e.g. a schema-less labeled flow feeding a
      // writer-fit misfit) leaves `relevant` false; the commit-time probes
      // skip non-`unprepared` prepare states, so the enforcement ladder's
      // reject would silently fail open (same shape as the late-sink-request
      // hole, Codex P2 on #4070).
      this.markCfcRelevant("prepare-reasons");
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
    // Fail closed, same posture as addCommitPrecondition above: a
    // create-only mark is a commit gate — the exactly-once witness for
    // event receipts and single-use grant consumption — so silently
    // swallowing it over an inner transaction that cannot enforce it would
    // let a duplicate commit through unguarded (cubic P1 on #4649). Every
    // production transaction (v2) implements it; this arm exists for
    // hand-built/legacy inner transactions.
    if (!this.tx.markCreateOnly) {
      throw new Error(
        "storage transaction does not support markCreateOnly()",
      );
    }
    let marks = this.createOnlyMarks.get(link.space);
    if (!marks) {
      marks = new Set();
      this.createOnlyMarks.set(link.space, marks);
    }
    marks.add(createOnlyMarkKey(link));
    this.tx.markCreateOnly(link);
  }

  recordMergeableOp(link: NormalizedFullLink, delta: MergeableOpDelta): void {
    this.assertWritable("recordMergeableOp");
    const address = toMemorySpaceAddress(link);
    // Same S18 chokepoint as write()/writeOrThrow(): a mergeable op IS a
    // write. The ["cfc"]-path arm is structurally unreachable here (a
    // NormalizedFullLink always yields a value-rooted storage path), but the
    // reserved `grant:cfc:` documents are keyed by ID, and the mergeable
    // path must not slip an unprivileged grant mutation past the gate.
    this.noteSystemWrite(address);
    this.tx.recordMergeableOp?.(address, delta);
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

  getWriteAttemptLog(): readonly IWriteAttempt[] {
    // Absent source (a custom transaction with neither a native log nor a
    // journal) degrades to an empty log; the CFC prefix gate then finds no
    // overlapping attempt for any target and falls back to
    // transaction-global gating (conservative), never to a too-early bound.
    return getTransactionWriteAttempts(this.tx) ?? [];
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
    this.prepareRead(address);
    return this.tx.read(address, options);
  }

  trackReadPaths(
    address: Omit<IMemorySpaceAddress, "path">,
    paths: readonly (readonly string[])[],
    options?: Omit<IReadOptions, "trackReadWithoutLoad">,
  ): Result<Unit, ReadError> {
    if (paths.length === 0) return { ok: {} };
    const readOptions = this.#withAmbientReadMeta(options);
    this.prepareRead(address);
    if (this.tx.trackReadPaths) {
      return this.tx.trackReadPaths(address, paths, readOptions);
    }

    for (const path of paths) {
      const result = this.tx.read({ ...address, path }, {
        ...readOptions,
        trackReadWithoutLoad: true,
      });
      if (result.error) return result;
    }
    return { ok: {} };
  }

  readOrThrow(
    address: IMemorySpaceAddress,
    options?: IReadOptions,
  ): Immutable<FabricValue> {
    options = this.#withAmbientReadMeta(options);
    this.prepareRead(address);
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
    this.#cfcState.structureContainers = [];
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

  setCfcPolicyEvaluationMode(mode: CfcPolicyEvaluationMode): void {
    this.wrapped.setCfcPolicyEvaluationMode(mode);
  }

  setCfcLabelMetadataProtectionMode(
    mode: CfcLabelMetadataProtectionMode,
  ): void {
    this.wrapped.setCfcLabelMetadataProtectionMode(mode);
  }

  setCfcDeclaredMonotonicityMode(mode: CfcDeclaredMonotonicityMode): void {
    this.wrapped.setCfcDeclaredMonotonicityMode(mode);
  }

  setCfcDeclaredWideningExemption(
    exemption: CfcDeclaredWideningExemption,
  ): void {
    this.wrapped.setCfcDeclaredWideningExemption(exemption);
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

  recordCfcStructureContainer(address: CfcAddress): void {
    this.wrapped.recordCfcStructureContainer(address);
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

  recordCfcConsultedGrant(consulted: ConsultedGrant): void {
    this.wrapped.recordCfcConsultedGrant(consulted);
  }

  recordCfcConsultedPolicyManifest(
    consulted: ConsultedPolicyManifest,
  ): void {
    this.wrapped.recordCfcConsultedPolicyManifest(consulted);
  }

  resolveCfcPolicyManifest(
    reference: unknown,
    destinationSpace?: MemorySpace,
    bindCommit?: boolean,
  ): unknown {
    return this.wrapped.resolveCfcPolicyManifest(
      reference,
      destinationSpace,
      bindCommit,
    );
  }

  hasCfcPolicyManifest(space: MemorySpace, reference: unknown): boolean {
    return this.wrapped.hasCfcPolicyManifest(space, reference);
  }

  installCfcPolicyManifest(space: MemorySpace, reference: unknown): boolean {
    return this.wrapped.installCfcPolicyManifest(space, reference);
  }

  recordCfcLabelMetadataObservation(
    observation: CfcLabelMetadataObservation,
  ): void {
    this.wrapped.recordCfcLabelMetadataObservation(observation);
  }

  writeCfcGrant(input: CfcGrantWriteInput): { space: MemorySpace; id: string } {
    return this.wrapped.writeCfcGrant(input);
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

  getWriteAttemptLog(): readonly IWriteAttempt[] {
    return this.wrapped.getWriteAttemptLog?.() ??
      getTransactionWriteAttempts(this.wrapped.tx) ?? [];
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
