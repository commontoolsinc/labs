import { CFC_ATOM_TYPE, cfcAtom } from "@commonfabric/api/cfc";
import {
  buildCfcPolicySnapshot,
  type ExchangeRule,
  type PolicySnapshot,
} from "./policy.ts";
import { evaluateExchangeRules } from "./exchange-eval.ts";
import { type CfcTrustConfig, createTrustResolver } from "./trust.ts";

/**
 * Display-sink render ceiling resolution (Epic H3b of
 * docs/plans/cfc-future-work-implementation.md §7; spec §8.10.6).
 *
 * The render path is a display-sink egress boundary. Spec §8.10.6: "Ordinary
 * exchange-rule evaluation runs before the fit check, as at any boundary.
 * Confidentiality clauses that the ceiling does not satisfy AFTER exchange
 * evaluation MUST fail closed." So this module resolves the CONSUMED LABEL
 * of a rendered cell — it never rewrites the ceiling — and returns the
 * resolved confidentiality for the reconciler to fit (clause-subsumption,
 * §8.10.3) against the host's `maxConfidentiality`.
 *
 * Resolution runs RUNNER-side (this module) exactly as B5's sink gate does
 * (`evaluateGatedConfidentiality` in prepare.ts), differing only in the
 * boundary class: this mints `sinkClass:"display"` where the network sink
 * mints `sinkClass:"network"`. The reconciler consumes the resolved label; it
 * never runs the evaluator itself.
 */

/** The display sink class — the render sibling of B5's `"network"` class. */
export const RENDER_DISPLAY_SINK_CLASS = "display";

/** Boundary-context sink name for the render surface (spec §8.10.5 / §15.4). */
export const RENDER_SINK_NAME = "render";

/**
 * The display boundary context minted for every render evaluation: the sink
 * name plus its class. `sinkClass:"display"` scopes the standard render
 * exchange rules (and any deployment rule guarded on the display class).
 */
const renderDisplayBoundary = (): readonly unknown[] => [
  cfcAtom.boundaryContext("sink", RENDER_SINK_NAME),
  cfcAtom.boundaryContext("sinkClass", RENDER_DISPLAY_SINK_CLASS),
];

/**
 * The standard render exchange rule set (spec §4.3.3 SpaceReaderAccess, scoped
 * to the display boundary). `Space($s)` confidentiality plus a verified
 * `HasRole($p, $s, reader)` membership fact — under a display boundary — adds
 * a `User($p)` alternative, so a display audience holding that role fits the
 * `User(actingUser)` ceiling. `PersonalSpace(actingUser)` needs no rule: the
 * §8.10.6 ceiling admits it by exact match (the acting user is its owner).
 */
export const STANDARD_RENDER_EXCHANGE_RULES: readonly ExchangeRule[] = [{
  id: "space-reader-access-display",
  appliesTo: { type: CFC_ATOM_TYPE.Space, id: { var: "$s" } },
  preCondition: {
    integrity: [{
      type: CFC_ATOM_TYPE.HasRole,
      principal: { var: "$p" },
      space: { var: "$s" },
      role: "reader",
    }],
    boundary: [{
      type: CFC_ATOM_TYPE.BoundaryContext,
      key: "sinkClass",
      value: RENDER_DISPLAY_SINK_CLASS,
    }],
  },
  post: {
    addAlternatives: [{ type: CFC_ATOM_TYPE.User, subject: { var: "$p" } }],
  },
}];

/** Built once — the standard render rules are static deployment-independent. */
const STANDARD_RENDER_SNAPSHOT: PolicySnapshot = buildCfcPolicySnapshot([{
  id: "cfc-standard-render",
  rules: STANDARD_RENDER_EXCHANGE_RULES,
}])!;

export type RenderConfidentialityResolverConfig = {
  /** The display audience — the acting user whose HasRole facts are minted. */
  readonly actingPrincipal?: string;
  /**
   * Deployment trust config (B3), for any render rule with a `Concept`-valued
   * integrity guard. The standard SpaceReaderAccess rule uses a plain HasRole
   * guard and does not consult it, but it is threaded for parity with the
   * sink gate and future concept-guarded render rules.
   */
  readonly trustConfig?: CfcTrustConfig;
  /**
   * The acting user's VERIFIED reader spaces (§4.9.3): spaces for which the
   * runtime mints `HasRole(actingPrincipal, space, reader)` membership facts,
   * so a `Space(...)` label naming one of them resolves to `User(actingUser)`.
   *
   * These MUST be spaces the acting user is a proven reader of, NOT merely
   * spaces whose data is locally resident: residency is not read authority
   * (a runtime can sync a space's bytes under an ACL-off deployment without
   * the acting user being an authorized reader), so the cell's own storage
   * space is deliberately NOT trusted as a membership fact. The acting user's
   * own space (space DID == principal DID) is the one always-verifiable member
   * — a principal definitionally reads its own space regardless of ACL mode;
   * broader cross-space membership arrives with the §4.9.3 membership lookup.
   */
  readonly memberSpaces?: readonly string[];
};

/** The label of the cell being rendered, as read at the display boundary. */
export type RenderLabelInput = {
  readonly confidentiality: readonly unknown[];
  readonly integrity?: readonly unknown[];
};

/**
 * Resolves one rendered cell's confidentiality label at the display boundary.
 * Returns the exchange-rewritten confidentiality clause set; the reconciler
 * fits it against the ceiling. Fuel exhaustion returns the ORIGINAL label
 * (fail closed, invariant 6 — it will not have gained the resolving
 * alternative, so it stays outside the ceiling and renders blocked).
 */
export type RenderConfidentialityResolver = (
  label: RenderLabelInput,
) => readonly unknown[];

/** `HasRole(principal, space, reader)` facts for a principal's reader spaces. */
const mintReaderRoleFacts = (
  actingPrincipal: string | undefined,
  spaces: readonly string[],
): readonly unknown[] => {
  if (actingPrincipal === undefined) return [];
  return spaces.map((space) =>
    cfcAtom.hasRole(actingPrincipal, space, "reader")
  );
};

export const createRenderConfidentialityResolver = (
  config: RenderConfidentialityResolverConfig = {},
): RenderConfidentialityResolver => {
  const boundary = renderDisplayBoundary();
  const trustResolver = createTrustResolver(config.trustConfig);
  const staticRoleFacts = mintReaderRoleFacts(
    config.actingPrincipal,
    config.memberSpaces ?? [],
  );
  return (label) => {
    if (label.confidentiality.length === 0) return label.confidentiality;
    const result = evaluateExchangeRules(
      {
        confidentiality: [...label.confidentiality],
        integrity: [...(label.integrity ?? [])],
      },
      STANDARD_RENDER_SNAPSHOT,
      {
        // §4.9.3: role facts come ONLY from the verified member set, never
        // from the cell's residency — so a `Space(X)` label the acting user
        // cannot prove reader access to stays unresolved and fails closed.
        integrity: staticRoleFacts,
        boundary,
        trustResolver,
        actingPrincipal: config.actingPrincipal,
      },
    );
    return result.exhausted
      ? label.confidentiality
      : result.label.confidentiality ?? [];
  };
};
