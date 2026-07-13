import type { CellScope, JSONSchema } from "../builder/types.ts";
import type { FabricValue } from "@commonfabric/api";
import type { CfcModulePolicyRefAtom } from "@commonfabric/api/cfc";
import type { MemorySpace } from "@commonfabric/memory/interface";
import type { Immutable } from "@commonfabric/utils/types";
import type { Metadata } from "../storage/interface.ts";
import type {
  CfcLabelView,
  IFCLabel,
  LabelMetadataObservationClass,
  LabelObservationClass,
} from "./label-view-core.ts";
import type { PolicySnapshot } from "./policy.ts";
import type { SinkMaxConfidentiality } from "./sink-inventory.ts";
import type { CfcTrustConfig } from "./trust.ts";

export type {
  CfcLabelView,
  IFCLabel,
  LabelMetadataObservationClass,
  LabelObservationClass,
} from "./label-view-core.ts";

export const CFC_STRUCTURAL_PROVENANCE_SETUP_PROJECTION =
  "runtime.setup.result-projection";

// Recorded ONLY by the runtime's cell-serialization path (data-updating.ts
// BRANCH_CELL) when it materializes a runtime-constructed cell's initial
// value into the brand-new doc the cell points at. The prepare gate accepts a
// protected write only when this marker covers the target AND the write
// creates the doc — arbitrary `cell.set` calls record no marker and stay
// fully enforced.
export const CFC_STRUCTURAL_PROVENANCE_SEED_MATERIALIZATION =
  "runtime.setup.seed-materialization";

export type CfcEnforcementMode =
  | "disabled"
  | "observe"
  | "enforce-explicit"
  | "enforce-strict";

export const CFC_ENFORCEMENT_MODES = [
  "disabled",
  "observe",
  "enforce-explicit",
  "enforce-strict",
] as const satisfies readonly CfcEnforcementMode[];

export const isCfcEnforcementMode = (
  input: unknown,
): input is CfcEnforcementMode =>
  typeof input === "string" &&
  CFC_ENFORCEMENT_MODES.includes(input as CfcEnforcementMode);

export const DEFAULT_CFC_ENFORCEMENT_MODE: CfcEnforcementMode = "disabled";

/**
 * Strictness ranking used to forbid weakening a transaction's enforcement mode
 * after it has been raised (audit S3). Higher = stricter. `disabled`/`observe`
 * impose no enforcement floor; the two `enforce-*` levels do.
 */
export const cfcEnforcementStrictness = (
  mode: CfcEnforcementMode,
): number => {
  switch (mode) {
    case "disabled":
      return 0;
    case "observe":
      return 1;
    case "enforce-explicit":
      return 2;
    case "enforce-strict":
      return 3;
  }
};

/** Lowest strictness considered "enforcing" (establishes a non-lowerable floor). */
export const CFC_ENFORCING_STRICTNESS = cfcEnforcementStrictness(
  "enforce-explicit",
);

export type CfcSandboxJsonValue =
  | null
  | boolean
  | number
  | string
  | CfcSandboxJsonValue[]
  | { [key: string]: CfcSandboxJsonValue };

export type CfcSandboxOutputPolicy = "observed" | "opaque" | "denied";

export type CfcStreamChannel = "stdout" | "stderr";

export type CfcStreamSegment = {
  text: string;
  label: IFCLabel;
  offset?: number;
  byteLength?: number;
};

export type CfcStreamObservation =
  | {
    channel: CfcStreamChannel;
    policy: "observed";
    label: IFCLabel;
    segments: CfcStreamSegment[];
    truncated?: boolean;
  }
  | {
    channel: CfcStreamChannel;
    policy: "opaque";
    label: IFCLabel;
    byteLength?: number;
    truncated?: boolean;
  }
  | {
    channel: CfcStreamChannel;
    policy: "denied";
    label: IFCLabel;
    reason?: string;
  };

export type CfcSandboxExitCodeObservation =
  | {
    policy: "observed";
    label: IFCLabel;
    value: number | null;
  }
  | {
    policy: "opaque";
    label: IFCLabel;
  }
  | {
    policy: "denied";
    label: IFCLabel;
    reason?: string;
  };

