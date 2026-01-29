# 14. Glossary

Short definitions of recurring CFC terms (informative). For the normative model, see Sections 3–8.

## 14.1 Labels

- **Atom**: A structured label element with a `type` and parameters (Section 4.1). Atoms appear in confidentiality clauses and integrity sets.
- **Clause**: One confidentiality requirement. A clause is either a single atom or a list of alternative atoms (OR) (Section 3.1.1).
- **CNF confidentiality**: Confidentiality is an AND of clauses (CNF). Exchange rules add alternatives inside clauses; data combination concatenates clauses (Sections 3.1.1–3.1.3).
- **Integrity label**: A conjunction (set) of integrity atoms/facts that justify beliefs about a value or a decision (Section 3.1.6).

## 14.2 Policies

- **Policy record**: Content-addressed definition of exchange rules and classifications for a policy/context principal (Sections 4.4 and 5).
- **Policy principal / context principal**: A confidentiality atom whose meaning is given by a policy record. In schemas/templates it is unbound (no hash); in runtime labels it is bound to a specific policy hash (Sections 4.1.2 and 4.4.2).
- **Exchange rule**: An integrity-guarded rewrite that adds (or sometimes removes) confidentiality alternatives and may mint integrity facts (Sections 3.1.3 and 4.4.5).
- **Trusted boundary**: A runtime point where policy evaluation and verification occurs (e.g., display, network egress, store writes). Exchange rules, `refer(...)` checks, and attestation/provenance facts are enforced here, not by untrusted pattern code (Sections 6, 8, 11).

## 14.3 Intents and Side Effects

- **IntentEvent**: High-integrity event minted from UI interaction by trusted UI/runtime components (Section 3.8).
- **IntentOnce**: Single-use, consumable intent capability used to authorize a specific side effect; it is consumed only on commit (Sections 6 and 7).
- **Attempt vs commit**: An attempt sends an external request; commit means policy-defined success criteria are met and the intent is consumed (Section 7.5).
- **Commit point**: A sink that performs side effects (e.g., `fetch`) and is responsible for coupling consumption to commit conditions (Section 7.5).

## 14.4 Control-Flow Effects

- **PC (flow-path) integrity**: Integrity required to justify control-flow decisions that enable declassification (robust declassification) (Section 3.4 and 3.8.6).
- **PC (flow-path) confidentiality**: Confidentiality introduced by control decisions influenced by secret inputs; it must be joined into downstream outputs when routing/selection depends on secrets (Section 8.11).

## 14.5 Data Handling Primitives

- **Pass-through (`passThrough`)**: Output is a reference to an input; the runtime verifies reference preservation (Section 8.2).
- **Projection (`projection`)**: Output is a subfield of an input object; labels propagate according to projection semantics (Section 8.3).
- **Exact copy (`exactCopyOf`)**: Output must be bitwise-equal to an input at runtime; mismatches are fatal (Section 8.4).
- **Opaque input**: Handler may receive a reference but cannot read the content; used to pass secrets safely through untrusted code (Section 8.13).
- **Write authority (`writeAuthorizedBy`)**: Field-level capability set controlling who may modify stored state; separate from value integrity (Section 8.15).

