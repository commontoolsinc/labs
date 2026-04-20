import type {
  CfcEnforcementMode,
  TrustSnapshot,
} from "@commonfabric/runner/cfc";
import type { HarnessSandboxConfig } from "./sandbox/types.ts";

export const DEFAULT_GATEWAY_BASE_URL = "https://llm.stage.commontools.dev/";
export type HarnessGatewayAuthMode = "bearer" | "none";

export interface HarnessConfig {
  gatewayBaseUrl: string;
  gatewayAuthMode: HarnessGatewayAuthMode;
  model?: string;
  vmTarget?: string;
  skillsRoot?: string;
  artifactRoot?: string;
  cfcEnforcementMode: CfcEnforcementMode;
  trustSnapshot?: TrustSnapshot;
  sandbox?: HarnessSandboxConfig;
}

export interface ResolveHarnessConfigOptions {
  gatewayBaseUrl?: string;
  gatewayAuthMode?: HarnessGatewayAuthMode;
  gatewayAuthModeOverride?: string | HarnessGatewayAuthMode;
  model?: string;
  vmTarget?: string;
  skillsRoot?: string;
  artifactRoot?: string;
  cfcEnforcementMode?: CfcEnforcementMode;
  inheritedCfcEnforcementMode?: CfcEnforcementMode;
  cfcEnforcementModeOverride?: string | CfcEnforcementMode;
  trustSnapshot?: TrustSnapshot;
  sandbox?: HarnessSandboxConfig;
}

const CFC_ENFORCEMENT_MODES: readonly CfcEnforcementMode[] = [
  "disabled",
  "observe",
  "enforce-explicit",
  "enforce-strict",
];
const GATEWAY_AUTH_MODES: readonly HarnessGatewayAuthMode[] = [
  "bearer",
  "none",
];

export const isCfcEnforcementMode = (
  input: unknown,
): input is CfcEnforcementMode =>
  typeof input === "string" &&
  CFC_ENFORCEMENT_MODES.includes(input as CfcEnforcementMode);

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
  >,
): CfcEnforcementMode => {
  const parsedOverride = typeof options.cfcEnforcementModeOverride === "string"
    ? parseCfcEnforcementMode(options.cfcEnforcementModeOverride)
    : options.cfcEnforcementModeOverride;
  return parsedOverride ??
    options.cfcEnforcementMode ??
    options.inheritedCfcEnforcementMode ??
    "disabled";
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
): HarnessConfig => ({
  gatewayBaseUrl: normalizeGatewayBaseUrl(
    options.gatewayBaseUrl ?? DEFAULT_GATEWAY_BASE_URL,
  ),
  gatewayAuthMode: resolveGatewayAuthMode(options),
  ...(options.model !== undefined ? { model: options.model } : {}),
  ...(options.vmTarget !== undefined ? { vmTarget: options.vmTarget } : {}),
  ...(options.skillsRoot !== undefined
    ? { skillsRoot: options.skillsRoot }
    : {}),
  ...(options.artifactRoot !== undefined
    ? { artifactRoot: options.artifactRoot }
    : {}),
  ...(options.trustSnapshot !== undefined
    ? { trustSnapshot: options.trustSnapshot }
    : {}),
  ...(options.sandbox !== undefined ? { sandbox: options.sandbox } : {}),
  cfcEnforcementMode: resolveCfcEnforcementMode(options),
});