export type CfcSandboxDiagnostic = {
  level: "info" | "warning" | "error";
  code: string;
  message: string;
  label?: IFCLabel;
  details?: { [key: string]: CfcSandboxJsonValue };
};

export type CfcSandboxResult = {
  version: 1;
  stdout: CfcStreamObservation;
  stderr: CfcStreamObservation;
  exitCode: CfcSandboxExitCodeObservation;
  diagnostics?: CfcSandboxDiagnostic[];
};

/**
 * Provenance component of a persisted labelMap entry. Components follow
 * distinct update disciplines (S16 design):
 * - `declared`: schema store policy — monotone (grow-only) per §8.12.
 * - `link`: reference-carried label — replaced when the link at the path
 *   is rewritten.
 * - `derived`: default-transition flow label — replaced when the value at
 *   the path is overwritten; an ancestor overwrite clears derived
 *   descendants.
 * - `structure`: flow label on a container's SHAPE (membership, key set,
 *   order, length — §8.5.6.1/SC-7) for written values made purely of
 *   references, where per-slot link entries already label each reference.
 *   A CONCRETE-path structure entry applies only to reads at exactly its
 *   path (observing the container is observing its shape); reads strictly
 *   below it are pointer handling and stay clean. On every structure
 *   container — DECLARED list-coordinator containers (the S16
 *   `recordCfcStructureContainer` hook — filter/flatMap results, where the
 *   membership decision lives) and the container nodes of generic
 *   pure-link-structure value writes — the runtime additionally mints
 *   three `*`-child CLASS TEMPLATES at `[...container, "*"]` beside the
 *   container-anchored `observes:"enumerate"` stamp — `shape`, `value`,
 *   `followRef` — carrying the same per-tx J
 *   (docs/specs/cfc-template-population.md §3): templates ARE consumed at
 *   matching child paths, so a per-child existence probe or a slot-pointer
 *   observation consumes the membership/assignment decision (the SC-4/SC-8
 *   residual fixes) while `readConsumesEntry`'s class table keeps probes
 *   clean of content taint — the pointer/content split moves onto the
 *   class axis instead of hanging on path anchoring alone. Three machinery
 *   boundaries keep scaffolding out (the first two measured on the phase-B
 *   pointwise suite, the third what let the generic route mint — the SC-8
 *   remainder): reads covered by a same-tx dereference trace are
 *   resolution machinery and skip templates (the C0 §6.1 row-4 rule
 *   extended to plain reads); a transaction re-deriving a container's
 *   membership stamps does not consume the entries it replaces (§8.12.8
 *   replace-from-criteria readback exclusion); and the op-instantiation/
 *   wiring machinery's reads of plumbing containers carry the
 *   `machineryRead` marker (reactivity-log.ts) and skip template
 *   consumption while keeping every other consumption. Update discipline
 *   matches `derived` (templates replace-from-criteria with the enumerate
 *   stamp they accompany; concrete `observes:"shape"` existence entries
 *   freeze at creation). Readers that predate this component treat its
 *   entries as covering (over-taint, fail-safe).
 * - `external-ingest`: the `ExternalIngest` provenance mark a vouched ingest
 *   channel mints onto the value it durably appends. Builtin-authored from
 *   verified channel metadata only (the split-mint), so it bypasses the
 *   runtime-minted gate; anchored at the ingest target cell and re-minted
 *   (replacing the prior mark for that doc) on each ingest. Its update
 *   discipline is replace-per-doc, driven by the ingest stamp.
 * - `label-metadata`: the §4.6.4.2 field-precise population profile
 *   (template-population Stage B) — multi-`*` templates under the
 *   `/cfc/labels/<target-envelope-path>/...` metadata subtree carrying the
 *   observation labels of the payload label's source-bearing fields. Update
 *   discipline: a pure function of the payload entries in the same envelope,
 *   re-derived from the FINAL payload entry set at every persist (so they
 *   replace on overwrite, clear with the entries they describe, and stay
 *   SC-11 no-op on unchanged recomputes by construction; never carried
 *   forward). Always paired with `observes:"labelMetadata"`: no payload read
 *   class consumes them — the introspection surface (`inspectConfLabel`) is
 *   their only consumer. See `label-metadata-population.ts`.
 * Entries without an origin are legacy (pre-component) entries and are
 * treated as one combined component with the historical update rules.
 * The effective label at a path is the join of all components.
 */
