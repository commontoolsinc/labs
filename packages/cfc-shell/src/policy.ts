/**
 * CFC Policy Exchange Rule Engine
 *
 * Direct TypeScript implementation of the Lean formalization in formal/Cfc/Policy.lean.
 *
 * The engine evaluates exchange rules at trusted boundaries (display, network egress,
 * store write). A label may contain policy principals in its confidentiality CNF.
 * Each policy principal points to a policy record containing exchange rules.
 * At the boundary, the runtime:
 *   1) collects policy principals in scope from the label,
 *   2) evaluates their exchange rules against the label + boundary-minted integrity,
 *   3) repeats until reaching a fixpoint (no more changes).
 *
 * Exchange rules use a pattern language with variables and literals for matching
 * and instantiating atoms. This is the spec's core "declassification happens via
 * integrity-guarded exchange rules" mechanism.
 */

import { Atom, Clause, Confidentiality, Integrity, Label, labels } from "./labels.ts";

// ============================================================================
// Atom equality (re-exported from labels for convenience)
// ============================================================================

function atomEqual(a: Atom, b: Atom): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case "Origin": return (b as typeof a).url === a.url;
    case "CodeHash": return (b as typeof a).hash === a.hash;
    case "EndorsedBy": return (b as typeof a).principal === a.principal;
    case "AuthoredBy": return (b as typeof a).principal === a.principal;
    case "LLMGenerated": return (b as typeof a).model === a.model;
    case "UserInput": return true;
    case "NetworkProvenance": return (b as typeof a).tls === a.tls && (b as typeof a).host === a.host;
    case "TransformedBy": return (b as typeof a).command === a.command;
    case "Space": return (b as typeof a).id === a.id;
    case "PersonalSpace": return (b as typeof a).did === a.did;
    case "SandboxedExec": return true;
    case "InjectionFree": return true;
    case "InfluenceClean": return true;
    case "Policy": return (b as typeof a).name === a.name && (b as typeof a).subject === a.subject && (b as typeof a).hash === a.hash;
    case "IntegrityToken": return (b as typeof a).name === a.name;
    case "HasRole": return (b as typeof a).principal === a.principal && (b as typeof a).space === a.space && (b as typeof a).role === a.role;
    case "Capability": return (b as typeof a).capKind === a.capKind && (b as typeof a).resource === a.resource;
    case "Custom": return (b as typeof a).tag === a.tag && (b as typeof a).value === a.value;
  }
}

function atomSetContains(atoms: Atom[], atom: Atom): boolean {
  return atoms.some(a => atomEqual(a, atom));
}

function labelEqual(a: Label, b: Label): boolean {
  if (a.confidentiality.length !== b.confidentiality.length) return false;
  if (a.integrity.length !== b.integrity.length) return false;
  // Check every clause in a is in b and vice versa
  const confMatch = a.confidentiality.every(ca =>
    b.confidentiality.some(cb =>
      ca.length === cb.length && ca.every(aa => cb.some(ab => atomEqual(aa, ab)))
    )
  ) && b.confidentiality.every(cb =>
    a.confidentiality.some(ca =>
      ca.length === cb.length && ca.every(aa => cb.some(ab => atomEqual(aa, ab)))
    )
  );
  if (!confMatch) return false;
  // Check integrity sets match
  return a.integrity.every(ai => atomSetContains(b.integrity, ai)) &&
    b.integrity.every(bi => atomSetContains(a.integrity, bi));
}

// ============================================================================
// Bindings (variable environment from pattern matching)
// ============================================================================

type BindingVal = string | number | boolean | Atom;
type Bindings = Map<string, BindingVal>;

function bindingsClone(bs: Bindings): Bindings {
  return new Map(bs);
}

function bindVar(bs: Bindings, name: string, val: BindingVal): Bindings | null {
  const existing = bs.get(name);
  if (existing !== undefined) {
    // Must be same value
    if (typeof existing !== typeof val) return null;
    if (typeof existing === "object" && typeof val === "object") {
      if (!atomEqual(existing as Atom, val as Atom)) return null;
    } else if (existing !== val) {
      return null;
    }
    return bs;
  }
  const next = bindingsClone(bs);
  next.set(name, val);
  return next;
}

// ============================================================================
// Atom Patterns
// ============================================================================

/** A field pattern: either a literal value or a variable to bind/check */
export type FieldPat<T> =
  | { kind: "lit"; value: T }
  | { kind: "var"; name: string };

