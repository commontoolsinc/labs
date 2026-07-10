import { deepFreeze } from "@commonfabric/data-model/deep-freeze";
import { hashStringOf } from "@commonfabric/data-model/value-hash";
import { isRecord } from "@commonfabric/utils/types";
import type { AtomPattern } from "./atom-pattern.ts";

/**
 * Policy records + exchange rules (spec §4.3/§4.4, Epic B2 of
 * docs/plans/cfc-future-work-implementation.md §3).
 *
 * This is stage B2a: a deployment-configured, frozen policy set supplied via
 * `RuntimeOptions.cfcPolicyRecords` — the degenerate single-policy-root case
 * of spec §4.4.1's content-addressed policy storage. Rule scoping happens
 * through each rule's explicit `appliesTo` pattern rather than through
 * label-carried `Policy(...)` principals; space-hosted, hash-bound policy
 * docs (B2b) arrive later and reuse these record shapes verbatim.
 */

/**
 * A guarded clause-local rewrite (spec §4.3.2). Shape mapping to the spec's
 * `ExchangeRule`: `appliesTo` is the spec's `preCondition.confidentiality[0]`
 * — the TARGET pattern that selects the clause alternative being rewritten;
 * `preCondition.confidentiality` here holds only the REMAINING side
 * conditions (`[1..]`), scoped by `preConfScope`. `post.addAlternatives` is
 * the spec's `postCondition.confidentiality`; `post.dropClause: true` is the
 * spec's empty instantiated confidentiality postcondition (drop the matched
 * alternative / clause). Integrity postconditions are deliberately absent
 * from B2a — no rule ships that needs one, and evidence minting stays with
 * trusted runtime surfaces.
 */
export type ExchangeRule = {
  /** Stable identifier: diagnostics, canonical evaluation order, digests. */
  readonly id: string;
  /** Target pattern selecting the clause alternative this rule rewrites. */
  readonly appliesTo: AtomPattern;
  /**
   * Conjunctive guards (spec §4.3.2 preCondition). `confidentiality` are the
   * non-target side conditions; `integrity` match against available
   * integrity evidence (invariant 3: exchange requires explicit integrity
   * guards); `boundary` match against boundary-context atoms minted per
   * evaluation (`BoundaryContext` — the generic form of the spec's
   * `allowedSink` applicability metadata); `policyState` match against
   * durable grant records resolved through `ExchangeEvalContext.grantResolver`
   * (spec §8.12.7 route 2a / §13.4.4 — each pattern is a record with a
   * CONCRETE string `kind` plus field patterns; variables bind from the
   * resolved grant's fields exactly as atom patterns bind).
   */
  readonly preCondition?: {
    readonly confidentiality?: readonly AtomPattern[];
    readonly integrity?: readonly AtomPattern[];
    readonly boundary?: readonly AtomPattern[];
    readonly policyState?: readonly AtomPattern[];
  };
  /**
   * Scope for the non-target confidentiality side conditions. Default
   * `targetClause`: they must match alternatives of the SAME clause as the
   * target match. `anywhere` (opt-in) lets them match any clause of the
   * label.
   */
  readonly preConfScope?: "targetClause" | "anywhere";
  /**
   * Effect when the rule fires on a matched clause alternative. Exactly one
   * of the two forms (validated): `addAlternatives` instantiates patterns
   * under the match bindings and ADDS them to the matched clause (spec
   * §3.1.3 — exchange rules add alternatives); `dropClause: true` removes
   * the matched alternative (and the clause when no alternatives remain) —
   * the spec's empty-postcondition removal form.
   */
  readonly post: {
    readonly addAlternatives?: readonly AtomPattern[];
    readonly dropClause?: boolean;
  };
};

/**
 * A named, digest-bound set of exchange rules (spec §4.3.1, reduced to the
 * B2a surface: `id` + `rules`). `digest` is COMPUTED content-addressing over
 * the canonical record content — never trusted from input (a supplied digest
 * is verified and mismatch fails closed, §4.4.3 discipline).
 */