export type LabelEntryOrigin =
  | "declared"
  | "link"
  | "derived"
  | "structure"
  | "external-ingest"
  | "label-metadata";

/**
 * Consumption class of a persisted labelMap entry (Epic C,
 * docs/specs/cfc-observation-classes.md §3-§4; spec §4.6.3): which kind of
 * read observation consumes the entry's label. Orthogonal to `origin`, which
 * stays the update-discipline axis.
 *
 * Absent `observes` = a covering entry, consumed by every CONTENT read class
 * (`value`/`shape`/`enumerate`) but never by `followRef` observations — a
 * pointer read does not read content, and covering consumption there would
 * taint blind pass-throughs with the target's content label (C0 §6.1). One
 * carve-out: an entry with `origin:"link"` and absent `observes` is
 * implicitly `observes:"followRef"`, consumed by followRef reads only and
 * never as a covering entry (see `entryObservationClass`). That reproduces
 * the pointer/content split legacy link entries already had (value reads
 * dropped them via `excludeLinkOrigin`), so old persisted data keeps its
 * meaning without migration.
 *
 * The spec's fifth class, `count`, deliberately has no axis value: a count
 * observation (cardinality without membership) is strictly weaker than
 * `enumerate`, so count-shaped reads (length, COUNT) consume the `enumerate`
 * class — a sound over-approximation (C0 §4).
 *
 * (The union itself lives in `label-view-core.ts` — the leaf of the module
 * graph — and is re-exported above; label views carry the same axis, C4.)
 */
export type LabelMapEntry = {
  path: readonly string[];
  label: IFCLabel;
  origin?: LabelEntryOrigin;
  /**
   * Payload consumption classes, or — on `origin:"label-metadata"`
   * population templates only (Stage B) — the `labelMetadata` class, which
   * no payload read consumes (`readConsumesEntry`): those entries are
   * resolved exclusively by the introspection surface.
   */
  observes?: LabelObservationClass | LabelMetadataObservationClass;
};

export type CfcMetadata = {
  version: 1;
  schemaHash: string;
  labelMap: {
    version: 1;
    entries: Array<LabelMapEntry>;
  };
};

export type EntityDocumentWithCfc = {
  value?: unknown;
  source?: unknown;
  cfc?: CfcMetadata;
};

// CFC value types are deeply immutable by contract. The chokepoints
// that produce them (`canonicalizeLogicalPath()`, the `record*` /
// `set*` methods on `IExtendedStorageTransaction`, and
// `buildPreparedDigestInput()`) deep-freeze every record they emit,
// and the `Immutable<>` wrappers below pin the same shape into the
// type system so consumers see the invariant statically.
export type CfcAddress = Immutable<{
  space: MemorySpace;
  id: string;
  scope: CellScope;
  path: string[];
}>;

export type ConsumedRead =
  & CfcAddress
  & Immutable<{
    meta?: Metadata;
    nonRecursive?: boolean;
    /**
     * Position on the transaction's activity clock (shared with write
     * attempts — see `OrderedWriteAttempt`). Part of the prepared digest:
     * the write-prefix provenance gate's decision depends on which reads
     * precede which writes, so a post-prepare reorder that flips a read's
     * prefix membership must invalidate the preparation
     * (docs/specs/cfc-write-prefix-provenance.md §6). Absent only on
     * backends without the clock; the gate then treats the read as
     * preceding every write (conservative).
     */
    journalIndex?: number;
  }>;

export type AttemptedWrite = CfcAddress;

