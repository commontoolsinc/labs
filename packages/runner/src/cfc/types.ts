import type { CellScope, JSONSchema } from "../builder/types.ts";
import type { FabricValue, MemorySpace } from "@commonfabric/memory/interface";
import type { Immutable } from "@commonfabric/utils/types";
import type { Metadata } from "../storage/interface.ts";
import type { CfcLabelView, IFCLabel } from "./label-view-core.ts";
import type { SinkMaxConfidentiality } from "./sink-inventory.ts";

export type { CfcLabelView, IFCLabel } from "./label-view-core.ts";

export const CFC_STRUCTURAL_PROVENANCE_SETUP_PROJECTION =
  "runtime.setup.result-projection";

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

export type CfcMetadata = {
  version: 1;
  schemaHash: string;
  labelMap: {
    version: 1;
    entries: Array<{
      path: readonly string[];
      label: IFCLabel;
    }>;
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
    bundleId?: string;
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

export type CfcTxState = {
  relevant: boolean;
  enforcementMode: CfcEnforcementMode;
  prepare: CfcPrepareState;
  dereferenceTraces: CfcDereferenceTrace[];
  writePolicyInputs: WritePolicyInput[];
  // Implementation identity active when each write-policy input was recorded.
  // A single transaction may legitimately span multiple trust contexts (e.g. a
  // handler plus a child pattern it runs); writeAuthorizedBy must be verified
  // against the identity that authored each write, not the last one active.
  writePolicyInputIdentities: Map<
    WritePolicyInput,
    ImplementationIdentity | undefined
  >;
  trustSnapshot?: TrustSnapshot;
  implementationIdentity?: ImplementationIdentity;
  outbox: PostCommitSideEffect[];
  diagnostics: string[];
  // Per-sink confidentiality ceilings consulted by prepareBoundaryCommit for
  // every recorded sink-request input (set once by the Runtime at tx creation;
  // see SinkMaxConfidentiality). Undefined = no ceilings declared.
  sinkMaxConfidentiality?: SinkMaxConfidentiality;
};