function lit<T>(value: T): FieldPat<T> {
  return { kind: "lit", value };
}

function v<T>(name: string): FieldPat<T> {
  return { kind: "var", name };
}

function matchField<T>(pat: FieldPat<T>, val: T, bs: Bindings): Bindings | null {
  if (pat.kind === "lit") {
    return pat.value === val ? bs : null;
  }
  return bindVar(bs, pat.name, val as BindingVal);
}

function instantiateField<T>(pat: FieldPat<T>, bs: Bindings): T | null {
  if (pat.kind === "lit") return pat.value;
  const val = bs.get(pat.name);
  if (val === undefined) return null;
  return val as T;
}

/**
 * AtomPattern — matches one atom, potentially binding variables.
 * Mirrors the Lean AtomPattern from formal/Cfc/Policy.lean.
 */
export type AtomPattern =
  | { kind: "Origin"; url: FieldPat<string> }
  | { kind: "CodeHash"; hash: FieldPat<string> }
  | { kind: "EndorsedBy"; principal: FieldPat<string> }
  | { kind: "AuthoredBy"; principal: FieldPat<string> }
  | { kind: "UserInput" }
  | { kind: "NetworkProvenance"; tls: FieldPat<boolean>; host: FieldPat<string> }
  | { kind: "TransformedBy"; command: FieldPat<string> }
  | { kind: "Space"; id: FieldPat<string> }
  | { kind: "PersonalSpace"; did: FieldPat<string> }
  | { kind: "SandboxedExec" }
  | { kind: "InjectionFree" }
  | { kind: "InfluenceClean" }
  | { kind: "Policy"; name: FieldPat<string>; subject: FieldPat<string>; hash: FieldPat<string> }
  | { kind: "IntegrityToken"; name: FieldPat<string> }
  | { kind: "HasRole"; principal: FieldPat<string>; space: FieldPat<string>; role: FieldPat<string> }
  | { kind: "Capability"; capKind: FieldPat<string>; resource: FieldPat<string> }
  | { kind: "Custom"; tag: FieldPat<string>; value: FieldPat<string> }
  | { kind: "eq"; atom: Atom };

function matchAtomPattern(pat: AtomPattern, atom: Atom, bs: Bindings): Bindings | null {
  if (pat.kind === "eq") {
    return atomEqual(pat.atom, atom) ? bs : null;
  }
  if (pat.kind !== atom.kind) return null;

  switch (pat.kind) {
    case "Origin": {
      const a = atom as { kind: "Origin"; url: string };
      return matchField(pat.url, a.url, bs);
    }
    case "CodeHash": {
      const a = atom as { kind: "CodeHash"; hash: string };
      return matchField(pat.hash, a.hash, bs);
    }
    case "EndorsedBy": {
      const a = atom as { kind: "EndorsedBy"; principal: string };
      return matchField(pat.principal, a.principal, bs);
    }
    case "AuthoredBy": {
      const a = atom as { kind: "AuthoredBy"; principal: string };
      return matchField(pat.principal, a.principal, bs);
    }
    case "UserInput":
      return bs;
    case "NetworkProvenance": {
      const a = atom as { kind: "NetworkProvenance"; tls: boolean; host: string };
      const bs1 = matchField(pat.tls, a.tls, bs);
      if (!bs1) return null;
      return matchField(pat.host, a.host, bs1);
    }
    case "TransformedBy": {
      const a = atom as { kind: "TransformedBy"; command: string };
      return matchField(pat.command, a.command, bs);
    }
    case "Space": {
      const a = atom as { kind: "Space"; id: string };
      return matchField(pat.id, a.id, bs);
    }
    case "PersonalSpace": {
      const a = atom as { kind: "PersonalSpace"; did: string };
      return matchField(pat.did, a.did, bs);
    }
    case "SandboxedExec":
      return bs;
    case "InjectionFree":
      return bs;
    case "InfluenceClean":
      return bs;
    case "Policy": {
      const a = atom as { kind: "Policy"; name: string; subject: string; hash: string };
      const bs1 = matchField(pat.name, a.name, bs);
      if (!bs1) return null;
      const bs2 = matchField(pat.subject, a.subject, bs1);
      if (!bs2) return null;
      return matchField(pat.hash, a.hash, bs2);
    }
    case "IntegrityToken": {
      const a = atom as { kind: "IntegrityToken"; name: string };
      return matchField(pat.name, a.name, bs);
    }
    case "HasRole": {
      const a = atom as { kind: "HasRole"; principal: string; space: string; role: string };
      const bs1 = matchField(pat.principal, a.principal, bs);
      if (!bs1) return null;
      const bs2 = matchField(pat.space, a.space, bs1);
      if (!bs2) return null;
      return matchField(pat.role, a.role, bs2);
    }
    case "Capability": {
      const a = atom as { kind: "Capability"; capKind: string; resource: string };
      const bs1 = matchField(pat.capKind, a.capKind, bs);
      if (!bs1) return null;
      return matchField(pat.resource, a.resource, bs1);
    }
    case "Custom": {
      const a = atom as { kind: "Custom"; tag: string; value?: string };
      const bs1 = matchField(pat.tag, a.tag, bs);
      if (!bs1) return null;
      return matchField(pat.value, a.value ?? "", bs1);
    }
  }
}

