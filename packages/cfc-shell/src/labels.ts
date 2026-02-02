/**
 * CFC Label Algebra for the cfc-shell package.
 *
 * This module implements the label system from the CFC spec, providing:
 * - Atom types for provenance and authority tracking
 * - Confidentiality (CNF) and Integrity (set of attestations)
 * - Label lattice operations (join, meet, flowsTo)
 * - Helper constructors for common label patterns
 */

// ============================================================================
// Atom Types
// ============================================================================

export type Atom =
  | { kind: "Origin"; url: string }
  | { kind: "CodeHash"; hash: string }
  | { kind: "EndorsedBy"; principal: string }
  | { kind: "AuthoredBy"; principal: string }
  | { kind: "LLMGenerated"; model?: string }
  | { kind: "UserInput" }
  | { kind: "NetworkProvenance"; tls: boolean; host: string }
  | { kind: "TransformedBy"; command: string }
  | { kind: "Space"; id: string }
  | { kind: "PersonalSpace"; did: string }
  | { kind: "SandboxedExec" }
  | { kind: "InjectionFree" }
  | { kind: "InfluenceClean" }
  | { kind: "Policy"; name: string; subject: string; hash: string }
  | { kind: "IntegrityToken"; name: string }
  | { kind: "HasRole"; principal: string; space: string; role: string }
  | { kind: "Capability"; capKind: string; resource: string }
  | { kind: "Custom"; tag: string; value?: string };

// ============================================================================
// Label Structure
// ============================================================================

/**
 * Clause - a disjunction of atoms (OR)
 * For data to satisfy a clause, it must have at least one of the atoms
 */
export type Clause = Atom[];

/**
 * Confidentiality - Conjunctive Normal Form (CNF) of clauses
 * For data to satisfy confidentiality, it must satisfy ALL clauses
 * (each clause requires at least one atom to be present)
 *
 * Empty confidentiality = [] = public (no restrictions)
 */
export type Confidentiality = Clause[];

/**
 * Integrity - set of attestations (AND)
 * These are positive statements about the data's provenance
 * More atoms = higher integrity
 *
 * Empty integrity = [] = no provenance claims
 */
export type Integrity = Atom[];

/**
 * Label - combines confidentiality and integrity
 */
export interface Label {
  confidentiality: Confidentiality;
  integrity: Integrity;
}

/**
 * Labeled - a value paired with its label
 */
export interface Labeled<T> {
  value: T;
  label: Label;
}

// ============================================================================
// Atom Equality and Set Operations
// ============================================================================

function atomEqual(a: Atom, b: Atom): boolean {
  if (a.kind !== b.kind) return false;

  switch (a.kind) {
    case "Origin":
      return (b as typeof a).url === a.url;
    case "CodeHash":
      return (b as typeof a).hash === a.hash;
    case "EndorsedBy":
      return (b as typeof a).principal === a.principal;
    case "AuthoredBy":
      return (b as typeof a).principal === a.principal;
    case "LLMGenerated":
      return (b as typeof a).model === a.model;
    case "UserInput":
      return true;
    case "NetworkProvenance":
      return (b as typeof a).tls === a.tls && (b as typeof a).host === a.host;
    case "TransformedBy":
      return (b as typeof a).command === a.command;
    case "Space":
      return (b as typeof a).id === a.id;
    case "PersonalSpace":
      return (b as typeof a).did === a.did;
    case "SandboxedExec":
      return true;
    case "InjectionFree":
      return true;
    case "InfluenceClean":
      return true;
    case "Policy":
      return (b as typeof a).name === a.name && (b as typeof a).subject === a.subject && (b as typeof a).hash === a.hash;
    case "IntegrityToken":
      return (b as typeof a).name === a.name;
    case "HasRole":
      return (b as typeof a).principal === a.principal && (b as typeof a).space === a.space && (b as typeof a).role === a.role;
    case "Capability":
      return (b as typeof a).capKind === a.capKind && (b as typeof a).resource === a.resource;
    case "Custom":
      return (b as typeof a).tag === a.tag && (b as typeof a).value === a.value;
  }
}

