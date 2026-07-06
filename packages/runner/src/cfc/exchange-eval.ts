import { CFC_ATOM_TYPE } from "@commonfabric/api/cfc";
import { deepEqual } from "@commonfabric/utils/deep-equal";
import { isRecord } from "@commonfabric/utils/types";
import {
  type AtomPatternBindings,
  EMPTY_ATOM_PATTERN_BINDINGS,
  instantiateAtomPattern,
  isAtomVarPlaceholder,
  matchAtomPattern,
  matchAtomPatternAgainstAtoms,
} from "./atom-pattern.ts";
import {
  type CfcConfClause,
  clauseAlternatives,
  clausesEqual,
  isOrClause,
  normalizeClause,
} from "./clause.ts";
import type { IFCLabel } from "./label-view-core.ts";
import type { ExchangeRule, PolicySnapshot } from "./policy.ts";
import type { TrustResolver } from "./trust.ts";

/**
 * The guarded-rewrite evaluator (spec §4.4.5, Epic B4 of
 * docs/plans/cfc-future-work-implementation.md §3): runs a policy snapshot's
 * exchange rules over one label to a fuelled fixpoint. The ONLY things a
 * firing may do:
 *
 * - ADD instantiated alternatives to the clause whose alternative the rule's
 *   `appliesTo` matched (spec §3.1.3 — exchange adds alternatives), or
 * - REMOVE the matched alternative for a `dropClause` rule (the spec's
 *   empty-instantiated-postcondition form; the clause disappears when its
 *   last alternative goes — the singleton case is the §4.2.3 Expires
 *   discharge).
 *
 * Clauses are never merged, created, or reordered; sibling clauses are
 * untouched (invariant 11 clause locality); integrity is never modified
 * (B2a rules carry no integrity postcondition). Evaluation is evaluation-
 * time only — rewritten labels are never persisted (design decision 1).
 *
 * B2a rule scoping: every record in the snapshot is in scope for every label
 * (the degenerate single-policy-root case) — each rule is still gated by its
 * own `appliesTo` + guards. Label-carried `Policy(...)` principals selecting
 * records arrive with B2b.
 *
 * Termination (spec §4.4.5): add-only rule sets converge by monotonicity;
 * add+drop sets can cycle, so the evaluator is fuelled and FAILS CLOSED on
 * exhaustion — `exhausted: true` with the ORIGINAL label, never a partial
 * rewrite (invariant 6: violating a policy disables exchange, it never
 * silently downgrades).
 */

/** Default rule-firing budget per evaluated label. */
export const DEFAULT_EXCHANGE_FUEL = 64;

/** One state-changing rule application, for observe-mode diagnostics (B5). */
export type RuleFiring = {
  readonly recordId: string;
  readonly ruleId: string;
  /** Index of the rewritten clause in the label AT FIRING TIME. */
  readonly clauseIndex: number;
  readonly kind: "add" | "drop";
  /** Alternatives added by an `add` firing. */
  readonly added?: readonly unknown[];
  /** The alternative removed by a `drop` firing. */
  readonly dropped?: unknown;
};

export type ExchangeEvalContext = {
  /**
   * Integrity evidence available to rule guards BEYOND the label's own
   * integrity (boundary-minted facts, consumed-read integrity). The guard
   * pool is `label.integrity ∪ ctx.integrity`.
   */
  readonly integrity?: readonly unknown[];
  /** Boundary-context atoms minted for this evaluation site (B5). */
  readonly boundary?: readonly unknown[];
  /** Trust closure for concept-valued integrity guards (B3). */
  readonly trustResolver?: TrustResolver;
  readonly actingPrincipal?: string;
};

export type ExchangeEvalResult = {
  readonly label: IFCLabel;
  readonly firings: readonly RuleFiring[];
  readonly exhausted: boolean;
};

/**
 * A concept-valued integrity guard (spec §4.4.5): a CONCRETE `Concept` atom
 * pattern. Satisfied exclusively via the acting principal's trust closure —
 * never by pool-matching a literal Concept atom (which carried integrity
 * cannot legitimately contain; the mint gate strips it). Returns `undefined`
 * for non-concept-shaped patterns and `{ uri: undefined }` for a
 * concept-shaped pattern whose uri is malformed (a variable, non-string, or
 * empty) — malformed guards are never satisfied.
 */
const conceptGuard = (
  pattern: unknown,
): { uri: string | undefined } | undefined => {
  if (
    !isRecord(pattern) || isAtomVarPlaceholder(pattern) ||
    (pattern as { type?: unknown }).type !== CFC_ATOM_TYPE.Concept
  ) {
    return undefined;
  }
  const uri = (pattern as { uri?: unknown }).uri;
  return { uri: typeof uri === "string" && uri.length > 0 ? uri : undefined };
};

