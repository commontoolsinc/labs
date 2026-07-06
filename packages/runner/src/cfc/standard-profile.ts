import { CFC_ATOM_TYPE, CFC_CONCEPT_KIND } from "@commonfabric/api/cfc";
import type { CfcPolicyRecordInput, ExchangeRule } from "./policy.ts";

/**
 * The §10.1 standard prompt-caveat profile, expressed entirely as ordinary
 * exchange rules (Epic B6 of docs/plans/cfc-future-work-implementation.md §3;
 * spec §10.1 / §8.10.5). There is NO prompt-specific runtime branch: the
 * runtime surfaces atoms (caveats in confidentiality, evidence in integrity,
 * `BoundaryContext` at release sites) and these rules decide discharge.
 *
 * Two consumers share this one definition:
 * - the trusted-schema sanitizer (`schema-sanitization.ts`), which runs the
 *   material-risk discharge over an instruction-inert path's confidentiality
 *   with its freshly-minted `InjectionSafe` — replacing the old hardcoded
 *   `filterMaterialRiskAtoms` strip with a rule firing (goldens prove
 *   equivalence);
 * - deployments, which spread `STANDARD_PROMPT_CAVEAT_POLICY` into
 *   `RuntimeOptions.cfcPolicyRecords` so the display/tier rules run at real
 *   boundaries under `cfcPolicyEvaluation`.
 */

/** Legacy single-risk kind: behaves as unscreened (§10.1). */
export const PROMPT_INJECTION_RISK_LEGACY =
  "https://commonfabric.org/cfc/concepts/prompt-injection-risk";

/** The canonical material-risk tier kinds (the screening gradient). */
export const MATERIAL_RISK_KINDS: readonly string[] = [
  PROMPT_INJECTION_RISK_LEGACY,
  CFC_CONCEPT_KIND.PromptInjectionRiskUnscreened,
  CFC_CONCEPT_KIND.PromptInjectionRiskIngressScreened,
  CFC_CONCEPT_KIND.PromptInjectionRiskValueScreened,
];

// The bare-string aliases the legacy single-risk profile used (§4.7.3). A
// discharge rule must recognize them too so the profile reproduces the old
// `filterMaterialRiskAtoms` strip byte-for-byte (which matched both forms).
// They participate in DISCHARGE only; the tier gradient is defined over the
// canonical URIs, into which a deployment normalizes aliases before tier
// evaluation (§10.1 SHOULD-normalize).
const MATERIAL_RISK_ALIAS_KINDS: readonly string[] = [
  "prompt-injection-risk",
  "prompt-injection-risk-unscreened",
  "prompt-injection-risk-ingress-screened",
  "prompt-injection-risk-value-screened",
];

/** Every caveat kind a positive `InjectionSafe` discharges. */
export const MATERIAL_RISK_DISCHARGE_KINDS: readonly string[] = [
  ...MATERIAL_RISK_KINDS,
  ...MATERIAL_RISK_ALIAS_KINDS,
];

const injectionSafeGuard = { type: CFC_ATOM_TYPE.InjectionSafe } as const;

// A material-risk caveat is discharged (clause/alternative dropped) by
// positive InjectionSafe integrity on the value (§8.10.5). One rule per kind:
// AtomPattern matches a single concrete `kind`. The pattern names ONLY `type`
// and `kind` (subset semantics leave every other field unconstrained), so a
// caveat with or without a `source` discharges alike — exactly the
// source-generic, field-agnostic reach the old wholesale strip had.
const materialRiskDischargeRules: ExchangeRule[] = MATERIAL_RISK_DISCHARGE_KINDS
  .map((kind) => ({
    id: `discharge-material-risk:${kind}`,
    appliesTo: {
      type: CFC_ATOM_TYPE.Caveat,
      kind,
    },
    preCondition: { integrity: [injectionSafeGuard] },
    post: { dropClause: true },
  }));

// Tier upgrades (§10.1): ADD the higher-tier caveat as an alternative in the
// same clause, guarded by stage-matched `CaveatScreened{verdict:"pass"}` whose
// kind + source structurally match the caveat being upgraded. The lower tier
// remains (harmless — strictly harder to discharge). Upgrades never discharge
// and never touch PROMPT_INFLUENCE.
const ingressUpgradeRule: ExchangeRule = {
  id: "tier-upgrade:unscreened-to-ingress",
  appliesTo: {
    type: CFC_ATOM_TYPE.Caveat,
    kind: CFC_CONCEPT_KIND.PromptInjectionRiskUnscreened,
    source: { var: "$s" },
  },
  preCondition: {
    integrity: [{
      type: CFC_ATOM_TYPE.CaveatScreened,
      kind: CFC_CONCEPT_KIND.PromptInjectionRiskUnscreened,
      source: { var: "$s" },
      stage: "ingress",
      verdict: "pass",
    }],
  },
  post: {
    addAlternatives: [{
      type: CFC_ATOM_TYPE.Caveat,
      kind: CFC_CONCEPT_KIND.PromptInjectionRiskIngressScreened,
      source: { var: "$s" },
    }],
  },
};

