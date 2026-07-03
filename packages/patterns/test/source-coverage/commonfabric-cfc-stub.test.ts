export type CfcAtom = Record<string, unknown>;

export const CFC_CONCEPT_KIND = {
  PromptInjectionRiskUnscreened: "PromptInjectionRiskUnscreened",
  PromptInfluence: "PromptInfluence",
} as const;

export const cfcAtom = {
  injectionSafe(): CfcAtom {
    return { type: "InjectionSafe" };
  },
  caveat(kind: string, source: CfcAtom): CfcAtom {
    return { type: "Caveat", kind, source };
  },
  builtin(name: string): CfcAtom {
    return { type: "Builtin", name };
  },
  userSurfaceInput(
    user: string,
    surface: string,
    valueDigest: string,
  ): CfcAtom {
    return { type: "UserSurfaceInput", user, surface, valueDigest };
  },
  promptSlotBound(
    source: CfcAtom,
    role: string,
    kernelName: string,
    subject: string,
    surface: string,
    valueDigest: string,
  ): CfcAtom {
    return {
      type: "PromptSlotBound",
      source,
      role,
      kernelName,
      subject,
      surface,
      valueDigest,
    };
  },
};