/**
 * Extends each environment through one guard pattern against a pool,
 * collecting the disjunction of all consistent extensions (dedup'd). The
 * shared-variable unification inside `matchAtomPattern` is what correlates
 * guards with the target match.
 */
const extendThroughPattern = (
  environments: readonly AtomPatternBindings[],
  pattern: unknown,
  pool: readonly unknown[],
): AtomPatternBindings[] => {
  const next: AtomPatternBindings[] = [];
  for (const environment of environments) {
    for (
      const extended of matchAtomPatternAgainstAtoms(pattern, pool, environment)
    ) {
      if (!next.some((existing) => deepEqual(existing, extended))) {
        next.push(extended);
      }
    }
  }
  return next;
};

type RuleMatch = {
  readonly clauseIndex: number;
  readonly alternative: unknown;
  readonly bindings: AtomPatternBindings;
};

/**
 * All matches of one rule against the current label (spec §4.4.5
 * `matchRuleWithTargetClause`): the `appliesTo` pattern fixes the target
 * clause/alternative; remaining guards must all be satisfiable under one
 * shared environment. Every consistent environment is its own match — the
 * §4.3.4 disjunction of all valid bindings.
 */
const matchRule = (
  rule: ExchangeRule,
  confidentiality: readonly CfcConfClause[],
  availableIntegrity: readonly unknown[],
  ctx: ExchangeEvalContext,
): RuleMatch[] => {
  const matches: RuleMatch[] = [];
  const anywhereAlternatives = rule.preConfScope === "anywhere"
    ? confidentiality.flatMap((clause) => clauseAlternatives(clause))
    : undefined;

  for (
    let clauseIndex = 0;
    clauseIndex < confidentiality.length;
    clauseIndex++
  ) {
    const alternatives = clauseAlternatives(confidentiality[clauseIndex]);
    for (const alternative of alternatives) {
      const target = matchAtomPattern(rule.appliesTo, alternative);
      if (target === null) continue;

      let environments: AtomPatternBindings[] = [target];

      // Non-target confidentiality side conditions, scoped per rule.
      const confPool = anywhereAlternatives ?? alternatives;
      for (const pattern of rule.preCondition?.confidentiality ?? []) {
        environments = extendThroughPattern(environments, pattern, confPool);
        if (environments.length === 0) break;
      }
      if (environments.length === 0) continue;

      // Integrity guards (invariant 3): concept-shaped guards route to the
      // trust closure and extend no bindings; concrete/pattern guards match
      // the available-integrity pool.
      let guardsSatisfied = true;
      for (const pattern of rule.preCondition?.integrity ?? []) {
        const concept = conceptGuard(pattern);
        if (concept !== undefined) {
          if (
            concept.uri === undefined || ctx.trustResolver === undefined ||
            !ctx.trustResolver.conceptSatisfied(
              concept.uri,
              availableIntegrity,
              ctx.actingPrincipal,
            )
          ) {
            guardsSatisfied = false;
            break;
          }
          continue;
        }
        environments = extendThroughPattern(
          environments,
          pattern,
          availableIntegrity,
        );
        if (environments.length === 0) {
          guardsSatisfied = false;
          break;
        }
      }
      if (!guardsSatisfied) continue;

      // Boundary applicability guards.
      for (const pattern of rule.preCondition?.boundary ?? []) {
        environments = extendThroughPattern(
          environments,
          pattern,
          ctx.boundary ?? [],
        );
        if (environments.length === 0) break;
      }
      if (environments.length === 0) continue;

      for (const bindings of environments) {
        matches.push({ clauseIndex, alternative, bindings });
      }
    }
  }
  return matches;
};

/**
 * Applies one rule match (spec §4.4.5 `applyExchangeRule`). Returns the
 * INPUT array (same reference) when nothing changes, so the caller's
 * structural-change detection is a reference check. Fail-closed no-ops:
 * a postcondition that does not instantiate under the match bindings, or
 * instantiates to a clause-shaped (`anyOf`) value — an alternative must be
 * an atom, and promoting a smuggled `anyOf` record into clause position
 * would widen the clause beyond what the rule author wrote.
 */
