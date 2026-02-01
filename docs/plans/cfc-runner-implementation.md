# CFC Implementation Plan: Tier 2 Dynamic Enforcement in Runner

This plan applies the CFC spec (`docs/specs/cfc/`) to the runner package
(`packages/runner/`). The goal is Tier 2: parameterized labels with dynamic
checking that fails on violation. The trust lattice is hardcoded but structured
for later configuration.

## Context

**What exists today:**
- `cfc.ts` — flat 4-level classification lattice, LUB computation over schemas
- `scheduler.ts` — `ReactivityLog` tracks reads/writes/potentialWrites per action
- `storage/interface.ts` — `StorageValue.labels` with `{ classification?: string[] }`
- `traverse.ts` — `SchemaObjectTraverser` calls `cfc.lubSchema()` during reads
- `cell.ts` — write operations (`push`, `remove`, `set`) cause internal reads
  tracked via `markReadAsPotentialWrite`
- `sample()` uses non-reactive transactions (covert channel for IFC)

**What's missing:**
- Parameterized atoms (User, Space, Resource, Service, etc.)
- CNF confidentiality labels and conjunctive integrity labels
- Per-action taint accumulation during execution
- Write-time label checks (fail on violation)
- Exchange rules / declassification policies
- Space policy cells
- Principal context per action execution

---

## Phase 1: Label Algebra

Build the core label representation and operations independent of the runner.
This is pure data structures and algorithms with no runtime integration yet.

### 1.1 Atom Representation

- [x] Define `Atom` type as discriminated union with canonical serialization
  ```
  Confidentiality atoms: User(did), Space(id), Resource(class, subject),
    Service(id), Classification(level), Expires(timestamp),
    PolicyPrincipal(hash)
  Integrity atoms: CodeHash(hash), AuthoredBy(did), EndorsedBy(did),
    HasRole(principal, space, role)
  ```
- [x] Implement `canonicalizeAtom(atom: Atom): string` for equality comparison
  (deterministic JSON with sorted keys)
- [x] Implement `atomEquals(a: Atom, b: Atom): boolean` via canonical form
- [x] Add atom constructors: `userAtom(did)`, `spaceAtom(id)`, etc.

**File:** new `packages/runner/src/cfc/atoms.ts`

### 1.2 CNF Confidentiality Labels

- [x] Define `ConfidentialityLabel` as array of clauses, each clause an array
  of atom alternatives: `Atom[][]` (outer = AND, inner = OR)
- [x] Implement `joinConfidentiality(a, b)` — concatenate clauses (union of
  constraints)
- [x] Implement `meetConfidentiality(a, b)` — clause-wise intersection
- [x] Implement `confidentialityLeq(a, b)` — a ≤ b iff every clause in a is
  satisfied when every clause in b is satisfied (for each clause in a, there
  exists a clause in b that is a subset)
- [x] Implement `emptyConfidentiality()` — bottom element (no restrictions)
- [x] Normalize clauses: deduplicate atoms within clauses, sort clauses
  canonically, remove subsumed clauses

**File:** new `packages/runner/src/cfc/confidentiality.ts`

### 1.3 Integrity Labels

- [x] Define `IntegrityLabel` as a set of atoms (conjunction): `Set<Atom>` by
  canonical string
- [x] Implement `joinIntegrity(a, b)` — intersection (weaker claims)
- [x] Implement `meetIntegrity(a, b)` — union (stronger claims)
- [x] Implement `integrityLeq(a, b)` — a ≤ b iff a ⊇ b (more endorsements =
  higher integrity)
- [x] Implement `emptyIntegrity()` — top element (no endorsements required)

**File:** new `packages/runner/src/cfc/integrity.ts`

### 1.4 Composite Labels

- [x] Define `Label = { confidentiality: ConfidentialityLabel, integrity: IntegrityLabel }`
- [x] Implement `joinLabel(a, b)` — join both components
- [x] Implement `labelLeq(a, b)` — both components ≤
- [x] Implement `emptyLabel()` — bottom confidentiality, top integrity
- [x] Implement `labelFromSchema(schema, rootSchema, cfc)` — bridge from
  existing `ifc.classification` annotations to new `Label` type. Maps flat
  strings through the existing classification lattice, then wraps as
  `Classification(level)` atoms.