/**
 * One applied write attempt in transaction order (§6 of
 * docs/specs/cfc-write-prefix-provenance.md — the ordered full-address
 * write-attempt log). Unlike every other CfcAddress in the digest input,
 * `path` is the RAW storage path (`["value", ...]`, `["cfc"]`, `[]`),
 * deliberately NOT canonicalized: the prefix gate must distinguish
 * user-value writes from runtime surfaces, and the digest must bind the
 * addresses at full fidelity so the commit recheck can re-derive the same
 * last-overlapping-write bounds. Not reducible to one entry per exact
 * address: the bound is the last OVERLAPPING write (either prefix
 * direction), which an exact-address-keyed log cannot answer.
 */
export type OrderedWriteAttempt = Immutable<{
  space: MemorySpace;
  id: string;
  scope: CellScope;
  path: string[];
  journalIndex: number;
}>;

export type CfcDereferenceTrace = Immutable<{
  source: CfcAddress;
  target: CfcAddress;
  kind: "value" | "write-redirect";
}>;

/**
 * One label-METADATA observation (inv-12 Stage 2, spec §4.6.4.1-.2; the SC-6
 * partial revisit): the introspection surface (`inspectConfLabel`) observed
 * first-layer label metadata, and the observation enters the reading
 * transaction's consumed set carrying its §4.6.4.2 population-rule label.
 *
 * `target.path` is the ENVELOPE metadata subtree address the observation is
 * about — `["cfc","labels",...]`, never a payload path — so the record is
 * self-describing and cannot be confused with a payload read. The raw
 * `["cfc"]` journal read underneath stays a runtime-internal verifier read
 * (excluded from flow/consumed derivations exactly as before, SC-6); THIS
 * record is the application-observation channel. `confidentiality` is the
 * joined population-rule label of the per-field observations the query
 * consumed — non-empty by construction (public observations record nothing:
 * an empty label adds nothing to any join, gate, or digest).
 */
export type CfcLabelMetadataObservation = Immutable<{
  target: CfcAddress;
  observes: LabelMetadataObservationClass;
  confidentiality: unknown[];
}>;

export type ImplementationIdentity =
  | { kind: "builtin"; builtinId: string }
  | {
    kind: "verified";
    /**
     * Content-addressed module identity (prefix-free `cf:module/<hash>`
     * hash) — reload-stable and robust to unrelated module changes in the
     * same program.
     */
    moduleIdentity?: string;
    /** Export/`__cfReg` symbol of the registered factory, when module-scope. */
    symbol?: string;
    sourceFile?: string;
    bindingPath?: string[];
    codeHash?: string;
  }
  | { kind: "unsupported"; className: string; reason: string };

export type TrustSnapshot = {
  id: string;
  actingPrincipal?: string;
  revision?: string;
};

// `WritePolicyInput` is field-level `readonly` rather than `Immutable<>`
// because its `link-write` variant carries a `CfcLabelView` whose
// implementation-side helpers (`cloneCfcLabelView()`,
// `hasCfcLabelValues()`, etc.) operate on the mutable shape; pulling
// those into `Immutable<>` would cascade further than this cleanup
// pass. The runtime invariant still holds (the chokepoint
// `deepFreeze()` covers the whole record); this just keeps the type
// surface narrower.
export type WritePolicyInput =
  | {
    readonly kind: "schema";
    readonly target: CfcAddress;
    readonly schemaHash?: string;
    readonly schema?: JSONSchema;
  }
  | {
    readonly kind: "structural-provenance";
    readonly target: CfcAddress;
    readonly claim: string;
    readonly sources: readonly CfcAddress[];
  }
  | {
    readonly kind: "trusted-event";
    readonly target: CfcAddress;
    readonly eventId: string;
    readonly provenance?: FabricValue;
  }
  | {
    readonly kind: "link-write";
    readonly target: CfcAddress;
    readonly source: CfcAddress;
    readonly linkSchema?: JSONSchema;
    readonly cfcLabelView?: CfcLabelView;
  }
  | {
    readonly kind: "sink-request";
    readonly effectId: string;
    readonly sink: string;
    readonly request: FabricValue;
  }
  | {
    readonly kind: "custom";
    readonly target?: CfcAddress;
    readonly name: string;
    readonly value: FabricValue;
  };

