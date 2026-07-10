import { deepEqual } from "@commonfabric/utils/deep-equal";
import { utf8Compare } from "@commonfabric/utils/utf8";
import {
  type AtomPatternBindings,
  conceptGuard,
  instantiateAtomPattern,
  isAtomVarPlaceholder,
  matchAtomPattern,
  matchAtomPatternAgainstAtoms,
} from "./atom-pattern.ts";
import { isRecord } from "@commonfabric/utils/types";
import {
  type CfcConfClause,
  clauseAlternatives,
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

/**
 * Whether a `policyState` evaluation site is a CONSUMING context (design
 * §2.2 single-use releases). Consuming sites are exactly the boundary gates
 * whose evaluation outcome changes a persisted or egress decision inside a
 * writing transaction's prepare — the sink-request egress ceiling and the
 * input-requirement gate on gated writes, and only under the `enforce`
 * policy-evaluation dial (under `observe` the decision is made on the raw
 * label, so the evaluation is diagnostics-only). Everything else — the
 * render ceiling, observe-dial evaluation, any read-path resolution — is
 * OBSERVING: a single-use grant is unsatisfiable there, fail closed, because
 * a grant consumed by looking at it would be spent by rendering. Standing
 * grants ignore this axis entirely.
 */
export type CfcGrantConsumptionContext = "consuming" | "observing";

/**
 * The point-query a `policyState` guard sends to the grant resolver: the
 * guard's concrete `kind` plus every guard field that is concrete under the
 * current binding environment (a literal value, or a pattern whose variables
 * are all bound). Fields still carrying free variables are omitted — they are
 * bound FROM the resolved grant's fields, not queried by.
 */
export type CfcGrantResolverQuery = {
  readonly kind: string;
  readonly fields: Readonly<Record<string, unknown>>;
  /**
   * The evaluation site's consumption context, stamped from
   * {@link ExchangeEvalContext.grantConsumption}. ABSENT means observing
   * (fail closed): a hand-built query that never states its context cannot
   * resolve a single-use grant.
   */
  readonly consumption?: CfcGrantConsumptionContext;
};

/**
 * Resolves durable grant records for a `policyState` guard (spec §8.12.7
 * route 2a). Supplied on the context by the RUNNER (the evaluator itself
 * stays pure — all I/O lives in this closure): the runner-side implementation
 * computes candidate content addresses from `(kind + bound fields)`, point-
 * reads them fail-closed (§4.9.3 discipline: absent/malformed/unsynced
 * resolve nothing, never enumeration), verifies each record against its
 * address, filters revoked/expired grants against the runner clock, and
 * returns the surviving grants EXPANDED one fact per audience entry, in
 * canonical (content-address, then audience) order — so evaluation stays
 * deterministic. The evaluator matches the guard pattern against the returned
 * facts exactly as atom patterns match. A resolver that throws fails the
 * guard CLOSED (the rule does not fire); it must not crash evaluation.
 */
export type CfcGrantResolver = (
  query: CfcGrantResolverQuery,
) => readonly unknown[];

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
  /**
   * Grant lookup for `policyState` guards (route 2a). Absent → every
   * policyState guard is unsatisfied and its rule never fires (fail closed).
   */
  readonly grantResolver?: CfcGrantResolver;
  /**
   * Consuming vs observing evaluation site (single-use releases, design
   * §2.2) — stamped onto every resolver query. Absent = observing (fail
   * closed): only the writing-transaction boundary gates in prepare.ts pass
   * `"consuming"`, coupled to the claim staging that flushes at the end of
   * the same prepare pass. See {@link CfcGrantConsumptionContext}.
   */
  readonly grantConsumption?: CfcGrantConsumptionContext;
};