**File:** new `packages/runner/src/cfc/labels.ts`

### 1.5 Tests for Label Algebra

- [x] Unit tests for atom canonicalization and equality
- [x] Unit tests for CNF join, meet, leq (including edge cases: empty labels,
  single clause, overlapping alternatives)
- [x] Unit tests for integrity join/meet/leq
- [x] Unit tests for composite label operations
- [x] Property: `join(a, b) >= a` and `join(a, b) >= b`
- [x] Property: `leq(a, join(a, b))` always true
- [x] Backwards compatibility: flat classification strings round-trip through
  `labelFromSchema`

**File:** new `packages/runner/src/cfc/__tests__/labels.test.ts`

---

## Phase 2: Trust Lattice and Policies

### 2.1 Trust Lattice

- [x] Define `TrustLattice` class that owns the atom kind relationships
- [x] Hardcode the classification sub-lattice (existing 4-level:
  unclassified < confidential < secret < topsecret)
- [x] Hardcode atom kind rules:
  - `Classification` atoms ordered by the sub-lattice
  - `User(a)` and `User(b)` are incomparable unless a = b
  - `Space(x)` and `Space(y)` are incomparable unless x = y
  - Conjunction of atoms is higher than each individual atom
- [x] Expose `compare(a: Label, b: Label): "above" | "below" | "equal" | "incomparable"`
- [x] Accept optional configuration in constructor (for future user-defined
  lattices), but default to hardcoded values
- [x] Migrate existing `classificationLattice` from `cfc.ts` into `TrustLattice`
  as one sub-component

**File:** new `packages/runner/src/cfc/trust-lattice.ts`

### 2.2 Exchange Rules

- [x] Define `ExchangeRule` type:
  ```
  { precondition: { confidentiality: AtomPattern[], integrity: AtomPattern[] },
    postcondition: { addAlternatives: AtomPattern[] },
    variables: string[] }
  ```
- [x] Implement `AtomPattern` — atom template with variable bindings
  (e.g., `User($principal)` where `$principal` binds to any DID)
- [x] Implement `matchPrecondition(label, rule)` — returns all valid variable
  bindings
- [x] Implement `applyRule(label, rule, bindings)` — add alternatives per
  postcondition
- [x] Implement `evaluateRules(label, rules)` — fixpoint iteration: apply all
  matching rules until no label change, with cycle detection (max iterations)

**File:** new `packages/runner/src/cfc/exchange-rules.ts`

### 2.3 Policy Records

- [x] Define `PolicyRecord` type:
  ```
  { id: string (content hash),
    exchangeRules: ExchangeRule[],
    spaceRoles: Map<DID, Role[]>,
    version: number }
  ```
- [x] Implement `hashPolicy(policy)` — deterministic content-addressed ID
- [x] Define well-known schema for space policy cells
- [x] Implement `loadPolicyFromCell(cell)` — deserialize policy from a cell value
- [x] Hardcode a default policy record that encodes the existing 4-level
  classification behavior (backwards compatible)

**File:** new `packages/runner/src/cfc/policy.ts`

### 2.4 Space Policy Cells

- [x] Define well-known address for policy cell within a space
  (e.g., `{space, id: "cfc:policy", path: []}`)
- [x] In `Runtime` or `Runner`, when a space is opened, load its policy cell
- [x] Subscribe to policy cell changes (reactive policy updates)
- [x] Cache resolved policy per space on the CFC instance
- [x] Fallback to default policy when no policy cell exists

**File:** modifications to `packages/runner/src/runtime.ts` and new
`packages/runner/src/cfc/space-policy.ts`

### 2.5 Tests for Trust Lattice and Policies

