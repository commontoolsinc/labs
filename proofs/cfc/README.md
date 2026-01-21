# Lean4 Formal Proofs for CFC (Contextual Flow Control) Specification

This directory contains formal proofs in Lean4 for key properties of the CFC
information flow control system as specified in `docs/specs/cfc/`.

## Overview

The CFC specification describes an information flow control model that integrates
classical IFC with Contextual Integrity (CI). These proofs formalize and verify
the core security properties claimed in the specification.

## What We Prove

### 1. Label Lattice Structure (`CFC/Lattice.lean`)

- **Confidentiality labels** (CNF structure) form a bounded join semilattice
  - Join (clause concatenation) is associative, commutative, idempotent
  - Join is monotonic with respect to the lattice ordering
- **Integrity labels** (simple conjunction) form a bounded meet semilattice
  - Meet (intersection) is associative, commutative, idempotent
- **Combined labels** form a product lattice

### 2. Label Propagation (`CFC/Propagation.lean`)

- Propagation through computations preserves label lattice structure
- Confidentiality only increases (or stays same) through computation
- Integrity only decreases (or stays same) through computation
- Pass-through preserves both confidentiality and integrity

### 3. Exchange Rule Correctness (`CFC/Exchange.lean`)

- Exchange rules can only add alternatives (disjunctions) to clauses
- Exchange rule application is monotonic in the lattice ordering
- Fixpoint evaluation terminates (finite iterations)
- Access check is sound with respect to exchange rules

### 4. Safety Invariants (`CFC/Safety.lean`)

From Section 10 of the spec:
- **Monotonicity**: Confidentiality labels are monotone unless explicitly rewritten
- **Robust declassification**: Low-integrity inputs cannot influence declassification
- **Transparent endorsement**: High-confidentiality data cannot influence endorsement
- **Flow-path confidentiality**: Control flow carries confidentiality

### 5. Single-Use Semantics (`CFC/SingleUse.lean`)

From Section 6 of the spec:
- Events are processed exactly once
- Intent consumption is atomic
- Causal ID derivation ensures uniqueness
- Fork prevention for event transformations

### 6. Store Label Monotonicity (`CFC/Store.lean`)

From Section 8.12 of the spec:
- Store labels can only become more restrictive over time
- Writing data requires label compatibility
- Schema evolution preserves monotonicity

### 7. Multi-Party Consent (`CFC/MultiParty.lean`)

From Section 3.9 of the spec:
- Effective scope is intersection of individual consent scopes
- All participants must consent for computation to proceed
- Result confidentiality allows access by all participants

## Project Structure

```
CFC/
├── Basic.lean          -- Basic definitions and utilities
├── Atom.lean           -- Parameterized atoms
├── Label.lean          -- Labels (confidentiality + integrity)
├── Lattice.lean        -- Lattice structure proofs
├── Exchange.lean       -- Exchange rule formalization
├── Propagation.lean    -- Label propagation rules
├── Safety.lean         -- Safety invariant proofs
├── SingleUse.lean      -- Single-use semantics
├── Store.lean          -- Store label monotonicity
├── MultiParty.lean     -- Multi-party consent
└── Main.lean           -- Top-level imports
```

## Building

Requires Lean 4 (tested with v4.x). Install via elan:

```bash
curl https://raw.githubusercontent.com/leanprover/elan/master/elan-init.sh -sSf | sh
```

Then build:

```bash
cd proofs/cfc
lake build
```

## Relationship to Specification

Each proof file references the corresponding section of the CFC specification:

| Proof File | Spec Sections |
|------------|---------------|
| `Lattice.lean` | 3.1 (Label Lattices) |
| `Exchange.lean` | 4.3-4.4 (Exchange Rules) |
| `Propagation.lean` | 8.1-8.9 (Label Transitions) |
| `Safety.lean` | 10 (Safety Invariants) |
| `SingleUse.lean` | 6 (Events and Intents) |
| `Store.lean` | 8.12 (Store Label Monotonicity) |
| `MultiParty.lean` | 3.9 (Multi-Party Confidentiality) |

## Key Theorems

### `confidentiality_join_is_semilattice`
The CNF confidentiality structure with clause concatenation forms a join semilattice.

### `integrity_meet_is_semilattice`
The integrity structure with set intersection forms a meet semilattice.

### `exchange_rule_monotonic`
Applying exchange rules can only increase the set of satisfiable access paths.

### `exchange_fixpoint_terminates`
Iterating exchange rule application reaches a fixpoint in finite steps.

### `propagation_preserves_monotonicity`
Label propagation through computations preserves lattice monotonicity.

### `robust_declassification`
Declassification decisions are independent of low-integrity inputs.

### `transparent_endorsement`
Endorsement decisions are independent of high-confidentiality data.

### `single_use_uniqueness`
Each event/intent is processed exactly once.

### `store_label_monotonic`
Store labels can only become more restrictive over time.

## Future Work

- Formalize the trust delegation model (Section 4.8)
- Prove properties of intent duration classes (Section 6.4.4)
- Formalize modification authorization (Section 8.15)
- Connect to the overlapping declassifiers open problem (Section 10)