const valueUpgradeRule: ExchangeRule = {
  id: "tier-upgrade:ingress-to-value",
  appliesTo: {
    type: CFC_ATOM_TYPE.Caveat,
    kind: CFC_CONCEPT_KIND.PromptInjectionRiskIngressScreened,
    source: { var: "$s" },
  },
  preCondition: {
    // Value-stage evidence binds the exact current value via `valueRef`. The
    // binding re-verification is carried by CaveatScreened's value-bound
    // propagation class (§15.4): a non-exactCopyOf transform drops the atom,
    // so a stale value-screened alternative can never be re-derived — the
    // rule simply stops matching (spec §10.1 re-binding blind spot).
    integrity: [{
      type: CFC_ATOM_TYPE.CaveatScreened,
      kind: CFC_CONCEPT_KIND.PromptInjectionRiskIngressScreened,
      source: { var: "$s" },
      stage: "value",
      verdict: "pass",
      valueRef: { var: "$r" },
    }],
  },
  post: {
    addAlternatives: [{
      type: CFC_ATOM_TYPE.Caveat,
      kind: CFC_CONCEPT_KIND.PromptInjectionRiskValueScreened,
      source: { var: "$s" },
    }],
  },
};

// Value-screened discharge (§8.10.5): the value-screened tier is dischargeable
// by its own value-stage screening evidence (with the binding held, via the
// value-bound propagation above) WITHOUT a separate InjectionSafe — the
// screening IS the positive evidence for this tier. A rule that omitted the
// CaveatScreened value-stage guard would be unsound (the tier alternative is a
// marker, not evidence).
const valueScreenedDischargeRule: ExchangeRule = {
  id: "discharge-value-screened",
  appliesTo: {
    type: CFC_ATOM_TYPE.Caveat,
    kind: CFC_CONCEPT_KIND.PromptInjectionRiskValueScreened,
    source: { var: "$s" },
  },
  preCondition: {
    integrity: [{
      type: CFC_ATOM_TYPE.CaveatScreened,
      kind: CFC_CONCEPT_KIND.PromptInjectionRiskValueScreened,
      source: { var: "$s" },
      stage: "value",
      verdict: "pass",
      valueRef: { var: "$r" },
    }],
  },
  post: { dropClause: true },
};

// Influence-caveat display discharge (§8.10.5): PROMPT_INFLUENCE is released
// only by disclosure/acknowledgment/disclaimer evidence that binds the same
// `source` and sink context — NEVER by InjectionSafe (§10.1: "InjectionSafe
// MUST NOT clear prompt-influence"). Each rule additionally gates on the
// boundary context (sink class / field role) it is scoped to, so a
// content-field disclaimer cannot release an influence caveat routed to an
// action field.
const influenceDisclosureRenderedRule: ExchangeRule = {
  id: "discharge-influence-display-rendered",
  appliesTo: {
    type: CFC_ATOM_TYPE.Caveat,
    kind: CFC_CONCEPT_KIND.PromptInfluence,
    source: { var: "$s" },
  },
  preCondition: {
    integrity: [{
      type: CFC_ATOM_TYPE.DisclosureRendered,
      kind: CFC_CONCEPT_KIND.PromptInfluence,
      source: { var: "$s" },
      sink: { var: "$sink" },
    }],
    boundary: [{
      type: CFC_ATOM_TYPE.BoundaryContext,
      key: "sinkClass",
      value: "display",
    }],
  },
  post: { dropClause: true },
};

const influenceAcknowledgedRule: ExchangeRule = {
  id: "discharge-influence-action-acknowledged",
  appliesTo: {
    type: CFC_ATOM_TYPE.Caveat,
    kind: CFC_CONCEPT_KIND.PromptInfluence,
    source: { var: "$s" },
  },
  preCondition: {
    // Routing-sensitive action fields require explicit user acknowledgment
    // (§10.1 conservative default), not a mere rendered disclosure.
    integrity: [{
      type: CFC_ATOM_TYPE.DisclosureAcknowledged,
      kind: CFC_CONCEPT_KIND.PromptInfluence,
      source: { var: "$s" },
    }],
    boundary: [{
      type: CFC_ATOM_TYPE.BoundaryContext,
      key: "fieldRole",
      value: "routing",
    }],
  },
  post: { dropClause: true },
};

const influenceDisclaimerRule: ExchangeRule = {
  id: "discharge-influence-content-disclaimer",
  appliesTo: {
    type: CFC_ATOM_TYPE.Caveat,
    kind: CFC_CONCEPT_KIND.PromptInfluence,
    source: { var: "$s" },
  },
  preCondition: {
    // Content fields may accept an attached disclaimer where policy permits.
    integrity: [{
      type: CFC_ATOM_TYPE.DisclaimerAttached,
      kind: CFC_CONCEPT_KIND.PromptInfluence,
      source: { var: "$s" },
      sink: { var: "$sink" },
    }],
    boundary: [{
      type: CFC_ATOM_TYPE.BoundaryContext,
      key: "fieldRole",
      value: "content",
    }],
  },
  post: { dropClause: true },
};

/**
 * The complete standard profile as a single policy record.
 */
export const STANDARD_PROMPT_CAVEAT_POLICY: readonly CfcPolicyRecordInput[] = [{
  id: "cfc:standard-prompt-caveat-profile",
  rules: [
    ...materialRiskDischargeRules,
    ingressUpgradeRule,
    valueUpgradeRule,
    valueScreenedDischargeRule,
    influenceDisclosureRenderedRule,
    influenceAcknowledgedRule,
    influenceDisclaimerRule,
  ],
}];
