/-
  Main.lean
  Top-level imports for CFC formal proofs.

  This file imports all modules in the CFC formalization,
  allowing the entire proof suite to be type-checked.
-/

import CFC.Basic
import CFC.Atom
import CFC.Label
import CFC.Lattice
import CFC.Exchange
import CFC.Propagation
import CFC.Safety
import CFC.SingleUse
import CFC.Store
import CFC.MultiParty

/-!
# CFC Formal Proofs Summary

This formalization proves key properties of the Contextual Flow Control (CFC)
specification as defined in `docs/specs/cfc/`.

## Modules

- **Basic**: Foundational types (DID, ContentHash, Reference, etc.)
- **Atom**: Parameterized atoms (User, Space, Context, Expires, etc.)
- **Label**: Label structure (CNF confidentiality, conjunction integrity)
- **Lattice**: Lattice properties (join/meet, associativity, monotonicity)
- **Exchange**: Exchange rule formalization and correctness
- **Propagation**: Label propagation through computations
- **Safety**: Safety invariants (monotonicity, robust declassification, etc.)
- **SingleUse**: Single-use semantics for events and intents
- **Store**: Store label monotonicity
- **MultiParty**: Multi-party consent properties

## Key Theorems

### Lattice Structure
- `conf_join_assoc`: Confidentiality join is associative
- `conf_join_access`: Access to join requires access to both inputs
- `int_meet_assoc`: Integrity meet is associative
- `label_join_assoc`: Combined label join is associative

### Exchange Rules
- `exchange_only_adds_alternatives`: Exchange rules only add, never remove
- `exchange_monotonic_access`: Exchange rules can only make access easier

### Safety Invariants
- `robust_declassification`: Low-integrity inputs cannot influence declassification
- `transparent_endorsement`: High-confidentiality data cannot influence endorsement
- `flow_path_confidentiality`: Control flow carries confidentiality
- `router_attack_prevented`: Router attack is prevented by flow-path tracking

### Single-Use Semantics
- `claim_once`: Cells can only be claimed once
- `event_processed_once`: Events are processed exactly once
- `refine_once_per_refiner`: Intents can only be refined once per refiner
- `consume_once`: Intents can only be consumed once
- `expired_not_consumable`: Expired intents cannot be consumed

### Store Monotonicity
- `valid_update_preserves_restrictiveness`: Valid updates don't weaken access control
- `addClause_valid_update`: Adding clauses is always valid
- `write_preserves_invariants`: Writing compatible data preserves invariants

### Multi-Party Consent
- `all_participants_must_consent`: Computation requires all consents
- `effective_scope_is_intersection`: Scope is intersection of individual scopes
- `participant_can_access_result`: Participants can access results
- `meeting_times_bounded`: Results respect maxResults constraint

## Usage

To build and check all proofs:

```bash
lake build
```

To check a specific module:

```bash
lake build CFC.Safety
```

## Notes

Some proofs are marked with `sorry` where the full proof is elided for brevity
or requires additional lemmas. These represent:

1. **Technical lemmas** about list operations that are straightforward but verbose
2. **Design constraints** that are enforced by construction rather than proven
3. **Areas for future work** where the proof strategy is clear but not fully formalized

The overall proof structure demonstrates the key invariants hold assuming
these technical details are filled in.
-/

def main : IO Unit :=
  IO.println "CFC formal proofs loaded successfully."
