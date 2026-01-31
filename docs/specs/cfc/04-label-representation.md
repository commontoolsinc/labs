# 4. Label Representation and Policy Infrastructure

## 4.1 Parameterized Atoms

Labels are sets of **parameterized atoms**. An atom is not a simple string but a structured value with a type and parameters.

### 4.1.1 Atom Syntax (Abstract)

The specification uses a functional notation for atoms:

```
User(did:key:alice)
Space(space-abc123)
PersonalSpace(did:key:alice)
Ctx.Email(did:key:alice)
GoogleAuth(did:key:alice)
EmailSecret(did:key:alice, {did:key:bob, did:key:carol})
AuthoredBy(did:mailto:hotel@example.com)
Expires(1735689600)
```

### 4.1.2 Atom Representation (Concrete)

Atoms are represented as JSON objects with a `type` field and type-specific parameters:

```typescript
// Policy principals appear in two forms:
// - PolicyNameAtom: unbound (no hash), used in schemas and authoring-time annotations.
// - PolicyRefAtom: bound (with hash), used in runtime labels and evidence.
type PolicyNameAtom = {
  // Policy principals are carried in confidentiality labels and are interpreted
  // only by trusted evaluators at boundary points.
  type: "Context" | "Policy";
  name: string;
  subject: DID;
};

type PolicyRefAtom = PolicyNameAtom & {
  // Content hash of the referenced policy record (required in runtime labels).
  // This binds the label to an immutable policy version.
  hash: string;
};

type Atom =
  // Subject principals (users, services)
  | { type: "User"; subject: DID }
  | { type: "Service"; subject: DID }

  // Space principals
  | { type: "Space"; id: SpaceID }
  | { type: "PersonalSpace"; owner: DID }  // Equivalent to a per-user space principal

  // Context/policy principals (reference policy records)
  | PolicyNameAtom                                       // e.g., schema-time: Ctx.Email(Alice)
  | PolicyRefAtom                                        // e.g., label-time: GoogleAuth(Alice, hash=...)

  // Resource classification
  | { type: "Resource"; class: string; subject: DID; scope?: unknown }

  // Temporal constraints
  | { type: "Expires"; timestamp: number }               // Absolute Unix timestamp
  | { type: "TTL"; seconds: number }                     // Schema-time convenience; resolved to Expires at label creation

  // Conceptual principals (abstract concepts bound to implementations via trust)
  | { type: "Concept"; uri: string }                     // e.g., "https://commonfabric.org/concepts/age-rounding"

  // Runtime environment principals
  | { type: "Runtime"; environment: RuntimeEnvironment }
  | { type: "Attestation"; attester: DID; evidence: AttestationEvidence }

  // Capability principals (egress/network access)
  | { type: "Capability"; resource: CapabilityResource }

  // Origin principals (external data sources)
  | { type: "Origin"; uri: string; fetchedAt: number; tlsCertHash?: string }

  // Verifier principals (trusted reviewers)
  | { type: "Verifier"; subject: DID; scope?: string }

  // Common integrity atoms (non-exhaustive)
  | { type: "CodeHash"; hash: string }
  | { type: "AuthoredBy"; sender: DID; messageId?: string }
  | { type: "EndorsedBy"; endorser: DID; action?: string }
  | { type: "HasRole"; principal: DID; space: SpaceID; role: "owner" | "writer" | "reader" }
  | { type: "AuthorizedRequest"; policy: PolicyRefAtom; user: DID; endpoint: string; requestDigest: string; codeHash: string }
  | { type: "PolicyCertified"; policyId: string; enforcer?: Atom }
  | { type: "NetworkProvenance"; host: string; tls: boolean; tlsCertHash?: string; requestDigest?: string; codeHash?: string }
  // Extension point: policies and runtimes may introduce additional atom types.
  | { type: string; [key: string]: unknown };

// Runtime environment types
type RuntimeEnvironment =
  | { kind: "local"; deviceId: DID }                     // User's device
  | { kind: "confidential"; provider: string; attestation: string }  // TEE/confidential compute
  | { kind: "server"; operator: DID; attestation?: string };         // Server with optional attestation

// Attestation evidence
interface AttestationEvidence {
  type: "sgx" | "sev" | "tdx" | "nitro" | "runtime-signature";
  quote?: string;           // Hardware attestation quote
  runtimeHash?: string;     // Hash of trusted runtime
  timestamp: number;
}

// Capability resources (for egress control)
type CapabilityResource =
  | { kind: "network"; pattern: string; tls: boolean }   // e.g., "*.openai.com"
  | { kind: "storage"; provider: string; bucket?: string }
  | { kind: "api"; service: string; scopes: string[] };
```

### 4.1.3 Atom Comparison

Two atoms are **equal** if they have the same type and all parameters match.

Implementations SHOULD compare atoms by canonical structural equality (deterministic field ordering, no ignored fields). For example:

```typescript
function atomEquals(a: Atom, b: Atom): boolean {
  return canonicalizeAtom(a) === canonicalizeAtom(b);
}

function canonicalizeAtom(atom: Atom): string {
  // Canonical JSON encoding of the atom, including all fields.
  // Implementations SHOULD use a standardized canonical JSON scheme (e.g., RFC 8785 / JCS).
  // Type-specific set-valued fields MUST be normalized (e.g., sorted arrays) before hashing.
  return c14nJson(atom);
}

function c14nJson(value: unknown): string {
  // Deterministic JSON serialization (no whitespace, sorted keys, stable number formatting).
  // A conforming implementation may use RFC 8785 (JCS).
  return "…";
}
```

Two atoms are **comparable** in the lattice if:
- They have the same type, OR
- One is a policy principal that explicitly declares ordering with another

For most atoms, ordering is **flat**: `User(Alice)` and `User(Bob)` are incomparable. Neither flows to the other without an explicit exchange rule.