- [x] Unit tests for trust lattice comparison operations
- [x] Unit tests for exchange rule matching and application
- [x] Unit tests for fixpoint evaluation (including convergence)
- [x] Test: default policy produces same results as current flat classification
- [x] Test: space policy cell load/subscribe/update cycle
- [x] Test: exchange rule with variable bindings across User/Space atoms

**File:** new `packages/runner/src/cfc/__tests__/policy.test.ts`

---

## Phase 3: Action Context and Taint Tracking

Wire the label algebra into the scheduler's action execution.

### 3.1 Action Taint Context

- [x] Define `ActionTaintContext`:
  ```
  { principal: Label,           // who is executing (User + Space)
    clearance: Label,           // max label this action may read
    accumulatedTaint: Label,    // join of all read labels so far
    policy: PolicyRecord,       // active policy for this space
    integrityBasis: IntegrityLabel }  // code hash + endorsements
  ```
- [x] Create taint context at action start in `Scheduler.execute()`:
  - Principal from `runtime.userIdentityDID` → `User(did)` atom
  - Space from action's target cell → `Space(id)` atom
  - Clearance = principal label (user can read their own data)
  - IntegrityBasis = `CodeHash(recipeHash)` for the running recipe
- [x] Store taint context on the action or frame, accessible during execution
- [x] At action end, the accumulated taint is the label for implicit outputs

**File:** new `packages/runner/src/cfc/action-context.ts`, modifications to
`packages/runner/src/scheduler.ts`

### 3.2 Read-Time Taint Accumulation

- [x] In `validateAndTransform` (`schema.ts`), after computing the label at the
  read path via `cfc.lubSchema()` / `cfc.schemaAtPath()`:
  - Convert the classification string to a `Label` via `labelFromSchema()`
  - Join it into the action's `accumulatedTaint`
- [x] In `SchemaObjectTraverser.traverse()` (`traverse.ts`), same: accumulate
  label from schema + path into taint context
- [x] For reads marked `markReadAsPotentialWrite` (in `diffAndUpdate`), also
  accumulate taint — these are reads that happen during writes
- [x] For stored labels: if labels exist at the `label/` path on the document,
  join those into taint as well (runtime labels override/augment schema-derived
  labels). Labels are stored at the `label/` path prefix on the same document,
  analogous to `value/` and `source/` — no separate facet/fact needed.
  - [x] **3.2a** Add `readLabelOrUndefined(address)` on
    `ExtendedStorageTransaction` — reads `{ ...address, path: ["label"] }`
    via the existing `read()` path and returns `Labels | undefined`
  - [x] **3.2b** In `readValueOrThrow` callers (schema.ts / traverse.ts),
    after reading the value, also call `readLabelOrUndefined()` for the same
    address. If labels are present, call
    `recordTaintedRead(tx, labelFromStoredLabels(labels))` to join stored
    labels into the action's taint
  - [x] **3.2c** Add `labelFromStoredLabels(labels: Labels): Label` in
    `labels.ts` — converts stored `Labels` (classification strings +
    parameterized atoms) into a composite `Label` for taint accumulation
- [x] Thread `ActionTaintContext` through the transaction or make it available
  via the runtime/frame stack

**File:** modifications to `packages/runner/src/schema.ts`,
`packages/runner/src/traverse.ts`, `packages/runner/src/data-updating.ts`

### 3.3 Write-Time Label Check

- [x] In `CellImpl.set()` and all write paths (`push`, `remove`, `update`),
  before committing:
  - Compute the label at the write target path
  - Check: `accumulatedTaint ≤ writeTargetLabel` (no write-down)
  - If violated: **throw an error** and abort the transaction
- [x] In `diffAndUpdate`, after computing the changeset but before
  `applyChangeSet`: run the label check for each changed path
- [x] For exchange rules: before the write check, attempt to apply matching
  exchange rules from the active policy. If rules declassify the taint
  sufficiently, the write is allowed.
- [x] Log violations with: action identity, read label, write label, paths
  involved

**File:** modifications to `packages/runner/src/cell.ts`,
`packages/runner/src/data-updating.ts`