export type ExchangeEvalResult = {
  readonly label: IFCLabel;
  readonly firings: readonly RuleFiring[];
  readonly exhausted: boolean;
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
 * Builds the {@link CfcGrantResolverQuery} for one `policyState` guard
 * pattern under one binding environment, or `undefined` when the pattern is
 * not queryable (fail closed): not a plain record, or its `kind` is not a
 * concrete non-empty string (boot validation enforces this for configured
 * policies; the evaluator re-checks because patterns are `unknown` and a
 * hand-built snapshot must not bypass the discipline). Query fields are the
 * guard fields that INSTANTIATE under the environment — a bound variable or a
 * fully concrete value; fields with free variables are omitted (they bind
 * FROM the grant). Explicit-`undefined` fields (absence requirements) are
 * omitted from the query; the full pattern re-match below still enforces
 * them against the returned facts.
 */
const grantGuardQuery = (
  pattern: unknown,
  bindings: AtomPatternBindings,
  consumption: CfcGrantConsumptionContext,
): CfcGrantResolverQuery | undefined => {
  if (
    !isRecord(pattern) || Array.isArray(pattern) ||
    isAtomVarPlaceholder(pattern)
  ) {
    return undefined;
  }
  const kind = (pattern as { kind?: unknown }).kind;
  if (typeof kind !== "string" || kind.length === 0) {
    return undefined;
  }
  const fields: Record<string, unknown> = {};
  for (const [key, fieldPattern] of Object.entries(pattern)) {
    if (key === "kind" || fieldPattern === undefined) continue;
    const instantiated = instantiateAtomPattern(fieldPattern, bindings);
    if (instantiated !== null) {
      fields[key] = instantiated.value;
    }
  }
  return { kind, fields, consumption };
};

/**
 * Extends each environment through one `policyState` guard pattern: per
 * environment, the resolver is point-queried with the guard's kind + bound
 * fields, and the guard pattern then matches the returned grant facts
 * exactly as atom patterns match a pool (binding free variables from grant
 * fields, unifying already-bound ones). Everything fails CLOSED to "no
 * extension" — no resolver, an unqueryable pattern, a resolver throw, or no
 * matching fact all leave the guard unsatisfied for that environment.
 */
const extendThroughGrantGuard = (
  environments: readonly AtomPatternBindings[],
  pattern: unknown,
  resolver: CfcGrantResolver | undefined,
  consumption: CfcGrantConsumptionContext,
): AtomPatternBindings[] => {
  if (resolver === undefined) return [];
  const next: AtomPatternBindings[] = [];
  for (const environment of environments) {
    const query = grantGuardQuery(pattern, environment, consumption);
    if (query === undefined) continue;
    let facts: readonly unknown[];
    try {
      facts = resolver(query);
    } catch {
      // Fail closed: a resolver failure (storage error, malformed state)
      // must never fire the rule — and must not abort evaluation of the
      // other rules/clauses either. The runner-side resolver diagnoses
      // through the transaction before rethrowing/soft-failing.
      continue;
    }
    if (!Array.isArray(facts)) continue;
    for (
      const extended of matchAtomPatternAgainstAtoms(
        pattern,
        facts,
        environment,
      )
    ) {
      if (!next.some((existing) => deepEqual(existing, extended))) {
        next.push(extended);
      }
    }
  }
  return next;
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

      // policyState guards (§8.12.7 route 2a): durable grant records resolved
      // through the context's grant resolver. Evaluated LAST so the query
      // benefits from every binding the other guards established (the
      // point-query fields). Fail closed throughout — see
      // `extendThroughGrantGuard`. A PRESENT guard that is not a non-empty
      // array is unsatisfiable: boot validation rejects that shape, so it
      // can only arrive through a hand-built snapshot, and degrading it to
      // "no guard" would fire a rule its author believed grant-gated (cubic
      // P1 on #4627). Only a genuinely-absent policyState means "no guard".
      const policyState = rule.preCondition?.policyState;
      if (policyState !== undefined) {
        if (!Array.isArray(policyState) || policyState.length === 0) {
          continue;
        }
        for (const pattern of policyState) {
          environments = extendThroughGrantGuard(
            environments,
            pattern,
            ctx.grantResolver,
            // Absent = observing, fail closed: a context that never states
            // it is a consuming site cannot resolve single-use grants.
            ctx.grantConsumption ?? "observing",
          );
          if (environments.length === 0) break;
        }
        if (environments.length === 0) continue;
      }

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
    // Canonical UTF-8 code-point order (not JS `<`, which orders UTF-16 code
    // UNITS and disagrees on astral ids) so evaluation and diagnostic order
    // match the repo's canonical string order everywhere (codex P2 on #4564).
    for (
      const record of [...snapshot.records].sort((a, b) =>
        utf8Compare(a.id, b.id)
      )
    ) {
      for (
        const rule of [...record.rules].sort((a, b) => utf8Compare(a.id, b.id))
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
      // batch no-ops — `applyRuleMatch` re-locates the alternative by
      // deepEqual (returns unchanged when it is gone), and the
      // `clauseIndex >= length` guard below skips a match whose clause was
      // spliced; the next pass re-derives matches from scratch.
      //
      // This is also why the (clauseIndex, alternative) "duplicate drop"
      // corruption cubic raised (P2 on #4564) cannot occur: descending order
      // fully processes a higher-index sibling clause before a lower-index one
      // splices into a freed slot, so the shifted-in clause never still
      // carries the target — a differential sweep over exhaustive + 20k
      // randomized labels confirmed zero divergence from any de-duplicated
      // variant. So no dedup is added; the two guards already no-op the
      // duplicate/stale drop matches (and are exercised by the sibling-clause
      // test below).
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
