/**
 * Action taint context — tracks accumulated information flow during a single
 * action (read/compute/write sequence) and enforces CFC write checks.
 */

import { userAtom, spaceAtom, authoredByAtom, codeHashAtom } from "./atoms.ts";
import { emptyIntegrity, integrityFromAtoms } from "./integrity.ts";
import { type Label, emptyLabel, joinLabel, labelLeq } from "./labels.ts";
import type { IntegrityLabel } from "./integrity.ts";
import { type ExchangeRule, evaluateRules } from "./exchange-rules.ts";
import { type PolicyRecord, DEFAULT_POLICY } from "./policy.ts";
import { formatLabel } from "./violations.ts";

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

export class CFCViolationError extends Error {
  constructor(
    public readonly kind: "write-down" | "clearance-exceeded",
    public readonly accumulatedTaint: Label,
    public readonly writeTargetLabel: Label,
  ) {
    super(`CFC violation: ${kind} — taint ${formatLabel(accumulatedTaint)} cannot flow to ${formatLabel(writeTargetLabel)}`);
    this.name = "CFCViolationError";
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ActionTaintContext = {
  /** Who is executing. */
  readonly principal: Label;
  /** Max label this action may read. */
  readonly clearance: Label;
  /** Join of all read labels during this action. */
  accumulatedTaint: Label;
  /** Active policy for the action's space. */
  readonly policy: PolicyRecord;
  /** Code hash + endorsements. */
  readonly integrityBasis: IntegrityLabel;
};

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

/**
 * Create an action context for a user acting within a space.
 *
 * - principal: empty confidentiality, integrity = [AuthoredBy(did)]
 * - clearance: confidentiality = [[User(did)], [Space(space)]], empty integrity
 * - accumulatedTaint: empty
 * - integrityBasis: [CodeHash(hash)] if provided, else empty
 */
export function createActionContext(options: {
  userDid: string;
  space: string;
  codeHash?: string;
  policy?: PolicyRecord;
}): ActionTaintContext {
  const { userDid, space, codeHash, policy } = options;

  const principal: Label = {
    confidentiality: [],
    integrity: integrityFromAtoms([authoredByAtom(userDid)]),
  };

  const clearance: Label = {
    confidentiality: [[userAtom(userDid)], [spaceAtom(space)]],
    integrity: emptyIntegrity(),
  };

  const integrityBasis = codeHash
    ? integrityFromAtoms([codeHashAtom(codeHash)])
    : emptyIntegrity();

  return {
    principal,
    clearance,
    accumulatedTaint: emptyLabel(),
    policy: policy ?? DEFAULT_POLICY,
    integrityBasis,
  };
}

// ---------------------------------------------------------------------------
// Taint accumulation
// ---------------------------------------------------------------------------

/** Mutate the context's accumulated taint by joining with a read label. */
export function accumulateTaint(
  ctx: ActionTaintContext,
  readLabel: Label,
): void {
  ctx.accumulatedTaint = joinLabel(ctx.accumulatedTaint, readLabel);
}

/**
 * Check if a read label exceeds the action's clearance.
 * Throws CFCViolationError if the action doesn't have sufficient clearance.
 *
 * Note: checkClearance is not called automatically during accumulateTaint
 * because clearance semantics require exchange rules to bridge between
 * Classification atoms and User/Space atoms. This will be enabled when
 * space policies define the mapping.
 */
export function checkClearance(
  ctx: ActionTaintContext,
  readLabel: Label,
): void {
  if (!labelLeq(readLabel, ctx.clearance)) {
    throw new CFCViolationError(
      "clearance-exceeded",
      readLabel,
      ctx.clearance,
    );
  }
}

// ---------------------------------------------------------------------------
// Write check
// ---------------------------------------------------------------------------

/**
 * Check whether writing to a target label is permitted given the accumulated
 * taint. Applies exchange rules for potential declassification first.
 *
 * Throws CFCViolationError if the write is not allowed.
 */
export function checkWrite(
  ctx: ActionTaintContext,
  writeTargetLabel: Label,
  rules: ExchangeRule[],
): void {
  const declassified = evaluateRules(ctx.accumulatedTaint, rules);

  if (!labelLeq(declassified, writeTargetLabel)) {
    throw new CFCViolationError(
      "write-down",
      ctx.accumulatedTaint,
      writeTargetLabel,
    );
  }
}