function instantiateAtomPattern(pat: AtomPattern, bs: Bindings): Atom | null {
  if (pat.kind === "eq") return pat.atom;

  switch (pat.kind) {
    case "Origin": {
      const url = instantiateField(pat.url, bs);
      return url !== null ? { kind: "Origin", url } : null;
    }
    case "CodeHash": {
      const hash = instantiateField(pat.hash, bs);
      return hash !== null ? { kind: "CodeHash", hash } : null;
    }
    case "EndorsedBy": {
      const principal = instantiateField(pat.principal, bs);
      return principal !== null ? { kind: "EndorsedBy", principal } : null;
    }
    case "AuthoredBy": {
      const principal = instantiateField(pat.principal, bs);
      return principal !== null ? { kind: "AuthoredBy", principal } : null;
    }
    case "UserInput":
      return { kind: "UserInput" };
    case "NetworkProvenance": {
      const tls = instantiateField(pat.tls, bs);
      const host = instantiateField(pat.host, bs);
      return tls !== null && host !== null ? { kind: "NetworkProvenance", tls, host } : null;
    }
    case "TransformedBy": {
      const command = instantiateField(pat.command, bs);
      return command !== null ? { kind: "TransformedBy", command } : null;
    }
    case "Space": {
      const id = instantiateField(pat.id, bs);
      return id !== null ? { kind: "Space", id } : null;
    }
    case "PersonalSpace": {
      const did = instantiateField(pat.did, bs);
      return did !== null ? { kind: "PersonalSpace", did } : null;
    }
    case "SandboxedExec":
      return { kind: "SandboxedExec" };
    case "InjectionFree":
      return { kind: "InjectionFree" };
    case "InfluenceClean":
      return { kind: "InfluenceClean" };
    case "Policy": {
      const name = instantiateField(pat.name, bs);
      const subject = instantiateField(pat.subject, bs);
      const hash = instantiateField(pat.hash, bs);
      return name !== null && subject !== null && hash !== null
        ? { kind: "Policy", name, subject, hash } : null;
    }
    case "IntegrityToken": {
      const name = instantiateField(pat.name, bs);
      return name !== null ? { kind: "IntegrityToken", name } : null;
    }
    case "HasRole": {
      const principal = instantiateField(pat.principal, bs);
      const space = instantiateField(pat.space, bs);
      const role = instantiateField(pat.role, bs);
      return principal !== null && space !== null && role !== null
        ? { kind: "HasRole", principal, space, role } : null;
    }
    case "Capability": {
      const capKind = instantiateField(pat.capKind, bs);
      const resource = instantiateField(pat.resource, bs);
      return capKind !== null && resource !== null ? { kind: "Capability", capKind, resource } : null;
    }
    case "Custom": {
      const tag = instantiateField(pat.tag, bs);
      const value = instantiateField(pat.value, bs);
      return tag !== null && value !== null ? { kind: "Custom", tag, value } : null;
    }
  }
}

function instantiateAll(pats: AtomPattern[], bs: Bindings): Atom[] | null {
  const result: Atom[] = [];
  for (const pat of pats) {
    const atom = instantiateAtomPattern(pat, bs);
    if (atom === null) return null;
    result.push(atom);
  }
  return result;
}

// ============================================================================
// Exchange Rules and Policy Records
// ============================================================================