/**
 * One grant document a boundary evaluation consulted (§8.12.7 route 2a):
 * its address plus the content digest of what the lookup resolved —
 * `CFC_GRANT_ABSENT_DIGEST` when the point query found no document (binding
 * "looked, found nothing" so a grant APPEARING between prepare and commit
 * invalidates too). Recorded by the runner-side grant resolver
 * (`createTxCfcGrantResolver`), folded into `PreparedDigestInput` below.
 *
 * Single-use CONSUMPTION RECEIPTS (design §2.2) ride the same entries: a
 * consuming resolution of a `singleUse` grant records the receipt address
 * with its present/absent state, so a receipt appearing between evaluations
 * invalidates the prepared digest exactly like a changed grant — the
 * digest-level complement to the create-only commit race.
 */
export type ConsultedGrant = {
  readonly space: MemorySpace;
  readonly id: string;
  readonly digest: string;
};

/**
 * One exact module-policy reference consulted by boundary evaluation. Both a
 * present manifest and an absent lookup are decision inputs; recording the
 * complete reference prevents pair/subject aliasing.
 */
export type ConsultedPolicyManifest = {
  readonly reference: CfcModulePolicyRefAtom;
  readonly state: "present" | "absent";
};

export type PreparedDigestInput = {
  readonly consumedReads: readonly ConsumedRead[];
  readonly attemptedWrites: readonly AttemptedWrite[];
  readonly writes: readonly AttemptedWrite[];
  /**
   * The ordered write-attempt log (see `OrderedWriteAttempt`). Mandatory in
   * the digest: `consumedReads`/`writes` are canonicalized by address-sort,
   * which discards order, but the write-prefix provenance gate's decision
   * depends on the read|write interleaving — without this (plus each read's
   * `journalIndex`) a post-prepare reordering that changes which reads fall
   * inside a write's prefix would slip past the commit recheck (audit S2
   * shape; docs/specs/cfc-write-prefix-provenance.md §6).
   */
  readonly writeAttemptLog: readonly OrderedWriteAttempt[];
  readonly dereferenceTraces: readonly CfcDereferenceTrace[];
  readonly triggerReads: readonly CfcAddress[];
  readonly writePolicyInputs: readonly WritePolicyInput[];
  readonly implementationIdentity?: ImplementationIdentity;
  readonly trustSnapshot?: TrustSnapshot;
  // Digest of the policy snapshot the boundary decisions evaluated under
  // (Epic B5): anything that can change a boundary decision must be in the
  // digest, so a decision made under one rule set cannot be committed under
  // another (same discipline as trustSnapshot).
  readonly policySnapshot?: { readonly digest: string };
  // Grant documents consulted by policyState-guarded evaluation (§8.12.7
  // route 2a), each bound by content digest — the same invalidation
  // discipline as policySnapshot: a decision that consumed one grant state
  // cannot commit under another. Absent when no grants were consulted, so
  // pre-existing digests are unchanged; canonicalized address-sorted.
  readonly consultedGrants?: readonly ConsultedGrant[];
  readonly consultedPolicyManifests?: readonly ConsultedPolicyManifest[];
  // Label-metadata observations (inv-12 Stage 2): boundary-decision inputs —
  // they change the flow join and the consumed set — bound under the same
  // discipline as writePolicyInputs. Absent when none were recorded, so
  // pre-Stage-2 digests are unchanged; canonicalized address-sorted.
  readonly labelMetadataObservations?: readonly CfcLabelMetadataObservation[];
};

export type PostCommitSideEffect = {
  id: string;
  kind: string;
  idempotencyKey?: string;
  flush(tx: unknown): void | Promise<void>;
};

export type CfcPrepareState =
  | { status: "unprepared" }
  | { status: "prepared"; digest: string; input: PreparedDigestInput }
  | { status: "invalidated"; digest?: string; reasons: string[] };

