import {
  type CfcEnforcementMode,
  type CfcFlowLabelsMode,
  isCfcEnforcementMode,
} from "@commonfabric/runner/cfc";
import type { CfcPosture } from "@commonfabric/runner";
import type { HarnessCfcEnforcementModeSource } from "./contracts/cfc-policy-snapshot.ts";
import {
  type HarnessCredentialOwnerRef,
  harnessCredentialOwnersEqual,
  type HarnessRunManifest,
} from "./contracts/run-manifest.ts";
import type {
  HarnessAllowedSkillScript,
  HarnessSkillScriptExecutionTarget,
} from "./contracts/skill.ts";
import type { HarnessBrowserAccessLease } from "./contracts/browser-access.ts";
import type { DockerRunscSandboxConfig } from "./sandbox/types.ts";

export const DEFAULT_GATEWAY_BASE_URL = "https://llm.stage.commontools.dev/";
export const DEFAULT_HARNESS_CFC_ENFORCEMENT_MODE =
  "enforce-explicit" as const satisfies CfcEnforcementMode;
export type HarnessGatewayAuthMode = "bearer" | "none";

/**
 * The fabric session's enforcement dial admits raises only: the remoteClient
 * preset already pins `enforce-explicit`, so the sole configurable move is up
 * to `enforce-strict`. This is a different dial from the harness's own
 * `cfcEnforcementMode`, which governs tool policy and the sandbox — this one
 * governs the runtime the `run_pattern` tool deploys patterns into.
 */
export type HarnessFabricCfcEnforcementMode =
  | "enforce-explicit"
  | "enforce-strict";
export type HarnessFabricCfcFlowLabelsMode = CfcFlowLabelsMode;

/**
 * Connection settings for the trusted Fabric session behind the
 * `run_pattern` tool: the deployed API URL, a PKCS#8 identity keyfile path
 * on the host, and the target space (a name or a `did:key`). When present,
 * the run offers `run_pattern` in the parent tool surface; when absent, the
 * tool is unavailable. The optional CFC dials reach the session's Runtime;
 * unset means the remoteClient preset's first-party posture
 * (`enforce-explicit`, flow labels off). `cfcPosture` opts the runtime into
 * a named bundle (`MAX_ENFORCEMENT_CFC_OPTIONS` in the runner's presets);
 * the two dials still apply over it.
 */
export interface HarnessFabricSessionConfig {
  apiUrl: string;
  identityKeyPath: string;
  space: string;
  cfcEnforcementMode?: HarnessFabricCfcEnforcementMode;
  cfcFlowLabels?: HarnessFabricCfcFlowLabelsMode;
  cfcPosture?: CfcPosture;
}
export type HarnessModelProviderId =
  | "openai-compatible-gateway"
  | "openai-codex";
export type HarnessModelAuthSource =
  | "api-key"
  | "none"
  | "owner-bound-oauth"
  | "cf-harness-local-store";

interface HarnessCommonConfig {
  cwd?: string;
  model?: string;
  modelAuthSource?: HarnessModelAuthSource;
  credentialOwner?: HarnessCredentialOwnerRef;
  harnessHomeIdentity?: string;
  skillsRoot?: string;
  allowedSkillScripts?: readonly HarnessAllowedSkillScript[];
  skillScriptExecutionTarget: HarnessSkillScriptExecutionTarget;
  browserAccess?: HarnessBrowserAccessLease;

  /**
   * Origins where a value materialized from a handle may be sent. Operator
   * configuration, empty or absent by default: a run that names no origin
   * cannot materialize a handle at all. The check is on the destination
   * rather than on the value because a handle's whole point is that the run
   * using it cannot see what it holds — only where it is going is knowable,
   * so that is what an operator gets to decide.
   */
  handleValueOrigins?: readonly string[];
  artifactRoot?: string;
  cfcEnforcementMode: CfcEnforcementMode;
  cfcEnforcementModeSource: HarnessCfcEnforcementModeSource;
  fabricSession?: HarnessFabricSessionConfig;
  sandbox?: DockerRunscSandboxConfig;
  runManifest?: HarnessRunManifest;
  runManifestPath?: string;
}

/** Public configuration shape retained for pre-provider gateway callers. */
export interface HarnessConfig extends HarnessCommonConfig {
  modelProvider?: HarnessModelProviderId;
  gatewayBaseUrl: string;
  gatewayAuthMode: HarnessGatewayAuthMode;
  credentialOwnerKey?: string;
}

