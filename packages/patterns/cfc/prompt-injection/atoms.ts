import type { ImmutableJSONValue } from "commonfabric";

export const DEFAULT_PROMPT_INJECTION_RISK_KIND =
  "https://commonfabric.org/cfc/concepts/prompt-injection-risk-unscreened";
export const DEFAULT_PROMPT_INFLUENCE_KIND =
  "https://commonfabric.org/cfc/concepts/prompt-influence";

export const INJECTION_SAFE_ATOM = {
  type: "https://commonfabric.org/cfc/atom/InjectionSafe",
} as const;

export const promptInjectionRiskAtom = (
  source: ImmutableJSONValue,
  kind: string = DEFAULT_PROMPT_INJECTION_RISK_KIND,
) => ({
  type: "https://commonfabric.org/cfc/atom/Caveat",
  kind,
  source,
});

export const promptInfluenceAtom = (
  source: ImmutableJSONValue,
  kind: string = DEFAULT_PROMPT_INFLUENCE_KIND,
) => ({
  type: "https://commonfabric.org/cfc/atom/Caveat",
  kind,
  source,
});

export const trustedAgentKernelAtom = (name: string) => ({
  type: "https://commonfabric.org/cfc/atom/Builtin",
  name,
});

export const userSurfaceInputAtom = (
  user: string,
  surface: string,
  valueDigest: string,
) => ({
  type: "https://commonfabric.org/cfc/atom/UserSurfaceInput",
  user,
  surface,
  valueDigest,
});

export const promptSlotBoundAtom = (
  source: ImmutableJSONValue,
  role: string,
  kernelName: string,
  subject: string,
  surface: string,
  valueDigest: string,
) => ({
  type: "https://commonfabric.org/cfc/atom/PromptSlotBound",
  source,
  role,
  kernelName,
  subject,
  surface,
  valueDigest,
});
