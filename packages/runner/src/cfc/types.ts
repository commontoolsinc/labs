import type { JSONSchema } from "../builder/types.ts";
import type { FabricValue, MemorySpace } from "@commonfabric/memory/interface";
import type { Metadata } from "../storage/interface.ts";

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

export type IFCLabel = {
  confidentiality?: unknown[];
  integrity?: unknown[];
};

export type CfcMetadata = {
  version: 1;
  schemaHash: string;
  labelMap: {
    version: 1;
    entries: Array<{
      path: string[];
      label: IFCLabel;
    }>;
  };
};

export type EntityDocumentWithCfc = {
  value?: unknown;
  source?: unknown;
  cfc?: CfcMetadata;
};

export type CfcAddress = {
  space: MemorySpace;
  id: string;
  type: string;
  path: string[];
};

export type ConsumedRead = CfcAddress & {
  meta?: Metadata;
  nonRecursive?: boolean;
};

export type AttemptedWrite = CfcAddress;

export type CfcDereferenceTrace = {
  source: CfcAddress;
  target: CfcAddress;
  kind: "value" | "write-redirect";
};

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

export type WritePolicyInput =
  | {
    kind: "schema";
    target: CfcAddress;
    schemaHash?: string;
    schema?: JSONSchema;
  }
  | {
    kind: "structural-provenance";
    target: CfcAddress;
    claim: string;
    sources: CfcAddress[];
  }
  | {
    kind: "trusted-event";
    target: CfcAddress;
    eventId: string;
    provenance?: FabricValue;
  }
  | {
    kind: "link-write";
    target: CfcAddress;
    source: CfcAddress;
    linkSchema?: JSONSchema;
  }
  | {
    kind: "sink-request";
    effectId: string;
    sink: string;
    request: FabricValue;
  }
  | {
    kind: "custom";
    target?: CfcAddress;
    name: string;
    value: FabricValue;
  };

export type PreparedDigestInput = {
  consumedReads: ConsumedRead[];
  potentialWrites: AttemptedWrite[];
  writes: AttemptedWrite[];
  dereferenceTraces: CfcDereferenceTrace[];
  writePolicyInputs: WritePolicyInput[];
  implementationIdentity?: ImplementationIdentity;
  trustSnapshot?: TrustSnapshot;
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
  trustSnapshot?: TrustSnapshot;
  implementationIdentity?: ImplementationIdentity;
  outbox: PostCommitSideEffect[];
  diagnostics: string[];
};
