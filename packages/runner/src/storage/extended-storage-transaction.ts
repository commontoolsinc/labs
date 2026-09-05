import type { JSONSchema as SchemaDocJSONSchema } from "@commonfabric/api";
import {
  deepFreeze,
  type FabricPlainObject,
  type FabricValue,
  type MutableFabricPlainObjectLayer,
  shallowMutableClone,
} from "@commonfabric/data-model";
import { mapLinkSchemas } from "@commonfabric/memory/v2/schema-table-links";
import { collectExternalSchemaRefHashes } from "../schema-decompose.ts";
import { getContentAddressedSchemasConfig } from "../schema-doc-config.ts";
import { lookupSchemaDocument } from "../schema-registry.ts";
import type { URI } from "../sigil-types.ts";
import { aclDocId } from "@commonfabric/memory/acl";
import {
  type CommitError,
  createReadOnlyTransactionError,
  type IAttestation,
  type IExtendedStorageTransaction,
  type IMemorySpaceAddress,
  type InactiveTransactionError,
  type INotFoundError,
  type IReadActivity,
  type IReadOptions,
  type IStorageTransaction,
  type ITransactionJournal,
  type IWriteAttempt,
  type IWriteOptions,
  type MemorySpace,
  type Metadata,
  type ReadError,
  type Result,
  type StorageTransactionFailed,
  type StorageTransactionStatus,
  toThrowable,
  type TransactionCommitOptions,
  type TransactionReactivityLog,
  type TransactionSealDestination,
  type TransactionWriteDetail,
  type Unit,
  type WriteError,
  type WriterError,
} from "./interface.ts";
import type {
  CommitPrecondition,
  SqliteOperation,
} from "@commonfabric/memory/v2";
import { isArrayIndexPropertyName } from "@commonfabric/utils/arrays";
import { deepEqual } from "@commonfabric/utils/deep-equal";
import { getLogger } from "@commonfabric/utils/logger";
import { isObjectOrArray } from "@commonfabric/utils/types";