function clauseEqual(a: Clause, b: Clause): boolean {
  if (a.length !== b.length) return false;
  // Clauses are sets, so order doesn't matter
  return a.every(atomA => b.some(atomB => atomEqual(atomA, atomB)));
}

function deduplicateAtoms(atoms: Atom[]): Atom[] {
  const result: Atom[] = [];
  for (const atom of atoms) {
    if (!result.some(a => atomEqual(a, atom))) {
      result.push(atom);
    }
  }
  return result;
}

function deduplicateClauses(clauses: Clause[]): Clause[] {
  const result: Clause[] = [];
  for (const clause of clauses) {
    if (!result.some(c => clauseEqual(c, clause))) {
      result.push(clause);
    }
  }
  return result;
}

function atomSetContains(atoms: Atom[], atom: Atom): boolean {
  return atoms.some(a => atomEqual(a, atom));
}

// ============================================================================
// Label Operations
// ============================================================================

/**
 * bottom - empty label (public, no provenance)
 */
function bottom(): Label {
  return {
    confidentiality: [],
    integrity: [],
  };
}

/**
 * join - Least Upper Bound (LUB)
 * Combines two labels to represent data derived from both sources
 *
 * Confidentiality: union of clauses (more restrictive - must satisfy both)
 * Integrity: intersection of atoms (less provenance - only shared attestations)
 */
function join(a: Label, b: Label): Label {
  // Union of confidentiality clauses
  const confidentiality = deduplicateClauses([
    ...a.confidentiality,
    ...b.confidentiality,
  ]);

  // Intersection of integrity atoms
  const integrity = deduplicateAtoms(
    a.integrity.filter(atom => atomSetContains(b.integrity, atom))
  );

  return { confidentiality, integrity };
}

/**
 * meet - Greatest Lower Bound (GLB)
 * Combines two labels to represent the minimum restrictions needed
 *
 * Confidentiality: intersection of clauses (less restrictive)
 * Integrity: union of atoms (more provenance)
 */
function meet(a: Label, b: Label): Label {
  // Intersection of confidentiality clauses
  const confidentiality = deduplicateClauses(
    a.confidentiality.filter(clauseA =>
      b.confidentiality.some(clauseB => clauseEqual(clauseA, clauseB))
    )
  );

  // Union of integrity atoms
  const integrity = deduplicateAtoms([
    ...a.integrity,
    ...b.integrity,
  ]);

  return { confidentiality, integrity };
}

/**
 * joinAll - fold join over an array of labels
 */
function joinAll(labels: Label[]): Label {
  if (labels.length === 0) return bottom();
  return labels.reduce(join);
}

/**
 * endorse - add integrity atoms to a label without changing confidentiality
 */
function endorse(label: Label, ...atoms: Atom[]): Label {
  return {
    confidentiality: label.confidentiality,
    integrity: deduplicateAtoms([...label.integrity, ...atoms]),
  };
}

/**
 * taintConfidentiality - join confidentiality but preserve the first label's integrity.
 * Used for PC taint from control flow (if/for/while).
 *
 * When data flows through a conditional or loop, the PC (program counter) label
 * taints the confidentiality (adds restrictions) but should NOT strip integrity.
 * This is because the integrity comes from the data itself, not the control flow.
 *
 * Example: if grep -q "secret" file.txt; then echo "found" > out.txt; fi
 * - "found" is a constant with no integrity
 * - But the output should carry file.txt's confidentiality (PC taint)
 * - Using join() would give empty integrity (intersection with PC's empty integrity)
 * - Using taintConfidentiality() preserves the echo's output integrity
 */
function taintConfidentiality(data: Label, pc: Label): Label {
  return {
    confidentiality: deduplicateClauses([
      ...data.confidentiality,
      ...pc.confidentiality,
    ]),
    integrity: data.integrity, // preserve data's integrity, don't intersect with PC
  };
}