/**
 * Flow-label propagation dial (S16 default transition), orthogonal to the
 * enforcement ladder: `off` = no derivation; `observe` = compute the per-tx
 * conservative join and emit diagnostics, persist nothing; `persist` = write
 * derived label components for every value write target. Propagation never
 * rejects by itself — enforcement stays with the existing consumers.
 */
export type CfcFlowLabelsMode = "off" | "observe" | "persist";

export const DEFAULT_CFC_FLOW_LABELS_MODE: CfcFlowLabelsMode = "off";

/**
 * Write-side `requiredIntegrity` floor dial (§8.12.4.1 / SC-18, Epic D3),
 * orthogonal to the enforcement ladder and the flow dial: `off` = no check;
 * `observe` = evaluate the floor and emit diagnostics, never reject;
 * `enforce` = a floor miss records a prepare reason (which rejects the commit
 * under the enforcing enforcement modes, and is logged otherwise). The floor
 * tests the WRITTEN VALUE's integrity — schema mints, carried link-view
 * integrity, the flow hereditary meet — never the consumed-read set (that is
 * the read-side gate in `verifyInputRequirements`).
 */
export type CfcWriteFloorMode = "off" | "observe" | "enforce";

export const DEFAULT_CFC_WRITE_FLOOR_MODE: CfcWriteFloorMode = "off";

/**
 * Trigger-read gating (§8.9.2 / SC-3, Epic H5). When ON, the addresses whose
 * invalidating writes SCHEDULED this run (`CfcTxState.triggerReads`) join the
 * consumed set the enforcement gates quantify over — the sink-request egress
 * ceiling and the input-requirement/requiredIntegrity gate — not only the flow
 * derivation. Closes the residual "dep changed" channel (~1 bit/change event)
 * where a handler scheduled by a secret write egresses without re-reading the
 * secret. Adds reads to the gate (fail-closed direction) at the cost of extra
 * metadata resolution per prepare, so it ships behind a flag (default OFF).
 */
export type CfcTriggerReadGating = boolean;

export const DEFAULT_CFC_TRIGGER_READ_GATING: CfcTriggerReadGating = false;

/**
 * Exchange-rule policy evaluation dial (Epic B5, spec §4.4.5/§5.3),
 * orthogonal to the enforcement ladder: `off` = the gates decide on raw
 * labels exactly as before this dial existed; `observe` = evaluate every
 * gated label to fixpoint and emit diagnostics (rule firings, whether the
 * rewrite would change the decision), but DECIDE on the un-rewritten label;
 * `enforce` = decide on the REWRITTEN label — fuel exhaustion is a
 * fail-closed prepare reason, never a partial result (invariant 6: a policy
 * violation disables exchange, it never silently downgrades).
 */
export type CfcPolicyEvaluationMode = "off" | "observe" | "enforce";

export const DEFAULT_CFC_POLICY_EVALUATION_MODE: CfcPolicyEvaluationMode =
  "off";

/**
 * Cross-space label-metadata representation dial (inv-12 Stage 1 / SC-25,
 * docs/specs/cfc-label-metadata-confidentiality.md §2/§5; spec §4.6.4.1),
 * orthogonal to the enforcement ladder: `off` = persisted label bytes are
 * identical to before this dial existed; `observe` = compute the
 * classification-governed transformed form for cross-space entries and emit a
 * structured diagnostic when it differs from the verbatim form (the
 * divergence count is the rollout metric), but persist VERBATIM; `enforce` =
 * persist the transformed form (commitment-class atom fields replaced by
 * their canonical digest markers `{digestOf: <hash>}`). The transform never
 * rejects — representation only.
 */
export type CfcLabelMetadataProtectionMode = "off" | "observe" | "enforce";

export const DEFAULT_CFC_LABEL_METADATA_PROTECTION_MODE:
  CfcLabelMetadataProtectionMode = "off";