export type PolicyRecord = {
  readonly id: string;
  readonly digest: string;
  readonly rules: readonly ExchangeRule[];
};

/**
 * The frozen record set a Runtime evaluates under, with a digest covering
 * every record — B5 folds it into `PreparedDigestInput` so a policy change
 * between prepare and commit invalidates (same discipline as
 * `trustSnapshot`).
 */
export type PolicySnapshot = {
  readonly records: readonly PolicyRecord[];
  readonly digest: string;
};

/**
 * Authoring form for `RuntimeOptions.cfcPolicyRecords`: a record without a
 * digest (computed at construction), or with one to be verified.
 */
export type CfcPolicyRecordInput = {
  readonly id: string;
  readonly rules: readonly ExchangeRule[];
  readonly digest?: string;
};

const RECORD_INPUT_KEYS = new Set(["id", "rules", "digest"]);
const RULE_KEYS = new Set([
  "id",
  "appliesTo",
  "preCondition",
  "preConfScope",
  "post",
]);
const PRE_CONDITION_KEYS = new Set([
  "confidentiality",
  "integrity",
  "boundary",
  "policyState",
]);
const POST_KEYS = new Set(["addAlternatives", "dropClause"]);

/**
 * Deployment policy records are trusted enforcement config, so malformation
 * fails CLOSED at construction time — a thrown error at Runtime boot naming
 * the offending record/rule, never a silently skipped rule (a dropped
 * discharge rule would be safe, but a dropped guard on a record an operator
 * believes active is a policy hole they cannot see). Unknown keys are
 * rejected for the same reason: a typo like `precondition` must not become
 * an unguarded rule.
 */
const rejectUnknownKeys = (
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  where: string,
): void => {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new Error(`cfcPolicyRecords: unknown key "${key}" in ${where}`);
    }
  }
};