/**
 * An exchange rule. Mirrors the Lean ExchangeRule from formal/Cfc/Policy.lean.
 *
 * - preConf: confidentiality patterns. First is the target (matched against a specific
 *   clause/alternative). Remaining must match somewhere in the label's conf atoms.
 * - preInteg: integrity patterns. Must all match in available integrity.
 * - postConf: atoms to add as alternatives in the target clause. Empty = drop the matched atom.
 * - postInteg: integrity atoms to add to the label.
 */
export interface ExchangeRule {
  name: string;
  preConf: AtomPattern[];
  preInteg: AtomPattern[];
  postConf: AtomPattern[];
  postInteg: AtomPattern[];
}

/**
 * A policy record: a policy principal (confidentiality atom) + its exchange rules.
 */
export interface PolicyRecord {
  principal: Atom;
  exchangeRules: ExchangeRule[];
}

// ============================================================================
// Rule Matching (mirrors formal/Cfc/Policy.lean matchRule)
// ============================================================================

interface RuleMatch {
  clauseIndex: number;
  altIndex: number;
  targetAtom: Atom;
  bindings: Bindings;
}

/** All (clauseIndex, altIndex, atom) positions in a CNF. */
function confPositions(conf: Confidentiality): Array<[number, number, Atom]> {
  const result: Array<[number, number, Atom]> = [];
  for (let i = 0; i < conf.length; i++) {
    for (let j = 0; j < conf[i].length; j++) {
      result.push([i, j, conf[i][j]]);
    }
  }
  return result;
}

/** All atoms across the entire CNF (flattened). */
function flattenConf(conf: Confidentiality): Atom[] {
  const result: Atom[] = [];
  for (const clause of conf) {
    for (const atom of clause) {
      result.push(atom);
    }
  }
  return result;
}

/** Match a pattern against any atom in a list, returning all resulting bindings. */
function matchAny(pat: AtomPattern, atoms: Atom[], bs: Bindings): Bindings[] {
  const results: Bindings[] = [];
  for (const atom of atoms) {
    const r = matchAtomPattern(pat, atom, bindingsClone(bs));
    if (r !== null) results.push(r);
  }
  return results;
}

/** Match a list of patterns, each against some atom in the list. Returns all valid binding sets. */
function matchAllSomewhere(pats: AtomPattern[], atoms: Atom[], bs: Bindings): Bindings[] {
  if (pats.length === 0) return [bs];
  const [first, ...rest] = pats;
  const firstMatches = matchAny(first, atoms, bs);
  const results: Bindings[] = [];
  for (const bs1 of firstMatches) {
    results.push(...matchAllSomewhere(rest, atoms, bs1));
  }
  return results;
}

/**
 * Match a rule against a label with available integrity.
 * Returns all possible matches with their clause/alt positions and bindings.
 */
function matchRule(rule: ExchangeRule, label: Label, availIntegrity: Integrity): RuleMatch[] {
  if (rule.preConf.length === 0) return [];

  const [targetPat, ...otherPats] = rule.preConf;
  const confAtoms = flattenConf(label.confidentiality);
  const results: RuleMatch[] = [];

  for (const [i, j, atom] of confPositions(label.confidentiality)) {
    const bs0 = matchAtomPattern(targetPat, atom, new Map());
    if (bs0 === null) continue;

    // Match remaining conf patterns somewhere in the label
    const confBindings = matchAllSomewhere(otherPats, confAtoms, bs0);

    // For each conf match, match integrity patterns
    for (const bs1 of confBindings) {
      const integBindings = matchAllSomewhere(rule.preInteg, availIntegrity, bs1);
      for (const bs2 of integBindings) {
        results.push({ clauseIndex: i, altIndex: j, targetAtom: atom, bindings: bs2 });
      }
    }
  }

  return results;
}

// ============================================================================
// Applying a Rule (mirrors formal/Cfc/Policy.lean applyRule)
// ============================================================================

function clauseInsert(atom: Atom, clause: Clause): Clause {
  if (clause.some(a => atomEqual(a, atom))) return clause;
  return [atom, ...clause];
}

function addUniqueAtom(atoms: Atom[], atom: Atom): Atom[] {
  if (atomSetContains(atoms, atom)) return atoms;
  return [...atoms, atom];
}