/**
 * Declared-component monotonicity gate dial (WP5; spec §8.12.1/§8.12.8;
 * docs/specs/cfc-persisted-declassification.md §4 item 3), orthogonal to the
 * enforcement ladder: the declared (store-policy) component of a persisted
 * path evolves only through the schema-walk re-mint in prepare, and §8.12.1's
 * `canUpdateStoreLabel` (confidentiality may only add clauses or remove
 * alternatives; the declared integrity claim may only remove atoms) had no
 * runtime check. `off` = nothing runs (bytes identical to before the dial);
 * `observe` = compare each re-minted declared entry against the stored
 * declared entry at the same path and emit a structured diagnostic on a
 * non-monotone re-mint, persisting today's behavior; `enforce` = a
 * non-monotone re-mint records a fail-closed prepare reason (rejecting the
 * commit under the enforcing enforcement modes). The gate governs ONLY the
 * `declared` component — derived/link-carried/structure components follow
 * their own §8.12.8 disciplines and are never touched. The sanctioned
 * exception (§8.12.7 route 2b, the future declassification-event writer) is
 * the per-tx privileged widening exemption below.
 */
export type CfcDeclaredMonotonicityMode = "off" | "observe" | "enforce";

export const DEFAULT_CFC_DECLARED_MONOTONICITY_MODE:
  CfcDeclaredMonotonicityMode = "off";

/**
 * Per-transaction privileged marker exempting exactly ONE (doc, path,
 * clauseDigest) triple from the declared-monotonicity gate (the seam for the
 * §8.12.7 route 2b declassification event; docs/specs/
 * cfc-persisted-declassification.md §4). `clauseDigest` is the canonical
 * clause digest (`cfcCanonicalClauseDigest`) of the STORED clause whose
 * dropping/widening the event sanctions — clause indices are
 * evaluation-ephemeral, digests are not. Settable only under the same
 * privileged discipline as `writeCfcGrant` (a trusted-builtin implementation
 * identity); absent = the gate applies in full; integrity violations are
 * never exemptable (the event widens a confidentiality clause).
 */
export type CfcDeclaredWideningExemption = {
  readonly space: MemorySpace;
  readonly id: string;
  readonly path: readonly string[];
  readonly clauseDigest: string;
};

