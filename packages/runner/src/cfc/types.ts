import type { CellScope, JSONSchema } from "../builder/types.ts";
import type { FabricValue } from "@commonfabric/api";
import type { MemorySpace } from "@commonfabric/memory/interface";
import type { Immutable } from "@commonfabric/utils/types";
import type { Metadata } from "../storage/interface.ts";
import type { CfcLabelView, IFCLabel } from "./label-view-core.ts";
import type { SinkMaxConfidentiality } from "./sink-inventory.ts";

export type { CfcLabelView, IFCLabel } from "./label-view-core.ts";

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
 *   Applies only to reads at exactly the entry's path (observing the
 *   container is observing its shape); reads strictly below it (slot
 *   pointer reads, dereferences) are pointer handling and stay clean —
 *   that asymmetry is what lets membership taint persist without smearing
 *   the pointwise per-element split. Update discipline matches `derived`.
 *   Readers that predate this component treat it as covering (over-taint,
 *   fail-safe).
 * Entries without an origin are legacy (pre-component) entries and are
 * treated as one combined component with the historical update rules.
 * The effective label at a path is the join of all components.
 */
export type LabelEntryOrigin = "declared" | "link" | "derived" | "structure";

export type LabelMapEntry = {
  path: readonly string[];
  label: IFCLabel;
  origin?: LabelEntryOrigin;
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
  }>;

export type AttemptedWrite = CfcAddress;

export type CfcDereferenceTrace = Immutable<{
  source: CfcAddress;
  target: CfcAddress;
  kind: "value" | "write-redirect";
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
    sourceLocation?: { line: number; column: number };
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

export type PreparedDigestInput = {
  readonly consumedReads: readonly ConsumedRead[];
  readonly attemptedWrites: readonly AttemptedWrite[];
  readonly writes: readonly AttemptedWrite[];
  readonly dereferenceTraces: readonly CfcDereferenceTrace[];
  readonly triggerReads: readonly CfcAddress[];
  readonly writePolicyInputs: readonly WritePolicyInput[];
  readonly implementationIdentity?: ImplementationIdentity;
  readonly trustSnapshot?: TrustSnapshot;
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

export type CfcTxState = {
  relevant: boolean;
  enforcementMode: CfcEnforcementMode;
  flowLabelsMode: CfcFlowLabelsMode;
  prepare: CfcPrepareState;
  dereferenceTraces: CfcDereferenceTrace[];
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
  // Addresses of writes to a document's ["cfc"] label-map path made OUTSIDE the
  // runtime's privileged persistence scope (audit S18). The runtime's own label
  // writes in prepareBoundaryCommit run privileged and never land here; anything
  // that does is forging metadata that drives derivation for other writes, so
  // prepareBoundaryCommit turns each into a fail-closed reason.
  unprivilegedSystemWrites: string[];
};
