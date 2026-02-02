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
- [x] Decision: **Option A** — `sample()` accumulates taint but does not
  create reactive subscriptions. The taint context is orthogonal to reactivity.

**File:** modifications to `packages/runner/src/cell.ts`

### 3.5 Tests for Taint Tracking

- [x] Integration test: recipe reads a secret-labeled cell, writes to an
  unclassified cell → **fails**
- [x] Integration test: recipe reads a secret-labeled cell, writes to a
  secret-labeled cell → **succeeds**
- [x] Integration test: recipe reads unclassified, writes to secret → succeeds
  (write-up is fine)
- [x] Integration test: `cell.push()` on a secret array, pushing unclassified
  data → succeeds (write is to secret target)
- [x] Integration test: `cell.remove()` on a secret array, result written to
  unclassified cell → fails (internal read of secret array taints action)
- [x] Integration test: `sample()` of secret cell taints subsequent writes
- [x] Integration test: exchange rule declassifies taint, write succeeds
- [x] Integration test: multi-space action — reads from space A (confidential),
  writes to space B (unclassified) → fails unless policy allows
- [x] Backwards compatibility test: recipes without any `ifc` annotations
  behave exactly as today (empty labels, no restrictions)

**File:** `packages/runner/test/cfc-integration.test.ts`

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
- [x] Test: label persistence across simulated runtime restart

**File:** `packages/runner/test/cfc-runtime.test.ts`

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
- [x] Move graph algorithms (Tarjan SCC, Kahn topological sort) into
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

- [x] When opening a space, look up the user's role in that space's policy
- [x] Compute clearance: `User(self) ∧ Space(current) ∧ HasRole(self, space, role)`
- [x] Clearance determines the maximum label the user can read from that space
- [x] For now, default policy grants owner full access to their own space
- [ ] Cross-space reads: clearance is the meet of the user's clearance in each
  space (conservative)

### 6.3 Tests for Principal Wiring

- [x] Test: action context created with correct principal from runtime DID
- [x] Test: space policy grants reader role, clearance computed correctly
- [x] Test: cross-space read with insufficient clearance → fails
- [x] Test: owner of space has full clearance

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
- [x] Emit telemetry event for violations (via `RuntimeTelemetry`)

### 7.2 Debug Mode

- [x] Add `cfc.debug` flag (off by default) that logs every taint accumulation:
  "read path X, label Y, taint now Z"
- [x] Add `cfc.dryRun` flag that logs violations but doesn't fail (for gradual
  rollout)

### 7.3 Tests

- [x] Test: violation error contains correct structured data
- [x] Test: dry-run mode logs but doesn't throw
- [x] Test: debug mode produces expected log output

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

## Phase 8: Path-Level Taint Tracking

The current taint model joins all read labels into a single flat
`accumulatedTaint`. This means reading an object with a secret `token` field
taints the entire action — even if the token only flows into one specific output
field. Path-level tracking preserves *which paths carry which labels* through the
reactive graph, enabling field-level declassification.

**Motivating example (Gmail OAuth):** A recipe reads an auth object with
`{token: "ya29...", email: "alice@..."}`. The token field carries
`Service(google-auth)` taint. The recipe builds a fetch request putting the token
into `headers.Authorization`. With path-level tracking, only that header field
carries the Service taint — the URL and body don't. The auth policy can then say:
"Service(google-auth) may be declassified when consumed at
`headers.Authorization` by fetchData" — without needing a separate
`endorse_request` component to inspect the assembled request.

### 8.1 Path-Labeled Value Representation

- [x] Define `PathLabel` type: `{ path: string[], label: Label }`
- [x] Define `TaintMap`: a structure mapping paths to their labels, with
  efficient join and lookup operations
  ```
  TaintMap = {
    entries: PathLabel[],
    join(path: string[], label: Label): void,
    labelAt(path: string[]): Label,       // label for a specific path
    flatLabel(): Label,                    // join of all entries (fallback)
  }
  ```
- [x] `TaintMap.labelAt(path)` returns the label for that specific path, or
  the join of all ancestor paths (taint flows down: if the whole object is
  secret, every field is secret)