/**
 * hasIntegrity - check if label has a specific integrity atom
 */
function hasIntegrity(label: Label, atom: Atom): boolean {
  return atomSetContains(label.integrity, atom);
}

/**
 * hasAnyIntegrity - check if label has any of the given integrity atoms
 */
function hasAnyIntegrity(label: Label, atoms: Atom[]): boolean {
  return atoms.some(atom => hasIntegrity(label, atom));
}

/**
 * flowsTo - check if data at label 'a' can flow to context with label 'b'
 *
 * This is true if a's confidentiality requirements are a subset of b's
 * (every clause in a appears in b, meaning b is at least as restrictive)
 *
 * Integrity is not checked here - that's handled by exchange rules
 */
function flowsTo(a: Label, b: Label): boolean {
  // Every clause in a must appear in b
  return a.confidentiality.every(clauseA =>
    b.confidentiality.some(clauseB => clauseEqual(clauseA, clauseB))
  );
}

// ============================================================================
// Label Constructors
// ============================================================================

/**
 * userInput - data from user input (high integrity, public)
 */
function userInput(): Label {
  return {
    confidentiality: [],
    integrity: [{ kind: "UserInput" }, { kind: "InjectionFree" }, { kind: "InfluenceClean" }],
  };
}

/**
 * fromNetwork - data fetched from network (origin integrity, public)
 * Network data lacks InjectionFree and InfluenceClean — it is untrusted
 * and may contain prompt injection payloads.
 */
function fromNetwork(url: string, tls: boolean): Label {
  const host = new URL(url).host;
  return {
    confidentiality: [],
    integrity: [
      { kind: "Origin", url },
      { kind: "NetworkProvenance", tls, host },
    ],
  };
}

/**
 * llmGenerated - data generated by LLM (low integrity, public)
 */
function llmGenerated(model?: string): Label {
  return {
    confidentiality: [],
    // LLM output has NO InjectionFree or InfluenceClean — it may contain
    // injection payloads and its content was influenced by all its inputs.
    integrity: [{ kind: "LLMGenerated", model }],
  };
}

/**
 * fromFile - data from file (space confidentiality if spaceId given)
 */
function fromFile(path: string, spaceId?: string): Label {
  const confidentiality: Confidentiality = spaceId
    ? [[{ kind: "Space", id: spaceId }]]
    : [];

  return {
    confidentiality,
    integrity: [],
  };
}

/** Label for data that is both injection-free and influence-clean (e.g., user-typed input) */
function clean(): Label {
  return {
    confidentiality: [],
    integrity: [{ kind: "InjectionFree" }, { kind: "InfluenceClean" }, { kind: "UserInput" }],
  };
}

/** Label for data that is injection-free but influence-tainted (e.g., exit code from untrusted grep) */
function influenceTainted(): Label {
  return {
    confidentiality: [],
    integrity: [{ kind: "InjectionFree" }],
  };
}

/** Strip injection-related integrity from a label (e.g., after passing through LLM) */
function stripInjectionIntegrity(label: Label): Label {
  return {
    confidentiality: label.confidentiality,
    integrity: label.integrity.filter(
      a => a.kind !== "InjectionFree" && a.kind !== "InfluenceClean"
    ),
  };
}

/** Strip only InfluenceClean (keep InjectionFree) — for derived values like exit codes */
function stripInfluenceClean(label: Label): Label {
  return {
    confidentiality: label.confidentiality,
    integrity: label.integrity.filter(a => a.kind !== "InfluenceClean"),
  };
}

// ============================================================================
// Export namespace
// ============================================================================

export const labels = {
  bottom,
  join,
  meet,
  joinAll,
  endorse,
  taintConfidentiality,
  hasIntegrity,
  hasAnyIntegrity,
  flowsTo,
  userInput,
  fromNetwork,
  llmGenerated,
  fromFile,
  clean,
  influenceTainted,
  stripInjectionIntegrity,
  stripInfluenceClean,
};