### 3.4 Handle `sample()` as Taint Source

- [x] `sample()` currently uses `createNonReactiveTransaction` which hides
  reads from the scheduler
- [x] For IFC: `sample()` must still accumulate taint even though it doesn't
  create reactive dependencies
- [x] Option A: make `sample()` use the action's taint context directly
  (separate from reactivity tracking)
- [ ] Option B: prohibit `sample()` during taint-tracked actions (breaking
  change)
- [x] Decision: **Option A** — `sample()` accumulates taint but does not
  create reactive subscriptions. The taint context is orthogonal to reactivity.

**File:** modifications to `packages/runner/src/cell.ts`

### 3.5 Tests for Taint Tracking

- [ ] Integration test: recipe reads a secret-labeled cell, writes to an
  unclassified cell → **fails**
- [ ] Integration test: recipe reads a secret-labeled cell, writes to a
  secret-labeled cell → **succeeds**
- [ ] Integration test: recipe reads unclassified, writes to secret → succeeds
  (write-up is fine)
- [ ] Integration test: `cell.push()` on a secret array, pushing unclassified
  data → succeeds (write is to secret target)
- [ ] Integration test: `cell.remove()` on a secret array, result written to
  unclassified cell → fails (internal read of secret array taints action)
- [ ] Integration test: `sample()` of secret cell taints subsequent writes
- [ ] Integration test: exchange rule declassifies taint, write succeeds
- [ ] Integration test: multi-space action — reads from space A (confidential),
  writes to space B (unclassified) → fails unless policy allows
- [ ] Backwards compatibility test: recipes without any `ifc` annotations
  behave exactly as today (empty labels, no restrictions)

**File:** new `packages/runner/src/integration/cfc_enforcement.test.ts`

---

## Phase 4: Schema and Storage Integration

### 4.1 Extend `Labels` Type

- [x] Replace `Labels = { classification?: string[] }` with:
  ```
  Labels = {
    classification?: string[],          // backwards compat
    confidentiality?: Atom[][],         // CNF clauses
    integrity?: Atom[],                 // conjunction
  }
  ```
- [x] Update `StorageValue` interface — no structural change needed, just the
  `Labels` type widens
- [x] Verify storage serialization handles new atom types at the `label/` path
  - [x] **4.1a** Labels stored at the `label/` path are plain JSON objects
    (`Labels` type with `confidentiality: Atom[][]` and `integrity: Atom[]`).
    Since they go through the same `write()`/`read()` path as values, JSON
    round-trip is automatic. Verify discriminated union atoms serialize cleanly.
  - [x] **4.1b** Add `labelFromStoredLabels()` validation: when reading from
    `label/` path, validate atom shapes (guard against corrupted data)
  - [x] **4.1c** Write round-trip test: write labels at `label/` path → read
    back → verify structural equality with original atoms
- [x] Ensure old labels (flat `classification` strings) are read correctly and
  mapped to `Classification(level)` atoms on load

**File:** modifications to `packages/runner/src/storage/interface.ts`,
`packages/runner/src/storage/cache.ts`

### 4.2 Schema `ifc` Extension

- [x] Extend `ifc` annotation on JSON schemas to support parameterized atoms:
  ```
  ifc: {
    classification?: string[],          // existing (backwards compat)
    confidentiality?: Atom[][],         // new: CNF
    integrity?: Atom[],                 // new: conjunction
  }
  ```
- [x] Update `labelFromSchema()` to handle both old and new formats
- [x] Update `ContextualFlowControl.joinSchema()` to collect parameterized
  atoms in addition to flat classification strings (via new `labelForSchema()`)
- [x] Update `ContextualFlowControl.lubSchema()` to compute LUB over
  parameterized atoms using `TrustLattice` (via new `collectParameterizedLabels()`)

**File:** modifications to `packages/runner/src/cfc.ts` (or its replacement
module)

### 4.3 Persist Runtime Labels on Write

