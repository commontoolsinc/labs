import type {
  CfcEnforcementMode,
  TrustSnapshot,
} from "@commonfabric/runner/cfc";

export const DEFAULT_GATEWAY_BASE_URL = "https://llm.stage.commontools.dev/";

export interface HarnessConfig {
  gatewayBaseUrl: string;
  model?: string;
  vmTarget?: string;
  skillsRoot?: string;
  cfcEnforcementMode: CfcEnforcementMode;
  trustSnapshot?: TrustSnapshot;
}

export interface ResolveHarnessConfigOptions {
  gatewayBaseUrl?: string;
  model?: string;
  vmTarget?: string;
  skillsRoot?: string;
  cfcEnforcementMode?: CfcEnforcementMode;
  inheritedCfcEnforcementMode?: CfcEnforcementMode;
  cfcEnforcementModeOverride?: string | CfcEnforcementMode;
  trustSnapshot?: TrustSnapshot;
}

const CFC_ENFORCEMENT_MODES: readonly CfcEnforcementMode[] = [
  "disabled",
  "observe",
  "enforce-explicit",
  "enforce-strict",
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

export const resolveHarnessConfig = (
  options: ResolveHarnessConfigOptions = {},
): HarnessConfig => ({
  gatewayBaseUrl: normalizeGatewayBaseUrl(
    options.gatewayBaseUrl ?? DEFAULT_GATEWAY_BASE_URL,
  ),
  ...(options.model !== undefined ? { model: options.model } : {}),
  ...(options.vmTarget !== undefined ? { vmTarget: options.vmTarget } : {}),
  ...(options.skillsRoot !== undefined
    ? { skillsRoot: options.skillsRoot }
    : {}),
  ...(options.trustSnapshot !== undefined
    ? { trustSnapshot: options.trustSnapshot }
    : {}),
  cfcEnforcementMode: resolveCfcEnforcementMode(options),
});
