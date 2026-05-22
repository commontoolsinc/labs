import type { CfcEnforcementMode } from "@commonfabric/runner/cfc";
import type {
  HarnessCfcAbsenceBehavior,
  HarnessCfcSubstrateStatus,
} from "../diagnostics.ts";
import type { SandboxRuntimeDescription } from "../sandbox/types.ts";
import type { PromptSlotBinding } from "./prompt-slot.ts";
import type { HarnessRunManifest } from "./run-manifest.ts";
import type { HarnessAllowedSkillScript } from "./skill.ts";
import type {
  HarnessSubagentProfile,
  HarnessSubagentProfileConfig,
} from "./subagent.ts";
import type { BuiltinToolId } from "./tool-descriptor.ts";

export type HarnessCfcEnforcementModeSource =
  | "override"
  | "explicit-config"
  | "inherited"
  | "run-manifest"
  | "default";

export type HarnessPromptSlotBindingSource =
  | "run-options"
  | "run-state"
  | "absent";

export type HarnessParentToolAllowance = "all-builtins" | "restricted";

export interface HarnessCfcPolicySnapshotRunManifestSummary {
  present: boolean;
  type?: HarnessRunManifest["type"];
  path?: string;
  source?: HarnessRunManifest["source"];
  wishId?: string;
  parentWishId?: string;
  dispatchClass?: string;
  capabilityProfile?: string;
  cfcEnforcementMode?: CfcEnforcementMode;
  labelSource?: string;
  promptSlotPresent?: boolean;
}

export interface HarnessCfcPolicySnapshot {
  type: "cf-harness.cfc-policy-snapshot";
  version: 1;
  generatedAt: string;
  runId: string;
  cfc: {
    enforcementMode: CfcEnforcementMode;
    enforcementModeSource: HarnessCfcEnforcementModeSource;
    absenceBehavior?: HarnessCfcAbsenceBehavior;
    substrateStatus?: HarnessCfcSubstrateStatus;
  };
  runManifest: HarnessCfcPolicySnapshotRunManifestSummary;
  promptSlot: {
    present: boolean;
    bindingSource: HarnessPromptSlotBindingSource;
    binding?: PromptSlotBinding;
  };
  parentTools: {
    allowance: HarnessParentToolAllowance;
    allowedToolIds: readonly BuiltinToolId[];
  };
  skillScripts: {
    allowedScripts: readonly HarnessAllowedSkillScript[];
  };
  subagents: {
    allowedProfiles: readonly HarnessSubagentProfile[];
    profileConfigs: readonly HarnessSubagentProfileConfig[];
  };
  substrate?: {
    sandbox?: SandboxRuntimeDescription;
    protectedXattrs?: {
      expectedSandboxVisible: false;
      sandboxVisibility: "not-probed";
    };
  };
}

export interface CreateHarnessCfcPolicySnapshotOptions {
  runId: string;
  generatedAt: string;
  cfcEnforcementMode: CfcEnforcementMode;
  cfcEnforcementModeSource: HarnessCfcEnforcementModeSource;
  runManifest?: HarnessRunManifest;
  runManifestPath?: string;
  promptSlotBinding?: PromptSlotBinding;
  promptSlotBindingSource: HarnessPromptSlotBindingSource;
  parentToolAllowance: HarnessParentToolAllowance;
  allowedToolIds: readonly BuiltinToolId[];
  allowedSkillScripts?: readonly HarnessAllowedSkillScript[];
  allowedSubagentProfiles: readonly HarnessSubagentProfile[];
  subagentProfileConfigs: readonly HarnessSubagentProfileConfig[];
  absenceBehavior?: HarnessCfcAbsenceBehavior;
  substrateStatus?: HarnessCfcSubstrateStatus;
  sandbox?: SandboxRuntimeDescription;
  protectedXattrs?: {
    expectedSandboxVisible: false;
    sandboxVisibility: "not-probed";
  };
}

export const createHarnessCfcPolicySnapshot = (
  options: CreateHarnessCfcPolicySnapshotOptions,
): HarnessCfcPolicySnapshot => ({
  type: "cf-harness.cfc-policy-snapshot",
  version: 1,
  generatedAt: options.generatedAt,
  runId: options.runId,
  cfc: {
    enforcementMode: options.cfcEnforcementMode,
    enforcementModeSource: options.cfcEnforcementModeSource,
    ...(options.absenceBehavior !== undefined
      ? { absenceBehavior: options.absenceBehavior }
      : {}),
    ...(options.substrateStatus !== undefined
      ? { substrateStatus: options.substrateStatus }
      : {}),
  },
  runManifest: {
    present: options.runManifest !== undefined,
    ...(options.runManifest !== undefined
      ? {
        type: options.runManifest.type,
        source: options.runManifest.source,
        ...(options.runManifest.wishId !== undefined
          ? { wishId: options.runManifest.wishId }
          : {}),
        ...(options.runManifest.parentWishId !== undefined
          ? { parentWishId: options.runManifest.parentWishId }
          : {}),
        ...(options.runManifest.dispatchClass !== undefined
          ? { dispatchClass: options.runManifest.dispatchClass }
          : {}),
        ...(options.runManifest.capabilityProfile !== undefined
          ? { capabilityProfile: options.runManifest.capabilityProfile }
          : {}),
        ...(options.runManifest.cfc?.enforcementMode !== undefined
          ? { cfcEnforcementMode: options.runManifest.cfc.enforcementMode }
          : {}),
        ...(options.runManifest.cfc?.labelSource !== undefined
          ? { labelSource: options.runManifest.cfc.labelSource }
          : {}),
        promptSlotPresent: options.runManifest.promptSlot !== undefined,
      }
      : {}),
    ...(options.runManifestPath !== undefined
      ? { path: options.runManifestPath }
      : {}),
  },
  promptSlot: {
    present: options.promptSlotBinding !== undefined,
    bindingSource: options.promptSlotBindingSource,
    ...(options.promptSlotBinding !== undefined
      ? { binding: options.promptSlotBinding }
      : {}),
  },
  parentTools: {
    allowance: options.parentToolAllowance,
    allowedToolIds: [...options.allowedToolIds],
  },
  skillScripts: {
    allowedScripts: (options.allowedSkillScripts ?? []).map((script) => ({
      ...script,
    })),
  },
  subagents: {
    allowedProfiles: [...options.allowedSubagentProfiles],
    profileConfigs: options.subagentProfileConfigs.map((config) => ({
      ...config,
      allowedToolIds: [...config.allowedToolIds],
      ...(config.nativeModelToolIds !== undefined
        ? { nativeModelToolIds: [...config.nativeModelToolIds] }
        : {}),
      returnPolicy: { ...config.returnPolicy },
    })),
  },
  ...(options.sandbox !== undefined || options.protectedXattrs !== undefined
    ? {
      substrate: {
        ...(options.sandbox !== undefined ? { sandbox: options.sandbox } : {}),
        ...(options.protectedXattrs !== undefined
          ? { protectedXattrs: options.protectedXattrs }
          : {}),
      },
    }
    : {}),
});
