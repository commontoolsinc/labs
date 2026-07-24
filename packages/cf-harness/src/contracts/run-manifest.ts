import {
  type CfcEnforcementMode,
  isCfcEnforcementMode,
} from "@commonfabric/runner/cfc";
import { isRecord } from "@commonfabric/utils/types";
import {
  normalizePromptSlotBinding,
  type PromptSlotBinding,
} from "./prompt-slot.ts";

export const LOOM_RUN_MANIFEST_TYPE = "cf-harness.loom-run-manifest" as const;

export interface LoomRunManifestWorkspace {
  hostPath?: string;
  sandboxPath?: string;
  cwd?: string;
}

export interface LoomRunManifestCfc {
  enforcementMode?: CfcEnforcementMode;
  labelSource?: "loom-run-manifest";
}

export const HARNESS_CREDENTIAL_OWNER_REF_TYPE =
  "cf-harness.credential-owner-ref" as const;

export interface HarnessCredentialOwnerRef {
  type: typeof HARNESS_CREDENTIAL_OWNER_REF_TYPE;
  version: 1;
  ownerKey: string;
  tenantKey?: string;
}

export const harnessCredentialOwnersEqual = (
  left: HarnessCredentialOwnerRef,
  right: HarnessCredentialOwnerRef,
): boolean =>
  left.type === right.type && left.version === right.version &&
  left.ownerKey === right.ownerKey && left.tenantKey === right.tenantKey;

export interface LoomRunManifest {
  type: typeof LOOM_RUN_MANIFEST_TYPE;
  version: 1;
  source: "loom";
  instanceId?: string;
  wishId?: string;
  parentWishId?: string;
  dispatchClass?: string;
  capabilityProfile?: string;
  model?: string;
  modelProvider?: "openai-compatible-gateway" | "openai-codex";
  credentialOwner?: HarnessCredentialOwnerRef;
  workspace?: LoomRunManifestWorkspace;
  promptSlot?: PromptSlotBinding;
  cfc?: LoomRunManifestCfc;
  extra?: Record<string, unknown>;
}

export type HarnessRunManifest = LoomRunManifest;

const isJsonObject = (input: unknown): input is Record<string, unknown> =>
  isRecord(input) && !Array.isArray(input);

const isLoomRunManifestType = (input: unknown): boolean =>
  input === undefined || input === LOOM_RUN_MANIFEST_TYPE;

const normalizeLoomRunManifestCfc = (
  input: unknown,
): LoomRunManifestCfc | undefined => {
  if (input === undefined) {
    return undefined;
  }
  if (!isJsonObject(input)) {
    throw new Error("run manifest cfc must be a JSON object");
  }
  if (
    input.enforcementMode !== undefined &&
    !isCfcEnforcementMode(input.enforcementMode)
  ) {
    throw new Error(
      `unsupported run manifest cfc.enforcementMode: ${
        String(input.enforcementMode)
      }`,
    );
  }
  if (
    input.labelSource !== undefined &&
    input.labelSource !== "loom-run-manifest"
  ) {
    throw new Error(
      `unsupported run manifest cfc.labelSource: ${String(input.labelSource)}`,
    );
  }
  return {
    ...(input.enforcementMode !== undefined
      ? { enforcementMode: input.enforcementMode }
      : {}),
    ...(input.labelSource !== undefined
      ? { labelSource: input.labelSource }
      : {}),
  };
};

const normalizeCredentialOwnerRef = (
  input: unknown,
): HarnessCredentialOwnerRef | undefined => {
  if (input === undefined) return undefined;
  if (!isJsonObject(input)) {
    throw new Error("run manifest credentialOwner must be a JSON object");
  }
  if (
    input.type !== HARNESS_CREDENTIAL_OWNER_REF_TYPE || input.version !== 1 ||
    typeof input.ownerKey !== "string" || input.ownerKey.trim() === "" ||
    input.ownerKey.trim() !== input.ownerKey ||
    (input.tenantKey !== undefined &&
      (typeof input.tenantKey !== "string" || input.tenantKey.trim() === "" ||
        input.tenantKey.trim() !== input.tenantKey))
  ) {
    throw new Error("invalid run manifest credentialOwner reference");
  }
  return {
    type: HARNESS_CREDENTIAL_OWNER_REF_TYPE,
    version: 1,
    ownerKey: input.ownerKey,
    ...(input.tenantKey !== undefined ? { tenantKey: input.tenantKey } : {}),
  };
};

export const normalizeLoomRunManifest = (
  input: unknown,
): LoomRunManifest => {
  if (!isJsonObject(input)) {
    throw new Error("run manifest must be a JSON object");
  }
  if (!isLoomRunManifestType(input.type)) {
    throw new Error(
      `unsupported run manifest type: ${String(input.type)}`,
    );
  }
  if (input.version !== undefined && input.version !== 1) {
    throw new Error(
      `unsupported run manifest version: ${String(input.version)}`,
    );
  }
  const promptSlot = input.promptSlot === undefined
    ? undefined
    : normalizePromptSlotBinding(input.promptSlot);
  const cfc = normalizeLoomRunManifestCfc(input.cfc);
  if (
    input.modelProvider !== undefined &&
    input.modelProvider !== "openai-compatible-gateway" &&
    input.modelProvider !== "openai-codex"
  ) {
    throw new Error(
      `unsupported run manifest modelProvider: ${String(input.modelProvider)}`,
    );
  }
  const credentialOwner = normalizeCredentialOwnerRef(input.credentialOwner);
  return {
    ...input,
    type: LOOM_RUN_MANIFEST_TYPE,
    version: 1,
    source: "loom",
    ...(promptSlot !== undefined ? { promptSlot } : {}),
    ...(cfc !== undefined ? { cfc } : {}),
    ...(credentialOwner !== undefined ? { credentialOwner } : {}),
  } as LoomRunManifest;
};

export const parseLoomRunManifestJson = (
  text: string,
): LoomRunManifest => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `failed to parse run manifest JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  return normalizeLoomRunManifest(parsed);
};
