import {
  type CfcEnforcementMode,
  isCfcEnforcementMode,
  type TrustSnapshot,
} from "@commonfabric/runner/cfc";
import type { HarnessCfcEnforcementModeSource } from "./contracts/cfc-policy-snapshot.ts";
import type { HarnessRunManifest } from "./contracts/run-manifest.ts";
import type {
  HarnessAllowedSkillScript,
  HarnessSkillScriptExecutionTarget,
} from "./contracts/skill.ts";
import type { HarnessBrowserAccessLease } from "./contracts/browser-access.ts";
import type { HarnessSandboxConfig } from "./sandbox/types.ts";

export const DEFAULT_GATEWAY_BASE_URL = "https://llm.stage.commontools.dev/";
export const DEFAULT_HARNESS_CFC_ENFORCEMENT_MODE =
  "enforce-explicit" as const satisfies CfcEnforcementMode;
export type HarnessGatewayAuthMode = "bearer" | "none";
export type HarnessModelProviderId =
  | "openai-compatible-gateway"
  | "openai-codex";
export type HarnessModelAuthSource = "api-key" | "none" | "owner-bound-oauth";

interface HarnessCommonConfig {
  cwd?: string;
  model?: string;
  vmTarget?: string;
  skillsRoot?: string;
  allowedSkillScripts?: readonly HarnessAllowedSkillScript[];
  skillScriptExecutionTarget: HarnessSkillScriptExecutionTarget;
  browserAccess?: HarnessBrowserAccessLease;
  artifactRoot?: string;
  cfcEnforcementMode: CfcEnforcementMode;
  cfcEnforcementModeSource: HarnessCfcEnforcementModeSource;
  trustSnapshot?: TrustSnapshot;
  sandbox?: HarnessSandboxConfig;
  runManifest?: HarnessRunManifest;
  runManifestPath?: string;
}

/**
 * Resolved harness configuration. The gateway fields remain required for
 * backward-compatible library access; `modelProvider` determines whether they
 * are active. The Codex provider ignores them and uses `credentialOwnerKey`.
 */
export interface HarnessConfig extends HarnessCommonConfig {
  modelProvider: HarnessModelProviderId;
  gatewayBaseUrl: string;
  gatewayAuthMode: HarnessGatewayAuthMode;
  credentialOwnerKey?: string;
}

export interface ResolveHarnessConfigOptions {
  modelProvider?: HarnessModelProviderId;
  credentialOwnerKey?: string;
  gatewayBaseUrl?: string;
  gatewayAuthMode?: HarnessGatewayAuthMode;
  gatewayAuthModeOverride?: string | HarnessGatewayAuthMode;
  cwd?: string;
  model?: string;
  vmTarget?: string;
  skillsRoot?: string;
  allowedSkillScripts?: readonly HarnessAllowedSkillScript[];
  skillScriptExecutionTarget?: HarnessSkillScriptExecutionTarget;
  browserAccess?: HarnessBrowserAccessLease;
  artifactRoot?: string;
  cfcEnforcementMode?: CfcEnforcementMode;
  inheritedCfcEnforcementMode?: CfcEnforcementMode;
  cfcEnforcementModeOverride?: string | CfcEnforcementMode;
  trustSnapshot?: TrustSnapshot;
  sandbox?: HarnessSandboxConfig;
  runManifest?: HarnessRunManifest;
  runManifestPath?: string;
}

const GATEWAY_AUTH_MODES: readonly HarnessGatewayAuthMode[] = [
  "bearer",
  "none",
];

export const parseCfcEnforcementMode = (
  input: string | null | undefined,
): CfcEnforcementMode | undefined =>
  isCfcEnforcementMode(input) ? input : undefined;

export const isHarnessGatewayAuthMode = (
  input: unknown,
): input is HarnessGatewayAuthMode =>
  typeof input === "string" &&
  GATEWAY_AUTH_MODES.includes(input as HarnessGatewayAuthMode);

export const parseHarnessGatewayAuthMode = (
  input: string | null | undefined,
): HarnessGatewayAuthMode | undefined =>
  isHarnessGatewayAuthMode(input) ? input : undefined;