- [x] Ensure empty TaintMap behaves identically to current `emptyLabel()` —
  backwards compatible

**File:** new `packages/runner/src/cfc/taint-map.ts`

### 8.2 Per-Property Schema Labels

The schema `ifc` annotation already exists per-property (e.g.,
`token: { type: "string", ifc: { classification: ["secret"] } }`). Currently
`traverse.ts` collapses these into one label per document read. Change this to
produce path-level entries.

- [x] In `SchemaObjectTraverser`, when encountering a property with `ifc`,
  emit a `PathLabel` with the property path instead of joining into flat taint
- [x] `recordTaintedRead` gains an optional `path` parameter:
  `recordTaintedRead(tx, label, path?)`
- [x] When a path is provided, the taint context stores it in the TaintMap
  rather than flat-joining
- [x] When no path is provided (backwards compat), flat-join as before

**File:** modifications to `packages/runner/src/traverse.ts`,
`packages/runner/src/cfc/taint-tracking.ts`

### 8.3 Taint Propagation Through Reactive Graph (Link-Based)

The key insight: `diffAndUpdate` already writes **links** (cell references)
instead of copying values when the output contains Cell objects. A lift that
receives an auth cell and returns `{ headers: { Authorization: tokenCell } }`
never reads the token string — it writes a link. The taint the lift accumulates
is only from what it actually `.get()`s, not from linked cells it passes through.

This means field-to-field taint tracking largely comes for free:

**How it works:**

1. A lift receives input cells. It can access them as `OpaqueCell` (no `.get()`)
   or as regular cells.
2. If the lift reads `input.email` (no ifc) but only passes `input.token` as
   a cell reference in the output, the lift's taint = just the email read
   (no token taint). The token reference is written as a link via
   `diffAndUpdate` → `isCell(newValue)` branch (data-updating.ts:258).
3. The link itself carries minimal taint — it's a pointer, not the secret data.
   The label on the link document reflects the writing action's taint (the
   email read), not the linked-to token's label.
4. When `fetchData` later dereferences `headers.Authorization` (resolving the
   link to get the actual token string), *that* read accumulates the token's
   `Service(google-auth)` taint — but only in fetchData's context, at a known
   path.

**What this enables:**

- A lift that passes an `OpaqueCell` through never taints itself with that
  cell's content. OpaqueCell removes `.get()` from the interface, making this
  explicit.
- Path-level labels on the output document reflect which paths are links
  (untainted pointers) vs which paths are materialized values (tainted by reads).
- Builtins that dereference links accumulate taint per-path, enabling
  sink-aware declassification (Phase 9).

**Implementation:**

- [ ] Verify that `diffAndUpdate`'s cell-to-link conversion preserves the
  output document's path-level label structure — links should not inherit
  the linked-to cell's label until dereferenced
- [ ] In `recordTaintedRead`, distinguish between "read a link pointer" (low
  taint) and "dereferenced a link and read the value" (inherits linked cell's
  label)
- [ ] Ensure `OpaqueCell` usage in a lift context does not trigger
  `recordTaintedRead` — no `.get()` means no taint
- [ ] Document the pattern: lift authors should use `OpaqueCell` for
  pass-through fields to minimize taint. This is the idiomatic way to build
  request objects where secrets go into specific fields.

**Stage B (future) — Primitive value tracking:**

- [ ] Links only work for cell-valued fields. Primitive values (strings,
  numbers) are copied inline by `diffAndUpdate`, so reading `input.email`
  and writing it to `output.from` copies the string and taints the output.
- [ ] For primitives, future work can add proxy-based tracking or static
  analysis to map input reads to output paths. Deferred — the link-based
  model handles the Gmail case since the token is a cell reference.

**File:** modifications to `packages/runner/src/data-updating.ts` (label on
link writes), `packages/runner/src/cfc/taint-tracking.ts`

### 8.4 ActionTaintContext with TaintMap

- [x] Replace `accumulatedTaint: Label` with `taintMap: TaintMap` on
  `ActionTaintContext`
- [x] Keep `flatTaint(): Label` as a derived accessor (join of all entries)
  for backwards compat with `checkWrite` and `checkClearance`
