import {
  CFC_ATOM_TYPE,
  CFC_CONCEPT_KIND,
  type CfcAtom,
} from "../cfc-atom-kinds.ts";

// These factories build plain-data CFC atoms directly rather than delegating to
// the shared `cfcAtom` namespace object. A module-scope object-of-methods (what
// `cfcAtom` is) cannot be expressed in SES-compiled pattern code: `__cf_data`
// rejects its functions and the bundle verifier rejects it raw. Pattern-local
// arrow functions producing plain objects are hardened normally, so the
// pattern's import graph never pulls the namespace in.

export const DEFAULT_PROMPT_INJECTION_RISK_KIND =
  CFC_CONCEPT_KIND.PromptInjectionRiskUnscreened;
export const DEFAULT_PROMPT_INFLUENCE_KIND = CFC_CONCEPT_KIND.PromptInfluence;

export const INJECTION_SAFE_ATOM = {
  type: CFC_ATOM_TYPE.InjectionSafe,
} as const;

export const promptInjectionRiskAtom = (
  source: CfcAtom,
  kind: string = DEFAULT_PROMPT_INJECTION_RISK_KIND,
) => ({ type: CFC_ATOM_TYPE.Caveat, kind, source });

export const promptInfluenceAtom = (
  source: CfcAtom,
  kind: string = DEFAULT_PROMPT_INFLUENCE_KIND,
) => ({ type: CFC_ATOM_TYPE.Caveat, kind, source });

export const trustedAgentKernelAtom = (name: string) => ({
  type: CFC_ATOM_TYPE.Builtin,
  name,
});

export const userSurfaceInputAtom = (
  user: string,
  surface: string,
  valueDigest: string,
) => ({ type: CFC_ATOM_TYPE.UserSurfaceInput, user, surface, valueDigest });

export const promptSlotBoundAtom = (
  source: CfcAtom,
  role: string,
  kernelName: string,
  subject: string,
  surface: string,
  valueDigest: string,
) => ({
  type: CFC_ATOM_TYPE.PromptSlotBound,
  source,
  role,
  kernelName,
  subject,
  surface,
  valueDigest,
});