function applyRule(label: Label, match: RuleMatch, rule: ExchangeRule): Label | null {
  const postConfAtoms = instantiateAll(rule.postConf, match.bindings);
  if (postConfAtoms === null) return null;

  const postIntegAtoms = instantiateAll(rule.postInteg, match.bindings);
  if (postIntegAtoms === null) return null;

  const addedInteg = postIntegAtoms.filter(a => !atomSetContains(label.integrity, a));
  const clause = label.confidentiality[match.clauseIndex];
  if (!clause) return label;

  if (postConfAtoms.length === 0) {
    // Drop the matched alternative
    const atomAt = clause[match.altIndex];
    if (!atomAt || !atomEqual(atomAt, match.targetAtom)) return label;

    const newClause = [...clause.slice(0, match.altIndex), ...clause.slice(match.altIndex + 1)];
    let newConf: Confidentiality;
    if (newClause.length === 0) {
      // Empty clause — drop it entirely
      newConf = [...label.confidentiality.slice(0, match.clauseIndex), ...label.confidentiality.slice(match.clauseIndex + 1)];
    } else {
      newConf = label.confidentiality.map((c, i) => i === match.clauseIndex ? newClause : c);
    }
    let newInteg = label.integrity;
    for (const a of addedInteg) newInteg = addUniqueAtom(newInteg, a);
    return { confidentiality: newConf, integrity: newInteg };
  } else {
    // Add postcondition atoms as alternatives in the target clause
    let newClause = clause;
    for (const a of postConfAtoms) newClause = clauseInsert(a, newClause);
    const newConf = label.confidentiality.map((c, i) => i === match.clauseIndex ? newClause : c);
    let newInteg = label.integrity;
    for (const a of addedInteg) newInteg = addUniqueAtom(newInteg, a);
    return { confidentiality: newConf, integrity: newInteg };
  }
}

// ============================================================================
// Policy Collection and Evaluation
// ============================================================================

function isPolicyPrincipal(atom: Atom): boolean {
  return atom.kind === "Policy";
}

function collectPolicyPrincipals(conf: Confidentiality): Atom[] {
  const seen: Atom[] = [];
  for (const clause of conf) {
    for (const atom of clause) {
      if (isPolicyPrincipal(atom) && !atomSetContains(seen, atom)) {
        seen.push(atom);
      }
    }
  }
  return seen;
}

function policiesInScope(policies: PolicyRecord[], conf: Confidentiality): PolicyRecord[] {
  const principals = collectPolicyPrincipals(conf);
  const result: PolicyRecord[] = [];
  for (const p of principals) {
    const record = policies.find(pol => atomEqual(pol.principal, p));
    if (record) result.push(record);
  }
  return result;
}

/**
 * Sort drop-rule matches in descending index order (delete-from-the-back trick).
 * This prevents stale indices when applying multiple drops.
 */
function sortMatchesForDrop(matches: RuleMatch[]): RuleMatch[] {
  return [...matches].sort((a, b) => {
    if (a.clauseIndex !== b.clauseIndex) return b.clauseIndex - a.clauseIndex;
    return b.altIndex - a.altIndex;
  });
}

/**
 * One pass: evaluate all in-scope policy rules against the label.
 * Mirrors formal/Cfc/Policy.lean evalOnce.
 */
function evalOnce(policies: PolicyRecord[], boundaryIntegrity: Integrity, label: Label): Label {
  const inScope = policiesInScope(policies, label.confidentiality);
  let current = label;

  for (const pol of inScope) {
    for (const rule of pol.exchangeRules) {
      const avail = [...current.integrity, ...boundaryIntegrity];
      let matches = matchRule(rule, current, avail);

      // For drop rules, apply in descending order to avoid stale indices
      if (rule.postConf.length === 0) {
        matches = sortMatchesForDrop(matches);
      }

      for (const m of matches) {
        const next = applyRule(current, m, rule);
        if (next !== null) current = next;
      }
    }
  }

  return current;
}

/**
 * Evaluate exchange rules to a fixpoint (fuelled loop).
 * Mirrors formal/Cfc/Policy.lean evalFixpoint.
 */
export function evalExchangeRules(
  policies: PolicyRecord[],
  boundaryIntegrity: Integrity,
  label: Label,
  fuel: number = 10,
): Label {
  let current = label;
  for (let i = 0; i < fuel; i++) {
    const next = evalOnce(policies, boundaryIntegrity, current);
    if (labelEqual(next, current)) return current;
    current = next;
  }
  return current;
}

// ============================================================================
// Convenience constructors for building policies
// ============================================================================

export const pat = { lit, var: v };

export const policy = {
  evalExchangeRules,
};