- [x] `accumulateTaint(ctx, label, path?)` stores path-level entry when path
  is given, flat-joins otherwise
- [x] `checkWrite` continues to use flat taint — it's the final gate and needs
  the full picture
- [x] Add `taintAtPath(ctx, path): Label` — returns the taint for a specific
  output path (used by builtins)

**File:** modifications to `packages/runner/src/cfc/action-context.ts`

### 8.5 Tests for Path-Level Tracking

- [x] Unit: TaintMap join, lookup, ancestor propagation, flatLabel
- [x] Unit: recordTaintedRead with path produces path-level entry
- [x] Integration: read object with secret field + non-secret field, only
  secret field path carries taint
- [ ] Integration: lift that reads only the non-secret field → output untainted
- [ ] Integration: lift that reads the secret field → output tainted
- [x] Backwards compat: all existing CFC tests pass unchanged

**File:** `packages/runner/test/cfc-path-taint.test.ts`

---

## Phase 9: Sink-Aware Declassification

With path-level taint, builtins can inspect per-field taint on their inputs and
apply field-level declassification rules. This replaces the spec's
`endorse_request` pipeline (§5.2) with a simpler model: the auth policy
declares which confidentiality atoms may be consumed at which sink paths, and
the builtin enforces it at the point of consumption.

### 9.1 Sink Declassification Rules

- [ ] Define `SinkDeclassificationRule` type:
  ```
  {
    /** Atom pattern to match on taint */
    taintPattern: AtomPattern,
    /** Builtin that may consume this taint */
    allowedSink: string,          // e.g. "fetchData"
    /** Path within the sink's input where consumption is allowed */
    allowedPaths: string[][],     // e.g. [["options","headers","Authorization"]]
    /** Variables for pattern matching */
    variables: string[],
  }
  ```
- [ ] Add `sinkRules: SinkDeclassificationRule[]` to `PolicyRecord`
- [ ] Default policy: empty (no sink declassification — backwards compat)

**File:** new `packages/runner/src/cfc/sink-rules.ts`, modifications to
`packages/runner/src/cfc/policy.ts`

### 9.2 Builtin Taint Gate

When a builtin like `fetchData` is about to consume its inputs:

- [ ] Inspect the taint on each input path (via `taintAtPath`)
- [ ] For each path that carries confidentiality atoms:
  - Look up sink declassification rules for this builtin
  - If the path matches an allowed sink path and the taint matches the atom
    pattern → strip the matched atom (authority-only consumption)
  - If no rule matches → the taint remains, and if it exceeds the output
    label the write is blocked
- [ ] Emit `AuthorizedRequest` integrity atom when a sink rule fires — this
  provides the integrity evidence that the spec requires for exchange rules
  downstream
- [ ] For `fetchData` specifically: check taint on `options.headers.*`,
  `options.body`, `url` separately. Only `headers.Authorization` gets
  declassification for `Service(google-auth)`.

**File:** modifications to `packages/runner/src/builtins/fetch-data.ts`,
new helper in `packages/runner/src/cfc/sink-gate.ts`

### 9.3 Auth Policy for Gmail Example

- [ ] Define a Google auth policy record with:
  ```
  sinkRules: [{
    taintPattern: { kind: "Service", params: { id: "google-auth" } },
    allowedSink: "fetchData",
    allowedPaths: [["options", "headers", "Authorization"]],
    variables: [],
  }]
  ```
- [ ] The token's `Service(google-auth)` is declassified when it flows into
  `headers.Authorization` of a fetchData call
- [ ] If the token is put in the body, query string, or any other field — the
  taint remains and blocks the request
- [ ] The response inherits only the non-authority taint (e.g., `User(Alice)`)

**File:** test fixtures in `packages/runner/test/cfc-gmail-read.test.ts`

### 9.4 Relationship to endorse_request (Spec §5.2)

The spec defines `endorse_request` as a trusted component that inspects the
assembled request and emits `AuthorizedRequest` integrity. In our model:

- `endorse_request` is **not a separate component** — it's the policy predicate
  evaluated by the builtin's taint gate (§9.2)