**Space atoms** have special semantics: data in `Space(X)` is readable by any principal with `HasRole(principal, X, reader)`. This is not lattice ordering but exchange-rule-based authorization.

---

## 4.2 Label Structure

A **label** is an object containing confidentiality clauses (CNF) and integrity atoms. Expiration is represented as confidentiality atoms (`Expires`) rather than a separate field.

```typescript
// A clause is a single atom or OR of atoms
type Clause = Atom | Atom[];

interface Label {
  // Confidentiality: CNF (AND of clauses, each clause is atom or OR of atoms)
  // Includes temporal constraints as Expires atoms
  confidentiality: Clause[];

  // Integrity: simple conjunction (set of atoms)
  integrity: Atom[];
}
```

**CNF structure for confidentiality** (see [§3.1.1](./03-core-concepts.md#311-confidentiality-cnf-structure)):
- Each clause represents a requirement that must be satisfied
- A clause with multiple atoms (array) represents alternatives (OR)
- All clauses must be satisfied (AND)
- Exchange rules add alternatives to existing clauses
- `Expires(t)` atoms encode temporal constraints; access fails if `t < now`

```typescript
// Simple label (all singleton clauses)
{ confidentiality: [User(Alice), GoogleAuth(Alice)], integrity: [...] }
// Meaning: Alice ∧ GoogleAuth(Alice)

// With expiration
{ confidentiality: [User(Alice), GoogleAuth(Alice), Expires(1735689600)], integrity: [...] }
// Meaning: Alice ∧ GoogleAuth(Alice) ∧ NotExpired

// After exchange rule adds alternative
{ confidentiality: [User(Alice), [GoogleAuth(Alice), UserResource(Alice)]], integrity: [...] }
// Meaning: Alice ∧ (GoogleAuth(Alice) ∨ UserResource)
```

### 4.2.1 Label in JSON Schema

The `ifc` field in JSON Schema holds labels. In schema definitions, confidentiality is typically expressed as simple conjunctions (singleton clauses). Disjunctions arise at runtime when exchange rules fire.

```typescript
interface JSONSchemaIFC {
  // Confidentiality clauses for this schema path
  // In schemas, typically simple atoms (disjunctions added at runtime)
  // May include Expires atoms for temporal constraints
  confidentiality?: Atom[];

  // Integrity atoms for this schema path
  integrity?: Atom[];

  // Store-field write authorization (used only for in-place modifications; see Section 8.15)
  writeAuthorizedBy?: Atom[];

  // Shorthand for simple classification (backward compatibility)
  classification?: string[];  // Maps to Resource atoms
}
```

**Expiration in schemas**: Use `{ type: "Expires", timestamp: number }` or `{ type: "TTL", seconds: number }` atoms. TTL atoms are converted to absolute `Expires` atoms at label creation time.

**Example:**

```json
{
  "type": "object",
  "properties": {
    "email": {
      "type": "string",
      "ifc": {
        "confidentiality": [
          { "type": "User", "subject": "did:key:alice" },
          { "type": "Context", "name": "Email", "subject": "did:key:alice" }
        ]
      }
    },
    "ssn": {
      "type": "string",
      "ifc": {
        "confidentiality": [
          { "type": "User", "subject": "did:key:alice" },
          { "type": "Resource", "class": "SSN", "subject": "did:key:alice" }
        ],
        "integrity": [
          { "type": "AuthoredBy", "sender": "did:mailto:ssa.gov" }
        ]
      }
    }
  }
}
```

At runtime, these become CNF labels with singleton clauses:
```typescript
// Runtime label for email field
{
  confidentiality: [
    { type: "User", subject: "did:key:alice" },      // clause 1
    { type: "Context", name: "Email", subject: "did:key:alice", hash: "sha256:..." } // clause 2 (policy hash bound at label creation)
  ],
  // Each atom is its own clause (singleton)
}
```

### 4.2.2 Label Accumulation

When navigating schema paths, labels accumulate:

```
schema.properties.user.properties.ssn
```

The effective label at `/user/ssn` is the **join** of all labels along the path:
- Labels on the root schema
- Labels on `properties.user`
- Labels on `properties.ssn`

For confidentiality, join means **concatenation** of clauses (more restrictive—all clauses must be satisfied).
For integrity, join means **intersection** of atoms (weaker claims).
For expiration, join means **minimum** timestamp (earliest deadline).

### 4.2.2.1 Schema Evolution and Label Monotonicity

Schema evolution **must** preserve label monotonicity—new schema versions cannot weaken confidentiality constraints.

**Rules for schema evolution**:

1. **New optional fields inherit parent label**: When adding a new field without an explicit `ifc` annotation, the field inherits the label of its nearest ancestor with a label. This prevents accidental declassification.

2. **Explicit labels must be at least as restrictive**: New fields with explicit labels must have confidentiality that is a superset of (or equal to) the parent's confidentiality.

3. **Schema versions in store labels**: Store labels must include the schema version to enable migration verification.

```typescript
interface SchemaVersionedLabel extends Label {
  // Schema version when this label was established
  schemaVersion: string;

  // Migration history (for audit)
  labelHistory?: {
    version: string;
    confidentiality: Clause[];  // CNF clauses
    migratedAt: number;
  }[];
}

// Verify schema evolution preserves label monotonicity
function verifySchemaEvolution(
  oldSchema: JSONSchema,
  newSchema: JSONSchema
): { valid: boolean; violations: string[] } {
  const violations: string[] = [];

  for (const [path, newField] of walkSchema(newSchema)) {
    const oldField = getSchemaAtPath(oldSchema, path);

    if (!oldField) {
      // New field - must inherit or exceed parent confidentiality
      const parentPath = path.slice(0, -1);
      const parentLabel = getEffectiveLabel(newSchema, parentPath);
      const newLabel = newField.ifc ?? {};

      if (newLabel.confidentiality) {
        // Explicit label - verify it's at least as restrictive
        if (!isSubsetOrEqual(parentLabel.confidentiality, newLabel.confidentiality)) {
          violations.push(
            `New field ${path} has weaker confidentiality than parent`
          );
        }
      }
      // If no explicit label, it inherits parent (always valid)
    } else {
      // Existing field - cannot weaken confidentiality
      const oldLabel = oldField.ifc ?? {};
      const newLabel = newField.ifc ?? {};

      if (!isSubsetOrEqual(oldLabel.confidentiality ?? [], newLabel.confidentiality ?? [])) {
        violations.push(
          `Field ${path} confidentiality was weakened in new schema version`
        );
      }
    }
  }

  return { valid: violations.length === 0, violations };
}
```

**Example: Safe schema evolution**

```json
// v1: User record
{
  "type": "object",
  "ifc": { "confidentiality": [{ "type": "User", "subject": "..." }] },
  "properties": {
    "email": { "type": "string" }
  }
}

// v2: Add phone (inherits User confidentiality - safe)
{
  "type": "object",
  "ifc": { "confidentiality": [{ "type": "User", "subject": "..." }] },
  "properties": {
    "email": { "type": "string" },
    "phone": { "type": "string" }  // No explicit ifc - inherits parent
  }
}

// v3: Add SSN with stricter label (safe - more restrictive)
{
  "type": "object",
  "ifc": { "confidentiality": [{ "type": "User", "subject": "..." }] },
  "properties": {
    "email": { "type": "string" },
    "phone": { "type": "string" },
    "ssn": {
      "type": "string",
      "ifc": {
        "confidentiality": [
          { "type": "User", "subject": "..." },
          { "type": "Resource", "class": "SSN", "subject": "..." }
        ]
      }
    }
  }
}
```

### 4.2.3 Expiration (TTL) Semantics

Expiration ensures that a value becomes unreadable after a deadline, and implementations SHOULD delete expired values (and any derivatives that still carry the same `Expires(...)` constraint).

**Combination rule**: When data is combined, all `Expires` atoms from inputs are included in the output's confidentiality. Since all clauses must be satisfied, the earliest expiration effectively constrains access.

**Retention relaxation (dropping inherited expiration)**: Policies MAY allow specific derived outputs to drop an inherited `Expires(...)` clause when integrity proves the output is safe to retain longer. This is modeled as an exchange rule whose confidentiality postcondition is empty for the matched `Expires(...)` clause:

```typescript
// Drop an inherited Expires(...) constraint on a derived value under guard.
{
  preCondition: {
    confidentiality: [{ type: "Expires", timestamp: { var: "$t" } }],
    integrity: [{ type: "DetectedBy", detector: "song-fingerprint-v1" }]
  },
  postCondition: { confidentiality: [], integrity: [] }  // Remove the matched Expires clause
}
```

Which components can relax retention? The data's label specifies a conceptual principal (e.g., `SongDetector`) authorized to drop expiration for particular derived values. The user then delegates trust to that principal via a verifier they trust, who certifies specific code hashes as valid implementations. This follows the same trust model as other privileged operations.

**Example**: Raw audio may have `Expires(now + 1h)` in its confidentiality. A song detection component (certified by a trusted verifier) can drop the inherited expiration on derived song metadata via an exchange rule. Longer retention is typically expressed by the output schema itself carrying a `TTL(...)`/`Expires(...)` label, which becomes effective once the inherited input `Expires(...)` clause is dropped.

**Runtime enforcement**: The runtime must:
1. Treat `Expires(t)` as satisfiable only if `now ≤ t`
2. Periodically garbage collect values that are no longer satisfiable due to `Expires(...)`
3. Propagate `Expires` atoms through computations via standard label join until an explicit exchange rule drops them

---

## 4.3 Policy Records

A **policy principal** (Context or Policy atom) references a **policy record** that defines exchange rules.

### 4.3.1 Policy Record Structure

```typescript
interface PolicyRecord {
  // Unique identifier for this policy
  id: string;

  // Human-readable name
  name: string;

  // The principal this policy applies to
  principal: Atom;

  // Exchange rules (transmission principles)
  exchangeRules: ExchangeRule[];

  // Dependency classification
  dependencies: {
    // Fields that authorize but don't taint
    authorityOnly: string[];
    // Fields that taint the result
    dataBearing: string[];
  };

  // Integrity requirements for various operations
  integrityRequirements: {
    // Required integrity to read
    read?: Atom[];
    // Required integrity to write
    write?: Atom[];
    // Required integrity to share
    share?: Atom[];
  };
}
```

### 4.3.2 Exchange Rules

An exchange rule defines when confidentiality atoms may be rewritten:

```typescript
interface ExchangeRule {
  // Descriptive name
  name: string;

  // Precondition: atoms that must be present
  preCondition: {
    // Required confidentiality atoms (may use variables)
    confidentiality: AtomPattern[];
    // Required integrity atoms (the "guard")
    integrity: AtomPattern[];
  };

  // Postcondition: resulting atoms after exchange
  postCondition: {
    // New confidentiality atoms (may reference variables from precondition)
    confidentiality: AtomPattern[];
    // Integrity atoms added by this exchange
    integrity: AtomPattern[];
  };
}
```

### 4.3.3 Atom Patterns and Variables

Exchange rules may use **variables** to match and bind atom parameters:

```typescript
type AtomPattern = Atom | AtomVariable;

interface AtomVariable {
  var: string;           // Variable name, e.g., "X"
  type: string;          // Required atom type
  constraints?: {        // Optional constraints
    subject?: DID | { var: string };
    [key: string]: unknown;
  };
}

// A binding environment produced by rule matching.
// Variables may bind to atoms (e.g., a Space atom), DIDs, strings, numbers, etc.
type Bindings = Record<string, unknown>;

// Variables may also appear *inside* atom parameters using `{ var: string }` placeholders,
// which are substituted during instantiation. Example:
// `{ "type": "User", "subject": { "var": "P" } }` means `subject = bindings["P"]`.
```

**Example: Space reader exchange rule**

```json
{
  "name": "SpaceReaderAccess",
  "preCondition": {
    "confidentiality": [
      { "var": "S", "type": "Space" }
    ],
    "integrity": [
      { "type": "HasRole", "principal": { "var": "P" }, "space": { "var": "S" }, "role": "reader" }
    ]
  },
  "postCondition": {
    "confidentiality": [
      { "type": "User", "subject": { "var": "P" } }
    ],
    "integrity": []
  }
}
```

This rule says: if data has `Space(X)` confidentiality and we have `HasRole(P, X, reader)` integrity proof, then principal P may access the data.

### 4.3.4 Variable Binding: Disjunction of All Matches

When a variable pattern matches multiple atoms in a label, the rule produces a **disjunction of all valid bindings**. This is consistent with CNF semantics—each valid binding adds an alternative path to access.

**Example: Multiple spaces**

```typescript
// Rule: Space($X) + HasRole(user, $X, reader) → User(user)

// Label has two spaces:
{ confidentiality: [Space(A), Space(B), User(Owner)] }

// User has roles:
{ integrity: [HasRole(user, A, reader), HasRole(user, B, reader)] }

// Matching: $X can bind to A or B
// Both bindings are valid → both create alternatives
```

**Binding semantics:**

```typescript
function matchRuleWithBindings(
  rule: ExchangeRule,
  label: Label,
  integrity: Atom[]
): Bindings[] {
  // Find ALL valid bindings, not just the first
  const allBindings: Bindings[] = [];

  // For each variable in the rule
  for (const binding of enumerateBindings(rule.preCondition, label, integrity)) {
    if (satisfiesAllConstraints(binding, rule)) {
      allBindings.push(binding);
    }
  }

  return allBindings;  // May be empty, one, or many
}

// Each binding produces an alternative when the rule fires
function applyRuleWithAllBindings(
  label: Label,
  clauseIndex: number,
  rule: ExchangeRule,
  allBindings: Bindings[]
): Label {
  if (allBindings.length === 0) return label;

  const clause = label.confidentiality[clauseIndex];
  const alternatives = Array.isArray(clause) ? clause : [clause];

  // Each valid binding adds an alternative
  const newAlternatives = allBindings.map(bindings =>
    instantiate(rule.postCondition.confidentiality, bindings)
  ).flat();

  return {
    ...label,
    confidentiality: [
      ...label.confidentiality.slice(0, clauseIndex),
      [...alternatives, ...newAlternatives],
      ...label.confidentiality.slice(clauseIndex + 1)
    ]
  };
}
```

**Result for the example:**

```typescript
// Before: [Space(A), Space(B), User(Owner)]

// After rule fires with both bindings:
// [
//   [Space(A), User(user)],  // First binding: $X = A
//   [Space(B), User(user)],  // Second binding: $X = B
//   User(Owner)
// ]

// User can access if they satisfy EITHER Space(A) binding OR Space(B) binding
// (plus User(Owner) clause)
```

**Why disjunction:**

1. **Consistent with CNF**: Multiple paths = multiple alternatives
2. **No arbitrary choice**: Don't need to define which binding "wins"
3. **Preserves security**: More alternatives = more ways to satisfy, which is correct when multiple matching atoms exist

---

## 4.4 Policy Lookup and Evaluation

### 4.4.1 Content-Addressed Policy Storage

Policy records are stored using **content-addressing**. This prevents cache poisoning and policy substitution attacks.

**Storage locations** (for discovery):
- **System policies**: `/.well-known/cfc/policies/{policy-name}` → returns policy hash
- **Space policies**: `{space}/.policies/{policy-name}` → returns policy hash
- **User policies**: `{user-space}/.policies/{policy-name}` → returns policy hash

**Actual policy content** is stored by hash:
- `/.well-known/cfc/policy-content/{hash}` → policy record

Policy records are themselves labeled with integrity atoms identifying who may define them.

### 4.4.2 Policy References in Labels

Policy principals in labels **must include the content hash**:

```typescript
// Policy principal with required hash (see PolicyRefAtom in Section 4.1.2)
type PolicyAtom = PolicyRefAtom;

// Example in a label
{
  confidentiality: [
    { type: "User", subject: "did:key:alice" },
    {
      type: "Policy",
      name: "GoogleAuth",
      subject: "did:key:alice",
      hash: "sha256:a1b2c3d4..."  // Binds to specific policy version
    }
  ]
}
```

**When is the hash bound?** At label creation time. When data is first labeled (e.g., API response arrives, user creates data), the runtime:
1. Looks up the current policy hash via the discovery path
2. Attaches that hash to the policy atom in the label
3. The hash stays with the data forever (or until explicit migration)

This binding ensures:
- The exact policy version is cryptographically specified
- Cache cannot return a different policy for the same name
- Policy updates require explicit label migration

### 4.4.3 Policy Lookup with Verification

Given a label containing policy principal `P`, lookup proceeds:

1. Extract policy name, subject, and **hash** from `P`
2. Fetch policy record by hash from content store
3. **Verify** that `hash(retrieved) == P.hash`
4. Return policy record or error if verification fails

```typescript
function lookupPolicy(atom: PolicyAtom): PolicyRecord | undefined {
  if (atom.type === "Context" || atom.type === "Policy") {
    // Fetch by content hash
    const record = contentStore.get(atom.hash);

    if (!record) {
      // Policy not found - try discovery and fetch
      const subjectSpace = resolveSubjectSpace(atom.subject);
      const discoveredHash = storage.get(`${subjectSpace}/.policies/${atom.name}`);

      if (discoveredHash !== atom.hash) {
        // Hash mismatch - policy was updated but label wasn't migrated
        throw new PolicyVersionMismatchError(atom.name, atom.hash, discoveredHash);
      }

      return contentStore.get(discoveredHash);
    }

    // Verify hash matches (defense in depth)
    if (computeHash(record) !== atom.hash) {
      throw new PolicyIntegrityError(atom.name, atom.hash);
    }

    return record;
  }
  return undefined;
}
```

### 4.4.4 Policy Version Migration

When a policy is updated, existing labels referencing the old hash remain valid for the old version. Migration requires:

1. Create new policy record with updated rules
2. Store new record (new hash)
3. Update discovery pointer to new hash
4. Migrate labels: replace old `hash` with new `hash`

Labels with old hashes continue to use the old policy until explicitly migrated. This provides:
- **Stability**: Existing data behavior doesn't change unexpectedly
- **Auditability**: Clear record of which policy version applied when
- **Rollback safety**: Old policy remains available if migration fails

### 4.4.5 Exchange Rule Evaluation

Exchange rules typically **add alternatives** to existing clauses rather than replacing them. This creates the disjunctive structure in CNF labels (see [§3.1.3](./03-core-concepts.md#313-exchange-rules-add-alternatives)).

Some policies also use exchange rules to **remove** a confidentiality requirement (e.g., dropping an `Expires(...)` clause on derived, policy-approved metadata). In this spec, that is represented by an exchange rule whose instantiated `postCondition.confidentiality` is empty when applied to the target clause.

```typescript
function substituteVars(value: unknown, bindings: Bindings): unknown {
  if (Array.isArray(value)) return value.map(v => substituteVars(v, bindings));
  if (value && typeof value === "object") {
    // Placeholder form: { var: "X" }
    if ("var" in value && Object.keys(value).length === 1) {
      return bindings[(value as any).var as string];
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = substituteVars(v, bindings);
    return out;
  }
  return value;
}

function instantiate(patterns: AtomPattern[], bindings: Bindings): Atom[] {
  // Replace `{ var: "X" }` placeholders with `bindings["X"]` recursively.
  // Postconditions MUST NOT contain AtomVariable entries.
  return patterns.map(p => {
    if (p && typeof p === "object" && "var" in p && "type" in p) {
      throw new Error("AtomVariable not allowed in postCondition");
    }
    return substituteVars(p, bindings) as Atom;
  });
}
```

```typescript
function applyExchangeRule(
  label: Label,
  targetClauseIndex: number,
  targetAlternativeIndex: number,
  rule: ExchangeRule,
  bindings: Bindings
): Label {
  const clause = label.confidentiality[targetClauseIndex];
  const alternatives = Array.isArray(clause) ? clause : [clause];

  const newConfidentiality = instantiate(rule.postCondition.confidentiality, bindings);
  const newIntegrity = instantiate(rule.postCondition.integrity, bindings);
  const addedIntegrity = newIntegrity.filter(a => !label.integrity.some(b => atomEquals(a, b)));

  // Empty confidentiality postcondition means: drop the matched alternative.
  if (newConfidentiality.length === 0) {
    const remainingAlternatives = alternatives.filter((_, i) => i !== targetAlternativeIndex);
    return {
      ...label,
      confidentiality: remainingAlternatives.length === 0
        ? [
            ...label.confidentiality.slice(0, targetClauseIndex),
            ...label.confidentiality.slice(targetClauseIndex + 1)
          ]
        : [
            ...label.confidentiality.slice(0, targetClauseIndex),
            (remainingAlternatives.length === 1 ? remainingAlternatives[0] : remainingAlternatives),
            ...label.confidentiality.slice(targetClauseIndex + 1)
          ],
      integrity: [...label.integrity, ...addedIntegrity]
    };
  }

  const addedConfidentiality = newConfidentiality.filter(a => !alternatives.some(b => atomEquals(a, b)));
  if (addedConfidentiality.length === 0 && addedIntegrity.length === 0) return label;

  return {
    ...label,
    confidentiality: [
      ...label.confidentiality.slice(0, targetClauseIndex),
      [...alternatives, ...addedConfidentiality],  // Add alternatives, don't replace
      ...label.confidentiality.slice(targetClauseIndex + 1)
    ],
    integrity: [...label.integrity, ...addedIntegrity]
  };
}
```

At a trusted boundary (e.g., before display, before network egress), the system evaluates which exchange rules can fire:

```typescript
function evaluateExchangeRules(
  label: Label,
  boundaryIntegrity: Atom[]
): Label {
  let result = label;

  // Policy principals present in the label determine which rule sets are in scope.
  // Rules are matched against the FULL label, but applied to the clause containing
  // the rule's target confidentiality match (typically the first preCondition.confidentiality pattern).
  const policiesInScope = collectPolicyPrincipals(result.confidentiality)
    .map(lookupPolicy)
    .filter(Boolean) as PolicyRecord[];

  // Evaluate to a fixpoint: keep applying rules until no additional alternatives/removals apply.
  let changed = true;
  while (changed) {
    changed = false;
    const integrityInScope = [...result.integrity, ...boundaryIntegrity];

    for (const policy of policiesInScope) {
      for (const rule of policy.exchangeRules) {
        // IMPORTANT: `matchRuleWithTargetClause` returns *indices* into the label CNF.
        // If `applyExchangeRule` removes an alternative/clause (the "drop" case),
        // then later indices can shift and become stale.
        //
        // Correct implementations MUST either:
        //   (A) re-run matching after each successful application, or
        //   (B) apply drop-matches from the "back" (descending clause/alternative indices).
        //
        // We do both here: for drop rules we order matches from the back, and after any
        // successful application we restart matching so indices always refer to the current label.
        let applied = true;
        while (applied) {
          applied = false;

          // Recompute available integrity based on the *current* label.
          const integrityInScope = [...result.integrity, ...boundaryIntegrity];
          const matches = matchRuleWithTargetClause(rule.preCondition, result, integrityInScope);

          const ordered = (rule.postCondition.confidentiality.length === 0)
            ? [...matches].sort((a, b) =>
                (b.targetClauseIndex - a.targetClauseIndex) ||
                (b.targetAlternativeIndex - a.targetAlternativeIndex)
              )
            : matches;

          for (const match of ordered) {
            const next = applyExchangeRule(
              result,
              match.targetClauseIndex,
              match.targetAlternativeIndex,
              rule,
              match.bindings
            );
            if (next !== result) {
              result = next;
              changed = true;
              applied = true;
              break; // Restart matching: indices may have shifted.
            }
          }
        }
      }
    }
  }

  return result;
}
```

Helper function semantics referenced above (informative):

- `collectPolicyPrincipals(confidentiality)` returns the **unique** set of policy principals (`PolicyRefAtom` with `type: "Policy" | "Context"`) that appear anywhere in the label's confidentiality clauses/alternatives.
- `matchRuleWithTargetClause(preCondition, label, availableIntegrity)` returns **all** matches of an exchange rule's precondition:
  - The first `preCondition.confidentiality` pattern is the **target pattern** and determines `(targetClauseIndex, targetAlternativeIndex)` (the clause/alternative that will be rewritten).
  - The remaining confidentiality patterns must also match somewhere in `label.confidentiality`.
  - All integrity patterns must match against `availableIntegrity` (which, in `evaluateExchangeRules`, already includes `label.integrity` plus boundary-minted facts).
  - Each successful unification yields one binding environment `bindings`, producing one rule application (and therefore one disjunctive alternative path).

Implementations SHOULD evaluate exchange rules to a **fixpoint** (repeat until no additional alternatives/removals apply). Since each application either adds a previously absent alternative or removes a previously present alternative/clause (and implementations de-duplicate), fixpoint evaluation terminates.

**Multiple rules can fire on the same clause**, creating multiple alternatives:

```typescript
// Before: [User(Alice), GoogleAuth(Alice)]
// After two rules fire on GoogleAuth(Alice) clause:
// [User(Alice), [GoogleAuth(Alice), UserResource(Alice), DisplayableToUser(Alice)]]
```

**Access check** after exchange rules: a principal can access if they satisfy at least one alternative in every clause:

```typescript
function canAccess(principal: Principal, label: Label): boolean {
  return label.confidentiality.every(clause => {
    const alternatives = Array.isArray(clause) ? clause : [clause];
    return alternatives.some(atom => principal.satisfies(atom));
  });
}
```

`Principal` in this access check is an **access context** (what principals/capabilities are present, plus the current time). A minimal model:

```typescript
type Principal = {
  now: number;
  principals: Atom[];  // e.g., [{ type: "User", subject: actingUser }]
  satisfies: (atom: Atom) => boolean;
};

function makePrincipal(now: number, principals: Atom[]): Principal {
  return {
    now,
    principals,
    satisfies(atom: Atom): boolean {
      if (atom.type === "Expires") return now <= atom.timestamp;
      if (atom.type === "TTL") return false; // TTL is schema-time only
      return principals.some(p => atomEquals(p, atom));
    }
  };
}
```

---

## 4.5 Instance-Bound Integrity

Unlike confidentiality atoms (which describe *classes* of data), integrity atoms are *instance-bound*—they describe the provenance of **specific values**.

### 4.5.1 Integrity Scope Binding

An integrity atom is bound to a specific value or value set:

```typescript
interface IntegrityAtom {
  type: string;                    // e.g., "GPSMeasurement", "AuthoredBy"

  // What this integrity applies to
  scope: {
    valueDigest: string;           // H(canonicalize(value))
    // OR
    valueRef?: CellReference;      // Reference to source cell/path
  };

  // Provenance
  source: DID;                     // Device, author, service
  timestamp?: number;
  evidence?: unknown;              // Additional justification
}
```

**Example: GPS Measurement**

```json
{
  "type": "GPSMeasurement",
  "scope": {
    "valueDigest": "blake3:abc123..."
  },
  "source": "did:device:gps-sensor-456",
  "timestamp": 1703275200,
  "evidence": {
    "accuracy": 5.0,
    "satellites": 8
  }
}
```

This integrity atom asserts: "The value with digest `abc123...` is a valid GPS measurement from device `gps-sensor-456`."

### 4.5.2 Integrity vs Confidentiality Propagation

Confidentiality and integrity propagate differently through computations:

| Operation | Confidentiality | Integrity |
|-----------|-----------------|-----------|
| **Read field** | Inherited from parent | May be preserved if pure projection |
| **Combine values** | Join (concatenate clauses) | Meet (intersection = weaker) or invalidated |
| **Transform** | Inherited | Original destroyed, new transformation integrity added |
| **Copy** | Inherited | Preserved (same value) |

### 4.5.3 Projection Semantics

Extracting a field from a structured value:

```typescript
const measurement = { lat: 37.77, long: -122.41 };
// Integrity: GPSMeasurement(scope=H(measurement), device=...)

const lat = measurement.lat;
// Integrity: GPSMeasurement(scope=H(measurement), device=...).projection("/lat")
```

The projection retains a *scoped* version of the integrity—it's valid as a component of the original measurement, but not as a standalone GPS coordinate.

### 4.5.4 Combination Semantics

Combining values from different sources:

```typescript
const m1 = { lat: 37.77, long: -122.41 };  // GPSMeasurement(H(m1), device1)
const m2 = { lat: 40.71, long: -74.00 };   // GPSMeasurement(H(m2), device2)

const combined = { lat: m1.lat, long: m2.long };
// NOT a valid GPSMeasurement
// Integrity: DerivedFrom({
//   sources: [H(m1), H(m2)],
//   operation: "field-combination",
//   codeHash: H(combiner)
// })
```

The combined value has **derived integrity** that records its provenance but does not claim to be a valid GPS measurement.

### 4.5.5 Semantic vs Structural Integrity

Some integrity types are **structural** (bound to exact bits):
- `Signature(H(value), signer)` - invalid if any bit changes
- `GPSMeasurement(H(value), device)` - invalid if recombined

Other integrity types are **semantic** (survive some transformations):
- `AuthoredBy(sender, messageId)` - survives reformatting
- `ExtractedFrom(source, extractor)` - survives projection

The type of integrity determines how it propagates through the reactive graph.

---

## 4.6 Integration with Reactive System

### 4.6.1 Label Propagation Through Cells

When a `computed()` or `lift()` node executes:

1. Collect labels from all input cells
2. Join confidentiality clauses (concatenation—all clauses must be satisfied)
3. Meet integrity atoms (intersection, representing weaker combined claims)
4. Attach resulting label to output

```typescript
function propagateLabels(inputs: Cell[], output: Cell): void {
  // Confidentiality: concatenate all clauses (CNF join)
  const joinedConfidentiality: Clause[] = [];

  // Integrity: intersection (atoms present in all inputs)
  let metIntegrity: Atom[] | null = null;

  for (const input of inputs) {
    const label = input.getLabel();

    // Join confidentiality (concatenate clauses)
    joinedConfidentiality.push(...label.confidentiality);

    // Meet integrity (intersection)
    if (metIntegrity === null) {
      metIntegrity = [...label.integrity];
    } else {
      metIntegrity = metIntegrity.filter(a =>
        label.integrity.some(b => atomEquals(a, b))
      );
    }
  }

  output.setLabel({
    confidentiality: joinedConfidentiality,
    integrity: metIntegrity ?? []
  });
}
```

### 4.6.2 Endorsement in Handlers

When a handler executes (user interaction):

1. Handler code is identified by hash
2. UI context provides gesture provenance
3. These become integrity atoms on the output

```typescript
function endorseHandlerOutput(
  output: unknown,
  handlerHash: string,
  uiContext: UIContext
): Label {
  return {
    confidentiality: [],  // Inherited from inputs
    integrity: [
      { type: "CodeHash", hash: handlerHash },
      { type: "EndorsedBy", endorser: uiContext.user, action: uiContext.action },
      { type: "GestureProvenance", snapshot: uiContext.snapshotDigest }
    ]
  };
}
```

### 4.6.3 Schema Path Labels

Labels can apply to specific paths within a document:

```typescript
interface PathLabel {
  path: string[];  // JSON Pointer components
  label: Label;
}

interface DocumentLabels {
  // Label for the document root
  root: Label;

  // Additional labels for specific paths (more restrictive)
  paths: PathLabel[];
}
```

When reading a path, the effective label is:
- Root label joined with any path-specific labels that are prefixes of the read path

This enables fine-grained labeling like:
- Document has `User(Alice)` confidentiality
- Path `/ssn` additionally has `Resource("SSN", Alice)` confidentiality

---

## 4.7 Backward Compatibility

### 4.7.1 Simple Classification Strings

The existing `classification` field maps to parameterized atoms:

```typescript
function classificationToAtoms(
  classification: string[],
  defaultSubject: DID
): Atom[] {
  return classification.map(c => ({
    type: "Resource",
    class: c,
    subject: defaultSubject
  }));
}
```

So `{ classification: ["confidential"] }` becomes:
```json
{ "confidentiality": [{ "type": "Resource", "class": "confidential", "subject": "..." }] }
```

### 4.7.2 Hardcoded Lattice

The existing 4-level lattice (`unclassified → confidential → secret → topsecret`) is modeled as a system policy with exchange rules:

```json
{
  "id": "system-classification-lattice",
  "exchangeRules": [
    {
      "name": "SecretToConfidential",
      "preCondition": {
        "confidentiality": [{ "type": "Resource", "class": "secret" }],
        "integrity": [{ "type": "CodeHash", "hash": "*" }]
      },
      "postCondition": {
        "confidentiality": [{ "type": "Resource", "class": "confidential" }]
      }
    }
  ]
}
```

This allows the simple classification hierarchy to coexist with the full parameterized model.

---

## 4.8 Trust Delegation and Conceptual Binding

### 4.8.1 Conceptual vs Concrete Principals

Many principals in CFC are **conceptual**—they represent abstract ideas or requirements rather than concrete implementations. The act of binding a concept to a concrete principal (like a code hash) is a **trust statement**.

**Example concepts** (represented as URIs):
```
https://commonfabric.org/concepts/age-rounding
https://commonfabric.org/concepts/prompt-injection-free
https://commonfabric.org/concepts/enterprise-grade-tos
```

These concepts have open-ended semantics not formally captured in the system. What matters is that all entities can agree which semantics they're referring to in their policies.

### 4.8.2 Trust Statements

A **trust statement** asserts that a concrete principal correctly implements a concept:

```typescript
interface TrustStatement {
  // The concrete principal (e.g., a code hash)
  concrete: Atom;

  // The concept it implements
  implements: { type: "Concept"; uri: string };

  // Who makes this claim
  verifier: { type: "Verifier"; subject: DID };

  // Scope limitations (optional)
  scope?: {
    validUntil?: number;
    conditions?: string[];  // Human-readable conditions
  };

  // Cryptographic signature
  signature: string;
}
```

**Example**: A security auditor asserts that a specific code hash implements age rounding correctly:

```json
{
  "concrete": { "type": "CodeHash", "hash": "sha256:abc123..." },
  "implements": { "type": "Concept", "uri": "https://commonfabric.org/concepts/age-rounding" },
  "verifier": { "type": "Verifier", "subject": "did:key:auditor-firm" },
  "scope": { "validUntil": 1735689600 },
  "signature": "..."
}
```

### 4.8.3 Verifier Delegation

Users delegate trust to **verifiers** (trusted reviewers) who make trust statements on their behalf:

```typescript
interface VerifierDelegation {
  // The user delegating trust
  delegator: DID;

  // The verifier being trusted
  verifier: { type: "Verifier"; subject: DID };

  // What concepts this verifier is trusted for
  scope: {
    concepts?: string[];     // Specific concept URIs, or "*" for all
    maxConfidentiality?: Atom[];  // Upper bound on what this verifier can authorize
  };

  signature: string;
}
```

This creates a trust chain: User → Verifier → Trust Statement → Concrete Principal.

### 4.8.4 Lattice Relationships via Trust

Trust statements create **lattice relationships** between principals. When a user trusts verifier V, and V asserts that `CodeHash(H)` implements `Concept(C)`, then for that user:

- `CodeHash(H)` can satisfy requirements for `Concept(C)`
- Data requiring `Concept(C)` integrity can accept `CodeHash(H)` integrity

This is NOT a global lattice ordering—it's user-specific based on their trust delegations.

### 4.8.5 Multiple Declassification Paths

A key feature of conceptual principals is enabling **multiple valid declassification paths** to coexist:

```
High-precision location
    ├── [city-rounding module] → City-level location
    │       (implements: location-rounding)
    │
    └── [grid-snapping module] → Grid-cell location
            (implements: location-rounding)
```

Both modules implement the same concept (`location-rounding`), so both are valid declassification paths. A user might trust different verifiers for each, allowing either path.

**Note**: This creates a potential information leakage problem when outputs from multiple declassification paths are recombined (see [§10](./10-safety-invariants.md#10-safety-invariants), Open Problems).

### 4.8.6 Ecosystem Coordination

To maximize interoperability:

1. **Public concept directory**: A community-maintained directory of agreed-upon concepts at well-known URIs
2. **Schelling points**: The more entities use a concept, the more valuable it becomes for coordination
3. **Verifier reputation**: Verifiers build reputation by making accurate trust statements

The specification does not mandate specific concepts—it provides the infrastructure for concepts to emerge through ecosystem coordination.

### 4.8.7 Runtime Environment Trust

Runtime environment principals follow the same pattern:

- **Concept**: "Confidential compute environment"
- **Concrete**: `Attestation(sgx, quote=..., runtimeHash=...)`
- **Trust statement**: Cloud provider or auditor asserts the attestation meets confidential compute requirements

Different users may trust different attestation types or providers:

```json
{
  "concrete": {
    "type": "Attestation",
    "attester": "did:azure:confidential-compute",
    "evidence": { "type": "sev", "quote": "..." }
  },
  "implements": {
    "type": "Concept",
    "uri": "https://commonfabric.org/concepts/confidential-compute"
  },
  "verifier": { "type": "Verifier", "subject": "did:key:cloud-auditor" }
}
```

### 4.8.8 Client Attestation and Per-User Trust

**Attested clients** present a special case: they may be less trusted by *other* users but fully trusted by their owner for user-specific data.

```typescript
// Client attestation: less trusted by others
{
  type: "Runtime",
  environment: { kind: "local", deviceId: "did:device:alice-phone" }
}

// Policy: Alice's personal data can flow to Alice's devices
// But Bob's data cannot flow to Alice's devices without Bob's consent
```

This enables scenarios where:
- User-specific data (preferences, drafts) flows to the user's own devices
- Multi-user data requires stronger runtime guarantees (server or confidential compute)

---

## 4.9 Current User and Acting Principal

### 4.9.1 Acting User Context

At runtime, operations execute on behalf of an **acting user**. This is the authenticated principal making the request.

```typescript
interface ActingContext {
  // The authenticated user
  actingUser: DID;

  // Session information
  session: {
    authenticatedAt: number;
    expiresAt: number;
    authMethod: "passkey" | "oauth" | "delegation";
  };

  // Ambient integrity from authentication
  ambientIntegrity: Atom[];
}
```

### 4.9.2 Current User Variable

Labels and exchange rules can reference the **current user** using a variable:

```json
{
  "confidentiality": [
    { "type": "User", "subject": { "var": "$actingUser" } }
  ]
}
```

At runtime, `$actingUser` is substituted with the actual DID from the acting context.

### 4.9.3 HasRole Fact Generation

When evaluating exchange rules, the runtime generates `HasRole` integrity facts for the acting user:

```typescript
function generateRoleFacts(actingUser: DID, space: SpaceID): Atom[] {
  const membership = lookupMembership(space, actingUser);
  if (!membership) return [];

  return [{
    type: "HasRole",
    principal: actingUser,
    space: space,
    role: membership.role  // "owner" | "writer" | "reader"
  }];
}
```

These facts are minted by the trusted runtime based on verified space membership, NOT claimed by patterns or user code.

### 4.9.4 Per-User Content in Shared Spaces

For user-specific content within a shared space (e.g., personal notes in a team workspace):

**Pattern**: Link from personal space to shared space

1. User's private data lives in `PersonalSpace(User)`
2. A reference/link exists in the shared `Space(Team)`
3. Dereferencing requires both authorizations:
   - `HasRole(user, Team, reader)` - can see the link
   - `HasRole(user, PersonalSpace(User), reader)` - can read the content

Only the owning user satisfies both conditions.

---

## 4.10 Theoretical Note: CNF Representation

The exchange rules and policy structure can theoretically be represented in **Conjunctive Normal Form (CNF)** over the principal lattice:

```
G = (C₁ ∧ R₁) ∨ (D₁ → G₂) ∨ ...
```

Where:
- `Cᵢ` are capability requirements
- `Rᵢ` are runtime requirements
- `Dᵢ → Gⱼ` represents declassification paths to other guardrails

This representation could be useful for:
- Formal proofs of policy properties
- Optimization (collapsing redundant terms)
- Automated policy analysis

However, for implementation clarity, the specification keeps exchange rules as separate, declarative records rather than a single CNF expression. The semantics are equivalent, but separate rules are easier to author, audit, and debug.