/** Fully resolved configuration used by the engine. */
export type ResolvedHarnessConfig =
  & HarnessCommonConfig
  & (
    | {
      modelProvider: "openai-compatible-gateway";
      gatewayBaseUrl: string;
      gatewayAuthMode: HarnessGatewayAuthMode;
      credentialOwnerKey?: never;
    }
    | {
      modelProvider: "openai-codex";
      credentialOwnerKey: string;
      // Kept as inactive metadata for public API compatibility.
      gatewayBaseUrl: string;
      gatewayAuthMode: HarnessGatewayAuthMode;
    }
  );

export interface ResolveHarnessConfigOptions {
  modelProvider?: HarnessModelProviderId;
  credentialOwnerKey?: string;
  credentialOwner?: HarnessCredentialOwnerRef;
  modelAuthSource?: HarnessModelAuthSource;
  harnessHomeIdentity?: string;
  gatewayBaseUrl?: string;
  gatewayAuthMode?: HarnessGatewayAuthMode;
  gatewayAuthModeOverride?: string | HarnessGatewayAuthMode;
  cwd?: string;
  model?: string;
  skillsRoot?: string;
  allowedSkillScripts?: readonly HarnessAllowedSkillScript[];
  skillScriptExecutionTarget?: HarnessSkillScriptExecutionTarget;
  browserAccess?: HarnessBrowserAccessLease;
  handleValueOrigins?: readonly string[];
  artifactRoot?: string;
  cfcEnforcementMode?: CfcEnforcementMode;
  inheritedCfcEnforcementMode?: CfcEnforcementMode;
  cfcEnforcementModeOverride?: string | CfcEnforcementMode;
  fabricSession?: HarnessFabricSessionConfig;
  sandbox?: DockerRunscSandboxConfig;
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

export const isHarnessModelProviderId = (
  input: unknown,
): input is HarnessModelProviderId =>
  input === "openai-compatible-gateway" || input === "openai-codex";

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
): ResolvedHarnessConfig => {
  const modelProvider = options.modelProvider ?? "openai-compatible-gateway";
  if (
    options.credentialOwner !== undefined &&
    options.runManifest?.credentialOwner !== undefined &&
    !harnessCredentialOwnersEqual(
      options.credentialOwner,
      options.runManifest.credentialOwner,
    )
  ) {
    throw new Error(
      "configured credential owner does not match run manifest credential owner",
    );
  }
  const credentialOwner = options.credentialOwner ??
    options.runManifest?.credentialOwner;
  const harnessHomeIdentity = options.harnessHomeIdentity ??
    options.runManifest?.harnessHomeIdentity;
  const modelAuthSource = options.modelAuthSource ??
    options.runManifest?.modelAuthSource;
  if (
    credentialOwner !== undefined && options.credentialOwnerKey !== undefined &&
    credentialOwner.ownerKey !== options.credentialOwnerKey
  ) {
    throw new Error(
      "credential owner reference does not match configured credential owner key",
    );
  }
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
    ...(modelAuthSource !== undefined ? { modelAuthSource } : {}),
    ...(credentialOwner !== undefined ? { credentialOwner } : {}),
    ...(harnessHomeIdentity !== undefined ? { harnessHomeIdentity } : {}),
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
    ...(options.handleValueOrigins !== undefined
      ? { handleValueOrigins: options.handleValueOrigins }
      : {}),
    ...(options.artifactRoot !== undefined
      ? { artifactRoot: options.artifactRoot }
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
    ...(options.fabricSession !== undefined
      ? { fabricSession: options.fabricSession }
      : {}),
  };
  if (modelProvider === "openai-codex") {
    return {
      ...common,
      modelProvider,
      credentialOwnerKey: options.credentialOwnerKey ??
        credentialOwner?.ownerKey ?? "local",
      gatewayBaseUrl: normalizeGatewayBaseUrl(DEFAULT_GATEWAY_BASE_URL),
      gatewayAuthMode: "bearer",
    };
  }
  return {
    ...common,
    modelProvider,
    gatewayBaseUrl: normalizeGatewayBaseUrl(
      options.gatewayBaseUrl ?? DEFAULT_GATEWAY_BASE_URL,
    ),
    gatewayAuthMode: resolveGatewayAuthMode(options),
  };
};