- The sink declassification rule **is** the endorsement logic: it verifies the
  secret is in the right place
- The `AuthorizedRequest` integrity atom is emitted by the taint gate when the
  rule fires, providing the same integrity evidence for downstream exchange rules
- This is simpler (no separate pipeline stage) and more precise (per-field
  rather than whole-request inspection)

**Spec update needed:** §5.2.1 should note that `endorse_request` can be
implemented as a builtin-local policy check rather than a separate component,
when path-level labels are available.

### 9.5 Tests for Sink Declassification

- [ ] Unit: SinkDeclassificationRule matching against path + atom
- [ ] Integration: Gmail read path — token in Authorization header, request
  succeeds, response untainted by Service atom
- [ ] Integration: token in request body → request blocked (no sink rule for
  body path)
- [ ] Integration: token in wrong header (e.g., X-Token) → blocked
- [ ] Integration: non-secret field (email) in body → allowed
- [ ] Integration: AuthorizedRequest integrity atom emitted on success
- [ ] Backwards compat: fetchData without any ifc works unchanged

**File:** `packages/runner/test/cfc-sink-rules.test.ts`,
`packages/runner/test/cfc-gmail-read.test.ts`

---

## Phase 10: End-to-End Gmail Flow

With path-level tracking and sink declassification in place, wire up the full
Gmail example from the spec.

### 10.1 Gmail Read Path (end-to-end)

- [ ] OAuth token cell with `Service(google-auth)` on token field
- [ ] Recipe reads token, builds fetch request with token in Authorization
  header
- [ ] fetchData taint gate: declassifies Service atom at header path, emits
  AuthorizedRequest integrity
- [ ] Mock fetch returns Gmail messages
- [ ] Response cell carries `User(Alice)` taint only (not Service)
- [ ] Downstream recipe reads response — not blocked by Service taint

### 10.2 Gmail Write Path

- [ ] Recipe reads email draft (user data) + token
- [ ] Builds POST request: token in header (authority-only), draft in body
  (data-bearing)
- [ ] Response inherits draft's taint but not token's
- [ ] Test: draft with secret search query → response inherits secret taint

### 10.3 Error Path

- [ ] Failed request → error response inherits full input taint (safe default)
- [ ] Error exchange rule declassifies error code/message for display
- [ ] Auth error (401) → user sees error, token not leaked

**File:** `packages/runner/test/cfc-gmail-e2e.test.ts`

---

## Ordering (Phases 8-10)

```
Phases 1-7 (complete)
  │
  └──→ Phase 8 (Path-Level Taint)
          │
          ├──→ 8.1-8.2: TaintMap + per-property schema reads
          │       │
          │       └──→ 8.3-8.4: Propagation + ActionTaintContext update
          │               │
          │               └──→ 8.5: Tests
          │
          └──→ Phase 9 (Sink Declassification)
                  │
                  ├──→ 9.1-9.2: Rules + builtin taint gate
                  │       │
                  │       └──→ 9.3: Gmail auth policy
                  │
                  └──→ Phase 10 (Gmail E2E)
```

The link-based propagation model (Phase 8.3) is sufficient for the Gmail example:
lifts pass token cells as links (no read, no taint), and fetchData dereferences
at a known path where sink rules can fire. Stage B (primitive value tracking) is
deferred — links already handle cell-valued fields like OAuth tokens.

---

## Out of Scope (Future Work)

These are described in the spec but deferred from this implementation round:

- [ ] Intent events and single-use semantics (spec sections 6-7)
- [ ] VDOM snapshot digests and gesture provenance (spec section 6)
- [ ] Static analysis / TypeScript transformer integration (spec section 11)
- [ ] Multi-party consent validation (spec section 3.9)
- [ ] Path-level taint Stage B: primitive value field-to-field tracking
  through lifts via Proxy-based runtime tracing or static analysis (links
  already handle cell-valued fields)
- [ ] User-configurable trust lattices (structural support built, UI deferred)
- [ ] Robust declassification validation (spec invariant 7)
- [ ] Transparent endorsement checks (spec invariant 8)
- [ ] PC (program counter) integrity tracking (spec invariant 9)