// A PLAIN object (prototype `Object.prototype` or null) — the shape authored
// TS literals and parsed JSON produce. `isRecord` alone admits `Map`, `Set`,
// and class instances, whose own-enumerable string keys are usually empty, so
// the field-by-field validation below would read NO guards and wave through
// an unguarded rule (cubic P1 on #4562). Config that is not a plain object
// fails closed here.
const isPlainRecord = (value: unknown): value is Record<string, unknown> => {
  if (!isRecord(value) || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

const validatePatternArray = (
  value: unknown,
  where: string,
): readonly AtomPattern[] => {
  if (!Array.isArray(value)) {
    throw new Error(`cfcPolicyRecords: ${where} must be an array`);
  }
  for (const pattern of value) {
    if (pattern === undefined) {
      throw new Error(
        `cfcPolicyRecords: ${where} contains an undefined pattern`,
      );
    }
  }
  return value as readonly AtomPattern[];
};

/**
 * `policyState` guard validation (§8.12.7 route 2a): each entry is a grant
 * pattern — a PLAIN record whose `kind` field is a CONCRETE non-empty string
 * (the resolver point-queries by kind; a variable or pattern-valued kind
 * would require enumeration, which the §4.9.3 discipline forbids). Remaining
 * fields are ordinary atom patterns. An EMPTY array is rejected: a
 * policyState guard that names no grant pattern gates nothing — an authoring
 * error a policy author must see, not a vacuously-satisfied guard.
 */
const validatePolicyStateGuards = (value: unknown, where: string): void => {
  if (!Array.isArray(value)) {
    throw new Error(`cfcPolicyRecords: ${where} must be an array`);
  }
  if (value.length === 0) {
    throw new Error(
      `cfcPolicyRecords: ${where} must name at least one grant pattern`,
    );
  }
  for (const pattern of value) {
    if (!isPlainRecord(pattern)) {
      throw new Error(
        `cfcPolicyRecords: ${where} entries must be grant-pattern records`,
      );
    }
    // Own property required: the digest projection and atom-pattern matching
    // consider own fields only, so an inherited `kind` must not satisfy boot
    // validation (cubic P2 on #4627; isPlainRecord already confines this to
    // Object.prototype, where a `kind` would be global pollution — belt).
    const kind = Object.hasOwn(pattern, "kind")
      ? (pattern as { kind: unknown }).kind
      : undefined;
    if (typeof kind !== "string" || kind.length === 0) {
      throw new Error(
        `cfcPolicyRecords: ${where} entries need a concrete non-empty ` +
          `string kind (grant resolution is a point query by kind)`,
      );
    }
  }
};

const validateExchangeRule = (rule: unknown, where: string): ExchangeRule => {
  if (!isPlainRecord(rule)) {
    throw new Error(`cfcPolicyRecords: ${where} must be a rule object`);
  }
  rejectUnknownKeys(rule, RULE_KEYS, where);
  const { id, appliesTo, preCondition, preConfScope, post } = rule as {
    id?: unknown;
    appliesTo?: unknown;
    preCondition?: unknown;
    preConfScope?: unknown;
    post?: unknown;
  };
  if (typeof id !== "string" || id.length === 0) {
    throw new Error(`cfcPolicyRecords: ${where} needs a non-empty string id`);
  }
  const ruleWhere = `${where} "${id}"`;
  if (appliesTo === undefined) {
    throw new Error(
      `cfcPolicyRecords: ${ruleWhere} needs an appliesTo pattern`,
    );
  }
  if (preCondition !== undefined) {
    if (!isPlainRecord(preCondition)) {
      throw new Error(
        `cfcPolicyRecords: ${ruleWhere} preCondition must be an object`,
      );
    }
    rejectUnknownKeys(
      preCondition,
      PRE_CONDITION_KEYS,
      `${ruleWhere} preCondition`,
    );
    for (const guard of ["confidentiality", "integrity", "boundary"] as const) {
      const patterns = (preCondition as Record<string, unknown>)[guard];
      if (patterns !== undefined) {
        validatePatternArray(patterns, `${ruleWhere} preCondition.${guard}`);
      }
    }
    const policyState = (preCondition as Record<string, unknown>).policyState;
    if (policyState !== undefined) {
      validatePolicyStateGuards(
        policyState,
        `${ruleWhere} preCondition.policyState`,
      );
    }
  }
  if (
    preConfScope !== undefined && preConfScope !== "targetClause" &&
    preConfScope !== "anywhere"
  ) {
    throw new Error(
      `cfcPolicyRecords: ${ruleWhere} preConfScope must be "targetClause" or "anywhere"`,
    );
  }
  if (!isPlainRecord(post)) {
    throw new Error(`cfcPolicyRecords: ${ruleWhere} needs a post object`);
  }
  rejectUnknownKeys(post, POST_KEYS, `${ruleWhere} post`);
  const { addAlternatives, dropClause } = post as {
    addAlternatives?: unknown;
    dropClause?: unknown;
  };
  if (dropClause !== undefined && typeof dropClause !== "boolean") {
    throw new Error(
      `cfcPolicyRecords: ${ruleWhere} post.dropClause must be a boolean`,
    );
  }
  const adds = addAlternatives === undefined ? undefined : validatePatternArray(
    addAlternatives,
    `${ruleWhere} post.addAlternatives`,
  );
  const drops = dropClause === true;
  // Exactly one effect: an empty post is a no-op rule (an authoring error a
  // policy author must see), and add+drop on one rule is contradictory —
  // the spec models dropping as the EMPTY instantiated postcondition.
  if (drops && adds !== undefined) {
    throw new Error(
      `cfcPolicyRecords: ${ruleWhere} post cannot both addAlternatives and dropClause`,
    );
  }
  if (!drops && (adds === undefined || adds.length === 0)) {
    throw new Error(
      `cfcPolicyRecords: ${ruleWhere} post must addAlternatives or dropClause`,
    );
  }
  return rule as ExchangeRule;
};

/**
 * Canonical digestible projection of a record's content. Explicit field
 * spelling (rather than hashing the input object) so unknown/absent keys and
 * input aliasing cannot reach the digest, and a supplied-then-verified digest
 * never participates in its own computation. `hashStringOf` hashes object
 * fields in sorted-key order, so authoring key order is already immaterial;
 * rule ORDER is content (kept — reordering rules is a different record).
 */
const policyRecordDigest = (
  id: string,
  rules: readonly ExchangeRule[],
): string =>
  hashStringOf({
    // Version 2: the digestible projection gained `policyState` (§8.12.7
    // route 2a guards). The bump changes every record digest — safe today
    // because policy digests never persist beyond one process (they are
    // computed at boot and folded into in-memory prepared digests), and it
    // keeps the projection canonical: absent == [] by construction, with no
    // conditional key inclusion.
    version: 2,
    id,
    rules: rules.map((rule) => ({
      id: rule.id,
      appliesTo: rule.appliesTo,
      preCondition: {
        confidentiality: rule.preCondition?.confidentiality ?? [],
        integrity: rule.preCondition?.integrity ?? [],
        boundary: rule.preCondition?.boundary ?? [],
        policyState: rule.preCondition?.policyState ?? [],
      },
      preConfScope: rule.preConfScope ?? "targetClause",
      post: {
        addAlternatives: rule.post.addAlternatives ?? [],
        dropClause: rule.post.dropClause === true,
      },
    })),
  });

/**
 * Validates, digests, and deep-freezes a deployment policy-record set into
 * the `PolicySnapshot` a Runtime holds for its lifetime (mirrors the
 * `cfcSinkMaxConfidentiality` freeze discipline — enforcement config must
 * not be mutable after construction). Returns `undefined` for an undefined
 * input (no policies configured); an EMPTY array is a declared empty
 * snapshot with a stable digest. Throws on any malformed record (see
 * `rejectUnknownKeys` rationale), duplicate record/rule ids, and supplied
 * digests that fail verification.
 */
export const buildCfcPolicySnapshot = (
  inputs: readonly CfcPolicyRecordInput[] | undefined,
): PolicySnapshot | undefined => {
  if (inputs === undefined) return undefined;
  if (!Array.isArray(inputs)) {
    throw new Error("cfcPolicyRecords must be an array of policy records");
  }
  const records: PolicyRecord[] = [];
  const recordIds = new Set<string>();
  for (const input of inputs) {
    if (!isPlainRecord(input)) {
      throw new Error("cfcPolicyRecords: each record must be an object");
    }
    rejectUnknownKeys(input, RECORD_INPUT_KEYS, "policy record");
    const { id, rules, digest } = input as {
      id?: unknown;
      rules?: unknown;
      digest?: unknown;
    };
    if (typeof id !== "string" || id.length === 0) {
      throw new Error(
        "cfcPolicyRecords: each record needs a non-empty string id",
      );
    }
    if (recordIds.has(id)) {
      throw new Error(`cfcPolicyRecords: duplicate record id "${id}"`);
    }
    recordIds.add(id);
    if (!Array.isArray(rules)) {
      throw new Error(`cfcPolicyRecords: record "${id}" needs a rules array`);
    }
    const ruleIds = new Set<string>();
    const validatedRules = rules.map((rule) => {
      const validated = validateExchangeRule(rule, `record "${id}" rule`);
      if (ruleIds.has(validated.id)) {
        throw new Error(
          `cfcPolicyRecords: record "${id}" has duplicate rule id "${validated.id}"`,
        );
      }
      ruleIds.add(validated.id);
      return validated;
    });
    const computedDigest = policyRecordDigest(id, validatedRules);
    if (digest !== undefined && digest !== computedDigest) {
      throw new Error(
        `cfcPolicyRecords: record "${id}" digest mismatch (expected ${computedDigest})`,
      );
    }
    records.push({ id, digest: computedDigest, rules: validatedRules });
  }
  const snapshot: PolicySnapshot = {
    records,
    digest: hashStringOf({
      version: 1,
      records: records.map((record) => record.digest),
    }),
  };
  return deepFreeze(snapshot);
};
