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
  return {
    ...input,
    type: LOOM_RUN_MANIFEST_TYPE,
    version: 1,
    source: "loom",
    ...(promptSlot !== undefined ? { promptSlot } : {}),
    ...(cfc !== undefined ? { cfc } : {}),
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