const applyRuleMatch = (
  confidentiality: readonly CfcConfClause[],
  match: RuleMatch,
  rule: ExchangeRule,
): {
  confidentiality: readonly CfcConfClause[];
  firing?: Omit<RuleFiring, "recordId" | "ruleId">;
} => {
  const clause = confidentiality[match.clauseIndex];
  const alternatives = clauseAlternatives(clause);

  if (rule.post.dropClause === true) {
    const index = alternatives.findIndex((alternative) =>
      deepEqual(alternative, match.alternative)
    );
    if (index < 0) return { confidentiality };
    const remaining = alternatives.filter((_, i) => i !== index);
    const next = [...confidentiality];
    if (remaining.length === 0) {
      next.splice(match.clauseIndex, 1);
    } else {
      next[match.clauseIndex] = normalizeClause({ anyOf: remaining });
    }
    return {
      confidentiality: next,
      firing: {
        clauseIndex: match.clauseIndex,
        kind: "drop",
        dropped: match.alternative,
      },
    };
  }

  const added: unknown[] = [];
  for (const pattern of rule.post.addAlternatives ?? []) {
    const instantiated = instantiateAtomPattern(pattern, match.bindings);
    // Unbound variable or malformed placeholder: the rule cannot express its
    // postcondition for this match — fail closed, fire nothing.
    if (instantiated === null) return { confidentiality };
    if (isOrClause(instantiated.value)) return { confidentiality };
    if (
      !alternatives.some((alternative) =>
        deepEqual(alternative, instantiated.value)
      ) &&
      !added.some((alternative) => deepEqual(alternative, instantiated.value))
    ) {
      added.push(instantiated.value);
    }
  }
  if (added.length === 0) return { confidentiality };

  const next = [...confidentiality];
  next[match.clauseIndex] = normalizeClause({
    anyOf: [...alternatives, ...added],
  });
  return {
    confidentiality: next,
    firing: { clauseIndex: match.clauseIndex, kind: "add", added },
  };
};

/**
 * Runs every snapshot rule over `label` to a fuelled fixpoint and returns
 * the rewritten label (or the ORIGINAL on fuel exhaustion, flagged).
 *
 * Determinism: records and rules evaluate in canonical (id) order; matches
 * apply in label order (drop-rule matches back-to-front so earlier removals
 * cannot shift later target indices — spec §4.4.5 index discipline); added
 * alternatives land through `normalizeClause`, so alternative-insertion
 * order cannot leak into the result. Clause ORDER follows the input label;
 * the clause SET is what evaluation determines.
 */
export const evaluateExchangeRules = (
  label: IFCLabel,
  snapshot: PolicySnapshot | undefined,
  ctx: ExchangeEvalContext = {},
  fuel: number = DEFAULT_EXCHANGE_FUEL,
): ExchangeEvalResult => {
  const rules: Array<{ recordId: string; rule: ExchangeRule }> = [];
  if (snapshot !== undefined) {
    for (
      const record of [...snapshot.records].sort((a, b) =>
        a.id < b.id ? -1 : a.id > b.id ? 1 : 0
      )
    ) {
      for (
        const rule of [...record.rules].sort((a, b) =>
          a.id < b.id ? -1 : a.id > b.id ? 1 : 0
        )
      ) {
        rules.push({ recordId: record.id, rule });
      }
    }
  }
  if (
    rules.length === 0 || label.confidentiality === undefined ||
    label.confidentiality.length === 0
  ) {
    return { label, firings: [], exhausted: false };
  }

  const availableIntegrity = [
    ...(label.integrity ?? []),
    ...(ctx.integrity ?? []),
  ];

  let confidentiality: readonly CfcConfClause[] = label.confidentiality.map(
    normalizeClause,
  );
  const firings: RuleFiring[] = [];
  let remainingFuel = fuel;
  let changed = true;

  while (changed) {
    changed = false;
    for (const { recordId, rule } of rules) {
      const matches = matchRule(rule, confidentiality, availableIntegrity, ctx);
      // Index discipline (spec §4.4.5): adds never shift clause indices, so
      // add-matches apply in order; drop-matches apply back-to-front. A
      // match whose target was consumed by an earlier application in this
      // batch no-ops (applyRuleMatch re-locates the alternative); the next
      // pass re-derives matches from scratch.
      const ordered = rule.post.dropClause === true
        ? [...matches].sort((a, b) => b.clauseIndex - a.clauseIndex)
        : matches;
      for (const match of ordered) {
        if (match.clauseIndex >= confidentiality.length) continue;
        const applied = applyRuleMatch(confidentiality, match, rule);
        if (applied.confidentiality === confidentiality) continue;
        if (remainingFuel <= 0) {
          // Fail closed: never a partially-rewritten label (invariant 6).
          // The firings collected so far are returned for DIAGNOSTICS only
          // (which rules ping-ponged); their clause indices describe the
          // discarded intermediate state, and `label` is the original.
          return { label, firings, exhausted: true };
        }
        remainingFuel -= 1;
        confidentiality = applied.confidentiality;
        firings.push({ recordId, ruleId: rule.id, ...applied.firing! });
        changed = true;
      }
    }
  }

  return {
    label: {
      ...label,
      confidentiality: [...confidentiality],
    },
    firings,
    exhausted: false,
  };
};