import type { CellScope } from "../builder/types.ts";
import {
  type AttemptedWrite,
  canonicalizeLogicalPath,
  CFC_ENFORCING_STRICTNESS,
  CFC_GRANT_ID_PREFIX,
  type CfcAddress,
  type CfcDeclaredMonotonicityMode,
  type CfcDeclaredWideningExemption,
  type CfcDecomposedEnvelopes,
  type CfcDereferenceTrace,
  cfcDereferenceTracesEqual,
  type CfcEnforcementMode,
  cfcEnforcementStrictness,
  type CfcFlowLabelsMode,
  type CfcGrantWriteInput,
  type CfcLabelMetadataObservation,
  type CfcLabelMetadataProtectionMode,
  cfcMetadataPresent,
  type CfcPolicyEvaluationMode,
  type CfcPrefixProvenanceSummary,
  CfcRefusalDetail,
  type CfcTriggerReadGating,
  type CfcTrustConfig,
  type CfcTxState,
  type CfcWriteFloorMode,
  type ConsultedGrant,
  type ConsultedPolicyManifest,
  type ConsumedRead,
  DEFAULT_CFC_DECLARED_MONOTONICITY_MODE,
  DEFAULT_CFC_DECOMPOSED_ENVELOPES,
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
  type RuntimeWritePolicyAuthorization,
  type SinkMaxConfidentiality,
  type TrustSnapshot,
  type WritePolicyInput,
} from "../cfc/mod.ts";
import {
  runtimeOwnedStoreKey,
  type RuntimeOwnedStores,
} from "../cfc/runtime-owned-stores.ts";
import {
  CFC_STRUCTURAL_PROVENANCE_RUNTIME_OWNED_STORE,
  runtimeWritePolicyAuthorized,
} from "../cfc/types.ts";
import { CFC_POLICY_MANIFEST_ID_PREFIX } from "../cfc/policy.ts";
import { isTerminalRefusal, plainReason } from "../cfc/verdict-reason.ts";
import {
  type NormalizedFullLink,
  toMemorySpaceAddress,
} from "../link-types.ts";
import {
  metaFieldsWritten,
  NO_META_FIELDS,
  rawMetaWriteAuthorized,
  storedMetaFields,
} from "../meta-seam.ts";
import { ignoreReadForScheduling } from "../scheduler.ts";
import { normalizeCellScope, scopeRank } from "../scope.ts";
import type { MergeableOpDelta } from "./mergeable-ops.ts";
import { CFC_ENFORCEMENT_REJECTION_PREFIX } from "./rejection.ts";
import {
  clearSchemaRefusalTx,
  ignoreReadForCommit,
  internalVerifierRead,
  isInternalVerifierRead,
  isLazyMaterializationTx,
  isUiInputBlindWriteTx,
  markLazyMaterializationTx,
  noteSchemaRefusalTx,
  reactivityLogFromActivities,
  takeSchemaRefusalTx,
  unmarkLazyMaterializationTx,
} from "./reactivity-log.ts";
import {
  TransactionAborted,
  TransactionCompleteError,
} from "./transaction-errors.ts";
import {
  getDirectTransactionReactivityLog,
  getTransactionReadActivities,
  getTransactionWriteAttempts,
  getTransactionWriteDetails,
} from "./transaction-inspection.ts";

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

  /** Stage C tuning T1: one flow-label probe was evaluated (`computed`) or
   * answered from the memoized negative verdict (`memo`). Measurement
   * only. */
  onFlowLabelProbe?(outcome: "computed" | "memo"): void;

  onPreparedTx?(): void;

  /**
   * CFC prepare refused this transaction. `reasons` are the PLAIN reason
   * texts (the verdict tag is a classification channel and never leaves the
   * boundary); `refusals` are the structured descriptions their producers
   * recorded, paired to those texts; `terminal` is what the commit boundary
   * will decide the refusal is worth — a verdict on the data, or a refusal a
   * fresh attempt may resolve.
   */
  onPrepareReject?(refusal: {
    reasons: readonly string[];
    refusals: readonly CfcRefusalDetail[];
    terminal: boolean;
  }): void;

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
  #commitCallbacks = new Set<
    (
      tx: IExtendedStorageTransaction,
      result: Result<Unit, CommitError>,
    ) => void
  >();
  #statusOverride?: StorageTransactionStatus;
  #commitCallbacksDispatched = false;
  // Verdict callbacks fire when the commit's fate is sealed — the accept
  // verdict or the rejection receipt — BEFORE the coverage / read-repair
  // waits the commit promise (and commit callbacks) additionally sit out.
  #verdictCallbacks = new Set<
    (
      tx: IExtendedStorageTransaction,
      result: Result<Unit, CommitError>,
    ) => void
  >();
  #verdictCallbacksDispatched = false;
  // Post-commit effects this transaction staged and then discarded, held for
  // the moment the code that owns its retries stops retrying it — a decision no
  // rejection carries on its own, since a refusal one attempt cannot get past
  // is often one a later attempt can. Effects handed to a seal destination are
  // not here: that clears the outbox too, and it is a handover rather than an
  // ending.
  #abandonableEffects: PostCommitSideEffect[] = [];
  #abandonDispatched = false;
  // Set when a commit of this transaction succeeded. Abandonment is what the
  // staged work hears instead of a commit, so a transaction that committed has
  // nothing to abandon, and saying otherwise would report a request as never
  // sent after the outbox flushed it.
  #committed = false;
  // The verdict-time effect run of the current commit(): verdict callbacks
  // plus the CFC outbox flush. What settled()-style barriers wait on in
  // place of the commit promise, whose resolution additionally waits for
  // view coverage.
  #postCommitEffects?: Promise<void>;
  #commitPreparationCrash: string | undefined;
  // The transaction's fate, resolved exactly when the verdict callbacks
  // dispatch — every fate path (commit verdict, rejection receipt, abort,
  // pre-storage rejection, internal commit rejection) funnels through that
  // dispatch.
  readonly #verdict = Promise.withResolvers<Result<Unit, CommitError>>();
  #commitPreconditions = new Map<MemorySpace, CommitPrecondition[]>();
  #createOnlyMarks = new Map<MemorySpace, Set<string>>();
  #outboxIdempotencyKeys = new Set<string>();
  #readOnlySource?: string;
  #narrowestReadScope: CellScope = "space";
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
    decomposedEnvelopes: DEFAULT_CFC_DECOMPOSED_ENVELOPES,
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
    refusalDetails: [],
  };
  #reportedCfcRelevant = false;
  #reportedCfcPrepared = false;
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

  // The write-policy inputs the runtime recorded, by reference to the frozen
  // record. `#`-private, so nothing outside this class can add to it; the one
  // writer is `recordCfcWritePolicyInput` handed the runtime's mark.
  #runtimeWritePolicyInputs = new WeakSet<WritePolicyInput>();
  // The stores the runtime owns that a marker named on THIS transaction, by
  // {@link runtimeOwnedStoreKey}. A store the runtime mints and fills in one
  // go needs no more than this.
  #markedOwnedStores = new Set<string>();
  // The stores the runtime owns that outlive the transaction that minted them,
  // shared with every other transaction of the same runtime (`Runtime.edit`
  // hands the same object to each). Absent on a transaction the runtime did
  // not configure, which leaves only this transaction's own markers.
  #runtimeOwnedStores: RuntimeOwnedStores | undefined;
  // Per-transaction cache of `Cell.get()` results, keyed by stable cell view.
  // Replaced wholesale on any write (see `#invalidateReadResultCache`), so a hit
  // is only ever served when nothing has been written since the cached read.
  // This is a Map rather than a WeakMap, but the transaction owns it and writes
  // drop it wholesale, bounding retention to reads-without-writes in one tx.
  #readResultCache = new Map<string, Map<string, { value: unknown }>>();
  #readResultCacheHits = 0;
  #readResultCacheMisses = 0;
  #readResultCacheSets = 0;
  // Per-transaction memo for derivations that read only this snapshot -- link
  // resolution and CFC label views, each under its own key prefix. Dropped on
  // any write alongside the read cache above, and bounded the same way: it
  // retains only what was derived since this transaction's last write.
  #snapshotMemo = new Map<string, unknown>();

  // The seal destination (server-execution v2, serving-loop.md §3d): when
  // installed, commit() closes by sealing into it instead of committing to
  // the store — one abstraction, two destinations. ECMAScript-private with a
  // write-once pin, same shape as #cfcPolicySnapshotPinned: the Runtime
  // configures every tx exactly once in edit() (usually with `undefined` —
  // every client, and the OFF arm always), and that state must be just as
  // write-once as an installed destination, or handler code reaching the
  // concrete tx via `(cell.tx as any)` could hijack the commit path.
  #sealDestination: TransactionSealDestination | undefined;
  #sealDestinationPinned = false;

  // Stage C tuning T1 (see IExtendedStorageTransaction.probeFlowLabelWork):
  // the activity epoch counts every journaled read, write, dereference
  // trace and trigger read; the memo holds the last NEGATIVE probe verdict
  // with the epoch it was taken at (stamped AFTER the probe, whose own
  // metadata reads are internal-verifier reads that never change the
  // verdict but do move the epoch).
  #cfcActivityEpoch = 0;
  #flowLabelProbeMemo: { epoch: number } | undefined;

  #cfcInstrumentation: CfcInstrumentationHooks;

  constructor(
    public tx: IStorageTransaction,
    cfcInstrumentation: CfcInstrumentationHooks = {},
  ) {
    this.#cfcInstrumentation = cfcInstrumentation;
  }

  /**
   * The prepared-digest input this transaction would hand to verification,
   * which a test reads directly to pin what it carries.
   */
  get accessForTestingOnly(): {
    buildPreparedDigestInput(): PreparedDigestInput;
  } {
    return {
      buildPreparedDigestInput: () => this.#buildPreparedDigestInput(),
    };
  }

  /** Stage C tuning T1: any transaction activity that could change the
   * flow-label probe's answer moves the epoch. */
  #noteCfcActivity(): void {
    this.#cfcActivityEpoch += 1;
  }

  probeFlowLabelWork(): boolean {
    if (this.#flowLabelProbeMemo?.epoch === this.#cfcActivityEpoch) {
      this.#cfcInstrumentation.onFlowLabelProbe?.("memo");
      return false;
    }
    this.#cfcInstrumentation.onFlowLabelProbe?.("computed");
    const verdict = flowLabelWorkExists(this);
    // Only the negative verdict is worth remembering: a positive one makes
    // the caller mark the tx relevant, and a relevant tx is never probed
    // again. Stamped with the epoch as it stands AFTER the probe (its own
    // metadata reads moved it).
    this.#flowLabelProbeMemo = verdict
      ? undefined
      : { epoch: this.#cfcActivityEpoch };
    return verdict;
  }

  /**
   * One-shot configuration of the seal destination, called by the Runtime
   * in edit() for every transaction it creates — with `undefined` on every
   * client and in the OFF arm, and with the wave accumulator's destination
   * on a serving runtime under EXPERIMENTAL_SERVER_EXECUTION.
   */
  configureSealDestination(
    destination: TransactionSealDestination | undefined,
  ): void {
    if (this.#sealDestinationPinned) {
      throw new Error(
        "Seal destination is already configured for this transaction",
      );
    }
    this.#sealDestinationPinned = true;
    this.#sealDestination = destination;
  }

  /**
   * Authoritative writes for effect-COMPLETION transactions (F2, the
   * completion-visibility wedge; serving-loop.md §4): gated on a
   * configured seal destination. Since Phase 2 that is NOT synonymous
   * with the serving posture — the speculation overlay is every
   * flag-ON client's default destination too (see the inline note
   * below) — but the gate still holds where it matters: the serving
   * runtime is where the replica's optimistic view layers sealed wave
   * overlays a later wave-commit can supersede-drop, making the
   * ordinary no-op elision destructive (a completion that diffs its
   * `inputHash` write against a doomed overlay durably lands `result
   * present + inputHash stale`; the next run's memo guard then wipes
   * the served value), and no client-side path reaches
   * `markEffectCompletion` under the flag (egress is dropped at the
   * overlay). In the OFF arm this is a no-op, so
   * `markEffectCompletion` keeps its documented byte-identical
   * behavior there — the accepted client-side corner (a completion
   * eliding against an in-flight optimistic overlay that later
   * rejects) costs one redundant refetch and self-heals, per the
   * recorded OFF-arm acceptance in verification-coverage.md.
   */
  markAuthoritativeWrites(): void {
    // Phase-2 truth update on the gate above: since the speculation
    // overlay became every flag-ON client's DEFAULT destination, "a
    // configured seal destination" no longer implies the SERVING
    // posture. Today this stays correct because no client-side path
    // reaches `markEffectCompletion` under the flag (egress is dropped
    // at the overlay, so effectful writebacks never run client-side) —
    // but a future client-side completion producer would silently get
    // authoritative (elision-skipping) writes here. Gate on the
    // destination's posture (or the runtime's `servingPosture`) before
    // adding one; flagged in the Phase-2 review (F11).
    if (this.#sealDestination !== undefined) {
      this.tx.markAuthoritativeWrites?.();
    }
  }

  isAuthoritativeWrites(): boolean {
    return this.tx.isAuthoritativeWrites?.() === true;
  }

  noteCfcSinkReleaseReject(
    info: { sink: string; effectId: string; detail: string },
  ): void {
    this.#cfcState.diagnostics.push(
      `sink-request release rejected for ${info.sink} (${info.effectId}): ${info.detail}`,
    );
    this.#cfcInstrumentation.onSinkReleaseReject?.(info);
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
    return this.#cfcInstrumentation.resolvePolicyManifest?.(
      reference,
      this,
      destinationSpace,
      bindCommit,
    );
  }

  hasCfcPolicyManifest(space: MemorySpace, reference: unknown): boolean {
    return this.#cfcInstrumentation.hasPolicyManifest?.(
      space,
      reference,
      this,
    ) ?? false;
  }

  installCfcPolicyManifest(space: MemorySpace, reference: unknown): boolean {
    return this.#cfcInstrumentation.installPolicyManifest?.(
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

  setCfcDecomposedEnvelopes(enabled: CfcDecomposedEnvelopes): void {
    // A spelling dial, not an enforcement dial: either setting writes a
    // sound envelope and no gate consumes the value, so there is no pin
    // and no prepared-state invalidation to protect.
    this.#cfcState.decomposedEnvelopes = enabled;
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
    this.#noteCfcActivity();
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
    delegations: ReadonlyMap<
      MemorySpace,
      ReadonlyMap<string, readonly string[]>
    >,
  ): void {
    if (this.#cfcModuleDelegationsPinned) return;
    this.#cfcModuleDelegationsPinned = true;
    const snapshot = new Map<
      MemorySpace,
      ReadonlyMap<string, readonly string[]>
    >();
    for (const [space, spaceDelegations] of delegations) {
      const spaceSnapshot = new Map<string, readonly string[]>();
      for (const [identity, predecessors] of spaceDelegations) {
        spaceSnapshot.set(identity, [...predecessors]);
      }
      if (spaceSnapshot.size > 0) snapshot.set(space, spaceSnapshot);
    }
    this.#cfcState.moduleDelegations = snapshot;
  }

  markCfcRelevant(reason?: string): void {
    this.#cfcState.relevant = true;
    if (!this.#reportedCfcRelevant) {
      this.#reportedCfcRelevant = true;
      this.#cfcInstrumentation.onRelevantTx?.();
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

  // Record a write that reaches a document's ["cfc"] label map from outside
  // the privileged scope, whether by naming that path or by replacing the
  // whole document envelope. Such a write forges or erases the metadata that
  // drives CFC derivation for OTHER writes, bypassing the commit-boundary
  // derivation + mint-gating (audit S18). prepareBoundaryCommit turns each
  // recorded address into a fail-closed reason, so the violation surfaces
  // uniformly with every other CFC reason (enforce rejects, observe
  // diagnoses). Recording (and relevance marking) is deliberately
  // unconditional on the enforcement mode, like every other CFC signal:
  // setCfcEnforcementMode permits raising the mode mid-transaction
  // (disabled/observe impose no floor), so a forgery in a disabled window must
  // still be on record when a later escalation evaluates it. A transaction
  // still `disabled` at commit never runs prepareBoundaryCommit, so the record
  // stays inert there.
  #noteSystemWrite(
    address: IMemorySpaceAddress,
    value?: FabricValue,
    options?: IWriteOptions,
  ): void {
    if (this.#privilegedSystemWriteDepth > 0) return;
    if (address.id.startsWith(CFC_POLICY_MANIFEST_ID_PREFIX)) {
      throw new Error(
        `cfcPolicyManifest: ${address.id} is immutable reserved policy state`,
      );
    }
    // The raw meta seam. A meta field is a document-root sibling of `value`:
    // `patternIdentity` and `pattern` name the program a piece runs,
    // `argument`, `result` and `internal` name the cells it is wired to,
    // `schema` names the shape its result is validated against, `slug` names
    // it in the space, and the source fields record where its program came
    // from. A write there redirects a piece rather than editing its data, so
    // the seam is the runtime's: `setMetaRaw` marks the write it makes with
    // `rawMetaWriteAuthorization`, carried in the write's own options, and a
    // meta write arriving unmarked is refused here. The refusal is in-process
    // and holds whatever the CFC enforcement mode, like the space-ACL arm
    // below and unlike the ["cfc"] arm at the end — this is an authorization
    // decision about the piece graph rather than a label-derivation signal
    // whose treatment follows the mode. It is also the first arm that can
    // refuse: every arm below is keyed by target id, and one that recorded
    // and returned ahead of this would leave the seam open on the documents
    // its prefix names.
    if (!rawMetaWriteAuthorized(options)) {
      // Three shapes reach a meta field: an address naming the field, a
      // document-root envelope carrying it as a key, and a document-root
      // write that leaves it out — the root write replaces the envelope, so
      // every stored meta field it does not carry is a field it drops. The
      // first two are settled by the write alone. The third is settled by
      // reading what the document carries, one meta member at a time,
      // through the inner transaction and under a read that carries no
      // weight of its own. Reading through the outer transaction would put
      // the guard's read in the reactivity log and the flow join. Reading
      // the document root would name a logical path covering every entry in
      // the document's label map, widening what the transaction counts as
      // consumed. And the read takes no commit precondition:
      // `ignoreReadForCommit` drops it from the conflict set, so the blind
      // root writes the runtime makes stay blind rather than becoming
      // read-modify-writes that lose the race against any advance of the
      // document they replace. What that leaves open is an erasure racing
      // the guard, never a forgery — the two shapes that name a field are
      // refused from the write itself, with no read at all.
      const written = metaFieldsWritten(address.path, value);
      const dropped = address.path.length === 0
        ? storedMetaFields((field) =>
          this.tx.read({ ...address, path: [field] }, {
            meta: { ...ignoreReadForScheduling, ...ignoreReadForCommit },
          }).ok?.value
        ).filter((field) => !written.includes(field))
        : NO_META_FIELDS;
      if (written.length > 0 || dropped.length > 0) {
        const reached = [...written, ...dropped];
        throw new Error(
          `${address.id}: refusing an unauthorized write to the meta seam (${
            reached.join(", ")
          }). These document-root fields name the program a piece runs and ` +
            `the cells it is wired to; the runtime writes them through ` +
            `setMetaRaw.`,
        );
      }
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
    // The space ACL document has a non-standard write contract: the memory
    // server accepts only an ACL-only commit carrying a single whole-document
    // `set` (INV-12, docs/specs/memory-v2/09-invariants.md). A write through
    // the value surface is decomposed per key by `normalizeAndDiff` and
    // emitted as `op: "patch"`, which the server refuses — so it fails after a
    // round-trip, with an error about commit shape that the author of the
    // write has no reason to understand. Refuse it here instead, in-process,
    // naming the one sanctioned writer. `ACLManager` addresses the whole
    // document (path `[]`) and so passes; genesis bypasses this transaction
    // entirely via a raw `session.transact`; hydration delivers path-`[]`
    // shapes; the CFC space-membership reader only reads.
    if (address.path.length > 0 && address.id === aclDocId(address.space)) {
      throw new Error(
        `${address.id} is the space ACL document: mutate it through ` +
          `ACLManager, which replaces the whole document. A value-path write ` +
          `is emitted as a patch and rejected by the memory server.`,
      );
    }
    // A path-[] write replaces the whole document envelope, so it reaches the
    // label map without naming it.
    if (address.path.length === 0) {
      this.#noteRootEnvelopeWrite(address, value);
      return;
    }
    // The ["cfc"] document field holds the persisted label map. A value-path
    // write (path[0] is a user key) is not it.
    if (address.path[0] !== "cfc") return;
    this.markCfcRelevant("unprivileged-cfc-metadata-write");
    this.#cfcState.unprivilegedSystemWrites.push(
      `${address.id}/${address.path.join("/")}`,
    );
  }

  // Record a path-[] whole-document write that erases the stored ["cfc"] label
  // map. Such a write replaces every sibling of `value`, so an envelope that
  // leaves the document without a label map erases the one it held, and a
  // labeled document reads afterwards as an unlabeled one. That is the
  // downgrade the ["cfc"]-path arm above catches, reached by omission rather
  // than by overwrite, so it lands in the same record and yields the same
  // fail-closed reason.
  //
  // Both halves ask `cfcMetadataPresent`, the reader's own account of what
  // presents a label map, so the arm fires on the change a reader would see
  // rather than on the presence of a key. An envelope carrying `cfc: null`, or
  // any other value the reader reports as absent, erases the map as surely as
  // one carrying no `cfc` at all. A stored value the reader reports as absent
  // is not a map to erase.
  //
  // What this does NOT reach is a root write that leaves a label map behind
  // but not the stored one — minting a map where the document had none, or
  // substituting one for another. Both are the S18 forgery this seam still
  // stands open on, and the CFC test suite seeds stored label state through
  // exactly those shapes, so closing them means giving those fixtures another
  // way to seed first.
  //
  // The arm fires only when a map is there to erase: creating a document, and
  // replacing one that carries no label map, pass through. Hydration passes
  // through as well — an envelope delivered from storage carries the `cfc` it
  // was stored with — and the runtime's own root writes (`cid:` schema
  // documents) return at the privileged-scope check above before reaching
  // here.
  //
  // The read carries no weight of its own, the way the meta seam's guard read
  // above carries none. It goes through the inner transaction, so it stays out
  // of the outer transaction's reactivity log and flow join; it names the
  // ["cfc"] member rather than the document root, so it does not widen what
  // the transaction counts as consumed; and `ignoreReadForCommit` keeps it out
  // of the conflict set, so a blind root write stays blind rather than
  // becoming a read-modify-write that loses the race against any advance of
  // the document it replaces. `internalVerifierRead` says what the read is:
  // the runtime resolving a label, the same mark `readStoredCfcMetadata`
  // carries.
  //
  // That read is transaction-local, and it bounds what this arm establishes. A
  // transaction whose view does not hold the document answers the same "no map
  // here" that a document with no map answers, so a writer that has not synced
  // the document erases its label map and commits. There is no race in that:
  // the map is present throughout, and the writer simply never looked. What
  // the arm establishes is that a root envelope write cannot erase a label map
  // THIS TRANSACTION HAS LOADED, which is narrower than the seam needs.
  // Closing the rest means forcing the document into view before deciding —
  // the read-modify-write this design declines — or making the commit boundary
  // establish what the space holds. `cfc-privileged-system-write.test.ts` pins
  // the bypass, so it fails when either lands.
  #noteRootEnvelopeWrite(
    address: IMemorySpaceAddress,
    value: FabricValue | undefined,
  ): void {
    const carried = isObjectOrArray(value)
      ? (value as { cfc?: unknown }).cfc
      : undefined;
    if (cfcMetadataPresent(carried)) return;
    const stored = this.tx.read({ ...address, path: ["cfc"] }, {
      meta: {
        ...ignoreReadForScheduling,
        ...ignoreReadForCommit,
        ...internalVerifierRead,
      },
    });
    if (!cfcMetadataPresent(stored.ok?.value)) return;
    this.markCfcRelevant("unprivileged-cfc-metadata-erasure");
    this.#cfcState.unprivilegedSystemWrites.push(`${address.id}/cfc`);
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
  #noteWriteIdentity(): void {
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
      this.#cfcInstrumentation.onDigestInvalidation?.(reason);
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
    return this.#narrowestReadScope;
  }

  resetNarrowestReadScope(scope: CellScope = "space"): void {
    this.#narrowestReadScope = scope;
    // The caller is about to re-read to learn the scope of what it reads. A
    // memoized link resolution issues no reads, so it would contribute nothing
    // to the scope taken afterwards and the answer would come out too wide.
    this.#snapshotMemo = new Map();
  }

  markLazyMaterialize(enabled = true): void {
    if (enabled) markLazyMaterializationTx(this);
    else unmarkLazyMaterializationTx(this);
  }

  isLazyMaterialize(): boolean {
    return isLazyMaterializationTx(this);
  }

  issueReadEpoch(): number | undefined {
    return this.tx.issueReadEpoch?.();
  }

  enterReadEpoch(epoch: number | undefined): number | undefined {
    const previous = this.#readEpoch;
    this.#readEpoch = epoch;
    this.tx.enterReadEpoch?.(epoch);
    return previous;
  }

  exitReadEpoch(previous: number | undefined): void {
    this.#readEpoch = previous;
    this.tx.exitReadEpoch?.(previous);
  }

  // Mirrors the epoch pushed down to the storage transaction, so the caches
  // this class owns can tell whether the value they are about to keep, or
  // hand out, describes the current state or an earlier one.
  #readEpoch: number | undefined;

  noteSchemaRefusal(refusal: unknown): void {
    noteSchemaRefusalTx(this, refusal);
  }

  takeSchemaRefusal(): unknown {
    return takeSchemaRefusalTx(this);
  }

  clearSchemaRefusal(refusal: unknown): void {
    clearSchemaRefusalTx(this, refusal);
  }

  #recordReadScope(address: Pick<IMemorySpaceAddress, "scope">): void {
    const scope = normalizeCellScope(address.scope);
    if (scopeRank(scope) > scopeRank(this.#narrowestReadScope)) {
      this.#narrowestReadScope = scope;
    }
  }

  #prepareRead(address: Pick<IMemorySpaceAddress, "scope">): void {
    this.#noteCfcActivity();
    if (this.#cfcState.prepare.status === "prepared") {
      this.invalidateCfc("read-after-prepare");
    }
    this.#recordReadScope(address);
  }

  getCachedReadResult(
    key: string,
    variant: string,
  ): { value: unknown } | undefined {
    // Both caches key on path and schema, not on which instant is being read,
    // and they are dropped on write to stay level with current state. A read
    // resolving against an earlier epoch is describing a different instant, so
    // it neither takes from them nor adds to them — serving one across that
    // boundary would hand a materialized read's value to a current one, or the
    // reverse.
    if (this.#readEpoch !== undefined) return undefined;
    const cached = this.#readResultCache.get(key)?.get(variant);
    if (cached === undefined) {
      this.#readResultCacheMisses++;
    } else {
      this.#readResultCacheHits++;
    }
    return cached;
  }

  setCachedReadResult(
    key: string,
    variant: string,
    value: unknown,
  ): void {
    if (this.#readEpoch !== undefined) return;
    let byVariant = this.#readResultCache.get(key);
    if (byVariant === undefined) {
      byVariant = new Map();
      this.#readResultCache.set(key, byVariant);
    }
    byVariant.set(variant, { value });
    this.#readResultCacheSets++;
  }

  getSnapshotMemo(): Map<string, unknown> | undefined {
    // A finished transaction answers no reads, so nothing it memoized earlier
    // may be handed out as if it had.
    if (this.status().status !== "ready") return undefined;
    // A read resolving against an earlier epoch describes a different instant
    // than the memo does; see `getCachedReadResult`.
    if (this.#readEpoch !== undefined) return undefined;
    // Once CFC is prepared, the read path's `read-after-prepare` invalidation
    // is load-bearing: a memoized resolution issues no reads and would leave a
    // prepared digest standing over a read it never made.
    if (this.#cfcState.prepare.status === "prepared") return undefined;
    // Inside an ambient-read-meta scope the reads a derivation issues carry
    // metadata that flow-label derivation reads. Serving one across the scope
    // boundary — either way — would journal the wrong ones, so the scope
    // neither reads the memo nor writes to it.
    if (this.#ambientReadMeta !== undefined) return undefined;
    // Same for the UI-input blind-write mode, which tags every read it sees
    // `ignoreReadForCommit`. An entry made under it, served after it is
    // cleared, would stand in for reads that are supposed to carry a
    // value-equality commit precondition — and the precondition would simply
    // not be there.
    if (isUiInputBlindWriteTx(this)) return undefined;
    return this.#snapshotMemo;
  }

  getReadResultCacheStats(): {
    hits: number;
    misses: number;
    sets: number;
    entries: number;
  } {
    let entries = 0;
    for (const byVariant of this.#readResultCache.values()) {
      entries += byVariant.size;
    }
    return {
      hits: this.#readResultCacheHits,
      misses: this.#readResultCacheMisses,
      sets: this.#readResultCacheSets,
      entries,
    };
  }

  hasWrites(): boolean {
    // Union of both accountings: this class's own write-path bit (set by
    // noteWrite — covers mergeable ops and folded SQLite writes that never
    // touch the inner tx's flag) and the inner storage transaction's flag
    // (the materialized-read epoch fast path's authority). Either signal
    // alone risks a false negative for the other consumer.
    return this.#hasWrites || (this.tx.hasWrites?.() ?? false);
  }

  #hasWrites = false;

  /**
   * Record that this transaction has written.
   *
   * Called from every write path rather than inferred from one of their side
   * effects: a mergeable op and a folded SQLite write are both writes, and
   * neither drops the read-result cache — the value write a mergeable op
   * annotates has already done that, and a SQLite op changes no cell value
   * locally. Deriving "has written" from cache invalidation would miss both.
   */
  #noteWrite(): void {
    this.#hasWrites = true;
    this.#noteCfcActivity();
  }

  #invalidateReadResultCache(): void {
    // A write may have changed any value a cached read depends on — including
    // the links a resolution walked, which a write can add, retarget or
    // replace with a plain value. Drop both caches by replacing the maps; this
    // enforces the "no writes between the last read and this one" invariant
    // they rely on.
    this.#readResultCache = new Map();
    this.#snapshotMemo = new Map();
  }

  recordCfcDereferenceTrace(trace: CfcDereferenceTrace): void {
    this.#noteCfcActivity();
    const traces = this.#cfcState.dereferenceTraces;
    // Only a dereference the transaction had not already performed can move
    // the digest, which binds the trace SET
    // (`canonicalizePreparedDigestInput`). Invalidating on a repeat would
    // reject a commit the recheck in `commit()` goes on to accept, so this
    // guard answers the same question that recheck does.
    //
    // The scan is the rare path, not the hot one: it runs only once prepared,
    // and every resolution that reaches here has already probed its way down
    // the link — a probe invalidates on its own, before the hop is recorded.
    const changesDigest = this.#cfcState.prepare.status === "prepared" &&
      !traces.some((recorded) => cfcDereferenceTracesEqual(recorded, trace));
    // Freeze on entry: from this point on the record is owned by the tx and
    // identity-stable. Mirrors the chokepoint pattern on
    // `recordCfcWritePolicyInput()`; together they ensure every CfcAddress
    // that flows into the digest input lives behind a deep-frozen wrapper.
    traces.push(deepFreeze(trace));
    if (changesDigest) {
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

  recordCfcWritePolicyInput(
    input: WritePolicyInput,
    authorization?: RuntimeWritePolicyAuthorization,
  ): void {
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
    // And remember whether the RUNTIME recorded it. The set is private and
    // holds the frozen record itself, so `isRuntimeWritePolicyInput` answers
    // for exactly the records that arrived with the mark.
    if (runtimeWritePolicyAuthorized(authorization)) {
      this.#runtimeWritePolicyInputs.add(frozen);
      // An authorized marker naming a WHOLE document in the OWNER's own space
      // says the runtime owns that store, for the rest of this transaction.
      // Both tests are the ones enrollment applies: a marker carrying a path
      // names part of a document, and ownership is a claim about the whole
      // store; and a store outside the owner's space belongs to whoever holds
      // that space's replicas, so declaring a policy on it from this piece's
      // join would put another space's bytes behind this one's promise.
      if (
        frozen.kind === "structural-provenance" &&
        frozen.claim === CFC_STRUCTURAL_PROVENANCE_RUNTIME_OWNED_STORE &&
        canonicalizeLogicalPath(frozen.target.path).length === 0 &&
        frozen.sources?.[0]?.space === frozen.target.space
      ) {
        this.#markedOwnedStores.add(
          runtimeOwnedStoreKey(frozen.target.space, frozen.target.id),
        );
      }
    }
    if (this.#cfcState.prepare.status === "prepared") {
      this.invalidateCfc("write-policy-input-added");
    }
  }

  isRuntimeWritePolicyInput(input: WritePolicyInput): boolean {
    return this.#runtimeWritePolicyInputs.has(input);
  }

  /**
   * One-shot handover of the runtime's owned-store enrollment, called by
   * `Runtime.edit` for every transaction it creates. The same set reaches
   * every transaction, which is what carries an enrollment past the
   * transaction that made it.
   */
  configureRuntimeOwnedStores(stores: RuntimeOwnedStores): void {
    if (this.#runtimeOwnedStores !== undefined) {
      throw new Error(
        "Runtime-owned stores are already configured for this transaction",
      );
    }
    this.#runtimeOwnedStores = stores;
  }

  enrollRuntimeOwnedStore(
    target: CfcAddress,
    owner: string,
    authorization?: RuntimeWritePolicyAuthorization,
  ): void {
    // The same mark the write-policy marker carries. An enrollment outlives
    // every transaction, so it is at least as much the runtime's to make.
    if (!runtimeWritePolicyAuthorized(authorization)) return;
    // The same path test the marker applies: ownership is a claim about a
    // whole store. `runtimeOwnedStoreOwnerKey` applies the other one, refusing
    // to name an owner for a store outside its own space.
    if (canonicalizeLogicalPath(target.path).length > 0) return;
    // Deliberately not transactional. Which store the runtime owns does not
    // depend on whether a write landed, and an abandoned attempt that enrolled
    // one named an address derived from its own piece's cause, which nothing
    // else mints. The piece's release is what takes it out again.
    this.#runtimeOwnedStores?.add(
      runtimeOwnedStoreKey(target.space, target.id),
      owner,
    );
  }

  isRuntimeOwnedStore(
    space: string,
    id: string,
    authorization?: RuntimeWritePolicyAuthorization,
  ): boolean {
    // Answers about the whole runtime's enrollment, not this transaction's, so
    // it takes the runtime's mark like the recorders do. Every store id here
    // is derivable from a piece's cause, so an ungated answer would tell
    // pattern-authored code — which reaches `cell.tx` — whether a given piece
    // is running in this runtime.
    if (!runtimeWritePolicyAuthorized(authorization)) return false;
    const key = runtimeOwnedStoreKey(space, id);
    return this.#markedOwnedStores.has(key) ||
      (this.#runtimeOwnedStores?.has(key) ?? false);
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

  recordCfcRefusalDetail(detail: CfcRefusalDetail): void {
    // Deliberately inert: no relevance mark, no digest invalidation, no
    // prepare-state change. A detail DESCRIBES a decision another line of
    // this transaction already made; letting it move the enforcement state
    // would make the description part of the decision.
    this.#cfcState.refusalDetails.push(deepFreeze(detail));
  }

  writeCfcGrant(input: CfcGrantWriteInput): { space: MemorySpace; id: string } {
    this.#assertWritable("writeCfcGrant()");
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
      !isObjectOrArray(exemption) ||
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
    if (this.#outboxIdempotencyKeys.has(key)) {
      this.#cfcInstrumentation.onSinkDedupHit?.(key);
      return;
    }
    this.#outboxIdempotencyKeys.add(key);
    this.#cfcState.outbox.push(effect);
  }

  hasPendingPostCommitEffects(): boolean {
    return this.#cfcState.outbox.length > 0;
  }

  postCommitEffectsSettled(): Promise<void> {
    // Resolved before commit() reaches storage (pre-storage rejections
    // dispatch callbacks synchronously and clear the outbox), pending
    // between commit() entry and the verdict-time effect run.
    return this.#postCommitEffects ?? Promise.resolve();
  }

  commitVerdict(): Promise<Result<Unit, CommitError>> {
    return this.#verdict.promise;
  }

  #buildPreparedDigestInput(): PreparedDigestInput {
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
            .flatMap(([space, spaceDelegations]) =>
              [...spaceDelegations].map(([
                moduleIdentity,
                delegatedModuleIdentities,
              ]) => ({
                space,
                moduleIdentity,
                delegatedModuleIdentities: [
                  ...delegatedModuleIdentities,
                ].sort(),
              }))
            )
            .sort((left, right) =>
              left.space < right.space
                ? -1
                : left.space > right.space
                ? 1
                : left.moduleIdentity < right.moduleIdentity
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

  // `"<space>|<hash>"` pairs this transaction has already materialized (or
  // decided it cannot), so repeat passes never re-call writeOrThrow — a
  // repeat write, even an elided one, would invalidate a prepared CFC
  // digest (`write-after-prepare`).
  #ensuredSchemaDocs = new Set<string>();

  /**
   * The write-side delivery guarantee of content-addressed schemas
   * (`docs/specs/content-addressed-schemas.md`): every schema document a
   * written link references travels in the same transaction, into the same
   * space, as the reference itself. Scans this transaction's writes for
   * link schemas carrying external refs, expands each to its closure
   * through the realm registry (the link writer registered the documents
   * when it stamped the reference), and blind-writes the documents at the
   * canonical space scope. The staging happens eagerly, as each carrying
   * write stages (`#stageSchemaDocsForValue` from write()/writeOrThrow()),
   * so the transaction is self-consistent and a same-transaction read
   * through the staged link resolves its references. This full scan runs
   * before CFC prepare (so the writes are part of the prepared digest) and
   * again at commit for transactions that never prepare — a backstop for
   * values staged past the write choke points; the dedupe set makes
   * repeated passes no-ops.
   *
   * A hash the registry cannot supply is skipped: only a hand-crafted
   * value carries a reference its writer never registered. The commit
   * boundary rejects such a commit outright unless the space already
   * stores the document, and read-side assembly fails closed on whatever
   * predates that validation.
   */
  #materializeReferencedSchemaDocuments(): void {
    if (!getContentAddressedSchemasConfig()) return;
    const log = this.getReactivityLog();
    const spaces = new Set(
      [...(log.writes ?? []), ...(log.attemptedWrites ?? [])].map((write) =>
        write.space
      ),
    );
    for (const space of spaces) {
      for (const detail of this.getWriteDetails(space)) {
        this.#stageSchemaDocsForValue(space, detail.address.id, detail.value);
      }
    }
  }

  /**
   * Stages the schema-document closure behind one written value (see
   * `#materializeReferencedSchemaDocuments` for the contract). Deliberately
   * per-transaction: two concurrent transactions writing the same schema
   * each stage their own copy rather than eliding against the other's
   * uncommitted write, so neither carries an ordering dependency on the
   * other — `cid:` re-sets of identical content apply as no-ops.
   */
  #stageSchemaDocsForValue(
    space: MemorySpace,
    id: string,
    value: FabricValue | undefined,
  ): void {
    if (!getContentAddressedSchemasConfig()) return;
    if (id.startsWith("cid:")) return;
    if (value === undefined) return;
    const hashes = new Set<string>();
    // Link positions only: `$alias` records are binding vocabulary by
    // CONTEXT — in a transaction's written values they are plain data,
    // and scanning them here would treat data that merely looks like a
    // binding as a schema carrier. Binding schemas externalized by the
    // pattern serializer resolve through the realm registry.
    mapLinkSchemas(value, (schema) => {
      for (
        const hash of collectExternalSchemaRefHashes(
          schema as SchemaDocJSONSchema,
        )
      ) {
        hashes.add(hash);
      }
      return schema;
    });
    for (const hash of hashes) {
      this.stageSchemaDocClosure(space, hash);
    }
  }

  /**
   * Stages `cid:<hash>` and every document its closure references into
   * this transaction, from the realm registry: per-transaction dedupe,
   * then the confirmed-persistence elision — a document the space's
   * server already holds needs no re-delivery, and content addressing
   * makes the confirmed copy immutable, so the skip cannot race a
   * change. Server-CONFIRMED only: a pending local write is no evidence
   * the server holds it, and the dedupe set stays per-transaction on
   * purpose (sibling transactions never carry ordering dependencies on
   * each other's uncommitted writes). A hash the registry cannot supply
   * warns and is skipped; the commit boundary has the last word.
   *
   * Deliberately NOT gated on `contentAddressedSchemas`: the link scan
   * above is the flag's surface, while direct callers — the CFC envelope
   * store — need their documents delivered whatever the flag says.
   */
  stageSchemaDocClosure(space: MemorySpace, rootHash: string): void {
    const pending = [rootHash];
    while (pending.length > 0) {
      const hash = pending.pop()!;
      const key = `${space}|${hash}`;
      if (this.#ensuredSchemaDocs.has(key)) continue;
      this.#ensuredSchemaDocs.add(key);
      if (this.tx.isSchemaDocPersisted?.(space, hash) === true) continue;
      const document = lookupSchemaDocument(hash);
      if (document === undefined) {
        logger.warn(
          "schema-doc-materialize",
          "A staged reference names a schema document the registry cannot supply:",
          `cid:${hash}`,
        );
        continue;
      }
      this.#runPrivilegedSystemWrite(() => {
        this.writeOrThrow(
          {
            space,
            id: `cid:${hash}` as URI,
            type: "application/json",
            path: [],
          },
          { value: document },
        );
      });
      pending.push(...collectExternalSchemaRefHashes(document));
    }
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
    // exactly the protected writes `#noteSystemWrite` rejects from untrusted
    // code (audit S18). The runtime's own persistence is the one legitimate
    // writer, so it alone is exempt.
    let reasons: string[];
    // Each pass describes its own verdict. Diagnostics are append-only
    // history on purpose — an observe-mode rollout wants every divergence a
    // transaction ever produced — but a detail is paired to a reason THIS
    // pass recorded, so carrying one forward from a pass that a later prepare
    // superseded would render the same refusal twice, or render one the
    // current verdict no longer holds.
    this.#cfcState.refusalDetails = [];
    try {
      // The schema-doc materialization is INSIDE the try on purpose: it is
      // part of commit-prep, and a crash in it must take the same modeled
      // refusal below rather than escaping (the totality this catch exists
      // for).
      this.#materializeReferencedSchemaDocuments();
      reasons = this.#runPrivilegedSystemWrite(() =>
        prepareBoundaryCommit(
          this,
          // Stage-0 precision counters: threaded through only when the hook is
          // installed, so the gate skips all measurement (and the summary
          // allocation) otherwise. The non-null assertion restates the
          // presence check above — the hooks object is fixed at construction.
          this.#cfcInstrumentation.onPrefixProvenance === undefined
            ? undefined
            : {
              onPrefixProvenance: (summary) =>
                this.#cfcInstrumentation.onPrefixProvenance!(summary),
            },
        )
      );
    } catch (error) {
      // An UNMODELED crash inside commit-prep (e.g. schema-merge's
      // divergent-ifc assert reached through a stored envelope — the served-
      // wish shape, verification-coverage.md OW49/OW50) used to escape here
      // as a thrown error: the scheduler's action died without its
      // transaction ever settling — no rollback callbacks, an unresolved run
      // promise, an unhandled rejection — and the failure was invisible at
      // every surface above (the wish UI silently never mounted). Fail
      // exactly as closed as a modeled refusal instead: record the crash as
      // a prepare reason, so commit() rejects through the standard
      // pre-storage-rejection path and every observer (commit callbacks, the
      // scheduler's failed-commit machinery, error surfacing) sees the real
      // cause.
      const message = error instanceof Error ? error.message : String(error);
      this.#commitPreparationCrash = message;
      // Reported UNCONDITIONALLY, not through this module's opt-in logger
      // (disabled by default — utils/logger.ts early-returns): a crash here
      // is a bug in prep itself, and before this catch existed the class
      // escaped as an unhandled rejection, the loudest signal in the system.
      // Converting it to a modeled refusal must not also convert it to
      // silence — the same labs#4772 shape `reportDroppedCfcRejectedWrite`
      // (scheduler/events.ts) exists for.
      console.error(
        "[cfc] commit-prep crashed; refusing the commit:",
        message,
        error,
      );
      reasons = [`CFC commit-prep crashed: ${message}`];
    }
    if (reasons.length > 0) {
      const plainReasons = reasons.map(plainReason);
      const refusedSet = new Set(plainReasons);
      this.#cfcInstrumentation.onPrepareReject?.({
        reasons: plainReasons,
        refusals: this.#cfcState.refusalDetails.filter((detail) =>
          refusedSet.has(detail.reason)
        ),
        terminal: isTerminalRefusal(reasons),
      });
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
      // Diagnostics are read by people and by matchers; the verdict tag is
      // a classification channel and does not belong in either.
      this.#cfcState.diagnostics.push(...reasons.map(plainReason));
      return "";
    }
    const preparedInput = this.#buildPreparedDigestInput();
    const digest = preparedDigestFor(preparedInput);
    this.#cfcState.prepare = {
      status: "prepared",
      digest,
      input: preparedInput,
    };
    if (!this.#reportedCfcPrepared) {
      this.#reportedCfcPrepared = true;
      this.#cfcInstrumentation.onPreparedTx?.();
    }
    return digest;
  }

  enableMultiSpaceWrites(order?: readonly MemorySpace[]): void {
    this.tx.enableMultiSpaceWrites?.(order);
  }

  setReadOnly(reason = "runtime.readTx()"): void {
    this.#readOnlySource = reason;
    this.tx.setReadOnly?.(reason);
  }

  clearReadOnly(): void {
    this.#readOnlySource = undefined;
    this.tx.clearReadOnly?.();
  }

  isReadOnly(): boolean {
    return this.#readOnlySource !== undefined ||
      this.tx.isReadOnly?.() === true;
  }

  #assertWritable(method: string): void {
    if (!this.isReadOnly()) {
      return;
    }
    throw createReadOnlyTransactionError(method, this.#readOnlySource);
  }

  get journal(): ITransactionJournal {
    return this.tx.journal;
  }

  getReactivityLog(): TransactionReactivityLog {
    return getDirectTransactionReactivityLog(this.tx) ??
      reactivityLogFromActivities(this.tx.journal.activity());
  }

  addCommitPrecondition(
    space: MemorySpace,
    precondition: CommitPrecondition,
  ): void {
    this.#assertWritable("addCommitPrecondition");
    // Fail closed: a precondition is a commit gate, so silently ignoring it
    // on storage that cannot enforce it would let the gated commit through.
    if (!this.tx.addCommitPrecondition) {
      throw new Error(
        "storage transaction does not support addCommitPrecondition()",
      );
    }
    const preconditions = this.#commitPreconditions.get(space);
    if (preconditions) {
      preconditions.push(precondition);
    } else {
      this.#commitPreconditions.set(space, [precondition]);
    }
    this.tx.addCommitPrecondition(space, precondition);
  }

  getCommitPreconditions(
    space: MemorySpace,
  ): readonly CommitPrecondition[] | undefined {
    return this.tx.getCommitPreconditions?.(space) ??
      this.#commitPreconditions.get(space);
  }

  markCreateOnly(
    link: { space: MemorySpace; id: string; scope?: unknown },
  ): void {
    this.#assertWritable("markCreateOnly");
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
    let marks = this.#createOnlyMarks.get(link.space);
    if (!marks) {
      marks = new Set();
      this.#createOnlyMarks.set(link.space, marks);
    }
    marks.add(createOnlyMarkKey(link));
    this.tx.markCreateOnly(link);
  }

  recordMergeableOp(link: NormalizedFullLink, delta: MergeableOpDelta): void {
    this.#assertWritable("recordMergeableOp");
    const address = toMemorySpaceAddress(link);
    // Same S18 chokepoint as write()/writeOrThrow(): a mergeable op IS a
    // write. The label-map arms are structurally unreachable here (a
    // NormalizedFullLink always yields a value-rooted storage path, so neither
    // the ["cfc"] path nor the document root can arrive), but the reserved
    // `grant:cfc:` documents are keyed by ID, and the mergeable path must not
    // slip an unprivileged grant mutation past the gate. The meta-seam arm is
    // unreachable for the same reason, which is why no value reaches it from
    // here.
    this.#noteSystemWrite(address);
    // Record a mergeable intent only when the underlying transaction can also
    // poison it. Recording an intent that can never be poisoned would let a
    // later reshape or mixed-op leave a stale tail op in the commit — silent
    // corruption. When poison is unavailable the intent is simply not recorded,
    // so the commit falls back to the plain whole-array diff already written.
    if (this.tx.poisonMergeableOp) {
      this.tx.recordMergeableOp?.(address, delta);
    }
  }

  poisonMergeableOp(link: NormalizedFullLink): void {
    this.#assertWritable("poisonMergeableOp");
    this.tx.poisonMergeableOp?.(toMemorySpaceAddress(link));
  }

  recordSqliteWrite(space: MemorySpace, op: SqliteOperation): void {
    // A folded SQLite write is a write — honor the wrapper's read-only mode the
    // same way cell writes do, instead of silently recording it.
    this.#assertWritable("recordSqliteWrite");
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
    if (this.#statusOverride !== undefined) {
      return this.#statusOverride;
    }
    return this.tx.status();
  }

  read(
    address: IMemorySpaceAddress,
    options?: IReadOptions,
  ): Result<IAttestation, ReadError> {
    options = this.#withAmbientReadMeta(options);
    this.#prepareRead(address);
    return this.tx.read(address, options);
  }

  trackReadPaths(
    address: Omit<IMemorySpaceAddress, "path">,
    paths: readonly (readonly string[])[],
    options?: Omit<IReadOptions, "trackReadWithoutLoad">,
  ): Result<Unit, ReadError> {
    if (paths.length === 0) return { ok: {} };
    const readOptions = this.#withAmbientReadMeta(options);
    this.#prepareRead(address);
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
  ): FabricValue {
    options = this.#withAmbientReadMeta(options);
    this.#prepareRead(address);
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
  ): FabricValue {
    return this.readOrThrow(toMemorySpaceAddress(address), options);
  }

  write(
    address: IMemorySpaceAddress,
    value: FabricValue,
    options?: IWriteOptions,
  ): Result<IAttestation, WriteError | WriterError> {
    this.#assertWritable("write()");
    this.#noteSystemWrite(address, value, options);
    this.#noteWriteIdentity();
    if (this.#cfcState.prepare.status === "prepared") {
      this.invalidateCfc("write-after-prepare");
    }
    this.#invalidateReadResultCache();
    const result = this.tx.write(address, value, options);
    if (result.ok) {
      this.#stageSchemaDocsForValue(address.space, address.id, value);
    }
    return result;
  }

  writeOrThrow(
    address: IMemorySpaceAddress,
    value: FabricValue,
    options?: IWriteOptions,
  ): void {
    this.#assertWritable("writeOrThrow()");
    this.#noteSystemWrite(address, value, options);
    this.#noteWriteIdentity();
    if (this.#cfcState.prepare.status === "prepared") {
      this.invalidateCfc("write-after-prepare");
    }
    this.#invalidateReadResultCache();
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
      let valueObj: MutableFabricPlainObjectLayer;
      if (errorPath.length === 0) {
        valueObj = {};
      } else {
        const currentValue = this.readOrThrow({
          ...address,
          path: lastExistingPath,
        }, { meta: ignoreReadForScheduling });
        if (!isObjectOrArray(currentValue)) {
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
          currentValue,
        ) as MutableFabricPlainObjectLayer;
      }
      const remainingPath = address.path.slice(lastExistingPath.length);
      if (remainingPath.length === 0) {
        throw new Error(
          `Invalid error path: ${errorPath.join("/")}`,
        );
      }
      const lastKey = remainingPath.pop()!;
      let nextValue: MutableFabricPlainObjectLayer = valueObj;
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
      nextValue[lastKey] = value;
      const parentAddress = { ...address, path: lastExistingPath };
      const writeResultRetry = this.tx.write(parentAddress, valueObj);
      if (writeResultRetry.error) {
        throw toThrowable(writeResultRetry.error);
      }
    } else if (writeResult.error) {
      throw toThrowable(writeResult.error);
    }
    // The staged value may carry link schemas with external refs; stage
    // their closure with it (the write-side delivery guarantee, and what
    // makes a same-transaction read through the link resolve). The `cid:`
    // writes this issues recurse harmlessly: the stager skips them by id.
    this.#stageSchemaDocsForValue(address.space, address.id, value);
  }

  writeValueOrThrow(
    address: NormalizedFullLink,
    value: FabricValue,
    options?: IWriteOptions,
  ): void {
    this.#assertWritable("writeValueOrThrow()");
    this.writeOrThrow(toMemorySpaceAddress(address), value, options);
  }

  writeValuesOrThrow(
    writes: Iterable<
      { address: NormalizedFullLink; value: FabricValue; delete?: boolean }
    >,
  ): void {
    this.#assertWritable("writeValuesOrThrow()");
    this.#invalidateReadResultCache();
    if (this.tx.writeBatch) {
      // Keep the batch path on the same noteSystemWrite chokepoint as single
      // writes (S18). This is not inert, and never was: `#noteSystemWrite`'s
      // ID-keyed arms do not care about the path at all. The
      // `cfcPolicyManifest` immutability guard has always been reachable here,
      // and the space-ACL guard now joins it — that one fires on exactly
      // `path.length > 0`, and `toMemorySpaceAddress` prefixes "value", so
      // EVERY link-shaped write to the ACL document throws from here,
      // including one whose link path is [].
      //
      // That throw escapes mid-batch. `writeBatch` groups the generator's
      // writes into same-document runs and applies each run as it pulls the
      // next write, so a throw on write k leaves runs 1..k-1 already applied to
      // the transaction while the call fails: a partial write plus a throw, not
      // an atomic refusal. Nothing rolls those writes back — the transaction is
      // still open and still writable, so a caller that swallows the error and
      // commits anyway lands the prefix. Callers must treat a throw from
      // `writeValuesOrThrow` as poisoning the transaction (abort it, or let the
      // throw propagate past the commit, which is what every caller does
      // today). See `writeValuesOrThrow` partial-batch coverage in
      // `packages/runner/test/memory-v2-acl-mutation.test.ts`.
      // The value reaches the chokepoint's meta-seam and label-map arms,
      // both of which read the envelope of a document-root write. A batch
      // addresses its writes by link, and `toMemorySpaceAddress` prefixes
      // "value", so no batch write is addressed at a document root; the value
      // travels anyway, so the batch and single-write paths ask the
      // chokepoint the same question.
      const noteSystemWrite = (
        address: IMemorySpaceAddress,
        value: FabricValue,
      ) => this.#noteSystemWrite(address, value);
      // Capture the identity per yielded write, not once up front: an empty
      // batch authored nothing, so it must not record a write for the
      // transaction's write-identity summary.
      const noteWriteIdentity = () => this.#noteWriteIdentity();
      // Collected while the batch consumes the generator, staged after it
      // returns: the schema-document closure behind each written link (the
      // write-side delivery guarantee, and what makes a same-transaction
      // read through the link resolve). Staging mid-batch would inject
      // writes while `writeBatch` is applying runs.
      const staged: { address: IMemorySpaceAddress; value: FabricValue }[] = [];
      const result = this.tx.writeBatch(
        (function* () {
          for (const write of writes) {
            const address = toMemorySpaceAddress(write.address);
            noteSystemWrite(address, write.value);
            noteWriteIdentity();
            if (!write.delete && getContentAddressedSchemasConfig()) {
              staged.push({ address, value: write.value });
            }
            yield { address, value: write.value, delete: write.delete };
          }
        })(),
      );
      if (result.error) {
        throw toThrowable(result.error);
      }
      for (const write of staged) {
        this.#stageSchemaDocsForValue(
          write.address.space,
          write.address.id,
          write.value,
        );
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
    this.#assertWritable("abort()");
    this.#statusOverride = undefined;
    this.#clearPostCommitOutbox();
    this.#cfcState.prepare = { status: "unprepared" };
    this.#cfcState.dereferenceTraces = [];
    this.#cfcState.structureContainers = [];
    const result = this.tx.abort(reason);
    // An abort is a terminal outcome, and it discards the staged writes the
    // same way a rejected commit does. Settle callbacks compensate for writes
    // that did not become durable, so they run here as well.
    if (!result.error) {
      this.#runCommitCallbacks({ error: TransactionAborted(reason) });
    }
    return result;
  }

  #runCommitCallbacks(result: Result<Unit, CommitError>): void {
    if (this.#commitCallbacksDispatched) {
      return;
    }
    if (!result.error) this.#committed = true;
    // Verdict callbacks never fire after commit callbacks: on the async
    // path the effect chain dispatched them at the verdict already (this is
    // a no-op then); on synchronous fates (abort, pre-storage rejection)
    // both layers learn the fate here, verdict first.
    this.#runVerdictCallbacks(result);
    this.#commitCallbacksDispatched = true;
    // Call all callbacks, wrapping each in try/catch to prevent one
    // failing callback from breaking others.
    for (const callback of this.#commitCallbacks) {
      try {
        callback(this, result);
      } catch (error) {
        logger.error("storage-error", "Error in commit callback:", error);
      }
    }
    // A settled transaction dispatches its callbacks exactly once. Holding
    // them afterwards makes any reference to the transaction retain every
    // callback's closure, and through those closures the cells and registries
    // of the action that committed it.
    this.#commitCallbacks.clear();
  }

  #runVerdictCallbacks(result: Result<Unit, CommitError>): void {
    if (this.#verdictCallbacksDispatched) {
      return;
    }
    this.#verdictCallbacksDispatched = true;
    this.#verdict.resolve(result);
    for (const callback of this.#verdictCallbacks) {
      try {
        callback(this, result);
      } catch (error) {
        logger.error("storage-error", "Error in verdict callback:", error);
      }
    }
    this.#verdictCallbacks.clear();
  }

  /**
   * Drop the staged effects. `handedOff` says another runner has taken them,
   * so they are not held for abandonment: exactly one of `flush` and `abandon`
   * runs per effect, and a handed-off effect will be flushed elsewhere.
   */
  #clearPostCommitOutbox(handedOff = false): void {
    if (!handedOff) {
      this.#abandonableEffects.push(...this.#cfcState.outbox);
    }
    this.#cfcState.outbox = [];
    this.#outboxIdempotencyKeys.clear();
  }

  #rejectCommitBeforeStorage(
    result: Result<Unit, CommitError>,
  ): Result<Unit, CommitError> {
    if (result.error) {
      this.#statusOverride = {
        status: "error",
        journal: this.tx.journal,
        error: result.error as StorageTransactionFailed,
      };
      this.tx.abort(result.error);
    }
    this.#clearPostCommitOutbox();
    this.#runCommitCallbacks(result);
    return result;
  }

  async commit(
    options?: TransactionCommitOptions,
  ): Promise<Result<Unit, CommitError>> {
    if (this.#statusOverride?.status === "error") {
      return { error: this.#statusOverride.error };
    }
    // A transaction that is no longer open takes none of the commit-path
    // work below. The CFC relevance probes read stored metadata through this
    // transaction, and one whose commit is in flight, settled, or aborted
    // admits no reads. The terminal state is reported here as the result. The
    // underlying transaction holds a single commit verdict, and that verdict
    // belongs to the commit that is running.
    const openState = this.tx.status();
    if (openState.status !== "ready") {
      return {
        error: openState.status === "error"
          ? openState.error
          : TransactionCompleteError(),
      };
    }
    const readOnly = this.isReadOnly();
    if (readOnly) {
      this.tx.clearReadOnly?.();
    }
    if (!readOnly) {
      // Before the CFC probes and the prepared-digest recheck: writes added
      // here must precede any prepare, and the dedupe set makes this a
      // no-op for transactions prepareCfc() already covered.
      this.#materializeReferencedSchemaDocuments();
      // Flow-label relevance is computed, not caller-marked: a tx that
      // observed or wrote a labeled doc derives labels even when nothing
      // called markCfcRelevant (S16 — value-copy laundering happens in
      // exactly the txs nobody marked). Probe only while unprepared: the
      // probe reads metadata, and a read after prepare would invalidate the
      // digest of a transaction that already did its flow work.
      // Stage C tuning T1: `Runtime.prepareTxForCommit` usually asked the
      // same question a moment ago on this very transaction; the memoized
      // negative verdict answers here unless the tx journaled anything
      // since (see probeFlowLabelWork).
      if (
        !this.#cfcState.relevant &&
        this.#cfcState.prepare.status === "unprepared" &&
        this.#cfcState.flowLabelsMode !== "off" &&
        this.#cfcState.enforcementMode !== "disabled" &&
        this.probeFlowLabelWork()
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
        if (this.#commitPreparationCrash !== undefined) {
          return this.#rejectCommitBeforeStorage({
            error: {
              name: "CommitPreparationError",
              message: `CFC commit preparation crashed: ` +
                this.#commitPreparationCrash,
              failureClass: "unknown",
              permanentEvidence: false,
            },
          });
        }
        const reasons = this.#cfcState.prepare.status === "invalidated"
          ? this.#cfcState.prepare.reasons
          : [];
        const detail = reasons.length > 0 ? `: ${plainReason(reasons[0])}` : "";
        const message =
          `${CFC_ENFORCEMENT_REJECTION_PREFIX}: relevant transaction was not prepared${detail}`;
        // WATCH(cfc-verdict): a refusal is terminal only when EVERY reason is
        // a VERDICT on this transaction's data. Anything else — an input
        // prepare could not evaluate, or a prepared state a caller disturbed
        // (`invalidateCfc`, e.g. read-after-prepare) — can decide differently
        // on a fresh attempt, so the rejection keeps the retryable
        // discarded-attempt name. Untagged is retryable; see
        // cfc/verdict-reason.ts for why the default sits there.
        if (!isTerminalRefusal(reasons)) {
          return this.#rejectCommitBeforeStorage({
            error: {
              name: "StorageTransactionAborted",
              message,
              reason: new Error("cfc-refusal-not-a-verdict"),
            },
          });
        }
        const plainReasons = reasons.map(plainReason);
        // Pair each detail to a reason that actually refused. A gate records
        // its detail when it decides, which is also how it records an
        // observe-mode diagnostic and a reason a later resolution cleared —
        // neither of those refused this commit, and neither may ride out on
        // an error that says they did.
        const refusedSet = new Set(plainReasons);
        return this.#rejectCommitBeforeStorage({
          error: {
            name: "CfcCommitRefusalError",
            message,
            reasons: plainReasons,
            refusals: this.#cfcState.refusalDetails.filter((detail) =>
              refusedSet.has(detail.reason)
            ),
          },
        });
      }

      if (this.#cfcState.prepare.status === "prepared") {
        const currentDigest = preparedDigestFor(
          this.#buildPreparedDigestInput(),
        );
        if (currentDigest !== this.#cfcState.prepare.digest) {
          this.invalidateCfc("prepared-digest-mismatch");
          if (this.#cfcState.enforcementMode !== "observe") {
            return this.#rejectCommitBeforeStorage({
              error: {
                name: "StorageTransactionAborted",
                message:
                  `${CFC_ENFORCEMENT_REJECTION_PREFIX}: prepared digest changed`,
                reason: new Error("cfc-prepared-digest-mismatch"),
              },
            });
          }
        }
      }
    }

    // The destination switch (serving-loop.md §3d): with a seal destination
    // installed — a serving runtime under EXPERIMENTAL_SERVER_EXECUTION —
    // this action tx SEALS into the wave accumulator instead of committing
    // to the store. Everything above (the per-action-run CFC gates, §3c)
    // and below (commit callbacks, post-commit side effects) fires for both
    // destinations: sealing fires everything commit fires today. Sealed
    // means accepted into the wave, not durable: a later withdrawal
    // (superseded, requeued, lease lost) surfaces on the wave's verdict
    // channel, AFTER the callbacks and side effects here observed "ok" —
    // the serving loop (stage F) and the effect channel (stage G) must
    // consume dispositions from the wave outcome, never from this result.
    const promise = this.#sealDestination !== undefined
      ? this.#sealDestination.seal(this)
      : this.tx.commit(options);

    // Two callback layers with two timelines (CT-1950):
    //
    // - VERDICT callbacks and the CFC outbox flush run once the commit's
    //   fate is sealed — the accept verdict or the rejection receipt.
    //   They guard on durability alone (start the LLM request, register
    //   background work), so holding them out for the fan-out or the
    //   read-repair round trip would cost a window for nothing.
    // - COMMIT callbacks run when the commit promise settles: after
    //   coverage on accept, after the read-repair gate on rejection.
    //   Their consumers act on the post-commit view — a compensation or
    //   retry that runs before the repair frame would read the very state
    //   the rejection just invalidated.
    //
    // Both promises always resolve, even when the commit fails (the result
    // then carries the error); an exception is an internal error handled
    // below. The verdict is raced with the promise, not taken alone: in
    // the real flow the verdict settles first, but a wrapped commit whose
    // inner commit() was replaced or bypassed (test stubs) never resolves
    // the inner verdict, and the effect run — and with it this commit()'s
    // own completion — must not hang on it.
    const verdict = this.tx.commitVerdict !== undefined
      ? Promise.race([this.tx.commitVerdict(), promise])
      : promise;
    const effects = verdict.then(
      async (result) => {
        this.#runVerdictCallbacks(result);
        if (result.ok && !readOnly) {
          // The effect handoff (server-execution v2 stage G, serving-loop.md
          // §3/§5; Phase 2 speculation.md §2): a SEALED transaction's "ok"
          // means accepted into a wave — or into the speculation overlay —
          // not durable. A seal destination that owns an outbox takes the
          // effects here and flushes them only after the wave commit landed
          // the contribution; the Phase-2 speculation overlay takes a
          // derivation run's effects to enact the reversible kinds and DROP
          // egress (the client never performs external effects under the
          // flag). Everything else (the OFF arm's store commit, non-diverted
          // ON-arm runs, bare test accumulators) keeps today's inline flush.
          const deferred = this.#sealDestination !== undefined &&
            this.#cfcState.outbox.length > 0 &&
            this.#sealDestination.deferSealedEffects?.(
                this,
                [...this.#cfcState.outbox],
              ) === true;
          if (deferred) {
            this.#clearPostCommitOutbox(true);
            return;
          }
          for (const effect of this.#cfcState.outbox) {
            try {
              await effect.flush(this);
              this.#cfcInstrumentation.onOutboxFlush?.(effect);
            } catch (error) {
              logger.error(
                "storage-error",
                "Post-commit side effect failed:",
                { effect, error },
              );
            }
          }
          this.#outboxIdempotencyKeys.clear();
        } else {
          this.#clearPostCommitOutbox();
        }
      },
      () => {},
    );
    this.#postCommitEffects = effects;
    promise.then(
      (result) => {
        this.#runCommitCallbacks(result);
      },
      (reason) => {
        const error: CommitError = {
          name: "StorageTransactionAborted",
          message: "Transaction commit promise rejected",
          reason,
        };
        this.#statusOverride = {
          status: "error",
          journal: this.tx.journal,
          error,
        };
        this.#clearPostCommitOutbox();
        this.#runCommitCallbacks({ error });
        logger.error(
          "storage-error",
          "Transaction commit promise rejected:",
          reason,
        );
      },
    );

    // resolveAt "verdict" returns at fate-sealing on BOTH paths: the
    // verdict race resolves at the accept verdict or the rejection
    // receipt, ahead of the coverage / read-repair waits the settlement
    // promise sits out — and ahead of the effect run, which a slow outbox
    // effect must not stretch (it stays tracked via
    // postCommitEffectsSettled()). Commit callbacks and the
    // pending-commit barrier stay on the settlement promise either way.
    // Otherwise commit() spans the full settlement plus the effect layer:
    // callers that await the commit observe the outbox flushed, exactly
    // as when the flush ran inline here.
    if (options?.resolveAt === "verdict") {
      return await verdict;
    }
    const result = await promise;
    await effects;

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
    this.#assertWritable("addCommitCallback()");
    this.#commitCallbacks.add(callback);
  }

  addVerdictCallback(
    callback: (
      tx: IExtendedStorageTransaction,
      result: Result<Unit, CommitError>,
    ) => void,
  ): void {
    this.#assertWritable("addVerdictCallback()");
    this.#verdictCallbacks.add(callback);
  }

  abandonStagedWork(error: CommitError): void {
    if (this.#committed || this.#abandonDispatched) return;
    this.#abandonDispatched = true;
    // Everything this transaction staged and did not flush: the effects a
    // discard path moved aside, and any still on the outbox because the
    // transaction ended without reaching one. A handover empties the outbox
    // without adding to either, so handed-off effects are in neither.
    const effects = [...this.#abandonableEffects, ...this.#cfcState.outbox];
    this.#abandonableEffects = [];
    this.#cfcState.outbox = [];
    for (const effect of effects) {
      try {
        effect.abandon?.(error);
      } catch (abandonError) {
        logger.error(
          "storage-error",
          "Post-commit side effect's abandon failed:",
          { effect, error: abandonError },
        );
      }
    }
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

  /**
   * If true, drops settle callbacks instead of registering them. For work that
   * duplicates what another transaction already carries: the state such a
   * callback would compensate for belongs to the original, so this transaction
   * has nothing to take back when it ends.
   */
  discardSettleCallbacks?: boolean;
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
  #wrapped: IExtendedStorageTransaction;
  #options: TransactionWrapperOptions;

  constructor(
    wrapped: IExtendedStorageTransaction,
    options: TransactionWrapperOptions = {},
  ) {
    this.#wrapped = wrapped;
    this.#options = options;
  }

  /**
   * Get the transaction to use for creating child cells.
   */
  getTransactionForChildCells(): IExtendedStorageTransaction {
    return this.#options.childCellTx ?? this.#wrapped;
  }

  /**
   * The wrapped transaction, for side-table lookups keyed on tx object
   * identity (review thread r3739139477): the wave run context is a
   * WeakMap keyed on the ORIGINAL transaction, so a scoped read through
   * a `sample()`/`sink()` wrapper missed the served run's
   * demand-supplied identity and resolved against the service session.
   * `waveRunContextOf` walks this chain.
   */
  get wrappedTransaction(): IExtendedStorageTransaction {
    return this.#wrapped;
  }

  get tx(): IStorageTransaction {
    return this.#wrapped.tx;
  }

  // Effect-completion writebacks can be marked through a wrapper
  // (markEffectCompletion calls these on whatever tx shape it is
  // handed). Forward both, or a wrapped completion silently skips
  // authoritative mode and the F2 no-op-elision wedge reopens for
  // exactly those paths (stage-G round-2 thread 18).
  markAuthoritativeWrites(): void {
    this.#wrapped.markAuthoritativeWrites?.();
  }

  isAuthoritativeWrites(): boolean {
    return this.#wrapped.isAuthoritativeWrites?.() === true;
  }

  getCfcState(): Readonly<CfcTxState> {
    return this.#wrapped.getCfcState();
  }

  setCfcEnforcementMode(mode: CfcEnforcementMode): void {
    this.#wrapped.setCfcEnforcementMode(mode);
  }

  setCfcFlowLabelsMode(mode: CfcFlowLabelsMode): void {
    this.#wrapped.setCfcFlowLabelsMode(mode);
  }

  setCfcWriteFloorMode(mode: CfcWriteFloorMode): void {
    this.#wrapped.setCfcWriteFloorMode(mode);
  }

  setCfcTriggerReadGating(enabled: CfcTriggerReadGating): void {
    this.#wrapped.setCfcTriggerReadGating(enabled);
  }

  setCfcDecomposedEnvelopes(enabled: CfcDecomposedEnvelopes): void {
    this.#wrapped.setCfcDecomposedEnvelopes(enabled);
  }

  stageSchemaDocClosure(space: MemorySpace, rootHash: string): void {
    this.#wrapped.stageSchemaDocClosure(space, rootHash);
  }

  setCfcPolicyEvaluationMode(mode: CfcPolicyEvaluationMode): void {
    this.#wrapped.setCfcPolicyEvaluationMode(mode);
  }

  setCfcLabelMetadataProtectionMode(
    mode: CfcLabelMetadataProtectionMode,
  ): void {
    this.#wrapped.setCfcLabelMetadataProtectionMode(mode);
  }

  setCfcDeclaredMonotonicityMode(mode: CfcDeclaredMonotonicityMode): void {
    this.#wrapped.setCfcDeclaredMonotonicityMode(mode);
  }

  setCfcDeclaredWideningExemption(
    exemption: CfcDeclaredWideningExemption,
  ): void {
    this.#wrapped.setCfcDeclaredWideningExemption(exemption);
  }

  addCfcTriggerReads(reads: readonly IMemorySpaceAddress[]): void {
    this.#wrapped.addCfcTriggerReads(reads);
  }

  probeFlowLabelWork(): boolean {
    return this.#wrapped.probeFlowLabelWork?.() ??
      flowLabelWorkExists(this.#wrapped);
  }

  runWithAmbientReadMeta<T>(meta: Metadata, fn: () => T): T {
    return this.#wrapped.runWithAmbientReadMeta(meta, fn);
  }

  markLazyMaterialize(enabled = true): void {
    // Mark this layer as well as what it wraps: a reader holding the wrapper
    // asks the wrapper, and a reader holding the inner transaction asks that.
    if (enabled) markLazyMaterializationTx(this);
    else unmarkLazyMaterializationTx(this);
    this.#wrapped.markLazyMaterialize(enabled);
  }

  isLazyMaterialize(): boolean {
    return isLazyMaterializationTx(this) || this.#wrapped.isLazyMaterialize();
  }

  hasWrites(): boolean {
    return this.#wrapped.hasWrites();
  }

  issueReadEpoch(): number | undefined {
    return this.#wrapped.issueReadEpoch();
  }

  enterReadEpoch(epoch: number | undefined): number | undefined {
    return this.#wrapped.enterReadEpoch(epoch);
  }

  exitReadEpoch(previous: number | undefined): void {
    this.#wrapped.exitReadEpoch(previous);
  }

  noteSchemaRefusal(refusal: unknown): void {
    noteSchemaRefusalTx(this, refusal);
    this.#wrapped.noteSchemaRefusal(refusal);
  }

  takeSchemaRefusal(): unknown {
    return takeSchemaRefusalTx(this) ?? this.#wrapped.takeSchemaRefusal();
  }

  clearSchemaRefusal(refusal: unknown): void {
    clearSchemaRefusalTx(this, refusal);
    this.#wrapped.clearSchemaRefusal(refusal);
  }

  markCfcRelevant(reason?: string): void {
    this.#wrapped.markCfcRelevant(reason);
  }

  noteCfcDiagnostic(message: string): void {
    this.#wrapped.noteCfcDiagnostic(message);
  }

  invalidateCfc(reason: string): void {
    this.#wrapped.invalidateCfc(reason);
  }

  getNarrowestReadScope(): CellScope {
    return this.#wrapped.getNarrowestReadScope();
  }

  resetNarrowestReadScope(scope?: CellScope): void {
    this.#wrapped.resetNarrowestReadScope(scope);
  }

  recordCfcDereferenceTrace(trace: CfcDereferenceTrace): void {
    this.#wrapped.recordCfcDereferenceTrace(trace);
  }

  recordCfcStructureContainer(address: CfcAddress): void {
    this.#wrapped.recordCfcStructureContainer(address);
  }

  prepareCfc(): string {
    return this.#wrapped.prepareCfc();
  }

  setCfcTrustSnapshot(snapshot: TrustSnapshot | undefined): void {
    this.#wrapped.setCfcTrustSnapshot(snapshot);
  }

  setCfcImplementationIdentity(
    identity: ImplementationIdentity | undefined,
  ): void {
    this.#wrapped.setCfcImplementationIdentity(identity);
  }

  recordCfcWritePolicyInput(
    input: WritePolicyInput,
    authorization?: RuntimeWritePolicyAuthorization,
  ): void {
    this.#wrapped.recordCfcWritePolicyInput(input, authorization);
  }

  isRuntimeWritePolicyInput(input: WritePolicyInput): boolean {
    return this.#wrapped.isRuntimeWritePolicyInput(input);
  }

  enrollRuntimeOwnedStore(
    target: CfcAddress,
    owner: string,
    authorization?: RuntimeWritePolicyAuthorization,
  ): void {
    this.#wrapped.enrollRuntimeOwnedStore(target, owner, authorization);
  }

  isRuntimeOwnedStore(
    space: string,
    id: string,
    authorization?: RuntimeWritePolicyAuthorization,
  ): boolean {
    return this.#wrapped.isRuntimeOwnedStore(space, id, authorization);
  }

  recordCfcConsultedGrant(consulted: ConsultedGrant): void {
    this.#wrapped.recordCfcConsultedGrant(consulted);
  }

  recordCfcConsultedPolicyManifest(
    consulted: ConsultedPolicyManifest,
  ): void {
    this.#wrapped.recordCfcConsultedPolicyManifest(consulted);
  }

  resolveCfcPolicyManifest(
    reference: unknown,
    destinationSpace?: MemorySpace,
    bindCommit?: boolean,
  ): unknown {
    return this.#wrapped.resolveCfcPolicyManifest(
      reference,
      destinationSpace,
      bindCommit,
    );
  }

  hasCfcPolicyManifest(space: MemorySpace, reference: unknown): boolean {
    return this.#wrapped.hasCfcPolicyManifest(space, reference);
  }

  installCfcPolicyManifest(space: MemorySpace, reference: unknown): boolean {
    return this.#wrapped.installCfcPolicyManifest(space, reference);
  }

  recordCfcLabelMetadataObservation(
    observation: CfcLabelMetadataObservation,
  ): void {
    this.#wrapped.recordCfcLabelMetadataObservation(observation);
  }

  recordCfcRefusalDetail(detail: CfcRefusalDetail): void {
    this.#wrapped.recordCfcRefusalDetail(detail);
  }

  writeCfcGrant(input: CfcGrantWriteInput): { space: MemorySpace; id: string } {
    return this.#wrapped.writeCfcGrant(input);
  }

  noteCfcSinkReleaseReject(
    info: { sink: string; effectId: string; detail: string },
  ): void {
    this.#wrapped.noteCfcSinkReleaseReject(info);
  }

  enqueuePostCommitEffect(effect: PostCommitSideEffect): void {
    this.#wrapped.enqueuePostCommitEffect(effect);
  }

  hasPendingPostCommitEffects(): boolean {
    return this.#wrapped.hasPendingPostCommitEffects();
  }

  postCommitEffectsSettled(): Promise<void> {
    return this.#wrapped.postCommitEffectsSettled();
  }

  enableMultiSpaceWrites(order?: readonly MemorySpace[]): void {
    this.#wrapped.enableMultiSpaceWrites?.(order);
  }

  setReadOnly(reason?: string): void {
    this.#wrapped.setReadOnly?.(reason);
  }

  clearReadOnly(): void {
    this.#wrapped.clearReadOnly?.();
  }

  isReadOnly(): boolean {
    return this.#wrapped.isReadOnly?.() === true;
  }

  get journal(): ITransactionJournal {
    return this.#wrapped.journal;
  }

  getReactivityLog(): TransactionReactivityLog {
    return this.#wrapped.getReactivityLog?.() ??
      reactivityLogFromActivities(this.#wrapped.journal.activity());
  }

  addCommitPrecondition(
    space: MemorySpace,
    precondition: CommitPrecondition,
  ): void {
    // Fail closed, like ExtendedStorageTransaction: a precondition is a
    // commit gate and must not be silently dropped.
    if (!this.#wrapped.addCommitPrecondition) {
      throw new Error(
        "storage transaction does not support addCommitPrecondition()",
      );
    }
    this.#wrapped.addCommitPrecondition(space, precondition);
  }

  getCommitPreconditions(
    space: MemorySpace,
  ): readonly CommitPrecondition[] | undefined {
    return this.#wrapped.getCommitPreconditions?.(space);
  }

  markCreateOnly(
    link: { space: MemorySpace; id: string; scope?: unknown },
  ): void {
    this.#wrapped.markCreateOnly?.(link);
  }

  recordMergeableOp(link: NormalizedFullLink, delta: MergeableOpDelta): void {
    // Only record when the wrapped transaction can also poison — see the same
    // guard in ExtendedStorageTransaction.recordMergeableOp.
    if (this.#wrapped.poisonMergeableOp) {
      this.#wrapped.recordMergeableOp?.(link, delta);
    }
  }

  poisonMergeableOp(link: NormalizedFullLink): void {
    this.#wrapped.poisonMergeableOp?.(link);
  }

  recordSqliteWrite(space: MemorySpace, op: SqliteOperation): void {
    if (!this.#wrapped.recordSqliteWrite) {
      throw new Error(
        "storage transaction does not support recordSqliteWrite()",
      );
    }
    this.#wrapped.recordSqliteWrite(space, op);
  }

  getReadActivities(): Iterable<IReadActivity> {
    return this.#wrapped.getReadActivities?.() ??
      getTransactionReadActivities(this.#wrapped.tx);
  }

  getWriteAttemptLog(): readonly IWriteAttempt[] {
    return this.#wrapped.getWriteAttemptLog?.() ??
      getTransactionWriteAttempts(this.#wrapped.tx) ?? [];
  }

  getWriteDetails(
    space: MemorySpace,
  ): Iterable<TransactionWriteDetail> {
    return this.#wrapped.getWriteDetails?.(space) ??
      getTransactionWriteDetails(this.#wrapped.tx, space);
  }

  status(): StorageTransactionStatus {
    return this.#wrapped.status();
  }

  #transformReadOptions(options?: IReadOptions): IReadOptions {
    if (!this.#options.nonReactive) {
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
    return this.#wrapped.read(address, this.#transformReadOptions(options));
  }

  readOrThrow(
    address: IMemorySpaceAddress,
    options?: IReadOptions,
  ): FabricValue {
    return this.#wrapped.readOrThrow(
      address,
      this.#transformReadOptions(options),
    );
  }

  readValueOrThrow(
    address: NormalizedFullLink,
    options?: IReadOptions,
  ): FabricValue {
    return this.#wrapped.readValueOrThrow(
      address,
      this.#transformReadOptions(options),
    );
  }

  write(
    address: IMemorySpaceAddress,
    value: FabricValue,
    options?: IWriteOptions,
  ): Result<IAttestation, WriteError | WriterError> {
    return this.#wrapped.write(address, value, options);
  }

  writeOrThrow(
    address: IMemorySpaceAddress,
    value: FabricValue,
    options?: IWriteOptions,
  ): void {
    return this.#wrapped.writeOrThrow(address, value, options);
  }

  writeValueOrThrow(
    address: NormalizedFullLink,
    value: FabricValue,
    options?: IWriteOptions,
  ): void {
    return this.#wrapped.writeValueOrThrow(address, value, options);
  }

  writeValuesOrThrow(
    writes: Iterable<
      { address: NormalizedFullLink; value: FabricValue; delete?: boolean }
    >,
  ): void {
    if (this.#wrapped.writeValuesOrThrow) {
      return this.#wrapped.writeValuesOrThrow(writes);
    }
    for (const write of writes) {
      this.#wrapped.writeValueOrThrow(
        write.address,
        write.value,
        write.delete ? { delete: true } : undefined,
      );
    }
  }

  abort(reason?: unknown): Result<Unit, InactiveTransactionError> {
    return this.#wrapped.abort(reason);
  }

  commit(
    options?: TransactionCommitOptions,
  ): Promise<Result<Unit, CommitError>> {
    return this.#wrapped.commit(options);
  }

  addCommitCallback(
    callback: (
      tx: IExtendedStorageTransaction,
      result: Result<Unit, CommitError>,
    ) => void,
  ): void {
    if (this.#options.discardSettleCallbacks === true) return;
    return this.#wrapped.addCommitCallback(callback);
  }

  addVerdictCallback(
    callback: (
      tx: IExtendedStorageTransaction,
      result: Result<Unit, CommitError>,
    ) => void,
  ): void {
    if (this.#options.discardSettleCallbacks === true) return;
    return this.#wrapped.addVerdictCallback(callback);
  }

  abandonStagedWork(error: CommitError): void {
    // A wrapper that discards settle callbacks stands for work whose outcome
    // nobody acts on — duplicate work run only to compare its writes — so it
    // does not end the staged work of the transaction it wraps.
    if (this.#options.discardSettleCallbacks === true) return;
    return this.#wrapped.abandonStagedWork(error);
  }
}

/**
 * Create a transaction wrapper for work that re-runs what another transaction
 * already carries, so the two can be compared, and is discarded afterwards.
 *
 * The re-run registers the same settle callbacks the original did. Those
 * callbacks undo in-memory state on the way to a transaction that did not
 * become durable, and here the state belongs to the original run, which has
 * already committed it — so this wrapper drops them rather than letting the
 * discard tear down live state the original owns.
 */
export function createDuplicateWorkTransaction(
  tx: IExtendedStorageTransaction,
): TransactionWrapper {
  return new TransactionWrapper(tx, { discardSettleCallbacks: true });
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
