// Plain-data CFC atom-kind constants (and the JSON-value atom types), split out
// of `cfc.ts` so they can be imported by SES-compiled pattern code WITHOUT
// dragging in the `cfcAtom` methods-namespace object. A module-scope
// object-of-methods cannot live in a pattern bundle (the bundle verifier rejects
// it raw and `__cf_data` rejects its functions), so any pattern that imported
// from `cfc.ts` — even via an `import type` the CF compiler does not erase —
// pulled `cfcAtom` into its graph and failed to load. `cfc.ts` re-exports
// everything here so the runtime/host surface is unchanged.

export type CfcJsonValue =
  | null
  | boolean
  | number
  | string
  | CfcJsonArray
  | CfcAtomObject;

export interface CfcJsonArray extends ReadonlyArray<CfcJsonValue> {}

export interface CfcAtomObject extends Readonly<Record<string, CfcJsonValue>> {}

export type CfcAtom = CfcJsonValue;

export const CFC_ATOM_BASE = "https://commonfabric.org/cfc/atom/" as const;

export const CFC_ATOM_TYPE = {
  Builtin: `${CFC_ATOM_BASE}Builtin`,
  Caveat: `${CFC_ATOM_BASE}Caveat`,
  InjectionSafe: `${CFC_ATOM_BASE}InjectionSafe`,
  LinkReference: `${CFC_ATOM_BASE}LinkReference`,
  Origin: `${CFC_ATOM_BASE}Origin`,
  // Hereditary certification (spec §15.1.1 / §3.1.6.1): survives combination
  // via the class-aware meet — present on an output only when present on
  // every input.
  PolicyCertified: `${CFC_ATOM_BASE}PolicyCertified`,
  PromptSlotBound: `${CFC_ATOM_BASE}PromptSlotBound`,
  PromptSlotInfluence: `${CFC_ATOM_BASE}PromptSlotInfluence`,
  Resource: `${CFC_ATOM_BASE}Resource`,
  // Runtime-minted derivation provenance (spec §8.9.3): which implementation
  // produced this value. Evidence — not authorable in schemas.
  TransformedBy: `${CFC_ATOM_BASE}TransformedBy`,
  UserSurfaceInput: `${CFC_ATOM_BASE}UserSurfaceInput`,
} as const;

export const CFC_CONCEPT_KIND = {
  PromptInfluence: "https://commonfabric.org/cfc/concepts/prompt-influence",
  PromptInjectionRiskUnscreened:
    "https://commonfabric.org/cfc/concepts/prompt-injection-risk-unscreened",
} as const;