- [x] When a cell is written, persist the effective label at the `label/` path.
  Labels live at `label/` on the same document, alongside `value/` and
  `source/`. This uses the existing transaction write infrastructure — no new
  facet types or Provider changes needed.
  - [x] **4.3a** Add `writeLabelOrThrow(address, labels: Labels)` on
    `ExtendedStorageTransaction` — writes
    `{ ...address, path: ["label"] }` via the existing `writeOrThrow()`.
    This is symmetric with `writeValueOrThrow`.
  - [x] **4.3b** In `cell.ts` `set()` / `push()` / `remove()`, after the
    taint write-check passes, compute the effective label:
    `joinLabel(schemaLabel, accumulatedTaint)` — this is the label the
    written data carries. Call `tx.writeLabelOrThrow(address, toLabels(effectiveLabel))`
  - [x] **4.3c** In `data-updating.ts` after `applyChangeSet()`, call
    `tx.writeLabelOrThrow()` with the same computed label. This covers
    the `diffAndUpdate` write path.
  - [x] **4.3d** Add `toLabelStorage(label: Label): Labels` helper in
    `labels.ts` — converts a `Label` (runtime type) to `Labels` (storage
    type with `confidentiality` and `integrity` arrays)
- [x] On read, merge schema-derived labels with stored runtime labels (take
  the join — stored labels can only raise the classification, not lower it)
  - [x] **4.3e** In `recordTaintedRead` callers (schema.ts, traverse.ts),
    compute `joinLabel(schemaLabel, storedLabel)` and use that as the
    effective read label. Stored labels can only raise, never lower.
- [x] This means labels persist across runtime restarts — a cell that received
  secret data keeps its secret label even if the schema doesn't say so

**File:** modifications to `packages/runner/src/cell.ts`,
`packages/runner/src/storage/cache.ts`

### 4.4 Tests for Storage Integration

- [x] Test: write with new-format labels, read back, labels preserved
- [x] Test: old-format `{ classification: ["secret"] }` loads as
  `{ confidentiality: [[Classification("secret")]] }`
- [x] Test: schema label + stored label joined correctly (stored can only raise)
- [ ] Test: label persistence across simulated runtime restart

**File:** new `packages/runner/src/cfc/__tests__/storage.test.ts`

---

## Phase 5: Refactor Existing CFC

Replace the current `cfc.ts` with the new module structure while maintaining
backwards compatibility.

### 5.1 Module Structure

- [x] Create `packages/runner/src/cfc/` directory with:
  ```
  index.ts            — re-exports, ContextualFlowControl class
  atoms.ts            — atom types and canonicalization
  confidentiality.ts  — CNF label operations
  integrity.ts        — integrity label operations
  labels.ts           — composite Label type and operations
  trust-lattice.ts    — TrustLattice class
  exchange-rules.ts   — exchange rule evaluation
  policy.ts           — PolicyRecord type and loading
  space-policy.ts     — space policy cell integration
  action-context.ts   — ActionTaintContext
  ```
- [ ] Move graph algorithms (Tarjan SCC, Kahn topological sort) into
  `trust-lattice.ts` — they serve the lattice, not general use
- [x] `ContextualFlowControl` class becomes a facade over the new modules:
  - Keeps all existing public methods (`lubSchema`, `joinSchema`,
    `schemaAtPath`, `getSchemaAtPath`, `resolveSchemaRefs`, etc.)
  - Adds new methods: `createActionContext()`, `checkWrite()`,
    `accumulateTaint()`
  - Internally delegates to `TrustLattice`, label operations, policy
    evaluation
- [x] Update all imports across the runner package

### 5.2 Backwards Compatibility

- [x] Existing `Classification` constant export unchanged
- [x] Existing `schema.ifc.classification` annotations work unchanged
- [x] `lubSchema()` returns same results for schemas without parameterized atoms
- [x] All existing tests pass without modification
- [x] No changes to builder/recipe authoring API — patterns are unaware of
  enforcement until they hit a violation

### 5.3 Migration Tests