export type CfcTxState = {
  relevant: boolean;
  enforcementMode: CfcEnforcementMode;
  flowLabelsMode: CfcFlowLabelsMode;
  writeFloorMode: CfcWriteFloorMode;
  triggerReadGating: CfcTriggerReadGating;
  policyEvaluationMode: CfcPolicyEvaluationMode;
  labelMetadataProtectionMode: CfcLabelMetadataProtectionMode;
  declaredMonotonicityMode: CfcDeclaredMonotonicityMode;
  // The one sanctioned per-tx exemption from the declared-monotonicity gate
  // (§8.12.7 route 2b seam). Absent = gate applies. Set only through the
  // privileged `setCfcDeclaredWideningExemption` (trusted-builtin identity),
  // write-once, validated fail-closed — see the type's doc comment.
  declaredWideningExemption?: CfcDeclaredWideningExemption;
  prepare: CfcPrepareState;
  dereferenceTraces: CfcDereferenceTrace[];
  // Result containers a list coordinator (filter/flatMap) declares each
  // reconcile: their `structure` label (membership/order, §8.5.6.1) must be
  // re-derived from the per-tx join J — the selection criteria the coordinator
  // read (predicate results) — EVERY reconcile, decoupled from value writes.
  // The membership taint settles on a later pass than the container's root
  // value write, and incremental changes are slot/no-op writes that never
  // re-stamp the root, so without this the taint never lands (S16 over-taint
  // fix, the dual of the input-read over-taint). map does NOT declare: it is
  // length-preserving with no membership secret, so its container stays clean.
  structureContainers: CfcAddress[];
  // Addresses whose invalidating writes scheduled this run (§8.9.2 trigger
  // reads): the decision to run *now* was influenced by their values, so
  // they join the flow-label derivation even when the run never re-reads
  // them. Recorded by the scheduler when it consumes the pending trigger
  // set for an action; empty for non-scheduled (manual/event) transactions
  // whose triggers are in-journal anyway.
  triggerReads: CfcAddress[];
  writePolicyInputs: WritePolicyInput[];
  // Implementation identity active when each write-policy input was recorded.
  // A single transaction may legitimately span multiple trust contexts (e.g. a
  // handler plus a child pattern it runs); writeAuthorizedBy must be verified
  // against the identity that authored each write, not the last one active.
  writePolicyInputIdentities: Map<
    WritePolicyInput,
    ImplementationIdentity | undefined
  >;
  // Implementation identity active at each non-privileged write, collapsed to
  // a per-tx uniformity summary (§8.9.3 TransformedBy). Flow labels are one
  // per-tx join stamped on every written doc, so derivation provenance is
  // honest only when every write was authored under the same defined
  // identity: a write under a different identity — or before any was set —
  // makes the tx-level claim ambiguous, `multiple` collapses it, and the
  // mint is omitted (fail-safe under-claim, SC-10). Same capture rationale
  // as `writePolicyInputIdentities` above: attribution must not borrow an
  // identity a later run in the same transaction happens to set. The
  // runtime's own privileged persistence writes are excluded — bookkeeping,
  // not authorship.
  writeIdentity: {
    sawWrite: boolean;
    multiple: boolean;
    identity?: ImplementationIdentity;
  };
  trustSnapshot?: TrustSnapshot;
  implementationIdentity?: ImplementationIdentity;
  outbox: PostCommitSideEffect[];
  diagnostics: string[];
  // Per-sink confidentiality ceilings consulted by prepareBoundaryCommit for
  // every recorded sink-request input (set once by the Runtime at tx creation;
  // see SinkMaxConfidentiality). Undefined = no ceilings declared.
  sinkMaxConfidentiality?: SinkMaxConfidentiality;
  // Frozen deployment policy snapshot (Epic B2a) the exchange-rule evaluator
  // runs under, set once by the Runtime at tx creation alongside the sink
  // ceilings. Undefined = no policies configured (evaluation is a no-op; the
  // B5 gates decide on un-rewritten labels).
  policySnapshot?: PolicySnapshot;
  // Frozen deployment trust config (Epic B3) backing concept-guard
  // satisfaction (createTrustResolver), set once by the Runtime at tx
  // creation. Undefined = no trust configured (every concept guard fails
  // closed). Config identity is covered by TrustSnapshot.revision, not a
  // separate digest input.
  trustConfig?: CfcTrustConfig;
  // Addresses of writes to a document's ["cfc"] label-map path made OUTSIDE the
  // runtime's privileged persistence scope (audit S18). The runtime's own label
  // writes in prepareBoundaryCommit run privileged and never land here; anything
  // that does is forging metadata that drives derivation for other writes, so
  // prepareBoundaryCommit turns each into a fail-closed reason. Writes to
  // reserved `grant:cfc:` documents outside the trusted policy-writer path
  // (`writeCfcGrant`) are recorded here too — same S18 class, same reasons.
  unprivilegedSystemWrites: string[];
  // Grant documents consulted by policyState-guarded boundary evaluation in
  // this transaction (§8.12.7 route 2a), recorded by the runner-side grant
  // resolver, deduplicated by address. Folded into PreparedDigestInput.
  consultedGrants: ConsultedGrant[];
  // Exact module-policy manifest lookups (present and absent), deduplicated by
  // reference and folded into PreparedDigestInput.
  consultedPolicyManifests: ConsultedPolicyManifest[];
  // Label-metadata observations recorded by the introspection surface
  // (inv-12 Stage 2, `recordCfcLabelMetadataObservation`): application
  // observations of first-layer label metadata, carrying their §4.6.4.2
  // population-rule labels. Folded into the flow derivation
  // (`deriveFlowJoin`), the egress consumed set (`collectConsumedLabel`),
  // the per-write input gate (`verifyInputRequirements`), and
  // PreparedDigestInput. Only labeled observations are recorded (empty =
  // public = nothing to derive, gate, or bind).
  labelMetadataObservations: CfcLabelMetadataObservation[];
};