export const resolveCfcEnforcementMode = (
  options: Pick<
    ResolveHarnessConfigOptions,
    | "cfcEnforcementModeOverride"
    | "cfcEnforcementMode"
    | "inheritedCfcEnforcementMode"
    | "runManifest"
  >,
): CfcEnforcementMode => {
  const parsedOverride = typeof options.cfcEnforcementModeOverride === "string"
    ? parseCfcEnforcementMode(options.cfcEnforcementModeOverride)
    : options.cfcEnforcementModeOverride;
  const parsedRunManifestMode = parseCfcEnforcementMode(
    options.runManifest?.cfc?.enforcementMode,
  );
  return parsedOverride ??
    options.cfcEnforcementMode ??
    options.inheritedCfcEnforcementMode ??
    parsedRunManifestMode ??
    DEFAULT_HARNESS_CFC_ENFORCEMENT_MODE;
};

export const resolveCfcEnforcementModeSource = (
  options: Pick<
    ResolveHarnessConfigOptions,
    | "cfcEnforcementModeOverride"
    | "cfcEnforcementMode"
    | "inheritedCfcEnforcementMode"
    | "runManifest"
  >,
): HarnessCfcEnforcementModeSource => {
  const parsedOverride = typeof options.cfcEnforcementModeOverride === "string"
    ? parseCfcEnforcementMode(options.cfcEnforcementModeOverride)
    : options.cfcEnforcementModeOverride;
  if (parsedOverride != null) {
    return "override";
  }
  if (options.cfcEnforcementMode != null) {
    return "explicit-config";
  }
  if (options.inheritedCfcEnforcementMode != null) {
    return "inherited";
  }
  if (parseCfcEnforcementMode(options.runManifest?.cfc?.enforcementMode)) {
    return "run-manifest";
  }
  return "default";
};

export const normalizeGatewayBaseUrl = (input: string): string =>
  new URL(input).toString();

export const resolveGatewayAuthMode = (
  options: Pick<
    ResolveHarnessConfigOptions,
    "gatewayAuthMode" | "gatewayAuthModeOverride"
  >,
): HarnessGatewayAuthMode => {
  const parsedOverride = typeof options.gatewayAuthModeOverride === "string"
    ? parseHarnessGatewayAuthMode(options.gatewayAuthModeOverride)
    : options.gatewayAuthModeOverride;
  return parsedOverride ??
    options.gatewayAuthMode ??
    "bearer";
};

export const resolveHarnessConfig = (
  options: ResolveHarnessConfigOptions = {},
): HarnessConfig => {
  const modelProvider = options.modelProvider ?? "openai-compatible-gateway";
  if (
    modelProvider === "openai-codex" &&
    (options.gatewayBaseUrl !== undefined ||
      options.gatewayAuthMode !== undefined ||
      options.gatewayAuthModeOverride !== undefined)
  ) {
    throw new Error(
      "gateway URL/auth configuration cannot be combined with openai-codex",
    );
  }
  const common: HarnessCommonConfig = {
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    ...(options.model !== undefined ? { model: options.model } : {}),
    ...(options.vmTarget !== undefined ? { vmTarget: options.vmTarget } : {}),
    ...(options.skillsRoot !== undefined
      ? { skillsRoot: options.skillsRoot }
      : {}),
    ...(options.allowedSkillScripts !== undefined
      ? { allowedSkillScripts: options.allowedSkillScripts }
      : {}),
    skillScriptExecutionTarget: options.skillScriptExecutionTarget ?? "sandbox",
    ...(options.browserAccess !== undefined
      ? { browserAccess: options.browserAccess }
      : {}),
    ...(options.artifactRoot !== undefined
      ? { artifactRoot: options.artifactRoot }
      : {}),
    ...(options.trustSnapshot !== undefined
      ? { trustSnapshot: options.trustSnapshot }
      : {}),
    ...(options.sandbox !== undefined ? { sandbox: options.sandbox } : {}),
    ...(options.runManifest !== undefined
      ? { runManifest: options.runManifest }
      : {}),
    ...(options.runManifestPath !== undefined
      ? { runManifestPath: options.runManifestPath }
      : {}),
    cfcEnforcementMode: resolveCfcEnforcementMode(options),
    cfcEnforcementModeSource: resolveCfcEnforcementModeSource(options),
  };
  return {
    ...common,
    modelProvider,
    gatewayBaseUrl: normalizeGatewayBaseUrl(
      modelProvider === "openai-compatible-gateway"
        ? options.gatewayBaseUrl ?? DEFAULT_GATEWAY_BASE_URL
        : DEFAULT_GATEWAY_BASE_URL,
    ),
    gatewayAuthMode: modelProvider === "openai-compatible-gateway"
      ? resolveGatewayAuthMode(options)
      : "bearer",
    ...(modelProvider === "openai-codex"
      ? { credentialOwnerKey: options.credentialOwnerKey ?? "local" }
      : {}),
  };
};