- [x] Run full existing test suite — no regressions
- [x] Existing `cfc.test.ts` tests pass against new module
- [x] Existing integration tests pass (no enforcement triggered for
  unlabeled data)

---

## Phase 6: Principal Context Wiring

### 6.1 Wire Principal into Runtime

- [x] At `Runtime` construction, derive principal label from
  `userIdentityDID`:
  ```
  principal = { confidentiality: [], integrity: [UserAtom(did)] }
  ```
- [x] At action execution start (in `Scheduler`), construct
  `ActionTaintContext` with:
  - `principal` from runtime
  - `space` from the action's target cell's space
  - `clearance` from space policy (role-based)
  - `integrityBasis` from recipe code hash
- [x] Pass action context through to cell reads/writes (via frame, transaction
  metadata, or thread-local-like mechanism on the scheduler)

**File:** modifications to `packages/runner/src/runtime.ts`,
`packages/runner/src/scheduler.ts`

### 6.2 Space-Aware Clearance

- [ ] When opening a space, look up the user's role in that space's policy
- [ ] Compute clearance: `User(self) ∧ Space(current) ∧ HasRole(self, space, role)`
- [ ] Clearance determines the maximum label the user can read from that space
- [x] For now, default policy grants owner full access to their own space
- [ ] Cross-space reads: clearance is the meet of the user's clearance in each
  space (conservative)

### 6.3 Tests for Principal Wiring

- [x] Test: action context created with correct principal from runtime DID
- [ ] Test: space policy grants reader role, clearance computed correctly
- [ ] Test: cross-space read with insufficient clearance → fails
- [ ] Test: owner of space has full clearance

---

## Phase 7: Observability and Error Reporting

### 7.1 Violation Reporting

- [x] Define `CFCViolation` error type with structured fields:
  ```
  { kind: "write-down" | "read-up" | "clearance-exceeded",
    action: string,
    readLabels: Label[],
    writeLabel: Label,
    accumulatedTaint: Label,
    paths: { reads: string[], write: string } }
  ```
- [x] On violation, throw `CFCViolation` — this aborts the transaction
- [x] Log violations via existing `getLogger("cfc")` at error level
- [ ] Emit telemetry event for violations (via `RuntimeTelemetry`)

### 7.2 Debug Mode

- [x] Add `cfc.debug` flag (off by default) that logs every taint accumulation:
  "read path X, label Y, taint now Z"
- [x] Add `cfc.dryRun` flag that logs violations but doesn't fail (for gradual
  rollout)

### 7.3 Tests

- [x] Test: violation error contains correct structured data
- [ ] Test: dry-run mode logs but doesn't throw
- [ ] Test: debug mode produces expected log output

---

## Ordering and Dependencies

```
Phase 1 (Label Algebra)
  │
  ├──→ Phase 2 (Trust Lattice, Policies)
  │       │
  │       └──→ Phase 4 (Schema/Storage Integration)
  │               │
  │               └──→ Phase 5 (Refactor existing cfc.ts)
  │
  └──→ Phase 3 (Action Context, Taint Tracking)
          │
          └──→ Phase 6 (Principal Wiring)
                  │
                  └──→ Phase 7 (Observability)
```

Phases 1→2 and 1→3 can proceed in parallel after Phase 1 completes.
Phase 5 depends on both 2 and 4.
Phase 6 depends on 3.
Phase 7 is last.

---

## Out of Scope (Future Work)

These are described in the spec but deferred from this implementation round:

- [ ] Intent events and single-use semantics (spec sections 6-7)
- [ ] VDOM snapshot digests and gesture provenance (spec section 6)
- [ ] Static analysis / TypeScript transformer integration (spec section 11)
- [ ] Multi-party consent validation (spec section 3.9)
- [ ] Network provenance and `endorse_request` pipeline (spec section 5)
- [ ] User-configurable trust lattices (structural support built, UI deferred)
- [ ] Robust declassification validation (spec invariant 7)
- [ ] Transparent endorsement checks (spec invariant 8)
- [ ] PC (program counter) integrity tracking (spec invariant 9)
